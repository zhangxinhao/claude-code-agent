/**
 * Everything the release pipeline knows about the upstream packages it bundles.
 *
 * One fact is chosen — which version of the ACP adapter to ship — and every other version in a
 * release is derived from it rather than configured: the adapter's own `package.json` pins an
 * exact Claude Agent SDK version, and that SDK ships a manifest naming the exact Claude Code CLI
 * build it was published against, per platform, with a checksum. Reproducing that chain is what
 * keeps a package from ever carrying a pair upstream never tested.
 *
 * The result is written to `upstream.lock.json`, which is the only thing packaging reads.
 * Resolution happens when the lock is written and never at package time, so rebuilding a tag
 * produces the same bytes and a bump arrives as a reviewable diff.
 */
import { crypto } from "@std/crypto";
import { encodeBase64, encodeHex } from "@std/encoding";
import { UntarStream } from "@std/tar";
import { dirname } from "@std/path";

/** The npm package that publishes the Claude Agent SDK, and with it the native CLI. */
export const AGENT_SDK = "@anthropic-ai/claude-agent-sdk";

/** Where the resolved chain is recorded, relative to this plugin's directory. */
export const LOCK_PATH = "upstream.lock.json";

/** One npm package this release pins, and the digest that proves a download is that package. */
export interface PinnedPackage {
  name: string;
  version: string;
  /** npm's own `dist.integrity`, in its `sha512-<base64>` spelling. */
  integrity: string;
  tarball: string;
}

/** One platform's native Claude Code CLI, as the Claude Agent SDK's manifest describes it. */
export interface PinnedPlatform extends PinnedPackage {
  /** File name inside the package, which is also the name it is staged under. */
  binary: string;
  size: number;
  /** Lowercase hex SHA-256, taken from the SDK's own manifest rather than from a download. */
  sha256: string;
}

/** Every upstream fact one release is built from. */
export interface UpstreamLock {
  adapter: PinnedPackage;
  agentSdk: PinnedPackage & { claudeVersion: string };
  /**
   * Keyed by the SDK's own platform spelling (`win32-x64`), which `bundle.config.ts` maps target
   * triples onto.
   */
  platforms: Record<string, PinnedPlatform>;
}

/** Reads the lock, failing loudly rather than letting a build invent versions of its own. */
export async function readLock(path = LOCK_PATH): Promise<UpstreamLock> {
  return JSON.parse(await Deno.readTextFile(path)) as UpstreamLock;
}

/** Writes the lock in the one formatting a diff should never show noise from. */
export async function writeLock(
  lock: UpstreamLock,
  path = LOCK_PATH,
): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Resolves the whole dependency chain from one adapter version.
 *
 * `platforms` is limited to the ones asked for: resolving all eight would record versions for
 * targets this plugin does not publish, and a lock entry nothing builds is a fact nobody checks.
 */
export async function resolveUpstream(
  adapterName: string,
  requestedVersion: string,
  platforms: readonly string[],
): Promise<UpstreamLock> {
  const adapterMeta = await fetchPackageVersion(adapterName, requestedVersion);
  const sdkVersion = adapterMeta.dependencies?.[AGENT_SDK];
  if (sdkVersion === undefined) {
    throw new Error(`${adapterName} does not depend on ${AGENT_SDK}`);
  }
  // The adapter pins the SDK exactly rather than by range, which is what makes the pairing
  // reproducible at all. A range would mean the CLI a user ends up with depends on the day their
  // package happened to be built, so it is refused here rather than silently resolved.
  if (!/^\d+\.\d+\.\d+$/.test(sdkVersion)) {
    throw new Error(
      `${adapterName}@${adapterMeta.version} depends on ${AGENT_SDK}@${sdkVersion}, which is a ` +
        `range rather than an exact version; the CLI it pairs with is no longer knowable here`,
    );
  }
  const sdkMeta = await fetchPackageVersion(AGENT_SDK, sdkVersion);
  const manifest = await readSdkManifest(sdkMeta);

  const resolved: Record<string, PinnedPlatform> = {};
  for (const platform of platforms) {
    const entry = manifest.platforms[platform];
    if (entry === undefined) {
      throw new Error(
        `${AGENT_SDK}@${sdkVersion} ships no Claude Code CLI for ${platform}`,
      );
    }
    const platformMeta = await fetchPackageVersion(
      `${AGENT_SDK}-${platform}`,
      sdkVersion,
    );
    resolved[platform] = {
      name: platformMeta.name,
      version: platformMeta.version,
      integrity: platformMeta.dist.integrity,
      tarball: platformMeta.dist.tarball,
      binary: entry.binary,
      size: entry.size,
      sha256: entry.checksum,
    };
  }

  return {
    adapter: {
      name: adapterMeta.name,
      version: adapterMeta.version,
      integrity: adapterMeta.dist.integrity,
      tarball: adapterMeta.dist.tarball,
    },
    agentSdk: {
      name: sdkMeta.name,
      version: sdkMeta.version,
      integrity: sdkMeta.dist.integrity,
      tarball: sdkMeta.dist.tarball,
      claudeVersion: manifest.version,
    },
    platforms: resolved,
  };
}

/** One npm version document, narrowed to the fields this pipeline reads. */
interface VersionMeta {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  dist: { tarball: string; integrity: string };
}

/** The table the Claude Agent SDK ships describing the CLI build it was published against. */
interface SdkManifest {
  /** The Claude Code version, which is not the SDK's own version. */
  version: string;
  platforms: Record<string, { binary: string; size: number; checksum: string }>;
}

/** Reads one version document off the registry; `latest` resolves that dist-tag. */
export async function fetchPackageVersion(
  name: string,
  version: string,
): Promise<VersionMeta> {
  const url = `https://registry.npmjs.org/${name}/${version}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return await response.json() as VersionMeta;
}

/**
 * Reads the CLI manifest out of the Claude Agent SDK package.
 *
 * The manifest is the SDK's own record of the CLI build it was published against, and the
 * authority for that CLI's name, size and digest on every platform — which is what makes it worth
 * downloading a package here only to read one file out of it.
 */
async function readSdkManifest(meta: VersionMeta): Promise<SdkManifest> {
  const archive = await Deno.makeTempFile({ suffix: ".tgz" });
  try {
    await downloadVerified(meta.dist.tarball, meta.dist.integrity, archive);
    const manifest = await Deno.makeTempFile({ suffix: ".json" });
    try {
      await extractTarEntry(archive, "package/manifest.json", manifest);
      return JSON.parse(await Deno.readTextFile(manifest)) as SdkManifest;
    } finally {
      await Deno.remove(manifest).catch(() => {});
    }
  } finally {
    await Deno.remove(archive).catch(() => {});
  }
}

/**
 * Downloads one npm tarball and refuses it unless it hashes to what the registry published.
 *
 * The bytes are hashed while they stream to disk rather than afterwards: these archives run to
 * hundreds of megabytes, and reading one back to digest it would double both the I/O and the
 * memory a release job needs.
 */
export async function downloadVerified(
  url: string,
  integrity: string,
  destination: string,
): Promise<void> {
  const separator = integrity.indexOf("-");
  const algorithm = integrity.slice(0, separator);
  const expected = integrity.slice(separator + 1);
  if (algorithm !== "sha512" && algorithm !== "sha256") {
    throw new Error(`unsupported integrity algorithm in ${integrity}`);
  }
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url} answered ${response.status}`);
  }
  await Deno.mkdir(dirname(destination), { recursive: true });
  const file = await Deno.create(destination);
  const [toDisk, toDigest] = response.body.tee();
  const written = toDisk.pipeTo(file.writable);
  const digest = await crypto.subtle.digest(
    algorithm === "sha512" ? "SHA-512" : "SHA-256",
    toDigest,
  );
  await written;
  const actual = encodeBase64(new Uint8Array(digest));
  if (actual !== expected) {
    await Deno.remove(destination).catch(() => {});
    throw new Error(
      `${url} does not match its published integrity: expected ${integrity}, ` +
        `got ${algorithm}-${actual}`,
    );
  }
}

/** Writes the one file named `entry` out of a gzipped tar to `destination`. */
export async function extractTarEntry(
  archive: string,
  entry: string,
  destination: string,
): Promise<void> {
  await Deno.mkdir(dirname(destination), { recursive: true });
  const stream = (await Deno.open(archive)).readable
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new UntarStream());
  for await (const item of stream) {
    if (item.path !== entry || item.readable === undefined) {
      await item.readable?.cancel();
      continue;
    }
    await item.readable.pipeTo((await Deno.create(destination)).writable);
    return;
  }
  throw new Error(`${archive} does not contain ${entry}`);
}

/** Returns the lowercase hex SHA-256 of one file, streaming it rather than reading it whole. */
export async function sha256File(path: string): Promise<string> {
  const file = await Deno.open(path);
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", file.readable)),
  );
}
