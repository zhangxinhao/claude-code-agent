/**
 * Records the upstream chain one release is built from into `upstream.lock.json`.
 *
 * This is the only step that resolves anything off the network by name rather than by version, and
 * it is deliberately separate from packaging: a release must be able to rebuild the exact bytes it
 * shipped, which it cannot do if "which version" is answered again every time. Running it is how a
 * new adapter version enters the repository, whether a maintainer or a scheduled job does it.
 *
 * Usage:
 *   deno task sync                  # resolve whatever npm currently calls latest
 *   deno task sync --version 0.73.0 # pin one exact adapter version
 *   deno task sync --check          # report whether the lock is behind, changing nothing
 *
 * Exits 0 when the lock is already current and 20 when `--check` finds it behind, so a scheduled
 * job can branch on the code without parsing this output.
 */
import { parseArgs } from "@std/cli/parse-args";
import bundle from "../bundle.config.ts";
import {
  LOCK_PATH,
  readLock,
  resolveUpstream,
  type UpstreamLock,
  writeLock,
} from "./upstream.ts";

/** The exit code `--check` uses to say the lock is behind, distinct from any failure. */
const BEHIND = 20;

/** Reads the current lock, treating an absent one as "nothing pinned yet". */
async function currentLock(): Promise<UpstreamLock | undefined> {
  try {
    return await readLock();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: ["version"],
    boolean: ["check"],
  });
  const platforms = Object.values(bundle.targets).map((target) => target.npm);

  const before = await currentLock();
  const resolved = await resolveUpstream(
    bundle.adapter,
    flags.version ?? "latest",
    platforms,
  );

  // Compared as a whole rather than on the adapter version alone: upstream can republish the same
  // adapter against a different SDK patch, and a release that bundled a different CLI while
  // claiming the same version would be the hardest kind of difference to notice later.
  const unchanged = before !== undefined &&
    JSON.stringify(before) === JSON.stringify(resolved);

  const summary = `${resolved.adapter.name}@${resolved.adapter.version} ` +
    `(${resolved.agentSdk.name}@${resolved.agentSdk.version}, ` +
    `Claude Code ${resolved.agentSdk.claudeVersion})`;

  if (unchanged) {
    console.log(`${LOCK_PATH} is current: ${summary}`);
    return;
  }

  if (flags.check) {
    console.log(`${LOCK_PATH} is behind: ${summary}`);
    if (before !== undefined) {
      console.log(`  currently pinned: ${before.adapter.version}`);
    }
    Deno.exit(BEHIND);
  }

  await writeLock(resolved);
  console.log(`${LOCK_PATH} now pins ${summary}`);
  for (const [platform, entry] of Object.entries(resolved.platforms)) {
    console.log(`  ${platform}: ${entry.binary} ${entry.size} ${entry.sha256}`);
  }
}

if (import.meta.main) {
  await main();
}
