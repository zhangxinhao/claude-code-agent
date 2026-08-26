import type { AgentStartContext } from "@ora-space/plugin-sdk";
import { PluginMethodError } from "@ora-space/plugin-sdk";
import type { ClaudeClient } from "../services/claude-client.ts";

/** The JSON-RPC code for a request the plugin refuses because its parameters are unusable. */
const INVALID_PARAMS = -32602;

/**
 * Serves `agent/start` by bringing the Claude ACP adapter up in the host's working directory.
 *
 * Ora calls this once per connection, before any session exists, so the adapter is already
 * accepting ACP frames when the host runs its own `initialize` handshake. Per-session directories
 * travel later in ACP `session/new`, not here.
 */
export async function startClaude(
  client: ClaudeClient,
  context: AgentStartContext,
): Promise<void> {
  if (context.cwd.trim() === "") {
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/start requires a non-empty cwd",
    );
  }
  await client.start(context.cwd);
}

/**
 * Serves `agent/stop` by killing the adapter while keeping this plugin process alive.
 *
 * A later `agent/start` respawns it, which is what lets Ora restart a failed agent without paying
 * for a new plugin handshake.
 */
export function stopClaude(client: ClaudeClient): Promise<void> {
  return client.stop();
}
