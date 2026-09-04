/**
 * The one place that decides where this package's two bundled binaries live.
 *
 * Three callers have to agree on these paths, and a disagreement between any of them only ever
 * surfaces as an install that cannot start its agent: `command.ts` asks the host to spawn the
 * adapter at one of them, `scripts/adapter-entry.mjs` looks for the native CLI beside itself at
 * the other, and `scripts/package.ts` stages both. So all three derive the paths from here rather
 * than each spelling them out.
 */

/** Directory inside the package that holds both bundled binaries. */
export const BUNDLED_BIN_DIR = "assets/bin";

/** Operating systems a package can be built for, as `Deno.build.os` spells them. */
export type TargetOs = typeof Deno.build.os;

/**
 * Names one bundled binary for a target operating system.
 *
 * Windows decides executability by extension at spawn time, so the suffix is not cosmetic: an
 * extension-less binary there exists but cannot be started.
 */
function binaryName(stem: string, os: TargetOs): string {
  return os === "windows" ? `${stem}.exe` : stem;
}

/**
 * Package-relative path of the bundled ACP adapter, which is what the host spawns.
 *
 * This is `claude-agent-acp` compiled to a single file, not the npm package: the published
 * adapter is a Node program, and a package that shipped it as JavaScript would need a Node on the
 * user's machine to run it — the exact dependency bundling exists to remove.
 */
export function bundledAdapterPath(os: TargetOs = Deno.build.os): string {
  return `${BUNDLED_BIN_DIR}/${binaryName("claude-agent-acp", os)}`;
}

/**
 * Package-relative path of the bundled Claude Code CLI, which the adapter spawns in turn.
 *
 * Nothing in this plugin ever spawns it: it is named here only so the packaging script stages it
 * where `scripts/adapter-entry.mjs` looks, which is beside the adapter binary. The two are the
 * pair upstream publishes together — the adapter's own `package.json` pins the Claude Agent SDK
 * version that names this exact CLI build — and they are staged together so a package can never
 * carry a combination upstream has not shipped.
 */
export function bundledClaudePath(os: TargetOs = Deno.build.os): string {
  return `${BUNDLED_BIN_DIR}/${binaryName("claude", os)}`;
}
