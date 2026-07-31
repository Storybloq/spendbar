// Unit tests for the T-003 core, covering every guard the plan review required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageError } from "../dist/errors.js";
import { createDeps, splitCommand, DEFAULT_CONFIG } from "../dist/context.js";
import { encodePath, cleanName, modelFamily, loadConfig } from "../dist/config.js";
import { normDate, inWindow, windowLabel } from "../dist/dates.js";
import { validateInstances, validateCodexSessions, validateCodexDaily } from "../dist/json.js";
import { cnum, aggProjects, reconcile, crossCheck } from "../dist/aggregate.js";
import { codexStartDate, safeRealpath, codexCwd, codexProject, ROLLOUT_RE } from "../dist/codex.js";

const noRunner = () => ({ status: 0, stdout: "{}", stderr: "" });

function mkCtx(overrides = {}, config = {}) {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/Users/testuser", noRunner, {
    today: () => "20260731",
    ...overrides,
  });
  return { deps, config: { ...DEFAULT_CONFIG, ...config } };
}

// ---------------------------------------------------------------- config / names

test("encodePath replaces every non-alphanumeric with a dash", () => {
  assert.equal(encodePath("/Users/testuser/Developer/alpha"), "-Users-testuser");
  assert.equal(encodePath("/tmp/a.b_c"), "-tmp-a-b-c");
});

test("cleanName: workspace root strip, home itself, other home subpath, foreign prefix", () => {
  const ctx = mkCtx();
  const h = ctx.deps.homeEnc;
  assert.equal(cleanName(`${h}-Developer-alpha`, ctx), "alpha");
  assert.equal(cleanName(h, ctx), "~");
  assert.equal(cleanName(`${h}-Desktop-scratch`, ctx), "~/Desktop-scratch");
  assert.equal(cleanName(`${h}-Developer`, ctx), "~/Developer");
  assert.equal(cleanName("-Volumes-ext-Developer-x", ctx), "-Volumes-ext-Developer-x");
});

test("cleanName: rename applies last, legacy group wins first", () => {
  const ctx = mkCtx({}, { renames: { alpha: "Alpha Product" }, legacyGroups: { "raw-key": "Legacy" } });
  const h = ctx.deps.homeEnc;
  assert.equal(cleanName(`${h}-Developer-alpha`, ctx), "Alpha Product");
  assert.equal(cleanName("raw-key", ctx), "Legacy");
});

test("modelFamily classification incl. the codex fallback", () => {
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("claude-opus-4-8"), "opus");
  assert.equal(modelFamily("claude-sonnet-5"), "sonnet");
  assert.equal(modelFamily("claude-haiku-4-5"), "haiku");
  assert.equal(modelFamily("gpt-5.1-codex-max"), "gpt");
  assert.equal(modelFamily("some-codex-mini"), "gpt");
  assert.equal(modelFamily("mystery-model"), "other");
  assert.equal(modelFamily(null), "other");
});

test("loadConfig: missing file is silent, malformed warns and defaults", () => {
  const warnings = [];
  const missing = createDeps({ CCUSAGE_CMD: "ccusage", USAGE_CONFIG: "/nonexistent/does-not-exist.json" }, "/h", noRunner, {
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(loadConfig(missing), DEFAULT_CONFIG);
  assert.equal(warnings.length, 0, "missing file must not warn");

  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not valid json ,,, }");
  const badDeps = createDeps({ CCUSAGE_CMD: "ccusage", USAGE_CONFIG: bad }, "/h", noRunner, { warn: (m) => warnings.push(m) });
  assert.deepEqual(loadConfig(badDeps), DEFAULT_CONFIG);
  assert.equal(warnings.length, 1, "malformed config must warn exactly once");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- dates

test("normDate handles absolute, dashed and relative forms", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  assert.equal(normDate("20260101", deps), "20260101");
  assert.equal(normDate("2026-01-01", deps), "20260101");
  assert.equal(normDate("-3d", deps), "20260728");
  assert.equal(normDate("-30d", deps), "20260701");
  assert.equal(normDate(null, deps), null);
});

test("normDate rejects a malformed relative date with the frozen message", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  assert.throws(() => normDate("-xd", deps), (e) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.message, "bad relative date '-xd': expected -Nd, e.g. -3d or -30d");
    return true;
  });
});

// usage.py:106 interpolates with `!r`. Hard-coding "'" diverges the moment the value
// contains a quote or backslash — verified against CPython, not hand-written.
test("normDate's error quotes via repr, matching CPython on adversarial input", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  const cases = ["-'d", '-"d', "-\\d", "-a'b\"c\\d"];
  const script =
    "import sys,json\n" +
    "for s in json.loads(sys.argv[1]):\n" +
    "    print(f'bad relative date {s!r}: expected -Nd, e.g. -3d or -30d')\n";
  const out = spawnSync("python3", ["-c", script, JSON.stringify(cases)], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const expected = out.stdout.replace(/\n$/, "").split("\n");
  cases.forEach((s, i) => {
    assert.throws(() => normDate(s, deps), (e) => {
      assert.equal(e.message, expected[i], `case ${i}: ${JSON.stringify(s)}`);
      return true;
    });
  });
});

test("inWindow is inclusive on both ends", () => {
  assert.equal(inWindow("20260101", "20260101", "20260131"), true);
  assert.equal(inWindow("20260131", "20260101", "20260131"), true);
  assert.equal(inWindow("20251231", "20260101", null), false);
  assert.equal(inWindow("20260201", null, "20260131"), false);
});

test("windowLabel renders relative dates with their resolved value", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  assert.equal(windowLabel(null, null, deps), "(all time)");
  assert.equal(windowLabel("-3d", null, deps), "(since -3d (=20260728))");
  assert.equal(windowLabel("20260101", "20260131", deps), "(20260101 -> 20260131)");
});

// ---------------------------------------------------------------- json guards (F1/F2/F8)

// Shared minimal-valid scaffolding. The schema is strict as of T-006, so a payload must
// carry its totals and every consumed row field; these helpers keep each test focused on
// the ONE thing it is actually asserting.
const CLAUDE_TOTALS = { totalCost: 0, totalTokens: 0 };
const CODEX_TOTALS = { costUSD: 0, totalTokens: 0 };
const codexSession = (over = {}) => ({
  sessionFile: "rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-000000000001",
  costUSD: 1,
  totalTokens: 1,
  models: {}, // required as of code review R1; empty is the unclassified bucket
  ...over,
});
const codexDailyRow = (over = {}) => ({
  date: "2026-01-01",
  costUSD: 1,
  totalTokens: 1,
  models: {},
  ...over,
});
/** A breakdown entry carrying every counter the validator requires. */
const mbEntry = (over = {}) => ({
  modelName: "claude-opus-4-8",
  cost: 1,
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationTokens: 1,
  cacheReadTokens: 1,
  ...over,
});

// The key set is `/^(0|[1-9]\d*)$/` — CANONICAL integers, of any length. Single-character
// keys alone cannot pin that: `/^[0-9]$/` passes such a test while letting `"10"` and `"42"`
// through, and those ARE reordered by JS (measured: Object.keys of
// `{"10":…,"2":…,"007":…,"-p":…}` iterates 2, 10, 007, -p — textual order lost, which is
// exactly the float-summation hazard ALLOWLIST 6 exists for). The NON-canonical spellings
// matter just as much in the other direction: JS does not reorder `"007"` or `"1.0"`, so
// rejecting them would be a false positive on a key a producer could legitimately emit
// (code review R8).
test("validate rejects canonical-integer keys in projects (JS would reorder them)", () => {
  for (const key of ["0", "1", "2", "10", "42", "100", "9007199254740993"]) {
    assert.throws(
      () => validateInstances({ projects: { [key]: [], "-p": [] }, totals: CLAUDE_TOTALS }),
      (e) => e instanceof UsageError && /canonical-integer key/.test(e.message),
      `canonical integer key ${JSON.stringify(key)} must be rejected`,
    );
  }
  // NOT canonical integers — JS preserves their insertion order, so they must pass.
  for (const key of ["-Users-testuser", "007", "01", "1.0", "1e3", "-1", "1n", " 1"]) {
    assert.doesNotThrow(
      () => validateInstances({ projects: { [key]: [] }, totals: CLAUDE_TOTALS }),
      `${JSON.stringify(key)} is not a canonical integer and must be accepted`,
    );
  }
});

test("validate rejects canonical-integer keys in codex models", () => {
  assert.throws(
    () =>
      validateCodexSessions({
        sessions: [codexSession({ models: { 0: { totalTokens: 1 } } })],
        totals: CODEX_TOTALS,
      }),
    (e) => e instanceof UsageError && /canonical-integer key/.test(e.message),
  );
});

test("safe-integer boundary: 2^53-1 ok, 2^53 and above rejected — CLAUDE path", () => {
  const mk = (tok) => ({
    projects: { "-p": [{ date: "2026-01-01", totalCost: 1, totalTokens: tok, modelBreakdowns: [] }] },
    totals: CLAUDE_TOTALS,
  });
  assert.doesNotThrow(() => validateInstances(mk(Number.MAX_SAFE_INTEGER))); // 2^53-1
  assert.throws(() => validateInstances(mk(2 ** 53)), (e) => e instanceof UsageError);
  assert.throws(() => validateInstances(mk(2 ** 53 + 2)), (e) => e instanceof UsageError);
});

test("safe-integer boundary also covers Claude per-model counters (cnum never sees them)", () => {
  const mk = (tok) => ({
    projects: {
      "-p": [
        {
          date: "2026-01-01",
          totalCost: 1,
          totalTokens: 1,
          modelBreakdowns: [mbEntry({ inputTokens: tok })],
        },
      ],
    },
    totals: CLAUDE_TOTALS,
  });
  assert.doesNotThrow(() => validateInstances(mk(10)));
  assert.throws(() => validateInstances(mk(2 ** 53)), (e) => e instanceof UsageError);
});

test("safe-integer boundary — CODEX path", () => {
  const mk = (tok) => ({
    sessions: [codexSession({ totalTokens: tok, models: { "gpt-5.5": { totalTokens: tok } } })],
    totals: CODEX_TOTALS,
  });
  assert.doesNotThrow(() => validateCodexSessions(mk(Number.MAX_SAFE_INTEGER)));
  assert.throws(() => validateCodexSessions(mk(2 ** 53)), (e) => e instanceof UsageError);
});

// ---------------------------------------------------------------- cnum / reconcile

test("cnum rejects booleans with the exact frozen Python-repr message", () => {
  assert.throws(() => cnum(true, "sessions[0].costUSD"), (e) => {
    assert.equal(
      e.message,
      "unexpected ccusage codex output: sessions[0].costUSD = True (expected a finite non-negative number)",
    );
    return true;
  });
  assert.throws(() => cnum(-1, "x"), (e) => e instanceof UsageError);
  assert.throws(() => cnum(null, "x"), (e) => /= None /.test(e.message));
  assert.throws(() => cnum(Infinity, "x"), (e) => e instanceof UsageError);
  assert.equal(cnum(0, "x"), 0);
  assert.equal(cnum(12.5, "x"), 12.5);
});

test("reconcile tolerates float-order noise but reports a real gap", () => {
  assert.equal(reconcile(83.995, 83.99499999999999), "[totals reconcile: OK]");
  assert.match(reconcile(21.0, 999.0), /MISMATCH \$21\.00 vs ccusage \$999\.00 \(Δ \$-978\.00\)/);
});

test("crossCheck renders a signed delta, +0.00 when equal", () => {
  assert.equal(crossCheck(31.7, 31.7), "[session-start $31.70 vs codex daily $31.70 (Δ $+0.00)]");
});

test("aggProjects sums per project and per model family", () => {
  const ctx = mkCtx();
  const h = ctx.deps.homeEnc;
  const payload = {
    projects: {
      [`${h}-Developer-alpha`]: [
        {
          date: "2026-01-01",
          totalCost: 15.0,
          totalTokens: 30,
          modelBreakdowns: [
            { modelName: "claude-fable-5", cost: 10, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 1, cacheReadTokens: 7 },
            { modelName: "claude-opus-4-8", cost: 5, inputTokens: 5, outputTokens: 5, cacheCreationTokens: 5, cacheReadTokens: 5 },
          ],
        },
        { date: "2026-01-02", totalCost: 3.0, totalTokens: 6, modelBreakdowns: [] },
      ],
    },
    totals: { totalCost: 18.0 },
  };
  const { agg, grand } = aggProjects(ctx, payload);
  const a = agg.get("alpha");
  assert.equal(a.cost, 18.0);
  assert.equal(a.tokens, 36);
  assert.equal(a.byModel.get("fable"), 10);
  assert.equal(a.byModel.get("opus"), 20);
  assert.equal(a.first, "2026-01-01");
  assert.equal(a.last, "2026-01-02");
  assert.equal(grand, 18.0);
});

// usage.py:186-187 is an UNCONDITIONAL min/max. The port used to guard with `date &&`, so an
// empty date was skipped and `first` stayed at the next-earliest real date while Python
// reported "". Both exit 0 — a silent output divergence, and the only one a 221-case Claude
// mutation differential turned up (code review R6).
//
// T-006 is what made this reachable: R5 relaxed json.ts's requireString to accept "",
// because Python renders such a row rather than failing (ALLOWLIST 14). Before that the
// validator rejected the payload and the divergence could not be observed.
test("an empty date participates in first/last exactly as Python's min/max does", () => {
  const ctx = mkCtx();
  const h = ctx.deps.homeEnc;
  const { agg } = aggProjects(ctx, {
    projects: {
      [`${h}-Developer-alpha`]: [
        { date: "", totalCost: 1.0, totalTokens: 1, modelBreakdowns: [] },
        { date: "2026-07-10", totalCost: 2.0, totalTokens: 2, modelBreakdowns: [] },
      ],
    },
    totals: { totalCost: 3.0 },
  });
  const a = agg.get("alpha");
  assert.equal(a.first, "", 'min("9999-99-99", "", "2026-07-10") is "" — Python does not skip it');
  assert.equal(a.last, "2026-07-10");

  // A LONE empty date is the asymmetric case, and it is asymmetric in Python too: "" sorts
  // before every non-empty string, so min() takes it while max() keeps the sentinel.
  // Verified against CPython: min("9999-99-99","") == "" but max("0000-00-00","") ==
  // "0000-00-00". The port must reproduce both, sentinel included.
  const { agg: agg2 } = aggProjects(ctx, {
    projects: { [`${h}-Developer-beta`]: [{ date: "", totalCost: 0, totalTokens: 0, modelBreakdowns: [] }] },
    totals: { totalCost: 0 },
  });
  const b = agg2.get("beta");
  assert.equal(b.first, "");
  assert.equal(b.last, "0000-00-00", 'max("0000-00-00", "") keeps the sentinel');
});

// ---------------------------------------------------------------- codex security (F5/F9)

test("codexStartDate parses only well-formed rollout names", () => {
  const good = "rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-000000000001";
  assert.equal(codexStartDate(good), "20260101");
  assert.equal(codexStartDate("../../etc/passwd"), null);
  assert.equal(codexStartDate("rollout-nope"), null);
  assert.equal(codexStartDate(null), null);
});

test("safeRealpath returns a normalized path for a missing dir instead of throwing (F5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "srp-"));
  const missing = join(dir, "archived_sessions");
  // The whole point: Node's realpathSync throws here, Python's returns the path. The
  // existing prefix still gets resolved (on macOS /var -> /private/var), which is exactly
  // what os.path.realpath does — so compare against the resolved parent, not the raw path.
  assert.throws(() => realpathSync(missing));
  assert.equal(safeRealpath(missing), join(realpathSync(dir), "archived_sessions"));
  rmSync(dir, { recursive: true, force: true });
});

test("codexCwd resolves session_meta, refuses traversal, symlink escape and decoys", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const uuid = "019c0000-0000-7000-8000-00000000000";
  const name = (n) => `rollout-2026-01-01T10-00-00-${uuid}${n}`;
  const dated = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dated, { recursive: true });

  // 1. normal resolution
  writeFileSync(
    join(dated, name(1) + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { cwd: "/Users/testuser/Developer/alpha" } }) + "\n",
  );
  // 2. decoy cwd on a non-session_meta record must be ignored
  writeFileSync(
    join(dated, name(2) + ".jsonl"),
    "not json at all\n" + JSON.stringify({ type: "event_msg", payload: { cwd: "/decoy/project" } }) + "\n",
  );
  // 3. symlink escaping CODEX_HOME
  const target = join(outside, "escaped.jsonl");
  writeFileSync(target, JSON.stringify({ type: "session_meta", payload: { cwd: "/outside/evil" } }) + "\n");
  symlinkSync(target, join(dated, name(3) + ".jsonl"));

  const ctx = mkCtx({ codexHome: home });
  assert.equal(codexCwd(ctx, name(1), "2026/01/01"), "/Users/testuser/Developer/alpha");
  assert.equal(codexCwd(ctx, name(2), "2026/01/01"), null, "decoy must not resolve");
  assert.equal(codexCwd(ctx, name(3), "2026/01/01"), null, "symlink escape must not resolve");
  assert.equal(codexCwd(ctx, "../../etc/passwd", "2026/01/01"), null, "traversal must not resolve");

  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("codexCwd abandons a file whose single line exceeds the byte cap (F9)", () => {
  const home = mkdtempSync(join(tmpdir(), "codexbig-"));
  const dated = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dated, { recursive: true });
  const nm = "rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-000000000009";
  // One 2 MiB line with no newline — over MAX_LINE_BYTES (1 MiB).
  writeFileSync(join(dated, nm + ".jsonl"), "x".repeat(2 * 1024 * 1024));
  const ctx = mkCtx({ codexHome: home });
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), null, "oversized line must return unresolved, not OOM");
  rmSync(home, { recursive: true, force: true });
});

test("codexProject collapses claude scratchpads but keeps ordinary /tmp projects", () => {
  const ctx = mkCtx();
  assert.equal(codexProject(ctx, "/private/tmp/claude-501/scratch/scratchpad"), "(agent scratchpads)");
  assert.equal(codexProject(ctx, "/tmp/claude-99/x"), "(agent scratchpads)");
  assert.equal(codexProject(ctx, "/tmp/legitimate-project"), "-tmp-legitimate-project");
});

// ---------------------------------------------------------------- context

test("splitCommand mirrors Python str.split() and never shells out", () => {
  assert.deepEqual(splitCommand("npx --yes ccusage@latest"), {
    exe: "npx",
    prefixArgs: ["--yes", "ccusage@latest"],
  });
  assert.deepEqual(splitCommand("  ccusage  "), { exe: "ccusage", prefixArgs: [] });
});

// The claim in splitCommand's docstring, checked against CPython itself rather than
// hand-written. `\s+` was NOT the same set (code review R6): Python's str.split() also
// splits on the C1 separators - and , which `\s` does not match, while
// `\s` matches ﻿, which Python does not split on. Both directions matter — the first
// yields a wrong `exe` (and so a wrong frozen "'X' not found" message and `cmd:` line), the
// second splits a command Python would leave intact.
// EXHAUSTIVE, over every code point — a hand-picked probe list cannot substantiate the word
// "exactly" (code review R7). The production class spells U+2000-U+200A as a RANGE, and the
// old list sampled only its two endpoints, so narrowing it to U+2000-U+2008 (dropping two
// real Python whitespace characters) left this test green while its name still claimed
// equivalence. Same shape as the `\p{Nd}` table test: compare the two SETS, not samples.
test("splitCommand's whitespace set is exactly CPython's, verified against CPython", () => {
  // Surrogates are excluded: they cannot survive the JSON round-trip to Python as text, and
  // `chr(0xd800).isspace()` is False while a lone surrogate never splits here either, so
  // they agree trivially and only complicate the transport.
  const script =
    "import sys, json\n" +
    "print(json.dumps([cp for cp in range(0x110000)\n" +
    "                  if not (0xd800 <= cp <= 0xdfff) and chr(cp).isspace()]))\n";
  const res = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(res.status, 0, res.stderr);
  const pyWhitespace = JSON.parse(res.stdout);
  assert.ok(pyWhitespace.length > 20, `expected a real whitespace set, got ${pyWhitespace.length}`);

  const jsWhitespace = [];
  for (let cp = 0; cp < 0x110000; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (splitCommand(`a${String.fromCodePoint(cp)}b`).prefixArgs.length === 1) jsWhitespace.push(cp);
  }

  const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  const pySet = new Set(pyWhitespace);
  const jsSet = new Set(jsWhitespace);
  assert.deepEqual(
    jsWhitespace.filter((cp) => !pySet.has(cp)).map(hex),
    [],
    "the port splits on characters CPython does not (e.g. a stray U+FEFF from JS's \\s)",
  );
  assert.deepEqual(
    pyWhitespace.filter((cp) => !jsSet.has(cp)).map(hex),
    [],
    "CPython splits on characters the port does not (e.g. the C1 separators U+001C-U+001F)",
  );

  // ...and the split RESULT itself, not merely the boolean, on both sides of the boundary.
  for (const cp of [...pyWhitespace, 0x41, 0x30, 0x2d, 0xfeff, 0x200b, 0x180e]) {
    const ch = String.fromCodePoint(cp);
    assert.deepEqual(
      splitCommand(`a${ch}b`),
      pySet.has(cp) ? { exe: "a", prefixArgs: ["b"] } : { exe: `a${ch}b`, prefixArgs: [] },
      hex(cp),
    );
  }
});

test("createDeps performs no I/O and honours env overrides", () => {
  const deps = createDeps(
    { CCUSAGE_CMD: "ccusage", CODEX_HOME: "/custom/codex", USAGE_CONFIG: "/custom/cfg.json" },
    "/Users/testuser",
    noRunner,
  );
  assert.equal(deps.ccusageExe, "ccusage");
  assert.deepEqual(deps.ccusagePrefixArgs, []);
  assert.equal(deps.codexHome, "/custom/codex");
  assert.equal(deps.configPath, "/custom/cfg.json");
  assert.equal(deps.homeEnc, "-Users-testuser");
});

// usage.py:197 wraps the WHOLE lookup in expanduser, override included. Leaving '~'
// CCUSAGE_CMD must WIN over an injected override, which is what createDeps' if/else and
// bootstrapDeps both document. It did not: the old `return {...base, ...overrides}` put the
// override back on top afterwards, silently inverting the documented precedence (R1).
test("CCUSAGE_CMD beats an injected override, as documented", () => {
  const d = createDeps({ CCUSAGE_CMD: "envcmd --flag" }, "/h", noRunner, {
    ccusageExe: "overridden",
    ccusagePrefixArgs: ["nope"],
  });
  assert.equal(d.ccusageExe, "envcmd");
  assert.deepEqual(d.ccusagePrefixArgs, ["--flag"]);

  // With no env var the override is the source, and its prefix args default to [].
  const o = createDeps({}, "/h", noRunner, { ccusageExe: "overridden" });
  assert.equal(o.ccusageExe, "overridden");
  assert.deepEqual(o.ccusagePrefixArgs, []);
});

// A command that splits to nothing must fail closed here, not reach spawnSync and surface
// as ERR_INVALID_ARG_VALUE.
//
// This is a SANCTIONED DIVERGENCE, not a match (ALLOWLIST 13). Python never reaches
// `subprocess.run([])`: usage.py:112 builds `cmd = CCUSAGE + args`, so an empty prefix
// leaves the bare subcommand (`claude`, `codex`, …) as cmd[0] and Python execs *that* —
// usually FileNotFoundError, but a real `claude` on PATH would silently run with ccusage's
// arguments. The port refuses up front instead. (An earlier version of this comment made
// the `subprocess.run([])` claim; it is false — code review R5, same false claim R3 caught
// in the ALLOWLIST prose.)
test("a command that splits to an empty executable is refused", () => {
  // "" included deliberately: Python's os.environ.get returns it as a SET value, so it must
  // not be mistaken for "unset" and silently replaced by the bundled binary (R2).
  for (const cmd of ["", "   ", "\t", "\n  \t "]) {
    assert.throws(
      () => createDeps({ CCUSAGE_CMD: cmd }, "/h", noRunner),
      (e) => e instanceof UsageError && /no ccusage command available/.test(e.message),
      `CCUSAGE_CMD=${JSON.stringify(cmd)} must be refused`,
    );
  }
  assert.throws(
    () => createDeps({}, "/h", noRunner, { ccusageExe: "" }),
    (e) => e instanceof UsageError && /no ccusage command available/.test(e.message),
  );
});

// unexpanded makes it a relative path, so a decoy './~/sessions' under cwd becomes the
// trusted session root (code review R1).
test("CODEX_HOME expands a leading ~ so it can never resolve relative to cwd", () => {
  const mk = (v) => createDeps({ CCUSAGE_CMD: "ccusage", CODEX_HOME: v }, "/Users/testuser", noRunner).codexHome;
  assert.equal(mk("~/.codex-test"), "/Users/testuser/.codex-test");
  assert.equal(mk("~"), "/Users/testuser");
  assert.equal(createDeps({ CCUSAGE_CMD: "ccusage" }, "/Users/testuser", noRunner).codexHome, "/Users/testuser/.codex");
  assert.equal(mk("/abs/codex"), "/abs/codex");
});

// posixpath.expanduser ends with `userhome.rstrip('/')` then `(userhome + rest) or '/'`.
// Naive concatenation got both tails wrong, and both are silent: a trailing slash survives
// into `homeEnc`, where it matches no encoded project key at all (code review R7).
// Expected values measured against CPython, not derived from the implementation:
//   HOME=/tmp/foo/  -> expanduser('~')='/tmp/foo'  expanduser('~/.codex')='/tmp/foo/.codex'
//   HOME=""         -> expanduser('~')='/'         expanduser('~/.codex')='/.codex'
test("home expansion follows CPython's rstrip and empty-home rules", () => {
  const mk = (home, v) =>
    createDeps({ CCUSAGE_CMD: "ccusage", ...(v === undefined ? {} : { CODEX_HOME: v }) }, home, noRunner);

  assert.equal(mk("/tmp/foo/").codexHome, "/tmp/foo/.codex", "one trailing slash is stripped");
  assert.equal(mk("/tmp/foo///").codexHome, "/tmp/foo/.codex", "rstrip('/') removes EVERY trailing slash");
  assert.equal(mk("/tmp/foo/", "~").codexHome, "/tmp/foo");
  assert.equal(mk("/tmp/foo/").homeEnc, mk("/tmp/foo").homeEnc, "a trailing slash must not change homeEnc");

  // The `or '/'` tail. An empty home rstrips to "", so "~" would otherwise expand to "".
  assert.equal(mk("").codexHome, "/.codex", "empty home + '/.codex' is already non-empty");
  assert.equal(mk("", "~").codexHome, "/", "empty result falls back to the root");
  // Root itself rstrips to "" and must come back as "/", not "" or "//.codex".
  assert.equal(mk("/", "~").codexHome, "/");
  assert.equal(mk("/").codexHome, "/.codex", "not '//.codex'");
});

// Returning `~root/.codex` unchanged has the SAME relative-path hole as the bare `~` bug,
// just spelled differently — so another account's ~user is refused, not passed through.
test("a ~user path for another account is refused, never left relative", () => {
  // The accepted `~user` resolves from the PASSWD entry, not from HOME and not from $USER
  // (code review R8). CPython's `~user` branch calls `pwd.getpwnam(name).pw_dir` and never
  // consults HOME, so the two are given DIFFERENT values here — a test that set them equal
  // could not tell which one the port actually used.
  const passwd = { username: "testuser", homedir: "/passwd/testuser" };
  const mk = (v, over = {}) =>
    createDeps({ CCUSAGE_CMD: "ccusage", CODEX_HOME: v, USER: "testuser" }, "/Users/testuser", noRunner, {
      passwd,
      ...over,
    }).codexHome;

  assert.throws(() => mk("~root/.codex"), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /cannot expand CODEX_HOME '~root\/\.codex'/);
    return true;
  });
  assert.throws(() => mk("~other"), (e) => e instanceof UsageError);

  // The current account's own name IS resolvable — from pw_dir.
  assert.equal(mk("~testuser/.codex"), "/passwd/testuser/.codex", "must use pw_dir, not HOME");
  assert.equal(mk("~testuser"), "/passwd/testuser");
  // ...while bare `~` still uses HOME, which is what posixpath does.
  assert.equal(mk("~/.codex"), "/Users/testuser/.codex");

  // $USER is NOT the passwd name and must not be treated as it: an env var must not make the
  // port expand another account's `~name` to this account's home.
  assert.throws(
    () =>
      createDeps(
        { CCUSAGE_CMD: "ccusage", CODEX_HOME: "~root/.codex", USER: "root" },
        "/Users/testuser",
        noRunner,
        { passwd },
      ),
    (e) => e instanceof UsageError,
    "USER=root must not make ~root expand — the passwd name is the only authority",
  );

  // With no passwd entry available at all, every `~user` is refused rather than guessed.
  assert.throws(() => mk("~testuser", { passwd: undefined }), (e) => e instanceof UsageError);
});

// ---------------------------------------------------------------- unicode digits (R2-F2)

test("relative dates accept Unicode decimal digits, as Python's str.isdigit does", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  assert.equal(normDate("-3d", deps), "20260728");
  assert.equal(normDate("-٣d", deps), "20260728", "Arabic-Indic 3");
  assert.equal(normDate("-１０d", deps), "20260721", "fullwidth 10");
  assert.equal(normDate("-०३d", deps), "20260728", "Devanagari 03");
});

// The block-walk in digitValue assumes every Nd run is a contiguous ascending ten. Prove
// it against CPython for every Nd code point this runtime knows, rather than asserting it.
test("digitValue agrees with CPython int() on every Nd code point", () => {
  const script = [
    "import sys, unicodedata, json",
    "out = []",
    "for cp in range(0x110000):",
    "    ch = chr(cp)",
    "    if unicodedata.category(ch) == 'Nd':",
    "        out.append([cp, int(ch)])",
    "print(json.dumps(out))",
  ].join("\n");
  const res = spawnSync("python3", ["-c", script], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(res.status, 0, res.stderr);
  const expected = JSON.parse(res.stdout);
  assert.ok(expected.length > 500, `expected many Nd code points, got ${expected.length}`);

  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  let checked = 0;
  for (const [cp, value] of expected) {
    // normDate("-<digit>d") shifts by exactly the digit's numeric value.
    const got = normDate("-" + String.fromCodePoint(cp) + "d", deps);
    const want = normDate("-" + String(value) + "d", deps);
    assert.equal(got, want, `U+${cp.toString(16)} should have value ${value}`);
    checked += 1;
  }
  assert.equal(checked, expected.length);
});

// V8 knows Unicode 16 digits (U+10D40, Garay) that CPython 3.11's Unicode 14 does not.
// Using JS's own \p{Nd} would accept these where Python errors — a success-path divergence.
test("a digit V8 knows but the reference CPython does not is refused", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  const garayZero = String.fromCodePoint(0x10d40);
  assert.match(garayZero, /\p{Nd}/u, "fixture must be Nd per V8");
  const py = spawnSync("python3", ["-c", "import sys; print(sys.argv[1].isdigit())", garayZero], {
    encoding: "utf8",
  });
  assert.equal(py.stdout.trim(), "False", "fixture must NOT be a digit per this python3");
  assert.throws(() => normDate("-" + garayZero + "d", deps), (e) => e instanceof UsageError);
});

test("a relative date outside datetime.date's year 1..9999 is refused", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  // Python: date.today() - timedelta(days=1000000) raises OverflowError.
  assert.throws(() => normDate("-1000000d", deps), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /out of range/);
    return true;
  });
  // Just inside the boundary still works and stays fixed-width.
  const ok = normDate("-700000d", deps);
  assert.equal(ok.length, 8, `expected a fixed-width key, got ${ok}`);
  assert.ok(ok >= "01010101", ok);
});

test("superscripts are refused cleanly where Python's own int() would raise", () => {
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", noRunner, { today: () => "20260731" });
  // '²'.isdigit() is True in Python but int('²') raises ValueError -> traceback.
  assert.throws(() => normDate("-²d", deps), (e) => e instanceof UsageError);
});

test("a decoy '~' directory under cwd cannot capture session discovery", () => {
  const decoyRoot = mkdtempSync(join(tmpdir(), "decoy-"));
  const realHome = mkdtempSync(join(tmpdir(), "realhome-"));
  const nm = "rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-000000000001";
  const meta = (cwd) => JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n";

  // The trap: ./~/.codex-test/sessions/... relative to the process cwd.
  const decoyDated = join(decoyRoot, "~", ".codex-test", "sessions", "2026", "01", "01");
  mkdirSync(decoyDated, { recursive: true });
  writeFileSync(join(decoyDated, nm + ".jsonl"), meta("/ATTACKER/CONTROLLED"));

  // The genuine target that expanduser should reach.
  const realDated = join(realHome, ".codex-test", "sessions", "2026", "01", "01");
  mkdirSync(realDated, { recursive: true });
  writeFileSync(join(realDated, nm + ".jsonl"), meta("/Users/testuser/Developer/real"));

  const deps = createDeps({ CCUSAGE_CMD: "ccusage", CODEX_HOME: "~/.codex-test" }, realHome, noRunner);
  const ctx = { deps, config: DEFAULT_CONFIG };
  const prev = process.cwd();
  try {
    process.chdir(decoyRoot);
    assert.equal(codexCwd(ctx, nm, "2026/01/01"), "/Users/testuser/Developer/real");
  } finally {
    process.chdir(prev);
    rmSync(decoyRoot, { recursive: true, force: true });
    rmSync(realHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- codex daily validation

test("codex daily totals are safe-integer validated before cnum sees them", () => {
  const mk = (tok) => ({ daily: [codexDailyRow()], totals: { costUSD: 0, totalTokens: tok } });
  assert.doesNotThrow(() => validateCodexDaily(mk(Number.MAX_SAFE_INTEGER)));
  assert.throws(() => validateCodexDaily(mk(2 ** 53)), (e) => e instanceof UsageError);
  assert.throws(() => validateCodexDaily(mk(2 ** 53 + 2)), (e) => e instanceof UsageError);
});

test("codex daily row and per-model token counts are validated too", () => {
  const wrap = (row) => ({ daily: [row], totals: CODEX_TOTALS });
  assert.throws(
    () => validateCodexDaily(wrap(codexDailyRow({ totalTokens: 2 ** 53 }))),
    (e) => e instanceof UsageError && /codex daily\[0\]\.totalTokens/.test(e.message),
  );
  assert.throws(
    () => validateCodexDaily(wrap(codexDailyRow({ models: { "gpt-5.5": { totalTokens: 2 ** 53 } } }))),
    (e) => e instanceof UsageError,
  );
  assert.throws(
    () => validateCodexDaily(wrap(codexDailyRow({ models: { 0: { totalTokens: 1 } } }))),
    (e) => e instanceof UsageError && /canonical-integer key/.test(e.message),
  );
});

// ---------------------------------------------------------------- head-scan bounds (F6/F7)

const MAX_LINE_BYTES = 1 << 20;
const MAX_HEAD_BYTES = 4 << 20;
const ROLLOUT = "rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-00000000000";

function withRollout(name, body) {
  const home = mkdtempSync(join(tmpdir(), "codexbounds-"));
  const dated = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dated, { recursive: true });
  writeFileSync(join(dated, name + ".jsonl"), body);
  return { home, ctx: mkCtx({ codexHome: home }) };
}

test("an oversized line is refused even when it is newline-terminated", () => {
  const nm = ROLLOUT + "1";
  // The old check ran only after draining newline-terminated lines, so this slipped past.
  const body =
    "x".repeat(MAX_LINE_BYTES + 1) +
    "\n" +
    JSON.stringify({ type: "session_meta", payload: { cwd: "/should/not/be/reached" } }) +
    "\n";
  const { home, ctx } = withRollout(nm, body);
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), null);
  rmSync(home, { recursive: true, force: true });
});

test("input continuing past MAX_HEAD_BYTES returns null, not a partial parse", () => {
  const nm = ROLLOUT + "2";
  // 4 lines that land exactly on the total cap, then more data behind it.
  const line = "y".repeat(MAX_HEAD_BYTES / 4 - 1);
  const body = (line + "\n").repeat(4) + JSON.stringify({ type: "session_meta", payload: { cwd: "/x" } });
  const { home, ctx } = withRollout(nm, body);
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), null);
  rmSync(home, { recursive: true, force: true });
});

test("EOF landing exactly on MAX_HEAD_BYTES still resolves (probe distinguishes it)", () => {
  const nm = ROLLOUT + "4";
  const cwd = "/Users/testuser/Developer/exact";
  const LINE = MAX_HEAD_BYTES / 4 - 1; // 4 x (LINE + "\n") == MAX_HEAD_BYTES exactly
  // Line 1 is a real session_meta padded to LINE bytes; lines 2-4 are filler.
  const base = JSON.stringify({ type: "session_meta", payload: { cwd, pad: "" } });
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { cwd, pad: "a".repeat(LINE - base.length) },
  });
  assert.equal(Buffer.byteLength(meta), LINE, "fixture line must be exactly the cap quarter");
  const body = meta + "\n" + ("z".repeat(LINE) + "\n").repeat(3);
  assert.equal(Buffer.byteLength(body), MAX_HEAD_BYTES, "fixture must end exactly on the cap");

  const { home, ctx } = withRollout(nm, body);
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd);
  rmSync(home, { recursive: true, force: true });
});

// usage.py returns from line 1 without ever reading line 3, so a bound tripped later must
// not retract an answer already found (code review R2).
test("a valid session_meta on line 1 wins even when a later line is oversized", () => {
  const nm = ROLLOUT + "5";
  const cwd = "/Users/testuser/Developer/early";
  const body =
    JSON.stringify({ type: "session_meta", payload: { cwd } }) +
    "\n" +
    "{}\n" +
    "x".repeat(MAX_LINE_BYTES + 1) +
    "\n";
  const { home, ctx } = withRollout(nm, body);
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd);
  rmSync(home, { recursive: true, force: true });
});

// codexCwd returns from inside `for (const line of headLines(...))`, abandoning the
// generator mid-iteration. That must still run its `finally` and close the fd — if it did
// not, a real run over thousands of sessions would die with EMFILE.
test("abandoning the line generator early does not leak file descriptors", () => {
  const nm = ROLLOUT + "a";
  const cwd = "/Users/testuser/Developer/leak";
  // Two lines, so resolving on line 1 always leaves the generator unfinished.
  const meta = JSON.stringify({ type: "session_meta", payload: { cwd } });
  const { home, ctx } = withRollout(nm, meta + "\n" + meta + "\n");
  const openFds = () => readdirSync("/dev/fd").length;
  try {
    assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd); // warm up
    const before = openFds();
    for (let i = 0; i < 500; i++) {
      assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd);
    }
    const after = openFds();
    // A leak would be +500 here; allow a couple of descriptors of ambient noise.
    assert.ok(after - before <= 2, `descriptor leak: ${before} -> ${after} over 500 calls`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("universal newlines: \\r\\n and a lone \\r both terminate a line", () => {
  const cwd = "/Users/testuser/Developer/crlf";
  const meta = JSON.stringify({ type: "session_meta", payload: { cwd } });
  for (const [suffix, sep] of [["6", "\r\n"], ["7", "\r"]]) {
    const nm = ROLLOUT + suffix;
    const { home, ctx } = withRollout(nm, "{}" + sep + meta + sep);
    assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd, `separator ${JSON.stringify(sep)}`);
    rmSync(home, { recursive: true, force: true });
  }
});

// Python's strict utf-8 raises UnicodeDecodeError, which `except OSError` does NOT catch,
// so Python exits non-zero. Substituting U+FFFD would yield a corrupted but TRUSTED cwd.
test("malformed UTF-8 fails loud instead of yielding a replacement-character cwd", () => {
  const nm = ROLLOUT + "8";
  const home = mkdtempSync(join(tmpdir(), "codexbad-"));
  const dated = join(home, "sessions", "2026", "01", "01");
  mkdirSync(dated, { recursive: true });
  const good = Buffer.from(JSON.stringify({ type: "session_meta", payload: { cwd: "/x/" } }));
  // Splice a bare 0x80 continuation byte into the cwd value.
  const bad = Buffer.concat([good.subarray(0, good.length - 3), Buffer.from([0x80]), good.subarray(good.length - 3)]);
  writeFileSync(join(dated, nm + ".jsonl"), Buffer.concat([bad, Buffer.from("\n")]));
  const ctx = mkCtx({ codexHome: home });
  assert.throws(() => codexCwd(ctx, nm, "2026/01/01"), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /not valid UTF-8/);
    return true;
  });
  rmSync(home, { recursive: true, force: true });
});

test("a leading BOM is preserved, so the line fails to parse exactly as in Python", () => {
  const nm = ROLLOUT + "9";
  const cwd = "/Users/testuser/Developer/bom";
  const meta = JSON.stringify({ type: "session_meta", payload: { cwd } });
  // Line 1 is BOM-prefixed (unparseable in both languages); line 2 is clean.
  const { home, ctx } = withRollout(nm, "﻿" + meta + "\n" + meta + "\n");
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd);
  rmSync(home, { recursive: true, force: true });
});

// A trailing CR is an unresolved terminator, not payload. Counting it rejected a line of
// exactly MAX_LINE_BYTES whose CR happened to land on a chunk boundary (code review R3).
// The fixture is built so the buffer ends on that CR after a whole number of 64 KiB reads.
test("a line of exactly MAX_LINE_BYTES ending in CR at a chunk boundary is accepted", () => {
  const nm = ROLLOUT + "b";
  const CHUNK = 64 * 1024;
  const cwd = "/Users/testuser/Developer/crcap";
  const meta = JSON.stringify({ type: "session_meta", payload: { cwd } });
  // Line 1 consumes 65535 bytes so that after 17 chunks the buffer holds exactly
  // MAX_LINE_BYTES payload + one unresolved CR.
  const line1 = "a".repeat(CHUNK - 2) + "\n";
  const body = line1 + "b".repeat(MAX_LINE_BYTES) + "\r\n" + meta + "\n";
  assert.equal(Buffer.byteLength(line1), CHUNK - 1);
  assert.equal(Buffer.byteLength(line1) + MAX_LINE_BYTES + 1, 17 * CHUNK, "CR must end read 17");

  const { home, ctx } = withRollout(nm, body);
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd);
  rmSync(home, { recursive: true, force: true });
});

// The budget-exhaustion path must still distinguish EOF-at-the-cap from more-input, or an
// unterminated final line landing exactly on the cap is silently dropped (code review R3).
test("an unterminated 5th line ending exactly at MAX_HEAD_BYTES is still read", () => {
  const nm = ROLLOUT + "c";
  const cwd = "/Users/testuser/Developer/lastline";
  const base = JSON.stringify({ type: "session_meta", payload: { cwd, pad: "" } });
  // Final line is exactly MAX_LINE_BYTES; the four before it fill the rest of the cap.
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { cwd, pad: "a".repeat(MAX_LINE_BYTES - base.length) },
  });
  assert.equal(Buffer.byteLength(meta), MAX_LINE_BYTES);
  const fillerLen = (MAX_HEAD_BYTES - MAX_LINE_BYTES) / 4 - 1;
  const body = ("z".repeat(fillerLen) + "\n").repeat(4) + meta;
  assert.equal(Buffer.byteLength(body), MAX_HEAD_BYTES, "fixture must end exactly on the cap");

  const { home, ctx } = withRollout(nm, body);
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd);
  rmSync(home, { recursive: true, force: true });
});

test("a multibyte character straddling the 64 KiB read boundary is not corrupted", () => {
  const nm = ROLLOUT + "3";
  const CHUNK = 64 * 1024;
  const cwd = "/Users/testuser/Developer/café-プロジェクト";
  const needle = Buffer.from("é", "utf8"); // 2 bytes — must be split across the boundary
  const line = (padLen) =>
    JSON.stringify({ type: "session_meta", payload: { pad: "a".repeat(padLen), cwd } });

  // Solve for the padding that puts the first byte of 'é' at the last byte of chunk 1.
  let padLen = CHUNK;
  for (let i = 0; i < 4; i++) {
    const idx = Buffer.from(line(padLen), "utf8").indexOf(needle);
    if (idx === CHUNK - 1) break;
    padLen += CHUNK - 1 - idx;
  }
  const buf = Buffer.from(line(padLen), "utf8");
  assert.equal(buf.indexOf(needle), CHUNK - 1, "fixture must actually straddle the boundary");

  const { home, ctx } = withRollout(nm, buf.toString("utf8") + "\n");
  assert.equal(codexCwd(ctx, nm, "2026/01/01"), cwd, "cwd must survive byte-exact");
  rmSync(home, { recursive: true, force: true });
});
