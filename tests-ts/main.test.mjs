/**
 * The CLI entry point and the argparse port, at unit level.
 *
 * The 51 parser and help differential cases in `parity.mjs` already hold this to CPython
 * byte-for-byte, so these tests deliberately do NOT re-assert argparse's text. They cover
 * what a differential against a fixed `prog` cannot reach:
 *
 *  - the product-name parameterisation, which by construction has no oracle — the shipped
 *    `spendbar` output differs from every golden on purpose (ALLOWLIST 22)
 *  - the namespace-to-renderer mapping, where an absent option must stay absent
 *  - `main`'s exit-code and stream contract
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { main, COMMANDS, SUBCOMMANDS } from "../dist/main.js";
import { createDeps } from "../dist/context.js";
import { formatUsage, parseArgs, rewriteArgv, ArgparseError, HelpRequested } from "../dist/argparse.js";
import { renderDoc, renderTopHelp } from "../dist/help.js";

const stubDeps = (payload = {}) =>
  createDeps({ CCUSAGE_CMD: "stub" }, "/Users/testuser", () => ({
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }), { today: () => "20260715" });

const run = (argv, extra = {}) => {
  const out = [];
  const err = [];
  const code = main({
    argv,
    prog: "usage",
    today: () => "20260715",
    env: {},
    deps: stubDeps(),
    stdout: (c) => out.push(c),
    stderr: (c) => err.push(c),
    ...extra,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
};

test("the parser definition matches usage.py's, in declaration order", () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), [...SUBCOMMANDS]);
  // The two --metric choice lists are in DIFFERENT orders, and argparse reproduces each
  // verbatim. Sharing one list is the natural mistake and it breaks two goldens.
  const metric = (name) => COMMANDS.find((c) => c.name === name).options.find((o) => o.dest === "metric").choices;
  assert.deepEqual(metric("projects"), ["tokens", "cost", "both"]);
  assert.deepEqual(metric("daily"), ["cost", "tokens", "both"]);
  assert.notDeepEqual(metric("projects"), metric("daily"));
});

describe("product-name parameterisation (plan section 9)", () => {
  const def = (prog) => ({
    prog,
    commands: COMMANDS,
    width: 80,
    topHelp: (usage) => renderTopHelp(prog, usage, COMMANDS, 80),
  });

  test("prog changes the usage line AND its continuation indent, not just the word", () => {
    const asUsage = formatUsage("usage projects", COMMANDS[0].options, [], 80);
    const asSpendbar = formatUsage("spendbar projects", COMMANDS[0].options, [], 80);
    const indentOf = (s) => s.split("\n")[1].match(/^ */)[0].length;
    assert.equal(indentOf(asUsage), 22);
    assert.equal(indentOf(asSpendbar), 25, "continuation aligns under the longer prog");
  });

  test("the shipped help names spendbar and never the oracle name", () => {
    const doc = renderDoc("spendbar");
    assert.match(doc, /spendbar projects \[--since D\]/);
    assert.doesNotMatch(doc, /^usage — /m);
    assert.doesNotMatch(doc, /\busage (projects|daily|share|compare|blocks|hourly|alltime|codex|combined)\b/);
  });

  test("ordinary English containing the word 'usage' survives the substitution", () => {
    // The trap: a blanket s/usage/spendbar/ corrupts six goldens. These spans are prose.
    const r = run(["projects"], {
      prog: "spendbar",
      deps: stubDeps({ projects: { p: [{ date: "2026-01-01", totalCost: 1, totalTokens: 2, modelBreakdowns: [] }] }, totals: { totalCost: 1 } }),
    });
    assert.match(r.stdout, /^Per-project usage /);
  });

  test("the alltime hint points at the shipped name", () => {
    const payload = { projects: { p: [{ date: "2026-01-01", totalCost: 1, totalTokens: 2, modelBreakdowns: [] }] }, totals: { totalCost: 1 } };
    assert.match(run(["alltime"], { prog: "spendbar", deps: stubDeps(payload) }).stdout, /see 'spendbar codex'/);
    assert.match(run(["alltime"], { deps: stubDeps(payload) }).stdout, /see 'usage codex'/);
  });

  test("the config sentence is corrected, not copied (ALLOWLIST 22)", () => {
    const doc = renderDoc("spendbar");
    assert.match(doc, /from ~\/\.config\/spendbar\/config\.json/);
    assert.doesNotMatch(doc, /usage-config\.json next to this/);
  });

  test("prog is not readable from the environment in either direction", () => {
    // `-h`, not `alltime`: the no-data path renders no program name at all, so it would pass
    // even if main DID read the environment (code review R1). Help renders prog many times.
    const r = run(["-h"], { env: { PROG: "evil", SPENDBAR_PROG: "evil" }, deps: stubDeps() });
    assert.match(r.stdout, /^usage: usage \[-h\]/);
    assert.match(r.stdout, /^  usage projects /m);
    assert.doesNotMatch(r.stdout + r.stderr, /evil/);
  });

  test("parseArgs threads prog into every error it can raise", () => {
    for (const [argv, needle] of [
      [[], "usage: spendbar ["],
      [["frobnicate"], "spendbar: error:"],
      [["compare"], "usage: spendbar compare"],
    ]) {
      try {
        parseArgs(def("spendbar"), argv);
        assert.fail(`${JSON.stringify(argv)} should have raised`);
      } catch (e) {
        assert.ok(e instanceof ArgparseError, `${JSON.stringify(argv)}: ${e}`);
        assert.ok(e.render().includes(needle), `expected ${needle} in:\n${e.render()}`);
      }
    }
  });
});

describe("the argparse namespace reaches the renderers intact", () => {
  test("an absent option stays absent, matching a None default", () => {
    const { opts } = parseArgs(
      { prog: "usage", commands: COMMANDS, width: 80, topHelp: () => "" },
      ["projects", "--since", "20260101"],
    );
    assert.deepEqual(opts, { since: "20260101" });
    assert.equal("until" in opts, false, "an unsupplied option must not appear as a key");
  });

  test("an EMPTY --since is supplied-but-falsy, which usage.py treats as unset", () => {
    const { opts } = parseArgs(
      { prog: "usage", commands: COMMANDS, width: 80, topHelp: () => "" },
      ["projects", "--since", ""],
    );
    assert.deepEqual(opts, { since: "" });
    // usage.py's guard is `if a.since:` — the window label therefore reads "(all time)".
    const r = run(["projects", "--since", ""], {
      deps: stubDeps({ projects: { p: [{ date: "2026-01-01", totalCost: 1, totalTokens: 2, modelBreakdowns: [] }] }, totals: { totalCost: 1 } }),
    });
    assert.match(r.stdout, /\(all time\)/);
  });

  test("the last occurrence of a repeated option wins", () => {
    const { opts } = parseArgs(
      { prog: "usage", commands: COMMANDS, width: 80, topHelp: () => "" },
      ["projects", "--since", "20260101", "--since", "20260102"],
    );
    assert.equal(opts.since, "20260102");
  });
});

describe("rewriteArgv", () => {
  test("a relative date is attached only for an EXACT date-option name", () => {
    assert.deepEqual(rewriteArgv(["projects", "--since", "-3d"]), ["projects", "--since=-3d"]);
    // Measured: `--s -3d` is NOT rewritten, because the gate is exact-token membership, and
    // argparse then rejects the bare `-3d` as an option. Rewriting after resolving the
    // abbreviation would be more correct than the oracle, and therefore wrong.
    assert.deepEqual(rewriteArgv(["projects", "--s", "-3d"]), ["projects", "--s", "-3d"]);
  });

  test("every date option is covered, and non-date options are not", () => {
    for (const o of ["--since", "--until", "--vs", "--date", "--day1", "--day2"]) {
      assert.deepEqual(rewriteArgv([o, "-1d"]), [`${o}=-1d`]);
    }
    assert.deepEqual(rewriteArgv(["--metric", "-1d"]), ["--metric", "-1d"]);
  });

  test("only a whole -Nd token is rewritten", () => {
    for (const v of ["-3x", "-d", "--3d", "3d", "-3.5d", "-"]) {
      assert.deepEqual(rewriteArgv(["--since", v]), ["--since", v], `should not rewrite ${v}`);
    }
  });

  test("Python's \\\\d is Unicode Nd, not ASCII, so an Arabic-Indic digit rewrites (ISS-016)", () => {
    // Verified against the oracle: re.fullmatch(r"-\d+d", "-١d") matches, and int("١") == 1,
    // so this really does resolve to yesterday rather than erroring downstream.
    assert.deepEqual(rewriteArgv(["--since", "-١d"]), ["--since=-١d"]);
    assert.deepEqual(rewriteArgv(["--since", "-1١d"]), ["--since=-1١d"], "\\d+ spans scripts");
  });

  test("the Nd test is CPython 14.0's table, NOT V8's newer \\\\p{Nd} (code review R3)", () => {
    // U+10D40 GARAY DIGIT ZERO is Nd in V8's database and NOT in the pinned CPython 14.0 one
    // — one of 100 such code points, measured. Python does not rewrite it, so neither may we:
    // swapping isDecimalDigit for /\p{Nd}/u would turn an argparse error into a date.
    // It is also astral, so this pins code-point iteration rather than UTF-16 units.
    assert.match("\u{10D40}", /\p{Nd}/u, "guard: this must stay a V8-only Nd for the test to bite");
    assert.deepEqual(rewriteArgv(["--since", "-\u{10D40}d"]), ["--since", "-\u{10D40}d"]);
  });
});

describe("main's exit and stream contract", () => {
  test("help goes to stdout and exits 0", () => {
    const r = run(["-h"]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^usage: usage \[-h\]/);
  });

  test("a parse failure goes to stderr and exits 2", () => {
    const r = run(["frobnicate"]);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^usage: usage \[-h\]/);
    assert.match(r.stderr, /usage: error: argument cmd: invalid choice: 'frobnicate'/);
  });

  test("a deps failure is one stderr line and exit 1, like CPython's sys.exit(msg)", () => {
    const r = run(["alltime"], { env: { CCUSAGE_CMD: "" }, deps: undefined });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    // Exactly one line. `/.*\n$/s` would accept a stack trace too, because dotAll lets `.*`
    // swallow newlines — the assertion has to count them (code review R1).
    assert.equal(r.stderr.split("\n").length, 2, `expected one line, got ${JSON.stringify(r.stderr)}`);
    assert.ok(r.stderr.endsWith("\n"));
    assert.match(r.stderr, /^internal: no ccusage command available\./);
  });

  test("HelpRequested is not an error type, so it cannot be reported as a failure", () => {
    assert.ok(!(new HelpRequested("x") instanceof ArgparseError));
  });
});
