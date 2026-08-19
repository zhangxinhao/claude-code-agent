# ora-space.claude

An **agent plugin** for Ora that publishes
[Claude Code](https://claude.com/claude-code) as a selectable agent. The plugin
runs `claude-agent-acp` — Claude Code's
[Agent Client Protocol](https://agentclientprotocol.com) adapter — as a child
process and bridges it to Ora as a pure ACP pipe.

Nothing in Ora is hardcoded for this plugin: it is discovered from the installed
plugin directory, validated from `package.json`, and launched as an ordinary
agent provider. Deleting the directory removes the agent.

```
┌────────────────────────── Ora host (Rust) ───────────────────────────┐
│    invoke : agent/start · agent/stop · agent/listModels              │
│    notify : agent/acp (bidirectional, payload never parsed)          │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ stdio, 4-byte length + 0x01 + JSON-RPC
                             v
┌──────────────────── this plugin (Deno process) ──────────────────────┐
│  @ora-space/plugin-sdk/agent   AgentPlugin base, handshake, dispatch │
│  @ora-space/plugin-sdk/acp     AcpProcessBridge, NDJSON re-framing   │
│  src/main.ts · command.ts · models.ts   what is Claude-specific      │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ NDJSON, one JSON-RPC object per line
                             v
                   claude-agent-acp (ACP protocolVersion 1)
```

## What lives here

Everything generic — the Ora handshake, the `AgentPlugin` base class, the ACP
child-process bridge, command-candidate resolution, and the host simulator —
comes from the published SDK (`jsr:@ora-space/plugin-sdk`). This package only
contains what is specific to Claude Code:

```
package.json     Ora manifest: id, kind, engines, contributed agent, declared permissions
deno.json        SDK dependency (jsr:@ora-space/plugin-sdk@^1), lock: true, developer tasks
src/main.ts      ClaudeAgentPlugin extends AgentPlugin; spawns `claude-agent-acp` with no args
src/command.ts   ORA_CLAUDE_ACP_BIN pin (no PATH fallback), platform candidates, -32001 mapping
src/models.ts    agent/listModels: empty — see Models
tests/           HostSimulator-driven end-to-end check against the real adapter
```

## Models

`agent/listModels` returns an empty list, and that is the correct answer rather
than a gap. `claude-agent-acp` is a pure ACP server: it has no `models`
subcommand and its `initialize` result carries capabilities only. Claude Code's
model set appears exactly once on the wire — as the `category: "model"` entry of
the `configOptions` array in a `session/new` result — and reaches Ora through
`agent/acp` untouched, so the in-session model picker is fully populated.
`src/models.ts` records the alternatives that were considered and why each was
rejected.

## Requirements

- The Claude ACP adapter on PATH:
  `npm i -g @agentclientprotocol/claude-agent-acp`. On Windows npm installs a
  `claude-agent-acp.cmd` shim, which the plugin tries alongside the bare name.
  `ORA_CLAUDE_ACP_BIN` pins one exact binary instead, and is deliberately not
  backed by a PATH fallback — a pin that quietly ran a different adapter would
  be worse than failing.
- The `claude` CLI, authenticated — the adapter drives it.
- Deno, which Ora provides for plugin processes.

The manifest declares the permissions this plugin needs (`run`, `read`, `env`
for `ORA_CLAUDE_ACP_BIN`/`PATH`/…, `net`); Ora grants exactly those. The adapter
takes no arguments: it reads its initial directory from the spawn cwd, and every
per-session directory arrives through ACP `session/new`.

## Dependencies and offline use

The SDK is a regular dependency pinned by `deno.lock`. Ora resolves it into its
own dependency cache when the plugin is installed and launches the plugin with
`--cached-only`, so no network is touched at runtime. For fully offline
machines, publish a self-contained package (`"vendor": true` in `deno.json` and
run `deno install --entrypoint src/main.ts` before packing) so the SDK ships
inside the package.

## Identity and the built-in Claude CLI

This package claims `ora-space.claude`, the identity the frontend already labels
"Claude Code". While Ora still ships a built-in Claude agent under that identity
the plugin is discovered, validated, and then shadowed; removing the built-in
variant hands the agent to this package with no other change on either side.

## Verification

`deno task check`, `deno task lint`, and `deno task simulate`. The simulation
launches this plugin the way Ora does, against the real adapter, and asserts the
handshake, `agent/start`, ACP `initialize`, `session/new` carrying a model
option, an empty `agent/listModels`, and `agent/stop`. To run it against an
unpublished SDK checkout, point `ORA_PLUGIN_DENO_CONFIG` (and
`deno test --config`) at a config whose imports map `@ora-space/plugin-sdk/*` to
that checkout.

## Known limits

- `agent/start` receives the host's home directory as `cwd`; per-session working
  directories travel in ACP `session/new`, which this plugin passes through.
- When the adapter exits on its own the plugin logs it and lets the host observe
  a stalled connection; the contract has no `agent/exited` notification yet.
