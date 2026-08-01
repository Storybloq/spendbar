#!/usr/bin/env node
/**
 * Install matrix — does the packed tarball still work once a package manager has had its way
 * with it?
 *
 * `npm pack` proves what we put in the box. This proves the box survives being opened, by npm,
 * pnpm, yarn and bun, whose layouts disagree about where a dependency's files end up. That
 * disagreement is the whole point: `src/resolve-ccusage.ts` resolves ccusage's native binary
 * from THE SHIM's module graph rather than from spendbar's, because under pnpm's strict store
 * and yarn's Plug'n'Play the two graphs are not the same. Until this script existed, that
 * argument was checked only by unit tests with injected resolvers — against a model of the
 * layouts rather than the layouts.
 *
 * Three things worth knowing before reading the assertions.
 *
 * 1. Yarn resolves ccusage into its GLOBAL cache, inside a zip:
 *    `~/.yarn/berry/cache/ccusage-npm-20.0.19-<hash>.zip/node_modules/ccusage/src/cli.js`.
 *    That is a correct install, so "the resolved path is under the install prefix" is the
 *    wrong assertion — it would fail a working setup. We assert package IDENTITY instead
 *    (name and version, read from the manifest beside whatever the resolver returned), which
 *    holds in every layout.
 *
 * 2. Under yarn PnP a real invocation works only when the PnP loader reaches the CHILD
 *    process, which means NODE_OPTIONS. spendbar spawns `node <shim>`, and with that shim
 *    inside a zip the child needs the loader to read it at all. `yarn spendbar` works for
 *    exactly this reason. Passing `--require .pnp.cjs` on the command line does NOT work,
 *    because argv flags do not propagate to children — measured, not assumed. Using
 *    NODE_OPTIONS is also what lets this script test yarn with no yarn on PATH.
 *
 * 3. "No npx fallback" is proven by canaries that never fire, not by npx being absent. An
 *    absent npx only shows that the path which happened to succeed did not need one.
 *
 * WHAT THIS SCRIPT DOES NOT CLAIM: offline. Nothing here isolates the network, so the word
 * would be unearned. The claim is narrower and actually tested — resolution and invocation
 * succeed against the locally installed pinned copy with no package manager and no `npx`
 * resolvable from the child; and on the missing-override, missing-shim and missing-native
 * paths, no PATH fallback fires.
 *
 * The general "there is no npx fallback anywhere" claim is NOT this script's to make. Three
 * failure paths are three samples. That claim is carried by the mutation-tested selection-rule
 * tests in tests-ts/resolve.test.mjs, which assert the rule rather than sampling it.
 *
 * Usage:
 *   node scripts/install-matrix.mjs [--tarball <path>] [--only npm,pnpm] [--keep] [--root <dir>]
 *
 * `--tarball` pins the artifact under test. Pass the SAME file to the packaging contract via
 * SPENDBAR_TARBALL, and to `npm publish --dry-run`, so that every step demonstrably inspects
 * the bytes every other step tested — two `npm pack` runs produce two different files. With no
 * `--tarball`, this packs one and prints its sha256 for exactly that purpose.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED = "20.0.19";
/** Pinned so a matrix that behaves differently next month can be told from a regression. */
const YARN = "yarn@4.5.3";
const BUN = "bun@1.3.14";
const PNPM = "pnpm@10.30.0";

/** Must NOT be resolvable from a positive run's child — asserted from inside that child. */
const FORBIDDEN_ON_PATH = ["npx", "npm", "pnpm", "yarn", "bun", "bunx", "ccusage"];

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const KEEP = argv.includes("--keep");
const ONLY = (flagValue("--only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

let failed = 0;
let passed = 0;

const log = (s = "") => process.stdout.write(s + "\n");

function sh(cmd, args, { cwd, env, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFail && r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`,
    );
  }
  return r;
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    log(`    ok    ${name}`);
  } catch (e) {
    failed += 1;
    const detail = String(e.message).split("\n").join("\n          ");
    log(`    FAIL  ${name}\n          ${detail}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --------------------------------------------------------------------- scratch + toolchain

/**
 * `--root` names a PARENT to work under, never the working directory itself.
 *
 * This script deletes its scratch tree on exit, so taking the supplied path as the scratch dir
 * would mean `--root .` recursively deleting the repository — a one-character mistake with no
 * undo. Creating an owned `mkdtemp` beneath the parent means the only thing that can ever be
 * removed is a directory this run made.
 */
const rootParent = flagValue("--root");
if (rootParent !== null) mkdirSync(resolve(rootParent), { recursive: true });
const root = mkdtempSync(join(rootParent === null ? tmpdir() : resolve(rootParent), "spendbar-matrix-"));

/**
 * A bin dir holding node and nothing else.
 *
 * The child PATH is this plus `/usr/bin:/bin`, and the system dirs are NOT a concession —
 * pnpm's `node_modules/.bin` entry is a shell script that calls `sed`, `dirname` and `uname`,
 * so a literally node-only PATH breaks pnpm's own shim before spendbar is ever reached, which
 * would be measuring pnpm rather than us.
 *
 * What keeps the "no package manager on PATH" claim honest is not this list — it is the probe,
 * which enumerates PATH from inside the child and fails if any of FORBIDDEN_ON_PATH is
 * reachable. On this machine the system dirs contain none of them; on a machine where they do,
 * the probe says so instead of the claim quietly becoming false.
 */
const NODE_ONLY_BIN = join(root, "node-only-bin");
rmSync(NODE_ONLY_BIN, { recursive: true, force: true });
mkdirSync(NODE_ONLY_BIN, { recursive: true });
symlinkSync(process.execPath, join(NODE_ONLY_BIN, "node"));
const CHILD_PATH = `${NODE_ONLY_BIN}:/usr/bin:/bin`;

/**
 * `npx` and `ccusage` that announce themselves and succeed. Success is the point: a fallback
 * that fired would be REWARDED, so a fallback cannot hide behind a failing canary.
 */
const CANARY_BIN = join(root, "canary-bin");
const CANARY_FILE = join(root, "canary-fired.log");
mkdirSync(CANARY_BIN, { recursive: true });
for (const name of ["npx", "ccusage", "bunx"]) {
  const p = join(CANARY_BIN, name);
  writeFileSync(p, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${CANARY_FILE}"\nexit 0\n`);
  chmodSync(p, 0o755);
}

function toolVersion(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : `(unavailable: ${r.error?.code ?? r.status})`;
}

// ------------------------------------------------------------------- the candidate artifact

let tarball = flagValue("--tarball");
if (tarball === null) {
  const out = sh("npm", ["pack", "--pack-destination", root], { cwd: REPO }).stdout;
  tarball = join(root, out.trim().split("\n").pop().trim());
} else {
  tarball = resolve(tarball);
}
assert(existsSync(tarball), `tarball not found: ${tarball}`);
const SHA256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");

log("spendbar install matrix");
log("=======================");
log("");
log("candidate artifact");
log(`  path    ${tarball}`);
log(`  sha256  ${SHA256}`);
log("");
log("toolchain (recorded, because a matrix that is re-runnable is not automatically");
log("reproducible — a different pnpm or corepack can change the layout under test)");
log(`  node      ${process.version}`);
log(`  platform  ${process.platform}-${process.arch}`);
log(`  npm       ${toolVersion("npm")}`);
log(`  corepack  ${toolVersion("corepack")}`);
log(`  pnpm      ${toolVersion("pnpm")}`);
log(`  yarn      ${toolVersion("yarn")}   (provisioned as ${YARN} when absent)`);
log(`  bun       ${toolVersion("bun")}   (provisioned as ${BUN} when absent)`);
log(`  registry  ${toolVersion("npm", ["config", "get", "registry"])}`);
log("");

// ------------------------------------------------------------------------------ provisioning

const COREPACK_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

/**
 * Resolve a package manager to an argv prefix, provisioning it if needed.
 *
 * Provisioning never touches the user's global environment: yarn and pnpm come through
 * corepack, bun into a scratch prefix. A manager that cannot be provisioned is a HARD ERROR,
 * not a skip — the same rule the parity harness uses. A silent skip here would read as "all
 * four managers pass" while proving three.
 */
function provision(name) {
  const onPath = spawnSync(name, ["--version"], { encoding: "utf8" });
  if (onPath.status === 0) return { argv: [name], how: `PATH (${onPath.stdout.trim()})` };

  if (name === "yarn" || name === "pnpm") {
    const spec = name === "yarn" ? YARN : PNPM;
    const r = spawnSync("corepack", [spec, "--version"], {
      encoding: "utf8",
      env: { ...process.env, ...COREPACK_ENV },
    });
    if (r.status !== 0) {
      throw new Error(
        `could not provision ${name} via corepack ${spec}. Corepack downloads on first use, ` +
          `so this usually means the registry is unreachable — which is a failure to report, ` +
          `not a manager to skip.\n${r.stdout}\n${r.stderr}`,
      );
    }
    return { argv: ["corepack", spec], how: `corepack ${spec} (${r.stdout.trim()})` };
  }

  if (name === "bun") {
    const tools = join(root, "tools");
    mkdirSync(tools, { recursive: true });
    const bin = join(tools, "node_modules", ".bin", "bun");
    if (!existsSync(bin)) {
      const r = spawnSync("npm", ["install", "--prefix", tools, "--no-save", "--no-audit",
        "--no-fund", BUN], { encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(
          `could not provision ${BUN} into ${tools}. If the registry is unreachable, say so — ` +
            `do not record bun as skipped.\n${r.stdout}\n${r.stderr}`,
        );
      }
    }
    const v = spawnSync(bin, ["--version"], { encoding: "utf8" });
    assert(v.status === 0, `provisioned bun is not runnable: ${v.stderr}`);
    return { argv: [bin], how: `scratch install ${BUN} (${v.stdout.trim()})` };
  }

  return { argv: [name], how: "PATH" };
}

// ------------------------------------------------------------------------------- the probe
//
// Runs INSIDE an installed prefix and reports what spendbar's own resolver found, plus which
// forbidden commands are reachable from this child. Reporting rather than asserting keeps the
// judgement in one place (the checks below) and makes a failure show its evidence.

const PROBE = `
import { createRequire } from "node:module";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveBundledCcusage, platformPackage, nativeBinarySubpath,
} from "spendbar/dist/resolve-ccusage.js";

function nearestManifest(start) {
  let dir = dirname(start);
  for (;;) {
    const p = join(dir, "package.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    const up = dirname(dir);
    if (up === dir) throw new Error("no package.json above " + start);
    dir = up;
  }
}

const r = resolveBundledCcusage();
const shim = r.prefixArgs[0];
const pkgName = platformPackage(process.platform, process.arch);
const native = createRequire(shim).resolve(pkgName + "/" + nativeBinarySubpath(process.platform));
const shimMan = nearestManifest(shim);
const nativeMan = nearestManifest(native);

const reachable = [];
for (const name of ${JSON.stringify(FORBIDDEN_ON_PATH)}) {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      reachable.push(join(dir, name));
    } catch {}
  }
}

console.log(JSON.stringify({
  exe: r.exe, shim, native,
  shimName: shimMan.name, shimVersion: shimMan.version,
  nativeName: nativeMan.name, nativeVersion: nativeMan.version,
  reachable,
}));
`;

// ------------------------------------------------------------------------------- the cases

/** Empty HOME so a real invocation is deterministic and touches nobody's actual logs. */
const EMPTY_HOME = join(root, "empty-home");
mkdirSync(EMPTY_HOME, { recursive: true });

function nodeOnlyEnv(extra = {}) {
  return { PATH: CHILD_PATH, HOME: EMPTY_HOME, ...extra };
}

/**
 * One package manager: install the candidate with lifecycle scripts disabled, then ask the
 * three positive questions. Returns nothing; records pass/fail per check.
 */
function runManager(name, { install, spendbar }) {
  log(`  ${name}`);
  const prefix = join(root, `prefix-${name}`);
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });

  install(prefix);

  // Lifecycle scripts were disabled on purpose: the tarball ships a built dist/, so nothing
  // may depend on `prepare` running on the consumer's machine. If it did, --help fails here.
  check(`${name}: spendbar --help exits 0 and prints its own usage line`, () => {
    const r = spendbar(prefix, ["--help"]);
    assert(r.status === 0, `exit ${r.status}\n${r.stderr}`);
    assert(r.stdout.startsWith("usage: spendbar [-h]"), `stdout began: ${r.stdout.slice(0, 80)}`);
  });

  check(`${name}: resolves ccusage@${PINNED} and its native package, by identity`, () => {
    writeFileSync(join(prefix, "probe.mjs"), PROBE);
    const r = spendbar(prefix, null, { probe: true });
    assert(r.status === 0, `probe exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    const info = JSON.parse(r.stdout.trim().split("\n").pop());
    assert(info.shimName === "ccusage", `shim package is ${info.shimName}`);
    assert(info.shimVersion === PINNED, `shim is ccusage@${info.shimVersion}, want ${PINNED}`);
    // BOTH halves of "identity". Asserting only the version let a wrong native package pass
    // as long as its version happened to match — which is exactly the case this check exists
    // for, since the native package is the platform-specific one.
    const wantNative = `@ccusage/ccusage-${process.platform}-${process.arch}`;
    assert(info.nativeName === wantNative,
      `native package is ${info.nativeName}, want ${wantNative}`);
    assert(info.nativeVersion === PINNED,
      `native ${info.nativeName} is @${info.nativeVersion}, want ${PINNED}`);
    assert(info.exe === process.execPath, `spawn exe is ${info.exe}, want ${process.execPath}`);
    // The claim in the header, checked rather than asserted in prose.
    assert(info.reachable.length === 0,
      `these were reachable from the child, which breaks the no-package-manager claim:\n` +
      info.reachable.join("\n"));
    log(`          shim   ${info.shim}`);
    log(`          native ${info.native}`);
  });

  check(`${name}: a real invocation succeeds with no package manager on PATH`, () => {
    const r = spendbar(prefix, ["alltime"]);
    assert(r.status === 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert(/No usage found for all time\./.test(r.stdout), `stdout was: ${r.stdout.slice(0, 200)}`);
  });

  return prefix;
}

// --- npm -------------------------------------------------------------------------------

function npmCase() {
  const pm = provision("npm");
  log(`  (npm via ${pm.how})`);
  return runManager("npm", {
    install(prefix) {
      sh("npm", ["init", "-y"], { cwd: prefix });
      sh("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", tarball],
        { cwd: prefix });
    },
    spendbar(prefix, args, opts = {}) {
      const env = nodeOnlyEnv();
      return opts.probe
        ? spawnSync(process.execPath, [join(prefix, "probe.mjs")], { cwd: prefix, env, encoding: "utf8" })
        : spawnSync(join(prefix, "node_modules", ".bin", "spendbar"), args,
            { cwd: prefix, env, encoding: "utf8" });
    },
  });
}

// --- pnpm ------------------------------------------------------------------------------

function pnpmCase() {
  const pm = provision("pnpm");
  log(`  (pnpm via ${pm.how})`);
  const [cmd, ...pre] = pm.argv;
  return runManager("pnpm", {
    install(prefix) {
      writeFileSync(join(prefix, "package.json"),
        JSON.stringify({ name: "mx-pnpm", version: "1.0.0", private: true }, null, 2));
      sh(cmd, [...pre, "add", "--ignore-scripts", tarball],
        { cwd: prefix, env: { ...process.env, ...COREPACK_ENV } });
    },
    spendbar(prefix, args, opts = {}) {
      const env = nodeOnlyEnv();
      return opts.probe
        ? spawnSync(process.execPath, [join(prefix, "probe.mjs")], { cwd: prefix, env, encoding: "utf8" })
        : spawnSync(join(prefix, "node_modules", ".bin", "spendbar"), args,
            { cwd: prefix, env, encoding: "utf8" });
    },
  });
}

// --- yarn (default Plug'n'Play, global cache) -------------------------------------------

function yarnCase() {
  const pm = provision("yarn");
  log(`  (yarn via ${pm.how} — default PnP, global cache)`);
  const [cmd, ...pre] = pm.argv;
  return runManager("yarn", {
    install(prefix) {
      writeFileSync(join(prefix, "package.json"),
        JSON.stringify({ name: "mx-yarn", version: "1.0.0", packageManager: YARN }, null, 2));
      sh(cmd, [...pre, "add", tarball], {
        cwd: prefix,
        // Yarn's spelling of --ignore-scripts.
        env: { ...process.env, ...COREPACK_ENV, YARN_ENABLE_SCRIPTS: "false" },
      });
      // PnP has no node_modules/.bin, so the entrypoint is a launcher the loader can see.
      writeFileSync(join(prefix, "run.mjs"), 'import "spendbar/dist/cli.js";\n');
    },
    spendbar(prefix, args, opts = {}) {
      // NODE_OPTIONS, not argv flags: the loader has to reach the ccusage child spendbar
      // spawns, and command-line flags do not propagate to children. This is also exactly
      // why `yarn spendbar` works — and it lets us test yarn with no yarn on PATH.
      const env = nodeOnlyEnv({
        NODE_OPTIONS: `--require ${join(prefix, ".pnp.cjs")} --loader ${join(prefix, ".pnp.loader.mjs")}`,
      });
      const entry = opts.probe ? "probe.mjs" : "run.mjs";
      return spawnSync(process.execPath, [join(prefix, entry), ...(args ?? [])],
        { cwd: prefix, env, encoding: "utf8" });
    },
  });
}

// --- bun --------------------------------------------------------------------------------

function bunCase() {
  const pm = provision("bun");
  log(`  (bun via ${pm.how})`);
  const [cmd, ...pre] = pm.argv;
  return runManager("bun", {
    install(prefix) {
      writeFileSync(join(prefix, "package.json"),
        JSON.stringify({ name: "mx-bun", version: "1.0.0", private: true }, null, 2));
      sh(cmd, [...pre, "add", "--ignore-scripts", tarball], { cwd: prefix });
    },
    spendbar(prefix, args, opts = {}) {
      const env = nodeOnlyEnv();
      return opts.probe
        ? spawnSync(process.execPath, [join(prefix, "probe.mjs")], { cwd: prefix, env, encoding: "utf8" })
        : spawnSync(join(prefix, "node_modules", ".bin", "spendbar"), args,
            { cwd: prefix, env, encoding: "utf8" });
    },
  });
}

// --- the documented flow: npm install -g -------------------------------------------------

function globalCase() {
  log("  npm -g (the flow the README actually documents)");
  const prefix = join(root, "prefix-global");
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  sh("npm", ["install", "-g", "--prefix", prefix, "--ignore-scripts", tarball]);
  const bin = join(prefix, "bin", "spendbar");

  check("npm -g: installs a runnable spendbar at <prefix>/bin/spendbar", () => {
    assert(existsSync(bin), `no executable at ${bin}`);
    const r = spawnSync(bin, ["--help"], { env: nodeOnlyEnv(), encoding: "utf8" });
    assert(r.status === 0, `exit ${r.status}\n${r.stderr}`);
    assert(r.stdout.startsWith("usage: spendbar [-h]"), r.stdout.slice(0, 80));
  });

  check("npm -g: a real invocation succeeds", () => {
    const r = spawnSync(bin, ["alltime"], { env: nodeOnlyEnv(), encoding: "utf8" });
    assert(r.status === 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert(/No usage found for all time\./.test(r.stdout), r.stdout.slice(0, 200));
  });
}

// --- the negatives -----------------------------------------------------------------------
//
// All three run under npm, and that is deliberate rather than lazy. Once CCUSAGE_CMD is set it
// bypasses package resolution and manager layout entirely, so repeating this under pnpm, yarn
// and bun would re-run identical bootstrap code and add no evidence. The four-manager matrix
// above exists for the POSITIVE checks, which is where layout actually differs.

/**
 * Lazy on purpose. Reading the canary file to BUILD the failure message evaluated it even when
 * the assertion passed — so the three negatives failed with ENOENT on the very file whose
 * absence was the thing being proven. A message that only exists when it is needed.
 */
function assertNoCanary(r) {
  if (!r.canaryFired) return;
  throw new Error(`a canary FIRED:\n${readFileSync(CANARY_FILE, "utf8")}`);
}

function canaryRun(bin, args, extraEnv) {
  rmSync(CANARY_FILE, { force: true });
  const env = { PATH: `${CANARY_BIN}:${CHILD_PATH}`, HOME: EMPTY_HOME, ...extraEnv };
  const r = spawnSync(bin, args, { env, encoding: "utf8" });
  return { ...r, canaryFired: existsSync(CANARY_FILE) };
}

function negatives(npmPrefix) {
  log("  negatives (npm only — see the comment above; scope is stated, not implied)");
  const bin = join(npmPrefix, "node_modules", ".bin", "spendbar");

  check("N1 override path: a missing CCUSAGE_CMD fails closed, and npx never fires", () => {
    const r = canaryRun(bin, ["alltime"], { CCUSAGE_CMD: "spendbar-no-such-ccusage-exists" });
    assert(r.status !== 0, `expected a non-zero exit, got ${r.status}\n${r.stdout}`);
    assert(/not found/.test(r.stderr), `stderr was: ${r.stderr.slice(0, 200)}`);
    assertNoCanary(r);
  });

  check("N2 bundled path, missing shim: fails closed, and npx never fires", () => {
    const mod = join(npmPrefix, "node_modules", "ccusage");
    const hidden = `${mod}-hidden`;
    renameSync(mod, hidden);
    try {
      const r = canaryRun(bin, ["alltime"], {});
      assert(r.status !== 0, `expected a non-zero exit, got ${r.status}\n${r.stdout}`);
      assert(/could not find the bundled ccusage/.test(r.stderr), `stderr: ${r.stderr.slice(0, 200)}`);
      assertNoCanary(r);
    } finally {
      renameSync(hidden, mod);
    }
  });

  check("N3 bundled path, missing native package: fails closed, and npx never fires", () => {
    // --omit=optional is the real-world shape of this: ccusage delivers its binary through
    // optionalDependencies, so this is the install a restricted mirror or a deliberate
    // --omit=optional produces. It is what proves the preflight is load-bearing.
    const prefix = join(root, "prefix-npm-no-optional");
    rmSync(prefix, { recursive: true, force: true });
    mkdirSync(prefix, { recursive: true });
    sh("npm", ["init", "-y"], { cwd: prefix });
    sh("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts",
      "--omit=optional", tarball], { cwd: prefix });
    const r = canaryRun(join(prefix, "node_modules", ".bin", "spendbar"), ["alltime"], {});
    assert(r.status !== 0, `expected a non-zero exit, got ${r.status}\n${r.stdout}`);
    assert(/platform binary/.test(r.stderr), `stderr: ${r.stderr.slice(0, 300)}`);
    assertNoCanary(r);
  });
}

// ------------------------------------------------------------------------------------ main

const MANAGERS = { npm: npmCase, pnpm: pnpmCase, yarn: yarnCase, bun: bunCase };
const selected = ONLY.length ? ONLY : Object.keys(MANAGERS);

log("layout matrix (positive checks, one prefix per manager, lifecycle scripts disabled)");
const prefixes = {};
for (const name of selected) {
  const fn = MANAGERS[name];
  if (!fn) {
    log(`  ${name}: unknown manager`);
    failed += 1;
    continue;
  }
  try {
    prefixes[name] = fn();
  } catch (e) {
    failed += 1;
    log(`  ${name}: SETUP FAILED\n    ${String(e.message).split("\n").join("\n    ")}`);
  }
}
log("");

if (selected.includes("npm")) {
  log("documented install flow");
  try {
    globalCase();
  } catch (e) {
    failed += 1;
    log(`  npm -g: SETUP FAILED\n    ${String(e.message).split("\n").join("\n    ")}`);
  }
  log("");

  if (prefixes.npm) {
    try {
      negatives(prefixes.npm);
    } catch (e) {
      failed += 1;
      log(`  negatives: SETUP FAILED\n    ${String(e.message).split("\n").join("\n    ")}`);
    }
  } else {
    failed += 1;
    log("  negatives: SKIPPED because the npm prefix failed to build — reported as a failure,");
    log("  because a skipped negative that reads as a pass is worse than no negative at all.");
  }
  log("");
}

log(`${passed} passed, ${failed} failed`);
log(`candidate sha256: ${SHA256}`);
if (KEEP) log(`scratch kept at ${root}`);
else rmSync(root, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
