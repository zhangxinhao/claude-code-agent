# ora-space.claude

An Ora **agent plugin**: a Deno process that speaks Ora's binary JSON-RPC
protocol on stdio and bridges `claude-agent-acp` to Ora as an ACP pipe.
`README.md` describes what it does; this file records the constraints that are
easy to get wrong and expensive to rediscover. It follows the same shape as the
sibling `codeagent-agent/AGENTS.md` and `opencode-agent/AGENTS.md` — this
package used to lag them on an older SDK pin (`0.3.0`, no `HostProcesses`,
`waitForIdle`/`restart` Effect Surfaces, camelCase `agent/listModels`) until it
was migrated onto `0.9.0` to match; see the root `../AGENTS.md` for the general
rule this migration exists to satisfy.

## This is an agent plugin, and an agent plugin implements the whole SDK contract

**`kind = "agent"` in `orax.toml` is not a label — it is a contract, and a
partial implementation of it fails silently rather than loudly.** Ora validates
the registration handshake and then simply does not use what a plugin did not
declare. There is no warning, no log line, and no error surfaced to the user.

Every API the plugin SDK offers an agent must be served, not just the ones a
feature currently exercises:

| SDK surface                                                                                                                             | Where it is mounted                                     | What is lost by omitting it                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `agent/start` · `agent/stop`                                                                                                            | `handlers/lifecycle.ts`                                 | the agent cannot run at all — these are `abstract`, so this fails to compile |
| `agent/list_models`                                                                                                                     | `handlers/models.ts`                                    | no model picker; also `abstract`                                             |
| `agent/acp` (both directions)                                                                                                           | `handlers/acp.ts` + `services/claude-client.ts`         | no conversation; also `abstract`                                             |
| **Effect Resources** — `effect/coordinate`, `effect/reactivate`, `effect/verify_ready`, and the `EffectResourceDeclaration` behind them | `handlers/effects.ts`, mounted as `AgentPlugin.effects` | **Skills never appear in the Workspace, with no error anywhere**             |

The Effect row is the one that has actually shipped broken before, in the
sibling `codeagent-agent`. Read the next section before touching anything about
Skills.

## Effects are opt-in, and opting out is invisible

The Skill directory Ora writes into a Workspace exists **only** because this
plugin declares it. The chain is short and every link is a hard gate:

```
handlers/effects.ts  SKILLS_RESOURCE                    ← the declaration
main.ts              override readonly effects = …      ← mounted on the instance
base/agent-plugin.ts defineAgent({ …, effects })        ← handed to the SDK
SDK agent.ts         if (effects !== undefined) { declareEffectResource(…) }
SDK plugin.ts        effectResources omitted from ora/register when the list is empty
```

Miss **any** of those and `ora/register` goes out with no `effectResources`
field at all. From Ora's side this plugin does not consume Skills, so importing
one succeeds, Ora has no Target to project it onto, nothing is written to disk,
and no error is raised, logged, or shown anywhere.

**When a Skill does not appear, check the declaration before debugging
materialization.** The shipped bundle answers it in one command:

```
deno task build && grep -c skill dist/main.js
```

A `0` means the declaration never reached the package.

### What the coordination calls have to promise

Declaring a Resource is also a promise to make its mutation safe, and Ora will
call all three methods:

- **`coordinate`** must raise the new-turn barrier _before_ it waits for running
  turns, not after. A check that only latched on an observed idle moment would
  never find one in a Workspace whose prompts keep arriving; holding first makes
  the set of turns to drain finite, so the wait terminates. It must also release
  the barrier before failing — Ora only reactivates Targets whose coordination
  succeeded, so an abandoned barrier holds its queued prompts for the life of
  the process. The 10-second drain budget exists because Ora allows a plugin
  control call 30 seconds and coordination holds that call open; it must finish
  well inside that rather than wait out a prompt that may legitimately run for
  minutes.
- **`reactivate`** respawns the adapter. Restarting is deliberately chosen over
  modelling when Claude Code rereads its Skill directory: a restart is correct
  whether the adapter resolves Skills once at process start or per session.
- **`verify_ready`** reports readiness by **returning**; a Consumer says "not
  ready" by throwing. Returning a payload that says "not ready" would be
  recorded as ready.
- **Both coordination calls must be idempotent.** Ora retries them. The held
  frame queue is the marker: a repeat `reactivate` finds nothing held — the
  state a finished reactivation leaves behind — and must not restart an adapter
  that already rescanned, which would tear down the sessions that came back from
  the first restart.

`SKILLS_RESOURCE.workspaceRelativePath` is `.claude/skills` — the
project-relative directory Claude Code reads. Claude Code also reads a
user-level `~/.claude/skills` directory, and declaring that would be a mistake:
Ora fully owns what it materializes into a declared Resource, so it would
reconcile away Skills another tool put there.

## Resolving the adapter on Windows — always include `.bat`

**Every list of PATH spellings for the adapter must name `.exe`, `.cmd`, `.bat`,
and the bare name.** This has broken real installs more than once, always the
same way, and it is the single most important rule in this file after the one
above.

```ts
return Deno.build.os === "windows"
  ? [
    `${BINARY_NAME}.exe`,
    `${BINARY_NAME}.cmd`,
    `${BINARY_NAME}.bat`,
    BINARY_NAME,
  ]
  : [BINARY_NAME];
```

Why each part matters:

- **The host's PATH lookup only appends `.exe` to a bare name.** It does not try
  `.cmd` or `.bat`. So naming just `claude-agent-acp` finds nothing on a machine
  where the adapter is installed as a shim — which is what `npm i -g` actually
  writes on Windows.
- **Omitting a spelling is indistinguishable from "not installed".** The ladder
  inside `spawnAgentProcess` only advances on `program_not_found`, so a missing
  spelling exhausts the list and raises `AGENT_NOT_INSTALLED` (`-32001`).
- **That failure surfaces as something unrelated.** Ora deliberately suppresses
  the log for `AgentNotInstalled` (`connection.rs`, "would flood the runtime
  log"), then tears the plugin process down — so the only thing the user sees is
  `plugin stdout closed` from the plugin runtime's stdout reader. Nothing in
  that message mentions PATH, the adapter, or the spelling that was missed. **Do
  not spend time debugging the plugin when you see `plugin stdout closed`; check
  the candidate list first.**
- **The order here is Windows' own `PATHEXT` precedence.** `.exe` first means
  the process the host holds is the adapter itself rather than a `cmd.exe`
  wrapper around it, which matters when the host kills it.

Adding a spelling is free: only "this one is not on PATH" advances to the next
candidate, and a candidate that resolved and then failed is raised as-is rather
than being buried under the next attempt.

`ORA_CLAUDE_ACP_BIN` outranks the whole ladder and is used alone, never with a
fallback: silently running a different adapter than the one a developer named is
worse than failing.

## Process ownership

Every subprocess goes through the host: `createHostProcesses(plugin)` →
`ora/childprocess/spawn`. Never `Deno.Command`. The host owns the OS handle,
terminates process trees, and reclaims whatever a plugin generation left behind
— none of which a sandboxed plugin can promise, least of all through a Windows
shim whose real child outlives a kill of the wrapper.

`ClaudeClient` tracks generations: a process that is no longer `#running` was
superseded by a later `start()` — an Effect restart, typically — so its exit
must never clear the new process's tracking or fire `onExited`. The shared
`#expectedExit` flag reflects the newer generation's intent by then, which is
why the identity check comes first.

## Model discovery

`claude-agent-acp` is a pure ACP server: it takes no subcommand, and its
`initialize` result carries capabilities only. The model set appears exactly
once, as the `category: "model"` entry of the `configOptions` array in a
`session/new` result — `default`, `sonnet`, `opus`, `haiku`, `fable` as of this
writing.

`agent/list_models` receives the workspace `cwd` and answers it by running a
**separate, one-shot** `claude-agent-acp`, not by borrowing the connection Ora
holds:

- A request injected into Ora's connection returns its answer down Ora's pipe.
- Ora's own `initialize` declares the client capability that decides whether the
  adapter reports a model selector at all, and discovery runs before that.

The probe declares `clientCapabilities: { session: { configOptions: {} } }` —
without it the adapter reports no model selector. Answers are cached per
workspace for five minutes; a failure is never cached.

`session/delete` is sent only when `initialize` advertised the capability —
sending it unconditionally would earn a `method_not_found` on every discovery
and clean up nothing.

Note that `onStart` and `onStop` both invalidate the catalog for their `cwd`, so
a start/stop cycle around a picker opening makes the next open pay full price.

## Protocol hygiene

- **stdout is the binary protocol channel.** `protectProtocolStdout()` redirects
  every `console` method to stderr before any plugin code runs. A single
  `console.log` reaching stdout is read by the host as a corrupt frame and takes
  the plugin down.
- **ACP payloads are never parsed** on the bridge. Frames are re-framed between
  Ora's binary envelope and the adapter's NDJSON and otherwise passed through
  verbatim — this is also what lets Claude Code's ACP extensions (session modes,
  steering, its `_meta` capabilities) reach Ora without this plugin knowing they
  exist. `handlers/effects.ts` is the one exception, and a deliberately narrow
  one: it reads `method` and `id` off the envelope to track turns, and never
  looks at `params`.
- **Throw the right error code.** `AGENT_NOT_INSTALLED` (`-32001`) is retried
  quietly by Ora as expected local configuration; `AGENT_UNUSABLE` (`-32002`) is
  reported once and not retried; `-32000` is how an Effect Consumer says "not
  ready right now".

## Manifest

`orax.toml` is the manifest Ora reads. `package.json` is a legacy Ora manifest
that no release has ever read, and its `engines.ora` field held a plugin **SDK**
version in a **host** version field — do not fill it with an SDK number. If a
host requirement ever needs declaring, it goes in `orax.toml`:

```toml
[dependencies]
ora = ">= x.y.z"
```

Ora parses and validates that table today but does not yet enforce it.

## Working on this repository

- `deno task check` / `lint` / `format` / `test` / `simulate` / `build`.
- The SDK is imported from its published JSR package and pinned in `deno.json`;
  keep `deno.lock` synchronized when changing the SDK version — see the root
  `../AGENTS.md` before bumping it, since the Effect API and process-ownership
  API have changed shape across versions before.
- `deno task test` needs no CLI: discovery is exercised against a fake
  `HostProcesses` that scripts an ACP peer, and effect coordination against a
  `ClaudeClient` with a scripted `spawn`. `deno task simulate` needs a real
  `claude-agent-acp` on PATH (`npm i -g @agentclientprotocol/claude-agent-acp`).
- One test reads `src/main.ts` as text to assert the effect wiring is present.
  That is deliberate: the entrypoint calls `runAgentPlugin` at module scope, so
  importing it would start serving the host, and the wiring it guards is exactly
  the kind whose absence is invisible at runtime.
- Bump `orax.toml` `version` before handing someone a `.orax` to import.
  `install_local` refuses a version that is already installed and never retires
  older ones, so reusing a number silently leaves the old code running.
