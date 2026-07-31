/**
 * Locating the ccusage binary — a supply-chain boundary, so it FAILS CLOSED.
 *
 * There is deliberately no `npx` fallback. Fetching and executing registry code at run time
 * would happen precisely when the trusted local install is broken (damaged install, custom
 * registry, mirror, compromised token) — the worst possible moment, and pinning a version
 * does not make it safe. If the dependency cannot be resolved we say so and stop.
 *
 * ccusage@20 ships `bin: {ccusage: "./src/cli.js"}` — a JS shim — with the real Rust binary
 * delivered through per-platform **optionalDependencies**. That matters more than it looks:
 * `npm install --omit=optional`, a restricted mirror, or an unsupported platform all leave a
 * shim that spawns fine and then dies loading its platform package. Nothing surfaces as a
 * spawn-level ENOENT, so the failure would otherwise arrive as a stack trace buried inside
 * `ccusage failed: …`. We therefore verify the NATIVE BINARY — the same specifier the shim
 * itself resolves — BEFORE invoking anything.
 */
import { createRequire } from "node:module";
import { UsageError } from "./errors.js";

/** The exact version pinned in package.json `dependencies`. */
export const PINNED_CCUSAGE_VERSION = "20.0.19";

/**
 * Platform packages ccusage publishes. Kept as an explicit table rather than blind
 * interpolation so an unsupported platform produces a clear refusal instead of a
 * confusing module-not-found, and so the mapping is unit-testable on any host.
 */
export const PLATFORM_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "@ccusage/ccusage-darwin-arm64",
  "darwin-x64": "@ccusage/ccusage-darwin-x64",
  "linux-arm64": "@ccusage/ccusage-linux-arm64",
  "linux-x64": "@ccusage/ccusage-linux-x64",
  "win32-arm64": "@ccusage/ccusage-win32-arm64",
  "win32-x64": "@ccusage/ccusage-win32-x64",
});

/** Package name for a platform/arch pair, or null when ccusage publishes none. */
export function platformPackage(platform: string, arch: string): string | null {
  return PLATFORM_PACKAGES[`${platform}-${arch}`] ?? null;
}

/**
 * Subpath of the native executable inside its platform package.
 *
 * This mirrors `getNativeBinarySubpath` in ccusage's own shim (node_modules/ccusage/src/cli.js),
 * which resolves `${pkg}/bin/ccusage` — verified by reading it. Checking the package's
 * `package.json` instead, as this did before code review R1, verifies a DIFFERENT file than
 * the one that must exist: a package whose manifest is present but whose binary is missing
 * passed our preflight and then died inside the shim, which is precisely the failure the
 * preflight claims to prevent.
 */
export function nativeBinarySubpath(platform: string): string {
  return platform === "win32" ? "bin/ccusage.exe" : "bin/ccusage";
}

export interface Resolved {
  /** Executable to spawn — always the current Node, never a PATH lookup or shebang. */
  exe: string;
  /** Argv prefix (the resolved shim path). */
  prefixArgs: string[];
}

export interface ResolveOptions {
  platform?: string;
  arch?: string;
  /** Injected for tests; defaults to resolution relative to this module. Finds the shim. */
  resolve?: (specifier: string) => string;
  /**
   * Injected for tests; defaults to resolution relative to `from`. Finds the native binary
   * in the SHIM's module graph rather than ours — see the note in `resolveBundledCcusage`.
   */
  resolveFrom?: (from: string, specifier: string) => string;
}

/**
 * Resolve the bundled ccusage. Throws `UsageError` — never returns a degraded result.
 *
 * Spawns via `process.execPath` rather than the shim's shebang or a PATH lookup, so the
 * result does not depend on how the consumer's PATH is configured.
 */
export function resolveBundledCcusage(opts: ResolveOptions = {}): Resolved {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const req = opts.resolve ?? createRequire(import.meta.url).resolve;
  const reqFrom = opts.resolveFrom ?? ((from: string, spec: string) => createRequire(from).resolve(spec));

  const pkg = platformPackage(platform, arch);
  if (pkg === null) {
    throw new UsageError(
      `ccusage does not publish a binary for ${platform}-${arch}. ` +
        `Supported: ${Object.keys(PLATFORM_PACKAGES).sort().join(", ")}. ` +
        `Install ccusage yourself and set CCUSAGE_CMD to point at it.`,
    );
  }

  // The shim FIRST, because it is also where the binary must be resolved FROM (below).
  let shim: string;
  try {
    shim = req("ccusage/src/cli.js");
  } catch {
    throw new UsageError(
      `could not find the bundled ccusage. Reinstall spendbar's dependencies, or set ` +
        `CCUSAGE_CMD to a ccusage command you provide.`,
    );
  }

  // Verify the platform package: the shim would otherwise spawn successfully and fail later,
  // turning a plain install problem into an opaque subprocess error.
  //
  // Resolved FROM THE SHIM, not from this module (code review R5). The platform packages are
  // optionalDependencies of `ccusage`, not of spendbar, so the two module graphs are only
  // the same under npm's flat hoisting. Under pnpm's strict layout (or Yarn PnP) they live
  // beside the shim inside `.pnpm/ccusage@…/node_modules/@ccusage/…` and are invisible from
  // here — this preflight would report a missing binary the shim resolves perfectly well,
  // refusing a working install. `createRequire(shim)` reproduces the shim's own graph
  // exactly (verified: node_modules/ccusage/src/cli.js:9 builds its require the same way),
  // so a pass here means the shim will find it too.
  try {
    reqFrom(shim, `${pkg}/${nativeBinarySubpath(platform)}`);
  } catch {
    throw new UsageError(
      `ccusage is installed but its platform binary '${pkg}/${nativeBinarySubpath(platform)}' ` +
        `is missing. ` +
        `This happens with 'npm install --omit=optional' or a registry that does not serve ` +
        `optional dependencies. Reinstall including optional dependencies, or set ` +
        `CCUSAGE_CMD to a ccusage you provide.`,
    );
  }

  return { exe: process.execPath, prefixArgs: [shim] };
}
