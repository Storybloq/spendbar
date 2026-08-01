// Resolver + the static pin gate.
//
// These run in the DEFAULT suite on purpose: the binary-dependent contract test cannot run
// everywhere, so a version bump must trip something that can. The mapping is a pure
// function, which is what makes every platform testable from one host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { UsageError } from "../dist/errors.js";
import { createDeps } from "../dist/context.js";
import { runCcusage } from "../dist/ccusage.js";
import { bootstrapDeps } from "../dist/main-deps.js";
import {
  PINNED_CCUSAGE_VERSION,
  PLATFORM_PACKAGES,
  platformPackage,
  nativeBinarySubpath,
  resolveBundledCcusage,
} from "../dist/resolve-ccusage.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// --- the pin gate -----------------------------------------------------------------

test("PINNED_CCUSAGE_VERSION matches package.json dependencies", () => {
  assert.equal(
    pkg.dependencies?.ccusage,
    PINNED_CCUSAGE_VERSION,
    "bumping the dependency requires updating PINNED_CCUSAGE_VERSION and re-running " +
      "`npm run test:contract` against the new binary",
  );
});

test("ccusage is pinned exactly, with no range operator", () => {
  assert.match(pkg.dependencies.ccusage, /^\d+\.\d+\.\d+$/, "must be exact — no ^ or ~");
});

test("the installed ccusage is the pinned version", () => {
  const installed = JSON.parse(
    readFileSync(join(ROOT, "node_modules/ccusage/package.json"), "utf8"),
  );
  assert.equal(installed.version, PINNED_CCUSAGE_VERSION);
});

test("this host's platform package is installed and matches the wrapper version", () => {
  // Iterating node_modules/@ccusage alone passed vacuously when that directory existed but
  // was empty, and never checked that the package THIS host needs is present (code review
  // R1). Resolve the expected one explicitly first.
  const expected = platformPackage(process.platform, process.arch);
  assert.ok(expected, `no ccusage binary for ${process.platform}-${process.arch}`);

  // Resolved through the SHIM's module graph, not by reading a top-level
  // `node_modules/@ccusage/...` path (code review R7). That path only exists under npm's
  // flat hoisting — and assuming it here would contradict the very reason the resolver was
  // changed in R5: under pnpm's strict layout or Yarn PnP the platform package lives beside
  // the shim, where the shim (and the preflight) find it perfectly well while a top-level
  // read throws ENOENT. The test would then fail on a completely valid install.
  const shim = createRequire(import.meta.url).resolve("ccusage/src/cli.js");
  const fromShim = createRequire(shim);
  const own = JSON.parse(readFileSync(fromShim.resolve(`${expected}/package.json`), "utf8"));
  assert.equal(own.version, PINNED_CCUSAGE_VERSION, `${expected} must match the wrapper`);

  // The binary itself, not just the manifest — the R1 finding that a manifest-present /
  // binary-missing install must not pass.
  assert.doesNotThrow(
    () => fromShim.resolve(`${expected}/${nativeBinarySubpath(process.platform)}`),
    `${expected} must ship the native binary the shim loads`,
  );
});

// The preflight must check the file the SHIM loads. ccusage's own cli.js resolves
// `${pkg}/bin/ccusage` (bin/ccusage.exe on win32); checking `${pkg}/package.json` verified a
// different file, so a package with a manifest but no binary sailed through the check that
// exists to catch exactly that (code review R1).
test("the preflight resolves the same specifier ccusage's shim does", () => {
  assert.equal(nativeBinarySubpath("darwin"), "bin/ccusage");
  assert.equal(nativeBinarySubpath("linux"), "bin/ccusage");
  assert.equal(nativeBinarySubpath("win32"), "bin/ccusage.exe");

  const shim = readFileSync(join(ROOT, "node_modules/ccusage/src/cli.js"), "utf8");
  assert.match(shim, /'bin\/ccusage\.exe'\s*:\s*'bin\/ccusage'/, "shim subpaths changed — re-verify");

  // A manifest that resolves while the binary does not must still be refused.
  const resolve = (spec) => {
    if (spec.endsWith("/package.json")) return "/fake/pkg/package.json";
    return "/fake/ccusage/src/cli.js";
  };
  const resolveFrom = (_from, spec) => {
    if (spec.includes("bin/ccusage")) throw new Error("MODULE_NOT_FOUND");
    return "/fake/bin";
  };
  assert.throws(
    () => resolveBundledCcusage({ platform: "linux", arch: "x64", resolve, resolveFrom }),
    (e) => e instanceof UsageError && /bin\/ccusage' is missing/.test(e.message),
  );
});

// Matching the SPECIFIER is not enough — the resolution BASE has to match too (code review
// R5). The platform packages are optionalDependencies of `ccusage`, not of spendbar, so
// under npm's flat hoisting both graphs happen to agree, but under pnpm's strict layout or
// Yarn PnP they do not: the binary lives beside the shim and is invisible from this module.
// Resolving from here would then refuse an install the shim handles perfectly well.
//
// The previous test could not see this: one injected callback served both lookups, so the
// base was unobservable and a regression to `createRequire(import.meta.url)` stayed green.
test("the native binary is resolved FROM the shim, not from this module", () => {
  const SHIM = "/pnpm/.store/ccusage@20.0.19/node_modules/ccusage/src/cli.js";
  const bases = [];
  const r = resolveBundledCcusage({
    platform: "linux",
    arch: "x64",
    resolve: () => SHIM,
    resolveFrom: (from, spec) => {
      bases.push([from, spec]);
      return `${from}/../@ccusage/${spec}`;
    },
  });
  assert.deepEqual(
    bases,
    [[SHIM, "@ccusage/ccusage-linux-x64/bin/ccusage"]],
    "the native binary must be resolved exactly once, relative to the resolved shim",
  );
  assert.deepEqual(r.prefixArgs, [SHIM]);

  // And the production default really is the shim-rooted require: the host's own platform
  // binary must be resolvable from the resolved shim path. Under this repo's flat npm
  // layout it is resolvable from here too, so this cannot distinguish the two bases on its
  // own — that is precisely what the injected-base assertion above is for.
  const real = resolveBundledCcusage();
  const own = platformPackage(process.platform, process.arch);
  assert.doesNotThrow(
    () => createRequire(real.prefixArgs[0]).resolve(`${own}/${nativeBinarySubpath(process.platform)}`),
    `the shim at ${real.prefixArgs[0]} must resolve ${own}`,
  );
});

// --- no runtime code acquisition ---------------------------------------------------

// THE load-bearing guarantee. The source scan below is a lint, not a proof; this is the
// behavioural assertion: when the bundled dependency cannot be resolved and no CCUSAGE_CMD
// is set, bootstrap must THROW rather than reach for any fallback (code review R1).
test("bootstrap fails closed when the bundled dependency cannot be resolved", () => {
  // A broken install must throw, not degrade. An unpublished platform reaches the same
  // fail-closed path without needing to damage node_modules.
  assert.throws(
    () => resolveBundledCcusage({ platform: "freebsd", arch: "x64" }),
    (e) => e instanceof UsageError,
  );
  // Resolution failing must also mean no command gets invented downstream: with no
  // CCUSAGE_CMD and no injected override, createDeps refuses rather than defaulting.
  assert.throws(
    () => createDeps({}, "/h", () => ({ status: 0, stdout: "{}", stderr: "" })),
    (e) => e instanceof UsageError && /no ccusage command available/.test(e.message),
  );

  // ...and BOOTSTRAP itself must propagate that failure. The two assertions above exercise
  // resolveBundledCcusage and createDeps separately, so a regression where bootstrapDeps
  // caught the resolver's throw and invented a fallback command would leave them both green
  // — the test would keep its name while guaranteeing nothing (code review R5).
  let calls = 0;
  const broken = () => {
    calls += 1;
    throw new UsageError("broken install");
  };
  assert.throws(
    () => bootstrapDeps({}, {}, { resolve: broken }),
    (e) => e instanceof UsageError && /broken install/.test(e.message),
    "a resolver failure must escape bootstrapDeps, not be swallowed for a fallback",
  );
  assert.equal(calls, 1, "resolution must have actually been attempted");
});

// An explicitly EMPTY CCUSAGE_CMD must NOT be mistaken for "unset". Under a truthiness test
// it falls through to resolution and bootstrapDeps silently runs the BUNDLED binary — a
// different program than the user asked for.
//
// createDeps and bootstrapDeps guard this INDEPENDENTLY, so reverting either one alone is
// invisible to a test that only exercises the pair (code review R4 measured exactly that:
// mutating either file singly killed nothing). Each is therefore pinned separately below.
test("an explicitly empty CCUSAGE_CMD is refused, not silently replaced by the bundled binary", () => {
  assert.throws(
    () => bootstrapDeps({ CCUSAGE_CMD: "" }),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /no ccusage command available/);
      return true;
    },
  );
  // Sanity: with the variable genuinely unset, resolution DOES supply the bundled command.
  const d = bootstrapDeps({});
  assert.equal(d.ccusageExe, process.execPath);
});

test("createDeps' empty-CCUSAGE_CMD guard holds on its own, independent of bootstrapDeps", () => {
  // Pins context.ts's `!== undefined` directly: with an override supplied, a truthiness test
  // would treat "" as unset and silently hand back the override instead of refusing.
  assert.throws(
    () =>
      createDeps({ CCUSAGE_CMD: "" }, "/h", () => ({ status: 0, stdout: "{}", stderr: "" }), {
        ccusageExe: "/some/override",
      }),
    (e) => e instanceof UsageError && /no ccusage command available/.test(e.message),
    'CCUSAGE_CMD="" must be treated as set-and-invalid, not as unset',
  );
});

test("bootstrapDeps skips resolution entirely whenever a command was supplied", () => {
  // Pins main-deps.ts's own rule, independent of createDeps' guard. Without the injected
  // resolver this is unobservable: createDeps refuses the empty command either way on a host
  // where the bundled binary resolves, so reverting the rule changes nothing visible.
  // Counting calls is what separates the two guards (code review R4).
  let calls = 0;
  const spy = () => {
    calls += 1;
    return { exe: "/spy/node", prefixArgs: ["/spy/cli.js"] };
  };

  // Explicitly empty: supplied-but-degenerate. Must refuse WITHOUT resolving.
  assert.throws(
    () => bootstrapDeps({ CCUSAGE_CMD: "" }, {}, { resolve: spy }),
    (e) => e instanceof UsageError && /no ccusage command available/.test(e.message),
  );
  assert.equal(calls, 0, "an explicitly empty CCUSAGE_CMD must not trigger resolution");

  // A real command: also no resolution — the bundled package need not be installed at all.
  bootstrapDeps({ CCUSAGE_CMD: "ccusage" }, {}, { resolve: spy });
  assert.equal(calls, 0, "an explicit CCUSAGE_CMD must not require the bundled package");

  // An injected override likewise short-circuits resolution.
  bootstrapDeps({}, { ccusageExe: "/x" }, { resolve: spy });
  assert.equal(calls, 0, "an injected override must not trigger resolution");

  // Only with nothing supplied does resolution actually run.
  const d = bootstrapDeps({}, {}, { resolve: spy });
  assert.equal(calls, 1, "with no command supplied, resolution must run exactly once");
  assert.equal(d.ccusageExe, "/spy/node");
});

test("no npx fallback or floating tag survives anywhere in src/", () => {
  // SCOPE: this is a regression lint over string literals, not a proof of absence. It
  // cannot see a command assembled from variables, and its comment stripping is regex-based
  // (code review R1). The actual fail-closed guarantee is asserted behaviourally above;
  // this exists to catch the specific thing that was deleted from createDeps coming back.
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) {
        // Strip comments first: prose explaining WHY the fallback was removed is fine, and
        // so is the frozen parity message "Install Node.js (node + npx)" — that is advice
        // text, not something we execute. Only a command-shaped literal is a finding.
        const src = readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        // `npx` as a whole literal too: spawnSync("npx", ["--yes", "ccusage@latest"]) splits
        // the command across arguments, and the old pattern (which demanded whitespace or @
        // after npx inside ONE literal) missed it entirely.
        for (const m of src.matchAll(/["'`]\s*npx\s*(?:["'`]|[\s@][^"'`]*["'`])/g)) {
          offenders.push(`${p}: ${m[0]}`);
        }
        for (const m of src.matchAll(/["'`][^"'`]*ccusage@(latest|\*)[^"'`]*["'`]/g)) {
          offenders.push(`${p}: ${m[0]}`);
        }
      }
    }
  };
  walk(join(ROOT, "src"));
  assert.deepEqual(offenders, [], "runtime code acquisition must not be reachable");
});

// --- platform mapping (table-driven, runs on any host) ------------------------------

test("every advertised platform maps to its package", () => {
  const expected = {
    "darwin-arm64": "@ccusage/ccusage-darwin-arm64",
    "darwin-x64": "@ccusage/ccusage-darwin-x64",
    "linux-arm64": "@ccusage/ccusage-linux-arm64",
    "linux-x64": "@ccusage/ccusage-linux-x64",
    "win32-arm64": "@ccusage/ccusage-win32-arm64",
    "win32-x64": "@ccusage/ccusage-win32-x64",
  };
  assert.deepEqual({ ...PLATFORM_PACKAGES }, expected);
  for (const [key, name] of Object.entries(expected)) {
    const [platform, arch] = key.split("-");
    assert.equal(platformPackage(platform, arch), name);
  }
});

test("unsupported platforms map to null, not a guessed package name", () => {
  for (const [platform, arch] of [
    ["linux", "arm"],
    ["linux", "ppc64"],
    ["freebsd", "x64"],
    ["aix", "ppc64"],
    ["sunos", "x64"],
    ["darwin", "ia32"],
    ["win32", "ia32"],
  ]) {
    assert.equal(platformPackage(platform, arch), null, `${platform}-${arch}`);
  }
});

test("an unsupported platform is refused with the supported list, not a crash", () => {
  assert.throws(
    () => resolveBundledCcusage({ platform: "freebsd", arch: "x64" }),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /does not publish a binary for freebsd-x64/);
      assert.match(e.message, /darwin-arm64/, "should name what IS supported");
      assert.match(e.message, /CCUSAGE_CMD/, "should offer the escape hatch");
      return true;
    },
  );
});

test("a missing platform binary is diagnosed as an install problem, not a spawn failure", () => {
  // The real hazard: `npm install --omit=optional` leaves the shim, which spawns fine and
  // dies later loading its platform package — so ENOENT never fires and the user would
  // otherwise see a stack trace inside "ccusage failed:".
  const resolve = () => "/fake/ccusage/src/cli.js";
  const resolveFrom = (_from, spec) => {
    if (spec.startsWith("@ccusage/")) throw new Error("MODULE_NOT_FOUND");
    return "/fake/bin";
  };
  assert.throws(
    () => resolveBundledCcusage({ platform: "linux", arch: "x64", resolve, resolveFrom }),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /platform binary '@ccusage\/ccusage-linux-x64\/bin\/ccusage' is missing/);
      assert.match(e.message, /--omit=optional/);
      return true;
    },
  );
});

test("resolution succeeds here and yields node + the shim, never a PATH lookup", () => {
  const r = resolveBundledCcusage();
  assert.equal(r.exe, process.execPath);
  assert.equal(r.prefixArgs.length, 1);
  assert.match(r.prefixArgs[0], /ccusage[\\/]src[\\/]cli\.js$/);
});

// `env.HOME || homedir()` treated an explicitly EMPTY HOME as an ABSENT one and substituted
// the real user's home. Python does not: `expanduser` branches on `'HOME' not in os.environ`,
// so an empty HOME is a SET home and resolves to `/`. Measured against CPython:
//
//   HOME= python3 -c "import os; print(os.path.expanduser('~'), os.path.expanduser('~/.codex'))"
//   -> / /.codex
//
// The consequence is not cosmetic: a deliberately hermetic caller (a test harness, a sandbox)
// that clears HOME to avoid touching the developer's machine was silently pointed straight
// back at the developer's own ~/.claude and ~/.codex (code review R7).
test("an explicitly empty HOME resolves like Python, not as an absent HOME", () => {
  const deps = bootstrapDeps({ HOME: "", CCUSAGE_CMD: "ccusage" });
  assert.equal(deps.home, "/", "expanduser('~') with HOME='' is '/'");
  assert.equal(deps.codexHome, "/.codex", "not the real user's ~/.codex, and not '//.codex'");

  // It must also not leak in through CODEX_HOME's own expansion.
  const viaCodexHome = bootstrapDeps({ HOME: "", CODEX_HOME: "~/x", CCUSAGE_CMD: "ccusage" });
  assert.equal(viaCodexHome.codexHome, "/x");

  // The real fallback is unchanged: genuine ABSENCE still consults the OS, exactly as
  // Python's `pwd.getpwuid` branch does. Pinning this stops the fix from being "reverted"
  // into treating every HOME as empty.
  // (No `notEqual(absent.home, "/")` here: an account may legitimately have `/` as its home,
  // and the equality above already distinguishes the two branches — a regression that treated
  // every HOME as empty would yield "/" and fail it on any normal host. Asserting `!== "/"`
  // would reject a valid environment instead of a wrong implementation — code review R7.)
  // `userInfo().homedir`, not `homedir()`: the latter consults $HOME FIRST, so on this host
  // it is the process's own HOME rather than the password-database entry that the absent-HOME
  // branch actually reads. They coincide on a normal machine, which is exactly why the wrong
  // oracle went unnoticed — name the real source (code review R8).
  const absent = bootstrapDeps({ CCUSAGE_CMD: "ccusage" });
  assert.equal(absent.home, userInfo().homedir);
});

// A `~` that is not in the LEADING position is an ordinary path character. Measured against
// CPython (`posixpath.expanduser`, HOME=/home/testuser):
//
//   '/mnt/~backup/codex' -> '/mnt/~backup/codex'     'x/~/y' -> 'x/~/y'
//   './~'               -> './~'                      'a~b'  -> 'a~b'
//
// `!p.startsWith("~")` -> `!p.includes("~")` survived the whole suite (code review R8). Under
// that mutation `/mnt/~backup/codex` falls through to the `~user` branch, slices an empty
// user name out, and is REFUSED — a legitimate absolute CODEX_HOME turned into a hard error.
test("a '~' anywhere but the first character is a literal path character", () => {
  const codexHome = (p) =>
    bootstrapDeps({ HOME: "/home/testuser", CODEX_HOME: p, CCUSAGE_CMD: "ccusage" }).codexHome;

  for (const p of ["/mnt/~backup/codex", "x/~/y", "./~", "a~b", "/~"]) {
    assert.equal(codexHome(p), p, `${p} must survive expansion untouched`);
  }
  // The leading position still expands, so this is a narrowing of WHERE, not a disabling.
  assert.equal(codexHome("~/x"), "/home/testuser/x");
  assert.equal(codexHome("~"), "/home/testuser");
});

// bootstrapDeps merges three sources into createDeps' overrides, and the ORDER is load-bearing:
// caller overrides must win over the resolved bundled command, because an explicit injection
// is the caller saying "not the bundled one". Swapping the two spreads survived the whole
// suite (code review R8) — every existing test either supplies an override with no resolution
// or resolution with no override, so the two never actually collide.
test("caller overrides beat the resolved bundled command, not the other way round", () => {
  const spy = () => ({ exe: "/spy/node", prefixArgs: ["/spy/cli.js"] });

  // `ccusageExe: undefined` is present-but-undefined: `!== undefined` is false, so resolution
  // DOES run — and then the override spread must put the undefined back on top, leaving
  // createDeps with no command at all. Under the swapped order the resolved binary survives
  // and the process silently runs the bundled ccusage the caller just declined.
  assert.throws(
    () => bootstrapDeps({}, { ccusageExe: undefined }, { resolve: spy }),
    (e) => e instanceof UsageError && /no ccusage command available/.test(e.message),
    "an explicitly-undefined override must not be overwritten by the resolver",
  );

  // The same precedence, stated positively, on the args half.
  const d = bootstrapDeps({}, { ccusagePrefixArgs: ["X"] }, { resolve: spy });
  assert.equal(d.ccusageExe, "/spy/node", "the resolved exe still fills the gap");
  assert.deepEqual(d.ccusagePrefixArgs, ["X"], "but the caller's args win over the resolver's");
});

// --- the command-selection rule ---------------------------------------------------
//
// The install matrix demonstrates that no PATH fallback fires on three specific failure
// paths (missing CCUSAGE_CMD, missing shim, missing native package). Three samples cannot
// establish the general claim "there is no npx fallback anywhere" — a fourth branch could
// always exist, and chasing each one with another install scenario is a losing game.
//
// What carries the general claim is the RULE, asserted structurally: a command comes from
// somewhere a caller named, and a failure never reaches for a different one.
//
// Scope, stated rather than implied. `bootstrapDeps` has THREE inputs, not two: the two
// production ones below, plus `overrides.ccusageExe`, which is an in-process injection seam
// with no environment or CLI route to it — its precedence is covered by "caller overrides
// beat the resolved bundled command" above. And injecting a resolver here does not prove the
// real resolver cannot return something odd; that is what the install matrix's identity
// checks and canaries measure against actual installs. These two tests cover the SELECTION,
// not the resolver's implementation.

test("the two production paths select a named command, never an invented one", () => {
  const shim = "/resolved/ccusage/src/cli.js";
  const resolve = () => ({ exe: process.execPath, prefixArgs: [shim] });

  // (1) No override: the current Node plus the resolved shim, whatever else the environment
  // says. Not a PATH lookup, not the shim's shebang — so nothing here can depend on what
  // happens to be installed on the machine.
  for (const env of [{}, { HOME: "/tmp/h" }, { PATH: "/nowhere" }, { USAGE_CONFIG: "/x.json" }]) {
    const d = bootstrapDeps(env, {}, { resolve });
    assert.equal(d.ccusageExe, process.execPath, `env ${JSON.stringify(env)}`);
    assert.deepEqual(d.ccusagePrefixArgs, [shim], `env ${JSON.stringify(env)}`);
  }

  // (2) CCUSAGE_CMD set: exactly what the user wrote, and the resolver is never consulted —
  // an explicit command must not require the bundled package to exist at all.
  let resolverCalls = 0;
  const counting = () => {
    resolverCalls += 1;
    return { exe: "/never/used", prefixArgs: [] };
  };
  const d = bootstrapDeps({ CCUSAGE_CMD: "my-ccusage --flag" }, {}, { resolve: counting });
  assert.equal(d.ccusageExe, "my-ccusage");
  assert.deepEqual(d.ccusagePrefixArgs, ["--flag"]);
  assert.equal(resolverCalls, 0, "CCUSAGE_CMD must short-circuit resolution entirely");
});
test("a ccusage failure is terminal — one attempt, then throw, returned OR raised", () => {
  const attempts = [];
  /** `behaviour` either returns a runner result or throws, after recording its attempt. */
  const ctx = (behaviour) => ({
    deps: {
      ccusageExe: process.execPath,
      ccusagePrefixArgs: ["/resolved/cli.js"],
      runner: (exe, args) => {
        attempts.push([exe, ...args].join(" "));
        return behaviour();
      },
    },
  });

  const returns = (result) => () => result;
  const raises = (e) => () => { throw e; };

  // BOTH shapes of failure, because they are different code paths. The first three are results
  // the runner RETURNS. The last two it RAISES — the real runner does exactly that for
  // malformed UTF-8 (src/runner.ts decodeStream) and for a non-BufferSource capture. A
  // returns-only test would have been survived by a mutation that caught such an exception and
  // retried with another command, which is precisely the fallback this is here to rule out.
  const cases = [
    ["spawn failure", returns({ spawnError: true, status: null, stdout: "", stderr: "" })],
    ["nonzero exit, blank stdout", returns({ spawnError: false, status: 1, stdout: "", stderr: "x" })],
    ["unparseable stdout", returns({ spawnError: false, status: 0, stdout: "not json", stderr: "" })],
    ["runner raises UsageError", raises(new UsageError("ccusage produced malformed UTF-8"))],
    ["runner raises a plain Error", raises(new Error("internal: stderr was not captured as bytes"))],
  ];

  for (const [label, behaviour] of cases) {
    attempts.length = 0;
    assert.throws(() => runCcusage(ctx(behaviour), ["daily", "--json"]), Error, label);
    assert.equal(attempts.length, 1, `${label}: expected exactly one attempt, got ${attempts.length}`);
    assert.doesNotMatch(attempts[0], /npx/, `${label}: npx appeared in the attempted command`);
    assert.ok(attempts[0].startsWith(process.execPath), `${label}: ${attempts[0]}`);
  }
});
