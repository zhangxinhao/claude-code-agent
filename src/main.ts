import type {
  AcpSender,
  AgentModel,
  AgentStartContext,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { AGENT_METHODS } from "@ora-space/plugin-sdk";
import {
  type AgentListModelsContext,
  AgentPlugin,
  type PluginContext,
  runAgentPlugin,
} from "./base/agent-plugin.ts";
import { forwardAcpFrame } from "./handlers/acp.ts";
import { SkillEffectCoordinator } from "./handlers/effects.ts";
import { startClaude, stopClaude } from "./handlers/lifecycle.ts";
import {
  invalidateAllClaudeModels,
  invalidateClaudeModels,
  listClaudeModels,
} from "./handlers/models.ts";
import { ClaudeClient } from "./services/claude-client.ts";

/** Must match `ora.id` in package.json, which is also this agent's identity inside Ora. */
const PLUGIN_ID = "ora-space.claude";

/**
 * Publishes Claude Code as an Ora agent.
 *
 * One plugin process is one agent, so this class owns exactly one adapter and needs no addressing
 * of its own. Every API is delegated to a handler module, which keeps the entrypoint to wiring: the
 * sender handed in by `agent/start`, the adapter bridge, and the route mounting below.
 */
class ClaudeAgentPlugin extends AgentPlugin {
  /** Valid only between `agent/start` and the end of the process; frames before that are lost. */
  #send: AcpSender | undefined;
  /** Set by `onActivate`, which the base class runs before the host can call anything. */
  #processes: HostProcesses | undefined;
  /**
   * Workspace of the live ACP process.
   *
   * Used to invalidate its model catalog on lifecycle events, and as the directory a Skill Effect
   * restart respawns the adapter into.
   */
  #cwd: string | undefined;

  readonly #client = new ClaudeClient({
    onAcpFrame: (frame) => {
      this.#effects.observe(frame);
      // A send failure means the host connection is already gone; there is nothing this plugin
      // can do with the frame, and throwing here would only kill the stdout pump.
      void this.#send?.(frame).catch((error) => {
        console.warn(`failed to forward ACP frame to the host: ${error}`);
      });
    },
    onExited: () => {
      if (this.#cwd !== undefined) {
        invalidateClaudeModels(this.#cwd);
      }
      console.warn(
        "the Claude ACP adapter exited on its own; Ora decides whether to reconnect",
      );
    },
  });

  readonly #effects = new SkillEffectCoordinator(this.#client, () => this.#cwd);

  override readonly effects = this.#effects.definition;

  override onActivate(context: PluginContext): void {
    console.info(`${context.pluginId} activated`);
    this.#processes = context.processes;
    this.#client.attachProcesses(context.processes);
  }

  override onStart = async (
    context: AgentStartContext,
    send: AcpSender,
  ): Promise<void> => {
    if (this.#cwd !== undefined) {
      invalidateClaudeModels(this.#cwd);
    }
    this.#send = send;
    this.#cwd = context.cwd;
    invalidateClaudeModels(context.cwd);
    await startClaude(this.#client, context);
  };

  override onStop = async (): Promise<void> => {
    if (this.#cwd !== undefined) {
      invalidateClaudeModels(this.#cwd);
    }
    await stopClaude(this.#client);
  };

  override onListModels = (
    context: AgentListModelsContext,
  ): Promise<AgentModel[]> => {
    if (this.#processes === undefined) {
      throw new Error(
        `${AGENT_METHODS.listModels} was called before activation`,
      );
    }
    // Discovery is answered for the Workspace the host named, not for `#cwd`: `agent/start` gets a
    // neutral directory, and a user can open pickers for a project this connection never ran in.
    return listClaudeModels(this.#processes, context.cwd);
  };

  override onAcp = (frame: JsonValue): Promise<void> | void =>
    forwardAcpFrame(this.#client, this.#effects, frame);

  override async onDeactivate(): Promise<void> {
    invalidateAllClaudeModels();
    await this.#client.stop();
  }
}

await runAgentPlugin(new ClaudeAgentPlugin(), { pluginId: PLUGIN_ID });
