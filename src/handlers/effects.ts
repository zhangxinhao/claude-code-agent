import type {
  AgentEffectContext,
  AgentEffectDefinition,
  AgentEffectIdleState,
  AgentEffectRestartContext,
  EffectSurfaceDeclaration,
  JsonValue,
} from "@ora-space/plugin-sdk";
import type { ClaudeClient } from "../services/claude-client.ts";

/**
 * The Skill surface Claude Code reads: a project-relative `.claude/skills/<name>/SKILL.md` tree.
 *
 * Claude Code also reads a user-level `~/.claude/skills` directory, but that is Preserved State
 * from this plugin's point of view: Ora only manages the repository-root surface it declares here,
 * so it never fights another tool over the user-level directory.
 */
export const SKILLS_SURFACE: EffectSurfaceDeclaration = {
  workspaceRelativePath: ".claude/skills",
  materializationFormat: "skill_directory.v1",
  coordination: "wait_for_idle_and_restart",
};

const SESSION_PROMPT_METHOD = "session/prompt";

/**
 * Coordinates the `.claude/skills` Effect surface against the one adapter process this plugin owns.
 *
 * Claude Code resolves its Skill directories when a session starts, so a Skill edit on disk only
 * reaches a session created after the edit. This tracks in-flight `session/prompt` turns from the
 * ACP frames already flowing through the bridge — nothing here parses ACP beyond `method` and `id`
 * — and, once every turn has finished, holds any new one behind a barrier until `restart` has
 * respawned the adapter and replayed what it held, so the very next turn is guaranteed to land in
 * a session created after the write.
 */
export class SkillEffectCoordinator {
  readonly #client: ClaudeClient;
  readonly #cwd: () => string | undefined;
  readonly #openTurns = new Set<string | number>();
  /** `undefined` while no barrier is held; an array from the moment `waitForIdle` reports ready. */
  #held: JsonValue[] | undefined;
  #appliedGeneration: number | undefined;

  constructor(client: ClaudeClient, cwd: () => string | undefined) {
    this.#client = client;
    this.#cwd = cwd;
  }

  readonly definition: AgentEffectDefinition = {
    surfaces: [SKILLS_SURFACE],
    waitForIdle: (context) => this.#waitForIdle(context),
    restart: (context) => this.#restart(context),
  };

  /**
   * Observes one host-to-agent frame before it would be forwarded, absorbing it instead if the
   * barrier is holding new turns. Returns whether the frame was absorbed.
   */
  intercept(frame: JsonValue): boolean {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return false;
    }
    const { method, id } = frame;
    if (
      typeof method !== "string" ||
      (typeof id !== "string" && typeof id !== "number")
    ) {
      return false;
    }
    if (method !== SESSION_PROMPT_METHOD) {
      return false;
    }
    if (this.#held !== undefined) {
      this.#held.push(frame);
      return true;
    }
    this.#openTurns.add(id);
    return false;
  }

  /** Observes one agent-to-host frame, clearing turn tracking once a prompt resolves. */
  observe(frame: JsonValue): void {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return;
    }
    if ("method" in frame) {
      return; // requests and notifications the adapter sends are not responses.
    }
    const { id } = frame;
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    this.#openTurns.delete(id);
  }

  /**
   * Reports whether every turn has finished, engaging the new-turn barrier the moment it has.
   *
   * Idempotent by design: once the barrier is engaged, `#openTurns` stays empty forever because
   * `intercept` routes every later `session/prompt` into `#held` instead, so a repeated call keeps
   * returning `ready` with no further side effect.
   */
  #waitForIdle(_context: AgentEffectContext): AgentEffectIdleState {
    if (this.#openTurns.size > 0) {
      return "waiting_for_idle";
    }
    this.#held ??= [];
    return "ready";
  }

  /**
   * Restarts the adapter so the next session it creates resolves `.claude/skills` fresh, then
   * replays every held turn in order.
   *
   * The barrier is released only after the queue is fully drained, and draining re-checks the
   * queue length on every iteration, so a `session/prompt` that arrives mid-restart is still
   * caught by `intercept` and gets appended in time to be replayed rather than dropped.
   */
  async #restart(context: AgentEffectRestartContext): Promise<void> {
    const cwd = this.#cwd();
    const alreadyRunning = this.#client.running &&
      this.#appliedGeneration === context.generation;
    if (!alreadyRunning && cwd !== undefined) {
      await this.#client.start(cwd);
    }
    this.#appliedGeneration = context.generation;

    while (this.#held !== undefined && this.#held.length > 0) {
      const frame = this.#held.shift();
      if (frame !== undefined) {
        await this.#client.writeAcp(frame);
      }
    }
    this.#held = undefined;
  }
}
