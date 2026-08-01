// The strict schema guards must ACCEPT every payload the golden fixture actually emits.
// Without this, T-006's tightening would silently break T-005 (goldens wired into the TS
// suite) — the goldens only exercise Python today, so nothing else would catch it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createDeps, DEFAULT_CONFIG } from "../dist/context.js";
import { codexSessions } from "../dist/codex.js";
import {
  validateInstances,
  validateDaily,
  validateCodexSessions,
  validateCodexDaily,
} from "../dist/json.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE = join(ROOT, "tests/fake_ccusage.py");

function fixture(args, mode) {
  const out = spawnSync("python3", [FAKE, ...args], {
    encoding: "utf8",
    env: { ...process.env, FAKE_MODE: mode },
  });
  assert.equal(out.status, 0, `fake_ccusage failed for ${mode}: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

// The (branch, FAKE_MODE) matrix is DERIVED from fake_ccusage.py, not restated here (ISS-021).
//
// This table used to be written by hand, commenting itself as "every (argv, FAKE_MODE)
// combination the capture harness drives". It was derived from nothing and checked against
// nothing, and it was already wrong: it omitted all nine blocks modes, `instances/tied`, and
// every cross-provider `tolerated` pair — including `instances/codex_empty`, which is the one
// `combined_empty` actually drives. T-005 collapsed three parallel descriptions of this same
// matrix into cases.json for exactly this reason; this file was a fourth that survived it.
//
// cases.json is the wrong source for THIS test: it describes CLI invocations, while these
// tests drive ccusage branches directly. The right source is fake_ccusage.py's own per-branch
// dispatch tables, which are what decides the set of payloads the fixture can emit — and it
// now publishes them, so a mode added there is picked up here automatically.
const VOCABULARY = (() => {
  const out = spawnSync("python3", [FAKE, "--dump-vocabulary"], { encoding: "utf8" });
  assert.equal(out.status, 0, `fake_ccusage --dump-vocabulary failed: ${out.stderr}`);
  return JSON.parse(out.stdout);
})();

// Each branch, the ccusage argv that reaches it, and the validator the port applies. A branch
// with no validator has to be named with its reason rather than omitted, so that "not covered"
// is a statement someone made on purpose.
const BRANCHES = {
  instances: { argv: ["claude", "daily", "--instances"], validate: validateInstances },
  daily: { argv: ["daily"], validate: validateDaily },
  // codex_bad is the fixture behind golden codex_bad_cost. The validator must PASS IT
  // THROUGH so cnum can emit the byte-frozen message (code review R4).
  codex: { argv: ["codex", "session"], validate: validateCodexSessions },
  "codex daily": { argv: ["codex", "daily"], validate: validateCodexDaily },
  // `blocks` has no validator, by a deliberate parity decision: the port reproduces Python's
  // permissive handling of malformed blocks payloads rather than tightening it (ISS-002, and
  // ISS-023 for the one gap that leaves). Its modes are still exercised below for acceptance —
  // they simply have nothing to be validated against.
  blocks: { argv: ["blocks"], validate: null },
};

// A new branch in fake_ccusage.py must fail here rather than be silently skipped, which is the
// whole failure mode this issue was about: coverage quietly narrower than the comment claims.
test("every fake_ccusage branch is accounted for, with or without a validator", () => {
  assert.deepEqual(
    Object.keys(VOCABULARY).sort(),
    Object.keys(BRANCHES).sort(),
    "fake_ccusage.py changed its branches; give the new one an argv + validator (or an " +
      "explicit null with the reason) in BRANCHES above",
  );
});

/** Every (branch, mode) pair the fixture can serve, tolerated cross-provider pairs included. */
const ALL_PAIRS = Object.entries(VOCABULARY).flatMap(([branch, v]) =>
  [...v.modes, ...v.tolerated].map((mode) => ({ branch, mode, ...BRANCHES[branch] })),
);

const CASES = ALL_PAIRS.filter((c) => c.validate).map((c) => [c.argv, c.mode, c.validate]);

// fake_ccusage.py USED to dispatch with `TABLE.get(MODE, <default>)` and nothing else, so a
// FAKE_MODE that did not exist SILENTLY yielded the default payload — the case then
// duplicated "normal" while appearing to cover something else. A stale "assoc" entry did
// exactly that and no schema assertion could catch it, because the fallback payload is valid
// (code review R3).
//
// The test below used to detect that by comparing each mode's output against a deliberately
// bogus mode's, which was the best available check while the fallback was silent. It only
// ever covered the 11 combinations listed above, though — and code review R2 found the same
// defect reaching cases.json, where a mode typo'd as `blocks_truthinesss` ran the
// `blocks_normal` fixture with the entire parity suite green.
//
// So the fallback is no longer silent: fake_ccusage.py now validates FAKE_MODE against a
// vocabulary derived from its own dispatch tables and exits 2 on anything else. That fixes it
// for every caller at once rather than for an enumerated list, and it makes this test's old
// technique obsolete — a bogus mode no longer produces a payload to compare against.
test("an unknown FAKE_MODE is REFUSED, not silently served the default payload", () => {
  const out = spawnSync("python3", [FAKE, "daily"], {
    encoding: "utf8",
    env: { ...process.env, FAKE_MODE: "__no_such_fake_mode__" },
  });
  assert.notEqual(out.status, 0, "an unknown FAKE_MODE produced a payload instead of failing");
  assert.match(out.stderr, /is not a 'daily' mode/);
  assert.equal(out.stdout.trim(), "", "a refused mode must not also emit a payload");
});

test("a mode belonging to ANOTHER branch is refused too, not quietly defaulted", () => {
  // A global vocabulary was the first fix and it was not enough (code review R3): it proved a
  // mode existed somewhere, not that this branch implemented it, so `blocks_empty` on the
  // --instances branch still fell back to `instances_normal` and the case exercised a fixture
  // it never named.
  const out = spawnSync("python3", [FAKE, "claude", "daily", "--instances"], {
    encoding: "utf8",
    env: { ...process.env, FAKE_MODE: "blocks_empty" },
  });
  assert.notEqual(out.status, 0, "a blocks mode was accepted on the instances branch");
  assert.match(out.stderr, /is not a 'instances' mode/);
});

test("the DELIBERATE cross-provider tolerance still works, so `combined` is not broken", () => {
  // `combined` queries both providers under one FAKE_MODE, so a codex-side mode reaches the
  // Claude branch on purpose and must yield the ordinary Claude fixture. This is the case
  // that stops the rule above from being tightened into something that breaks combined_empty.
  assert.doesNotThrow(() => fixture(["claude", "daily", "--instances"], "codex_empty"));
});

test("every (branch, mode) pair the vocabulary claims is actually served", () => {
  // The other direction, and the one that keeps the check above from being satisfiable by a
  // fixture that refuses everything: each pair must actually run.
  //
  // It also stops `--dump-vocabulary` from becoming a FIFTH description of the matrix. The
  // dump is built from the same table objects `dispatch` indexes, so it cannot drift by
  // construction — but "cannot drift by construction" is a claim, and this is the measurement.
  // Covers blocks too, which has no validator and would otherwise go entirely unexercised.
  for (const { branch, argv, mode } of ALL_PAIRS) {
    assert.doesNotThrow(() => fixture(argv, mode), `${branch} refused FAKE_MODE=${mode}`);
  }
});

test("the derived matrix covers what the old hand-written table missed", () => {
  // Guards the fix itself. These four pairs are real combinations the suites drive, and every
  // one was absent from the table this replaced — so a regression to any restated list, or a
  // filter that quietly drops `tolerated`, fails here with the reason attached.
  const have = new Set(ALL_PAIRS.map((c) => `${c.branch}/${c.mode}`));
  for (const pair of [
    "instances/codex_empty", // combined_empty drives it; absent from the old table
    "instances/tied", // tiebreak.test.mjs
    "codex/tied",
    "blocks/blocks_malformed", // all nine blocks modes were missing
  ]) {
    assert.ok(have.has(pair), `derived matrix is missing ${pair}`);
  }
  // And the shape of the win, so a future narrowing is visible as a number rather than a diff.
  assert.ok(
    ALL_PAIRS.length >= 24,
    `expected the full matrix, got ${ALL_PAIRS.length} pairs`,
  );
});

for (const [args, mode, validate] of CASES) {
  test(`strict schema accepts fixture: ${args.join(" ")} [FAKE_MODE=${mode}]`, () => {
    const payload = fixture(args, mode);
    assert.doesNotThrow(
      () => validate(payload),
      `strict validation rejected a payload the fixture legitimately produces (${mode})`,
    );
  });
}

// End-to-end against the STORED GOLDEN, not a hand-built payload (code review R4).
//
// Nothing previously asserted that the real codex_bad fixture survives the validator and
// still yields the golden's exact stderr. It currently holds only because that fixture's
// session happens to carry a `models` key — drop it and validateCodexSessions fires first
// and replaces the frozen text, with no test failing until T-005 wires the goldens up.
test("the codex_bad fixture reproduces golden codex_bad_cost's stderr byte-for-byte", () => {
  const golden = JSON.parse(
    readFileSync(join(ROOT, "tests/golden/goldens/codex_bad_cost.json"), "utf8"),
  );
  const payload = fixture(["codex", "session"], "codex_bad");
  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", () => ({
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  }));
  let msg = "(no error)";
  try {
    codexSessions({ deps, config: DEFAULT_CONFIG });
  } catch (e) {
    msg = e.message;
  }
  // usage.py's sys.exit() appends the newline; the port's message carries none.
  assert.equal(`${msg}\n`, golden.stderr);
});

// The two shapes the withdrawn "nonzero tokens implies a model breakdown" invariant would
// have rejected. Pinned so it cannot be reintroduced from the review history.
test("nonzero tokens with no model breakdown stays valid on BOTH providers", () => {
  assert.doesNotThrow(() =>
    validateCodexSessions({
      sessions: [
        {
          sessionFile: "rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-000000000001",
          costUSD: 0.5,
          totalTokens: 5,
          models: {}, // feeds the 'unclassified' bucket in the model footer
        },
      ],
      totals: { costUSD: 0.5, totalTokens: 5 },
    }),
  );
  assert.doesNotThrow(() =>
    validateInstances({
      projects: { "-p": [{ date: "2026-01-02", totalCost: 3.0, totalTokens: 6, modelBreakdowns: [] }] },
      totals: { totalCost: 3.0, totalTokens: 6 },
    }),
  );
});

// Cost is zero for an unpriced or offline-resolved model while tokens are positive, so a
// gate that looked only at cost would wave a renamed collection through as "empty" and
// silently discard the usage (code review R1).
test("zero cost with positive tokens is real usage, not an empty result", () => {
  assert.doesNotThrow(() =>
    validateInstances({
      projects: { "-p": [{ date: "2026-01-05", totalCost: 0, totalTokens: 900, modelBreakdowns: [] }] },
      totals: { totalCost: 0, totalTokens: 900 },
    }),
    "a genuine zero-cost payload must still validate",
  );
  assert.throws(
    () => validateInstances({ totals: { totalCost: 0, totalTokens: 900 } }),
    /non-zero totals/,
    "absent 'projects' with positive tokens must fail even at zero cost",
  );
  assert.throws(
    () => validateDaily({ totals: { totalCost: 0, totalTokens: 900 } }),
    /non-zero totals/,
  );
});

// A session with directory: null must validate AND keep exercising the filename-date
// fallback — requiring it would break parity rather than detect producer drift.
//
// `models: {}` is present deliberately. Omitting it made this test assert that a session
// with NO models map is valid, which would have blocked requiring that map at all — the
// test would have locked in the schema-rename hole it was never about (code review R1).
// The valid unclassified shape is an EMPTY map, not an absent one.
test("codex session directory is optional and nullable", () => {
  const mk = (dir) => ({
    sessions: [
      {
        sessionFile: "rollout-2026-01-04T10-00-00-019c0000-0000-7000-8000-000000000009",
        costUSD: 1,
        totalTokens: 1,
        models: {},
        ...(dir === undefined ? {} : { directory: dir }),
      },
    ],
    totals: { costUSD: 1, totalTokens: 1 },
  });
  assert.doesNotThrow(() => validateCodexSessions(mk(null)));
  assert.doesNotThrow(() => validateCodexSessions(mk(undefined)));
  assert.doesNotThrow(() => validateCodexSessions(mk("2026/01/04")));
  assert.throws(() => validateCodexSessions(mk(42)), /expected a string, null, or absent/);
});
