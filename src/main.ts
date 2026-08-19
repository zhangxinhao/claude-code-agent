import { AcpProcessBridge, spawnPipedProcess } from "@ora-space/plugin-sdk/acp";
import {
  type AcpSender,
  type AgentModel,
  AgentPlugin,
  type AgentStartContext,
  type PluginContext,
  runAgentPlugin,
} from "@ora-space/plugin-sdk/agent";
import type { JsonValue } from "@ora-space/plugin-sdk";
import { tryClaude } from "./command.ts";
import { listClaudeModels } from "./models.ts";

/** Must match `ora.id` in package.json, which is also this agent's identity inside Ora. */
const PLUGIN_ID = "ora-space.claude";

/**
 * Publishes Claude Code as an Ora agent.
 *
 * One plugin process is one agent, so this class owns exactly one `claude-agent-acp` child and
 * needs no addressing of its own. Everything generic — the Ora handshake, the ACP re-framing, the
 * child process lifetime — lives in the SDK; this file only says how the adapter is launched.
 */
class ClaudeAgentPlugin extends AgentPlugin {
  /** Valid only between `agent/start` and the end of the process; frames before that are lost. */
  #send: AcpSender | undefined;

  readonly #bridge = new AcpProcessBridge({
    // The adapter is a native ACP server with no subcommand and no arguments: it takes its
    // initial directory from the spawn cwd and every per-session directory from `session/new`.
    spawn: (cwd) => tryClaude((command) => spawnPipedProcess(command, [], cwd)),
    onAcpFrame: (frame) => {
      // A send failure means the host connection is already gone; there is nothing this plugin
      // can do with the frame, and throwing here would only kill the stdout pump.
      void this.#send?.(frame).catch((error) => {
        console.warn(`failed to forward ACP frame to the host: ${error}`);
      });
    },
    onExited: () => {
      console.warn(
        "the Claude ACP adapter exited on its own; Ora decides whether to reconnect",
      );
    },
    logTag: "claude",
  });

  override onActivate(context: PluginContext): void {
    console.info(`${context.pluginId} activated`);
  }

  override async onStart(
    context: AgentStartContext,
    send: AcpSender,
  ): Promise<void> {
    this.#send = send;
    await this.#bridge.start(context.cwd);
  }

  override onStop(): Promise<void> {
    return this.#bridge.stop();
  }

  override onListModels(): AgentModel[] {
    return listClaudeModels();
  }

  override onAcp(frame: JsonValue): Promise<void> | void {
    return this.#bridge.forwardAcp(frame);
  }

  override async onDeactivate(): Promise<void> {
    await this.#bridge.stop();
  }
}

await runAgentPlugin(new ClaudeAgentPlugin(), { pluginId: PLUGIN_ID });
