import type { BundleConfig } from "./scripts/package.ts";
import {
  bundledAdapterPath,
  bundledClaudePath,
} from "./src/services/bundled-binary.ts";

/**
 * Declares what this plugin bundles and which targets it is published for.
 *
 * This is the plugin-specific half of the release pipeline: `scripts/sync-upstream.ts` and
 * `scripts/package.ts` know nothing about Claude Code beyond what is stated here.
 *
 * Every entry in `targets` produces one `.orax`, and a target absent here is simply not published,
 * because Ora refuses to install a package built for another triple. The set is bounded by what
 * the adapter can be compiled for rather than by what Claude Code ships: the native CLI is
 * published for eight platforms, Bun cross-compiles to five of them, and `windows-arm64` — which
 * Claude Code does ship — has no Bun target at all.
 *
 * The three names in each entry are three spellings of one platform that no single tool agrees
 * on, which is exactly why they are written down together rather than derived: `triple` is what
 * Ora matches a package against, `npm` is how the Claude Agent SDK names its per-platform
 * package, and `bun` is what `bun build --compile` takes.
 */
export default {
  adapter: "@agentclientprotocol/claude-agent-acp",
  targets: {
    "x86_64-pc-windows-msvc": {
      os: "windows",
      npm: "win32-x64",
      bun: "bun-windows-x64",
    },
    "aarch64-apple-darwin": {
      os: "darwin",
      npm: "darwin-arm64",
      bun: "bun-darwin-arm64",
    },
    "x86_64-unknown-linux-gnu": {
      os: "linux",
      npm: "linux-x64",
      bun: "bun-linux-x64",
    },
  },
  adapterPath: bundledAdapterPath,
  claudePath: bundledClaudePath,
} satisfies BundleConfig;
