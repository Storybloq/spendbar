/**
 * Negative contract tests for every comparison policy.
 *
 * A policy WAIVES a byte comparison. What makes that defensible is not the waiver but the
 * assertions that replace it — and "the policy executes its replacement assertions" is not
 * something structural validation can establish. A handler that quietly dropped a predicate,
 * or that returned success unconditionally, would register perfectly well and pass every
 * check in `assertRegistry`. That is the same "code exists, therefore it ran" evidence the
 * `dual_run_only` flag used to offer.
 *
 * So each policy is fed synthetic run pairs that violate exactly ONE predicate, and is
 * required to reject every one. Synthetic rather than recorded, because a recorded pair
 * varies in several ways at once and could not isolate which predicate did the rejecting —
 * a test that passes for the wrong reason is how a dropped predicate survives.
 *
 * Each case also carries a POSITIVE control: the same pair with the violation removed must
 * be accepted. Without it, a policy that rejected everything unconditionally would score a
 * perfect result here while asserting nothing at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { POLICIES, NON_EXACT_POLICIES, SANCTIONED_STDOUT_REWRITE } from "./harness/policies.mjs";
import { rawCaseProblems, parseWaiverScopes } from "./harness/cases.mjs";

const exit = (status) => ({ kind: "exit", status, signal: null, code: null });

/**
 * A non-exit termination, in the shape `run.mjs`'s `classify` actually produces.
 *
 * `status` is null and cannot be anything else — that is the whole reason the policies need
 * no separate "did it crash" predicate. Writing `{kind: "signal", status: 1}` here would be
 * more convenient for isolating a branch, and would test an input no subject can ever
 * produce; a test whose fixture is unreachable proves nothing about the code that runs.
 */
const signalled = (signal = "SIGSEGV") => ({ kind: "signal", status: null, signal, code: null });

const run = (stdout, stderr, termination = exit(1)) => ({
  stdout: Buffer.from(stdout, "utf8"),
  stderr: Buffer.from(stderr, "utf8"),
  termination: typeof termination === "number" ? exit(termination) : termination,
});

/** Shallow copies, which is all that is needed: `run` mints fresh Buffers and no policy mutates. */
const pair = (py, ts) => ({ py: { ...py }, ts: { ...ts } });

function rejects(policy, py, ts, c, why) {
  assert.throws(
    () => policy.differential(py, ts, c),
    (e) => e instanceof Error,
    `${policy.id} accepted a pair it must reject: ${why}`,
  );
}

function accepts(policy, py, ts, c, why) {
  policy.differential(py, ts, c); // throws on failure
  assert.ok(true, why);
}

describe("every non-exact policy is registered AND enforces its predicates", () => {
  test("the set of non-exact policies is not empty", () => {
    // If policies were ever collapsed into one, this file would silently test nothing.
    assert.ok(NON_EXACT_POLICIES.length >= 3, `only ${NON_EXACT_POLICIES.length} non-exact policies`);
  });

  test("every policy declares a waiverId, and only `exact` declares null", () => {
    for (const [id, p] of Object.entries(POLICIES)) {
      if (id === "exact") assert.equal(p.waiverId, null, "exact must consume no waiver");
      else assert.ok(typeof p.waiverId === "string" && p.waiverId, `${id} declares no waiverId`);
    }
  });
});

describe("ts-diag: a waived stderr must still be the port's one-line diagnostic", () => {
  const policy = POLICIES["ts-diag:invalid-date"];
  const c = { name: "synthetic", argv: ["hourly"], expectExit: 1 };
  const goodTsErr = "invalid --date: 'bogus'\n";
  const pyErr = "Traceback (most recent call last):\n  File \"/usr/lib/python3.13/x.py\", line 1\nValueError\n";

  test("positive control: a well-formed pair is accepted", () => {
    const { py, ts } = pair(run("", pyErr), run("", goodTsErr));
    accepts(policy, py, ts, c, "the control pair must pass or every rejection below is meaningless");
  });

  test("rejects an empty TS diagnostic", () => {
    const { py, ts } = pair(run("", pyErr), run("", ""));
    rejects(policy, py, ts, c, "empty stderr");
  });

  test("rejects an empty PYTHON diagnostic", () => {
    // The oracle half of the waiver: if python stops emitting a traceback, ALLOWLIST 19
    // describes a behaviour that no longer exists.
    const { py, ts } = pair(run("", ""), run("", goodTsErr));
    rejects(policy, py, ts, c, "python emitted nothing");
  });

  test("rejects a multi-line TS diagnostic (a traceback smuggled through)", () => {
    const { py, ts } = pair(run("", pyErr), run("", "invalid --date: 'x'\n  at foo (bar.js:1)\n"));
    rejects(policy, py, ts, c, "two lines");
  });

  test("rejects a diagnostic that is not newline-terminated", () => {
    // Deliberately NOT the obvious `"invalid --date: 'x'"` — that has no newline at all, so
    // the one-line check rejects it first and this test would pass while the termination
    // check was deleted. Measured: dropping `endsWith("\n")` left that version green.
    //
    // This input splits into exactly two parts, so it satisfies the one-line check, and the
    // pattern matches — only the missing terminator is wrong. A diagnostic that runs into
    // the next write without ending its line is a real shape the port must not emit.
    const { py, ts } = pair(run("", pyErr), run("", "invalid --date: 'x'\ntrailing"));
    rejects(policy, py, ts, c, "no trailing newline");
  });

  test("rejects a one-line diagnostic that does not match the pattern", () => {
    // "non-empty stderr" alone would accept a module-load failure or an unrelated stack.
    const { py, ts } = pair(run("", pyErr), run("", "Error: cannot find module 'foo'\n"));
    rejects(policy, py, ts, c, "wrong diagnostic");
  });

  test("rejects stdout on a failure path, from either side", () => {
    const pyWrote = pair(run("partial table\n", pyErr), run("", goodTsErr));
    rejects(policy, pyWrote.py, pyWrote.ts, c, "python stdout");
    const tsWrote = pair(run("", pyErr), run("half a table\n", goodTsErr));
    rejects(policy, tsWrote.py, tsWrote.ts, c, "ts stdout");
  });

  test("rejects a disagreeing exit status even though stderr is waived", () => {
    // Waiving stderr must cost exactly stderr. The termination is still compared.
    const { py, ts } = pair(run("", pyErr, 1), run("", goodTsErr, 2));
    rejects(policy, py, ts, c, "exit 1 vs 2");
  });

  test("rejects when python's exit disagrees with the transcribed expectExit", () => {
    const { py, ts } = pair(run("", pyErr, 3), run("", goodTsErr, 3));
    rejects(policy, py, ts, c, "python exited 3, case declares 1");
  });

  test("a crashed oracle is rejected, and reported as a crash rather than as an exit code", () => {
    // Two things are asserted here, and the second is the one that makes this test kill a
    // mutation. The VERDICT is over-determined: a signalled python has `status: null`, an
    // integer `expectExit` can never equal null, so the status comparison rejects this pair
    // even with the `kind` branch deleted. What only the `kind` branch produces is the
    // WORDING — and "python now exits null" would send a reader looking for an exit-code bug
    // in a run where the oracle was killed by a signal.
    const { py, ts } = pair(run("", pyErr, signalled("SIGSEGV")), run("", goodTsErr));
    assert.throws(
      () => policy.differential(py, ts, c),
      (e) => {
        assert.match(e.message, /killed by SIGSEGV/, "the diagnostic must name the signal");
        assert.doesNotMatch(e.message, /exits null/, "it must not describe a crash as an exit code");
        return true;
      },
    );
  });

  test("the two ts-diag policies do not accept each other's diagnostics", () => {
    // Otherwise one pattern could be deleted and the other would cover for it.
    const other = POLICIES["ts-diag:blocks-array-attr"];
    const { py, ts } = pair(run("", pyErr), run("", goodTsErr));
    rejects(other, py, ts, c, "invalid-date text under the blocks-array policy");
  });

  test("blocks-array-attr accepts its OWN diagnostic", () => {
    // Without this the policy is only ever asked to reject, so an unsatisfiable pattern —
    // or a handler that refused everything — would pass every test that names it.
    const other = POLICIES["ts-diag:blocks-array-attr"];
    const { py, ts } = pair(run("", pyErr), run("", "'list' object has no attribute 'get'\n"));
    accepts(other, py, ts, c, "its own pattern must be reachable");
  });
});

describe("partial-python-stdout: both streams waived, so the SHAPE carries the contract", () => {
  const policy = POLICIES["partial-python-stdout"];
  const c = { name: "synthetic", argv: ["blocks"], expectExit: 1 };
  const good = () => pair(run("Active blocks header\n", "TypeError: ...\n", 1), run("", "cost is not numeric\n", 1));

  test("positive control: python partial + port silent is accepted", () => {
    const { py, ts } = good();
    accepts(policy, py, ts, c, "control");
  });

  test("rejects python emitting nothing before dying", () => {
    // ALLOWLIST 23's premise. If it stops holding, the entry needs revisiting rather than
    // the case quietly continuing to pass.
    const { py, ts } = pair(run("", "TypeError: ...\n", 1), run("", "cost is not numeric\n", 1));
    rejects(policy, py, ts, c, "no partial output");
  });

  test("rejects the port half-writing a table", () => {
    const { py, ts } = pair(run("header\n", "TypeError\n", 1), run("header\n", "cost is not numeric\n", 1));
    rejects(policy, py, ts, c, "port wrote to stdout");
  });

  test("rejects either side failing without diagnosing", () => {
    const pySilent = pair(run("h\n", "", 1), run("", "msg\n", 1));
    rejects(policy, pySilent.py, pySilent.ts, c, "python silent");
    const tsSilent = pair(run("h\n", "err\n", 1), run("", "", 1));
    rejects(policy, tsSilent.py, tsSilent.ts, c, "port silent");
  });

  test("rejects a port killed by a signal, even though its stdout is correctly empty", () => {
    // A crashed port satisfies every other predicate this policy asserts — it wrote no
    // stdout, python wrote partial output, both produced stderr. Only the termination
    // comparison stands between "the port declined to half-write a table" and "the port
    // segfaulted", and those must not be recorded as the same result.
    const { py, ts } = pair(run("header\n", "TypeError\n", 1), run("", "boom\n", signalled("SIGKILL")));
    assert.throws(
      () => policy.differential(py, ts, c),
      (e) => {
        assert.match(e.message, /killed by SIGKILL/, "a crashed port must be named as crashed");
        return true;
      },
    );
  });

  test("rejects the port SUCCEEDING where the oracle failed", () => {
    // The regression this policy exists for: an earlier port returned 0 for a non-numeric
    // cost, rendering $0.00 and exiting 0 — a loud failure turned into a plausible wrong
    // number, which is strictly worse than either behaviour.
    const { py, ts } = pair(run("header\n", "TypeError\n", 1), run("", "warning\n", 0));
    rejects(policy, py, ts, c, "port exited 0");
  });

  test("guard: this policy really does waive the byte comparison", () => {
    // Otherwise the rejections above might be byte differences, not shape violations, and
    // the four replacement assertions would be untested.
    const { py, ts } = good();
    assert.notEqual(py.stdout.toString(), ts.stdout.toString(), "premise: the streams differ");
    assert.notEqual(py.stderr.toString(), ts.stderr.toString(), "premise: the streams differ");
    accepts(policy, py, ts, c, "differing bytes are accepted; only the shape is asserted");
  });
});

describe("help-config-path: one sanctioned span, everything else byte-frozen", () => {
  const policy = POLICIES["help-config-path"];
  const c = { name: "synthetic", argv: ["--help"], expectExit: 0 };
  const { from, to } = SANCTIONED_STDOUT_REWRITE;

  test("positive control: the rewritten span is accepted", () => {
    const { py, ts } = pair(run(`head ${from} tail`, "", 0), run(`head ${to} tail`, "", 0));
    accepts(policy, py, ts, c, "control");
  });

  test("rejects output that no longer contains the sanctioned span", () => {
    // The span vanishing means the waiver is being applied to text it was never granted for.
    const { py, ts } = pair(run("head tail", "", 0), run("head tail", "", 0));
    rejects(policy, py, ts, c, "span absent");
  });

  test("rejects a difference OUTSIDE the sanctioned span", () => {
    // The whole reason this is a rewrite rather than a blanket stdout waiver: the other
    // ~3.2 KB of help text must still be frozen.
    const { py, ts } = pair(run(`head ${from} tail`, "", 0), run(`HEAD ${to} tail`, "", 0));
    rejects(policy, py, ts, c, "text outside the span changed");
  });

  test("rejects a duplicated span, where the rewrite would be ambiguous", () => {
    // The TS side deliberately carries the rewritten span once and the PYTHON span once.
    //
    // The obvious input — both spans rewritten on the TS side — does not test this check at
    // all: `String.replace` rewrites only the first occurrence, so python becomes
    // "<to> mid <from>", that differs from "<to> mid <to>", and the ordinary byte comparison
    // rejects it. Measured: deleting the duplicate check left that version green.
    //
    // With this input the rewrite produces EXACTLY the TS bytes, so byte equality holds and
    // the duplicate check is the only thing objecting. What it is objecting to is real: a
    // port whose help text still contains Python's config sentence in a second position is
    // shipping documentation that points users at a file it never reads, which is the whole
    // reason ALLOWLIST 22 exists rather than being a `prog` swap.
    const { py, ts } = pair(run(`${from} mid ${from}`, "", 0), run(`${to} mid ${from}`, "", 0));
    rejects(policy, py, ts, c, "two occurrences");
  });

  test("rejects a stderr difference even though stdout is rewritten", () => {
    const { py, ts } = pair(run(`x ${from} y`, "", 0), run(`x ${to} y`, "unexpected\n", 0));
    rejects(policy, py, ts, c, "stderr diverged");
  });
});

describe("the registry rule the policies now lean on", () => {
  // `partial-python-stdout` no longer carries a `kind !== "exit"` check, and
  // `pythonTerminatedAsTranscribed` no longer tolerates an absent `expectExit`. Both rest on
  // one registry guarantee: the transcribed exit is an INTEGER, so it can never equal the
  // `null` status that `classify` gives a signalled or failed-to-spawn subject. If that
  // guarantee is not enforced, removing those checks opened a hole rather than deleting dead
  // code — so it is tested here, beside the policies that depend on it, rather than left to
  // be true of the current registry by luck.
  const wellFormed = {
    name: "synthetic", capability: "hourly", argv: ["hourly"], mode: "claude", extraEnv: {},
    codexFixture: false, expectExit: 0, storedGolden: false, comparisonPolicy: "exact", waiver: null,
  };

  test("control: a well-formed record raises nothing", () => {
    assert.deepEqual(rawCaseProblems([wellFormed]), []);
  });

  for (const bad of [null, "0", 1.5, undefined]) {
    test(`rejects expectExit: ${JSON.stringify(bad)}`, () => {
      // `null` is the dangerous one — it is what a hand-edited registry most plausibly grows,
      // and it is exactly the value that would compare equal to a crashed subject's status.
      const problems = rawCaseProblems([{ ...wellFormed, expectExit: bad }]);
      assert.equal(problems.length, 1, `expected exactly one problem, got ${JSON.stringify(problems)}`);
      assert.match(problems[0], /expectExit must be an integer/);
    });
  }

  test("an omitted expectExit is caught as a missing field, not silently accepted", () => {
    const { expectExit, ...withoutIt } = wellFormed;
    const problems = rawCaseProblems([withoutIt]);
    assert.ok(problems.some((p) => /omits required field 'expectExit'/.test(p)), JSON.stringify(problems));
  });

  // Types, not just presence. Each of these feeds something that would otherwise accept the
  // wrong shape in silence (code review R2).
  for (const [field, bad, want] of [
    // The measured one: `codexFixture` is read for TRUTHINESS, so the string "false" sets
    // CODEX_HOME on both implementations. The case then agrees with itself perfectly while
    // running the opposite fixture from the one it names.
    ["codexFixture", "false", /codexFixture must be a boolean/],
    ["codexFixture", 0, /codexFixture must be a boolean/],
    ["storedGolden", "true", /storedGolden must be a boolean/],
    ["mode", "", /mode must be a non-empty string/],
    ["mode", null, /mode must be a non-empty string/],
    ["extraEnv", [], /extraEnv must be an object/],
    // Values, not just the container: extraEnv is merged into a subprocess environment, where
    // a null arrives as the four characters "null" rather than as an error.
    ["extraEnv", { CCUSAGE_CMD: null }, /extraEnv must be an object whose values are all strings/],
    ["extraEnv", { FAKE_MODE: 3 }, /extraEnv must be an object whose values are all strings/],
    ["argv", "projects", /argv must be an array of strings/],
    // A non-string member is a different failure entirely once it reaches a subprocess
    // argument list, and `argv` is spread straight into one.
    ["argv", ["projects", 3], /argv must be an array of strings/],
  ]) {
    test(`rejects ${field}: ${JSON.stringify(bad)}`, () => {
      const problems = rawCaseProblems([{ ...wellFormed, [field]: bad }]);
      assert.ok(problems.some((p) => want.test(p)), `got ${JSON.stringify(problems)}`);
    });
  }
});

describe("allowlist scope parsing — the check that used to only look for an ID string", () => {
  // The published-waiver check once asked whether "[ALLOWLIST-19]" appeared anywhere in a
  // 500-line document. It did, so `argv_blocks_array` cited an entry scoped to
  // `hourly --date` for years without objection (code review R2). These tests pin the parser
  // that replaced it, because a scope check that silently parses NOTHING degrades to exactly
  // the old behaviour: every scope empty, every comparison vacuously in agreement.
  const DOC = [
    "19. `[ALLOWLIST-19]` **Something.**",
    "",
    "    **Cases covered by `[ALLOWLIST-19]`:** `case_a`, `case_b`,",
    "    `case_c`",
    "",
    "    Trailing prose that mentions `not_a_case` and must not be swept in.",
    "",
    "23. `[ALLOWLIST-23]` **Another.**",
    "",
    "    **Cases covered by `[ALLOWLIST-23]`:** `case_d`",
    "",
  ].join("\n");

  test("parses one entry's cases, including across a wrapped line", () => {
    const scopes = parseWaiverScopes(DOC);
    assert.deepEqual([...(scopes.get("ALLOWLIST-19") ?? [])].sort(), ["case_a", "case_b", "case_c"]);
  });

  test("stops at the blank line, so following prose is not absorbed as scope", () => {
    // Without a terminator the parser would swallow the rest of the document and every case
    // name in it would read as authorised — the failure mode that looks like a passing check.
    assert.ok(!parseWaiverScopes(DOC).get("ALLOWLIST-19").has("not_a_case"));
  });

  test("keeps separate entries separate", () => {
    const scopes = parseWaiverScopes(DOC);
    assert.deepEqual([...scopes.get("ALLOWLIST-23")], ["case_d"]);
    assert.ok(!scopes.get("ALLOWLIST-23").has("case_a"));
  });

  test("a second scope declaration for one ID is REFUSED, not silently preferred", () => {
    // Overwriting would leave the exact set comparison validating only the last declaration,
    // so a document publishing two different scopes for one entry would pass while being
    // ambiguous about what it authorises (code review R3).
    const dup = [
      "**Cases covered by `[ALLOWLIST-19]`:** `case_a`",
      "",
      "**Cases covered by `[ALLOWLIST-19]`:** `case_b`",
      "",
    ].join("\n");
    assert.throws(() => parseWaiverScopes(dup), /declares the scope of ALLOWLIST-19 more than once/);
  });

  test("an entry with no scope declaration is ABSENT, not empty", () => {
    // Absent and empty must not be the same state: absent means "nobody wrote a scope" and
    // has to fail loudly, where empty would read as "this entry legitimately covers nothing".
    assert.equal(parseWaiverScopes("14. `[ALLOWLIST-14]` **No scope line here.**").get("ALLOWLIST-14"), undefined);
  });

  test("the REAL document covers exactly the cases that cite each ID", async () => {
    // The end-to-end assertion, run against the committed ALLOWLIST.md and cases.json rather
    // than a fixture — this is the one that would have caught the original mis-citation.
    const { loadCases, assertWaiversArePublished } = await import("./harness/cases.mjs");
    assertWaiversArePublished(loadCases());
  });

  test("a case citing an entry that does not name it is REJECTED", async () => {
    const { assertWaiversArePublished, loadCases } = await import("./harness/cases.mjs");
    const cases = loadCases().map((c) =>
      c.name === "argv_blocks_array" ? { ...c, name: "argv_blocks_array_renamed" } : c);
    assert.throws(() => assertWaiversArePublished(cases), /published scope does not name it/);
  });

  test("an entry naming a case that no longer cites it is REJECTED", async () => {
    const { assertWaiversArePublished, loadCases } = await import("./harness/cases.mjs");
    const cases = loadCases().filter((c) => c.name !== "argv_blocks_null");
    assert.throws(() => assertWaiversArePublished(cases), /claims to cover argv_blocks_null/);
  });
});

describe("assertRegistry's mapped-record rules actually reject", () => {
  // `rawCaseProblems` was split out so it could be handed malformed records; its siblings were
  // not, and the stated reason was that `assertRegistry` reads the real registry and goldens
  // directory so a negative test cannot reach it. Code review R4 showed that argument is
  // wrong: the raw pass reads the module-level REGISTRY and contributes nothing to a synthetic
  // call, so the mapped rules isolate cleanly. R4 verified they are sound — but "verified once
  // by a reviewer" is not a test, and these rules are the ones that decide whether a waiver
  // may be applied at all.
  const base = {
    name: "synthetic", capability: "render:alltime", argv: ["alltime"], mode: "normal",
    extraEnv: {}, codexFixture: false, expectExit: 0, storedGolden: false,
    comparisonPolicy: "exact", waiver: null,
  };
  // A registry of one differential-only case cannot satisfy the capability-coverage or
  // golden-set rules, so those errors are always present; each test asserts on ITS message.
  const rejects = async (cases, pattern) => {
    const { assertRegistry } = await import("./harness/cases.mjs");
    assert.throws(() => assertRegistry(cases), pattern);
  };

  test("a waiver that its policy does not consume is rejected", () =>
    rejects([{ ...base, waiver: "ALLOWLIST-19" }], /consumes null/));

  test("a policy whose waiver is missing is rejected", () =>
    rejects([{ ...base, comparisonPolicy: "help-config-path", waiver: null }],
            /consumes "ALLOWLIST-22b"/));

  test("an unknown policy name is rejected", () =>
    rejects([{ ...base, comparisonPolicy: "no_such_policy" }], /unknown comparisonPolicy/));

  test("a policy name that collides with an Object prototype key is rejected", () =>
    // `POLICIES[c.comparisonPolicy]` is a plain property read, so "toString" would resolve to
    // a function and read as a registered policy if the lookup were not guarded.
    rejects([{ ...base, comparisonPolicy: "toString" }], /unknown comparisonPolicy/));

  test("a duplicate case name is rejected", () =>
    rejects([base, base], /duplicate case name/));

  test("an unknown capability tag is rejected", () =>
    rejects([{ ...base, capability: "render:nonexistent" }], /unknown capability/));

  test("a malformed captureAnchor on a stored case is rejected", () =>
    rejects([{ ...base, storedGolden: true, captureAnchor: "not-a-date" }], /malformed captureAnchor/));
});

describe("exact: the default policy compares everything", () => {
  const policy = POLICIES.exact;
  const c = { name: "synthetic", argv: ["projects"], expectExit: 0 };

  test("accepts identical runs and rejects each stream independently", () => {
    accepts(policy, run("out", "err", 0), run("out", "err", 0), c, "control");
    rejects(policy, run("out", "err", 0), run("OUT", "err", 0), c, "stdout");
    rejects(policy, run("out", "err", 0), run("out", "ERR", 0), c, "stderr");
    rejects(policy, run("out", "err", 0), run("out", "err", 1), c, "exit");
  });

  test("compares BYTES, not decoded strings", () => {
    // Two different byte sequences can decode to the same JS string (invalid UTF-8 becomes
    // U+FFFD), so a string comparison would report parity for output that is not identical.
    const a = { stdout: Buffer.from([0xff, 0xfe]), stderr: Buffer.alloc(0), termination: exit(0) };
    const b = { stdout: Buffer.from([0xfe, 0xff]), stderr: Buffer.alloc(0), termination: exit(0) };
    assert.equal(a.stdout.toString("utf8"), b.stdout.toString("utf8"), "premise: these decode alike");
    rejects(policy, a, b, c, "distinct invalid UTF-8");
  });
});
