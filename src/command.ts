import {
  platformCommandCandidates,
  readEnv,
  tryEachCandidate,
} from "@ora-space/plugin-sdk/acp";

/** The npm bin name of the ACP adapter that fronts Claude Code. */
const BINARY_NAME = "claude-agent-acp";

/**
 * Lists the commands that can launch Claude Code's ACP adapter, in priority order.
 *
 * `ORA_CLAUDE_ACP_BIN` pins one exact binary and is returned alone: a pin that quietly fell back
 * to whatever is on PATH would run a different adapter than the user asked for, which is worse
 * than failing. Without a pin, Windows gets both spellings because npm installs only a
 * `claude-agent-acp.cmd` shim while a bun or standalone install exposes the bare name.
 */
export function resolveClaudeCandidates(): string[] {
  const explicit = readEnv("ORA_CLAUDE_ACP_BIN")?.trim();
  if (explicit !== undefined && explicit !== "") {
    return [explicit];
  }
  return platformCommandCandidates(BINARY_NAME);
}

/** Runs `attempt` against each adapter candidate, mapping an absent adapter to `-32001`. */
export function tryClaude<T>(
  attempt: (command: string) => T | Promise<T>,
): Promise<T> {
  return tryEachCandidate(
    resolveClaudeCandidates(),
    attempt,
    (tried) =>
      `Claude Code's ACP adapter is not installed or not on PATH (tried: ${
        tried.join(", ")
      }); install it with \`npm i -g @agentclientprotocol/claude-agent-acp\` or set ORA_CLAUDE_ACP_BIN`,
  );
}
