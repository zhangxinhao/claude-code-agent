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
│  agent_runtime → plugin_agent                                        │
│    invoke : agent/start · agent/stop · agent/listModels              │
│    notify : agent/acp (bidirectional, payload never parsed)          │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ stdio, 4-byte length + 0x01 + JSON-RPC
                             v
┌──────────────────── this plugin (Deno process) ──────────────────────┐
│  src/main.ts        ClaudeAgentPlugin extends AgentPlugin            │
│  src/handlers/*     one module per registered API                    │
│  src/services/*     Claude adapter ownership, NDJSON framing         │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ NDJSON, one JSON-RPC object per line
                             v
                   claude-agent-acp (ACP protocolVersion 1)
```

## Contract mapping

| Host requirement                     | Implementation                                                           |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `ora/register` with methods + emits  | `runAgentPlugin` → SDK `defineAgent`: 3 methods, `agent/acp` emit        |
| `agent/start`                        | `handlers/lifecycle.ts` spawns `claude-agent-acp` in the host's cwd      |
| `agent/stop`                         | kills the adapter, keeps this process alive so a later start respawns    |
| `agent/listModels`                   | `handlers/models.ts`: empty — see **Models** below                       |
| `agent/acp` (both directions)        | `handlers/acp.ts` + `services/claude-client.ts`, payload never parsed    |
| adapter absent → `-32001`            | `services/command.ts` throws `PluginMethodError(AGENT_NOT_INSTALLED, …)` |
| one plugin = one agent = one process | a single plugin instance owning a single `ClaudeClient`                  |

## Models

`agent/listModels` returns an empty list, and that is the correct answer rather
than a gap.

`claude-agent-acp` is a pure ACP server. It has no `models` subcommand, and its
`initialize` result carries capabilities only. Claude Code's model set appears
exactly once on the wire — as the `category: "model"` entry of the
`configOptions` array in a `session/new` result:

```
default · sonnet · claude-fable-5[1m] · opus · haiku
```

Those options reach Ora through `agent/acp` untouched, so the in-session model
picker is fully populated. A pre-session list would have to be invented here,
and would disagree with the live list the moment Anthropic ships a model. Ora
treats "this agent advertises no pre-session models" as an ordinary answer; it
is exactly what a built-in CLI reports. `src/handlers/models.ts` records the
alternatives that were considered and why each was rejected.

## API registration architecture

The plugin follows the class-based organization from Ora's API registration
guide: every registered API is a method on a base class, and the entrypoint only
mounts handler modules onto it.

- `src/base/agent-plugin.ts` declares `abstract class AgentPlugin`. Required
  APIs are `abstract`, so an incomplete plugin fails to compile; optional APIs
  (`onStop`, `onActivate`, `onDeactivate`) ship default implementations.
- `runAgentPlugin` flattens the instance into a wire-name keyed dispatch table
  by walking its prototype chain, so dispatch is a single map lookup and a
  handler mounted as a field (`override onStart = …`) is found exactly like a
  method.
- `AGENT_METHOD_ROUTES` / `AGENT_NOTIFICATION_ROUTES` hold the class-method →
  JSON-RPC name mapping explicitly, because the host contract fixes the wire
  names and deriving them from method names would silently break on a rename.
- Adding an API later means adding one method to the base class, one route
  entry, and one handler module — the entrypoint does not grow.

## Layout

```
package.json              Ora manifest (ora.kind = "agent", ora.contributes.agent)
deno.json                 developer tasks only; Ora never reads it
src/
  main.ts                 entrypoint: mounts handlers onto the base class
  base/agent-plugin.ts    AgentPlugin base class + dispatch table + runAgentPlugin
  handlers/
    lifecycle.ts          agent/start, agent/stop
    models.ts             agent/listModels
    acp.ts                agent/acp (host → adapter)
  services/
    claude-client.ts      spawns and owns `claude-agent-acp`, both stdio pumps
    command.ts            binary resolution, candidate order, not-found mapping
    ndjson.ts             NDJSON line codec for the adapter's stdio
vendor/plugin-sdk/        pinned copy of @ora-space/plugin-sdk 0.1.3
tests/host-simulator.ts   drives this plugin the way the Ora host does
```

`vendor/plugin-sdk` is vendored rather than imported by specifier because Ora
launches the plugin with `deno run --no-prompt` and no import map: every module
the plugin loads must resolve from inside the package with no network access.
Refresh it from `packages/plugin-sdk/src` in the Ora repository when the SDK
changes.

## Requirements

- The Claude ACP adapter on PATH:
  `npm i -g @agentclientprotocol/claude-agent-acp`. On Windows npm installs a
  `claude-agent-acp.cmd` shim, which the plugin tries alongside the bare name.
  `ORA_CLAUDE_ACP_BIN` pins one exact binary instead, and is deliberately not
  backed by a PATH fallback — a pin that quietly ran a different adapter would
  be worse than failing.
- The `claude` CLI, authenticated — the adapter drives it.
- Deno, which Ora provides for plugin processes.

Ora launches agent plugins with
`--allow-run --allow-read --allow-env --allow-net`; this plugin needs all four
(spawn the adapter, resolve it, read `ORA_CLAUDE_ACP_BIN`, let Claude Code reach
the API).

The adapter takes no arguments and no subcommand: it reads its initial directory
from the spawn cwd, and every per-session directory arrives through ACP
`session/new`, which this plugin passes through.

## Installation and discovery

Ora discovers plugin packages as the direct children of
`<ORA_DATA_DIR>/plugins/`, so that directory must resolve to the folder holding
this package. On Windows, a junction keeps the packages in one place:

```powershell
cmd /c mklink /J "<ORA_DATA_DIR>\plugins" "%USERPROFILE%\.ora\plugins\installed"
```

Development runs (`task run:desktop`) set `ORA_DATA_DIR` to the repository's
`.data` directory, so the junction goes at `<repo>/.data/plugins`. A packaged
build uses Tauri's application data directory instead.

Every direct child of that directory must be a valid package: a folder without a
`package.json` is reported as a discovery issue.

### Identity and the built-in Claude CLI

This package claims `ora-space.claude`, the same identity Ora's built-in
`AgentCli::Claude` uses. That is deliberate — it is the id persisted in existing
sessions and the one the frontend already labels "Claude Code" — but it means
the two cannot both be live: `resolve_supervised_agents` offers built-in CLIs
first and drops any plugin claiming an identity already taken, logging
`ignoring an agent whose identity is already supervised`.

So until `Claude` is removed from `AgentCli::ALL` this plugin is discovered,
validated, and then shadowed. Removing that variant — the same step OpenCode
already went through — hands the agent to this package with no other change on
either side.

## Verification

`deno task simulate` runs `tests/host-simulator.ts`, which speaks Ora's binary
frame protocol to a freshly launched plugin process against the real adapter and
asserts every step rather than only printing it:

```
ok: register {"methods":["agent/start","agent/stop","agent/listModels"],"emits":["agent/acp"]}
ok: agent/start {"protocol":"acp","acpVersion":1}
ok: initialize @agentclientprotocol/claude-agent-acp protocolVersion 1
ok: session/new 04fc92d6-… models via ACP: ["default","sonnet","claude-fable-5[1m]","opus","haiku"]
ok: listModels [] (Claude publishes models through ACP only)
ok: agent/stop
plugin exited with code 0
ALL HOST SIMULATION CHECKS PASSED
```

`deno task check` type checks and `deno task lint` lints the same sources.

## Known limits

- `agent/start` receives the host's home directory as `cwd`; per-session working
  directories travel in ACP `session/new`, which this plugin passes through.
- When the adapter exits on its own the plugin logs it and lets the host observe
  a stalled connection; the contract has no `agent/exited` notification yet.
- Killing the adapter on `agent/stop` is best effort; Ora retains process-tree
  reaping.
