/**
 * The point of T-006, stated as tests: a producer field rename must FAIL LOUD.
 *
 * Before this, `num()` coerced a missing field to 0, so a rename produced a clean-looking
 * table with wrong totals. Each case below deletes or renames one consumed field and asserts
 * a UsageError *before* aggregation ever sees it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UsageError } from "../dist/errors.js";
import { createDeps, DEFAULT_CONFIG } from "../dist/context.js";
import { codexSessions, codexDaily, pyGet } from "../dist/codex.js";
import {
  validateInstances,
  validateDaily,
  validateCodexSessions,
  validateCodexDaily,
} from "../dist/json.js";

/**
 * Run a payload through the REAL codex pipeline: runner -> validateCodex* -> cnum.
 *
 * The codex fields below are guarded by `cnum` (and codex.ts's own sessionFile check), whose
 * message text is BYTE-FROZEN (ALLOWLIST entry 2; golden `codex_bad_cost`). Asserting them
 * against the validator in isolation was actively misleading: a validator that rejected them
 * FIRST would pass such a test while silently replacing the frozen message and breaking the
 * golden — which is exactly what happened and what code review R2 caught. So these assert
 * the end-to-end message instead.
 */
const codexCtx = (payload) => ({
  deps: createDeps({ CCUSAGE_CMD: "ccusage" }, "/h", () => ({
    status: 0,
    stdout: JSON.stringify(payload),
    stderr: "",
  })),
  config: DEFAULT_CONFIG,
});
const sessionsMsg = (payload) => {
  try {
    codexSessions(codexCtx(payload));
  } catch (e) {
    return e.message;
  }
  return "(no error)";
};
const dailyMsg = (payload) => {
  try {
    codexDaily(codexCtx(payload));
  } catch (e) {
    return e.message;
  }
  return "(no error)";
};

const rename = (obj, from, to) => {
  const { [from]: v, ...rest } = obj;
  return { ...rest, [to]: v };
};
const omit = (obj, field) => {
  const { [field]: _drop, ...rest } = obj;
  return rest;
};

/**
 * The counters REQUIRED on every model-breakdown entry — the four aggregate.ts:67 sums.
 * `totalTokens` is NOT among them: the producer does not emit it on a breakdown entry
 * (measured against the pinned binary), so requiring it would reject every real payload.
 */
const BREAKDOWN_COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
];

const mbEntry = (over = {}) => ({
  modelName: "claude-opus-4-8",
  cost: 15,
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationTokens: 1,
  cacheReadTokens: 27,
  ...over,
});

const instRow = () => ({
  date: "2026-01-01",
  totalCost: 15,
  totalTokens: 30,
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationTokens: 1,
  cacheReadTokens: 27,
  modelBreakdowns: [mbEntry()],
});
const inst = (row) => ({ projects: { "-p": [row] }, totals: { totalCost: 15, totalTokens: 30 } });

const dailyRow = () => ({
  period: "2026-01-01",
  totalCost: 5,
  totalTokens: 50,
  modelBreakdowns: [mbEntry({ cost: 5 })],
});
const daily = (row) => ({ daily: [row], totals: { totalCost: 5, totalTokens: 50 } });

const sess = () => ({
  sessionFile: "rollout-2026-01-01T10-00-00-019c0000-0000-7000-8000-000000000001",
  directory: "2026/01/01",
  costUSD: 10,
  totalTokens: 100,
  models: { "gpt-5.5": { totalTokens: 100 } },
});
const sessions = (s) => ({ sessions: [s], totals: { costUSD: 10, totalTokens: 100 } });

const cdRow = () => ({
  date: "2026-01-01",
  costUSD: 10,
  totalTokens: 100,
  models: { "gpt-5.5": { totalTokens: 100 } },
});
const cdaily = (row) => ({ daily: [row], totals: { costUSD: 10, totalTokens: 100 } });

const throws = (fn) => assert.throws(fn, (e) => e instanceof UsageError);

test("baseline: all four valid payloads pass", () => {
  assert.doesNotThrow(() => validateInstances(inst(instRow())));
  assert.doesNotThrow(() => validateDaily(daily(dailyRow())));
  assert.doesNotThrow(() => validateCodexSessions(sessions(sess())));
  assert.doesNotThrow(() => validateCodexDaily(cdaily(cdRow())));
});

// --- the headline trap: date vs period ------------------------------------------------

test("instances: 'date' renamed to 'period' is rejected, not read as zero", () => {
  throws(() => validateInstances(inst(rename(instRow(), "date", "period"))));
  throws(() => validateInstances(inst(omit(instRow(), "date"))));
});

test("generic daily: 'period' renamed to 'date' is rejected", () => {
  throws(() => validateDaily(daily(rename(dailyRow(), "period", "date"))));
  throws(() => validateDaily(daily(omit(dailyRow(), "period"))));
});

// --- cost field naming ------------------------------------------------------------------

test("instances/daily: 'totalCost' renamed to codex's 'costUSD' is rejected", () => {
  throws(() => validateInstances(inst(rename(instRow(), "totalCost", "costUSD"))));
  throws(() => validateDaily(daily(rename(dailyRow(), "totalCost", "costUSD"))));
});

test("codex: 'costUSD' renamed to claude's 'totalCost' is rejected, with cnum's frozen text", () => {
  assert.equal(
    sessionsMsg(sessions(rename(sess(), "costUSD", "totalCost"))),
    "unexpected ccusage codex output: sessions[0].costUSD = None (expected a finite non-negative number)",
  );
  // codex daily ROWS are never consumed (codex.ts:457 destructures only grand/grandTok), so
  // a row-level rename there is genuinely not an error; the TOTALS rename is.
  assert.equal(
    dailyMsg({ daily: [cdRow()], totals: rename({ costUSD: 10, totalTokens: 100 }, "costUSD", "totalCost") }),
    "unexpected ccusage output: codex daily totals.costUSD is missing — the ccusage schema may have changed",
  );
});

// THE regression this pins: golden `codex_bad_cost` freezes cnum's exact wording. A
// validator that type-checks the same field first runs at ccusage.ts:100, BEFORE codex.ts
// ever sees the payload, and silently substitutes its own message (code review R2).
test("cnum's byte-frozen codex message is not shadowed by schema validation", () => {
  const FROZEN =
    "unexpected ccusage codex output: sessions[0].costUSD = True (expected a finite non-negative number)";
  assert.equal(sessionsMsg(sessions({ ...sess(), costUSD: true })), FROZEN);

  // Same for the other cnum-guarded fields and codex.ts's own sessionFile guard.
  assert.equal(
    sessionsMsg(sessions(omit(sess(), "costUSD"))),
    "unexpected ccusage codex output: sessions[0].costUSD = None (expected a finite non-negative number)",
  );
  assert.equal(
    sessionsMsg(sessions(omit(sess(), "totalTokens"))),
    "unexpected ccusage codex output: sessions[0].totalTokens = None (expected a finite non-negative number)",
  );
  assert.equal(
    sessionsMsg(sessions(omit(sess(), "sessionFile"))),
    "unexpected ccusage codex output: sessions[0].sessionFile = None",
  );
  assert.equal(
    sessionsMsg({ sessions: [sess()], totals: omit({ costUSD: 10, totalTokens: 100 }, "costUSD") }),
    "unexpected ccusage codex output: totals.costUSD = None (expected a finite non-negative number)",
  );
  assert.equal(
    sessionsMsg({ sessions: [sess()], totals: omit({ costUSD: 10, totalTokens: 100 }, "totalTokens") }),
    "unexpected ccusage codex output: totals.totalTokens = None (expected a finite non-negative number)",
  );
  // And the renamed-collection case keeps codex.ts's own frozen wording too.
  assert.equal(
    sessionsMsg({ sessionList: [sess()], totals: { costUSD: 10, totalTokens: 100 } }),
    "unexpected ccusage codex output: missing 'sessions' list",
  );
});

// JSON `null` is NOT absence. Python's `.get(k, default)` returns None for a present-null
// key, which reaches cnum and exits 1; JS's `??` conflates the two and silently substituted
// 0, producing a clean table with wrong per-model tokens and a wrong cross-check total
// (code review R4 — the only 3 of 241 differential mutations where Python errored and the
// port returned clean zeros). Fixed in codex.ts via pyGet, NOT in the validator: rejecting
// null there would fire first and replace cnum's frozen wording.
test("a present-but-null counter fails loud, exactly as Python does", () => {
  assert.equal(
    sessionsMsg(sessions({ ...sess(), models: { "gpt-5.5": { totalTokens: null } } })),
    "unexpected ccusage codex output: sessions[0].models.gpt-5.5.totalTokens = None (expected a finite non-negative number)",
  );
  assert.equal(
    dailyMsg({ daily: [], totals: { costUSD: null, totalTokens: 0 } }),
    "unexpected ccusage codex output: codex daily totals.costUSD = None (expected a finite non-negative number)",
  );
  assert.equal(
    dailyMsg({ daily: [], totals: { costUSD: 0, totalTokens: null } }),
    "unexpected ccusage codex output: codex daily totals.totalTokens = None (expected a finite non-negative number)",
  );
  // ...while a genuinely valid zero still passes, so the fix did not just ban zero.
  assert.equal(dailyMsg({ daily: [], totals: { costUSD: 0, totalTokens: 0 } }), "(no error)");
  assert.equal(
    sessionsMsg(sessions({ ...sess(), models: { "gpt-5.5": { totalTokens: 0 } } })),
    "(no error)",
  );
});

// `pyGet` is the `dict.get` translation, and it is tested at UNIT level deliberately.
//
// Be honest about why: end-to-end, its default branch is currently UNREACHABLE. Every one of
// its call sites is a field the validator now requires to be present (session models'
// `totalTokens`, codex daily `totals.costUSD`/`totalTokens`), and validation runs first at
// ccusage.ts:100 — so no payload that reaches pyGet can be missing the key. That is exactly
// why this needs its own test: nothing observable would change if the helper regressed, so
// the contract has to be pinned where it is stated rather than where it is felt.
//
// `key in o` walks the prototype chain; Python's `dict.get` consults only own keys. The
// difference is the whole point of having this helper at all (code review R5).
test("pyGet reads OWN keys only, like Python's dict.get", () => {
  assert.equal(pyGet({ totalTokens: 5 }, "totalTokens", 0), 5);
  assert.equal(pyGet({}, "totalTokens", 0), 0, "absent -> the default");
  // Present-but-null is NOT absence: it must come back as null so cnum can speak (R4).
  assert.equal(pyGet({ totalTokens: null }, "totalTokens", 0), null);

  // Non-enumerable so nothing else in the process observes it (Object.entries/spread are
  // unaffected); `in` still sees it, `Object.hasOwn` does not.
  Object.defineProperty(Object.prototype, "totalTokens", { value: 999, configurable: true });
  try {
    assert.ok("totalTokens" in {}, "fixture must actually pollute the prototype");
    assert.equal(
      pyGet({}, "totalTokens", 0),
      0,
      "an INHERITED key must not stand in for an own key — Python's dict.get would not see it",
    );
  } finally {
    delete Object.prototype.totalTokens;
  }
  assert.ok(!("totalTokens" in {}), "the fixture must be fully undone");
});

// The ROOT and TOTALS shapes are frozen on the session path too (code review R3): usage.py:237
// raises "missing 'sessions' list" for a non-dict root, and usage.py:239-241 substitutes {}
// for a malformed totals and then lets cnum speak. A requireRoot here would replace both.
test("codex session root/totals shape errors keep Python's frozen wording", () => {
  const CNUM_TOTALS =
    "unexpected ccusage codex output: totals.costUSD = None (expected a finite non-negative number)";
  const NO_SESSIONS = "unexpected ccusage codex output: missing 'sessions' list";

  assert.equal(sessionsMsg({ sessions: [sess()] }), CNUM_TOTALS, "absent totals -> cnum");
  assert.equal(sessionsMsg({ sessions: [sess()], totals: 5 }), CNUM_TOTALS, "non-object totals -> cnum");
  assert.equal(sessionsMsg({ sessions: [sess()], totals: null }), CNUM_TOTALS);
  for (const root of [42, "x", null, []]) {
    assert.equal(sessionsMsg(root), NO_SESSIONS, `root ${JSON.stringify(root)} -> codex.ts`);
  }
  // The validator itself must simply pass these through rather than throwing first.
  assert.doesNotThrow(() => validateCodexSessions({ sessions: [sess()] }));
  assert.doesNotThrow(() => validateCodexSessions(42));

  // codex DAILY is the opposite case and must KEEP its root guard: codexDaily uses
  // `?? 0`, so a malformed root silently yields zeros there instead of failing.
  throws(() => validateCodexDaily({ daily: [] }));
  throws(() => validateCodexDaily(42));
});

// The two remaining places validateCodexSessions deliberately STEPS ASIDE — both were
// entirely unpinned, and flipping either to a `fail(...)` left the whole suite green
// (code review R6). They are opposite kinds of mistake, which is why both need a case.
test("a non-object SESSION ROW keeps codex.ts's byte-frozen wording", () => {
  // Measured against usage.py driven on the identical payload: it prints
  // "unexpected ccusage codex output: sessions[0] is not an object". That text is frozen
  // under ALLOWLIST 2, and no golden covers it — a validator rejecting the row first would
  // silently substitute "unexpected ccusage output: ..." (note: no "codex").
  for (const bad of [42, "x", null, []]) {
    assert.equal(
      sessionsMsg({ sessions: [bad], totals: { costUSD: 1, totalTokens: 1 } }),
      "unexpected ccusage codex output: sessions[0] is not an object",
      `sessions[0] = ${JSON.stringify(bad)}`,
    );
  }
  // The validator itself must pass it straight through rather than throwing first.
  assert.doesNotThrow(() =>
    validateCodexSessions({ sessions: [42], totals: { costUSD: 1, totalTokens: 1 } }),
  );
});

test("a non-object PER-MODEL entry is skipped, exactly as Python skips it", () => {
  // The opposite direction: usage.py's `for mname, m in ...: if isinstance(m, dict)` skips
  // these silently and exits 0 with a full table. Measured — Python exits 0, empty stderr.
  // Rejecting here would turn a clean run into exit 1, an unsanctioned divergence.
  for (const bad of [42, "x", null, [], true]) {
    assert.equal(
      sessionsMsg(sessions({ ...sess(), models: { "gpt-5.5": bad } })),
      "(no error)",
      `models["gpt-5.5"] = ${JSON.stringify(bad)} must be skipped, not rejected`,
    );
    assert.doesNotThrow(() => validateCodexSessions(sessions({ ...sess(), models: { "gpt-5.5": bad } })));
  }
  // ...and the same on a codex daily row, where nothing is consumed at all.
  for (const bad of [42, null, []]) {
    assert.doesNotThrow(() => validateCodexDaily(cdaily({ ...cdRow(), models: { "gpt-5.5": bad } })));
  }
});

// The codex-daily SHAPE guards, the mirror of the row-content rule already pinned above:
// `daily` not an array, and a non-object row. Both must be tolerated, because codexDaily
// discards `rows` wholesale — and both survived mutation before this (code review R6).
test("codex daily tolerates a malformed daily/row shape, since nothing reads it", () => {
  for (const rows of [42, "x", {}, null]) {
    assert.doesNotThrow(() => validateCodexDaily({ daily: rows, totals: { costUSD: 1, totalTokens: 1 } }));
  }
  for (const row of [42, "x", null, []]) {
    assert.doesNotThrow(() => validateCodexDaily({ daily: [row], totals: { costUSD: 1, totalTokens: 1 } }));
  }
  // The root and totals guards still apply — those ARE consumed.
  throws(() => validateCodexDaily({ daily: [], totals: { totalTokens: 1 } }));
  throws(() => validateCodexDaily({ daily: [] }));
});

// --- per-field sweep --------------------------------------------------------------------

for (const field of ["date", "totalCost", "totalTokens"]) {
  test(`instances: dropping row.${field} fails loud`, () => {
    throws(() => validateInstances(inst(omit(instRow(), field))));
  });
}
for (const field of ["period", "totalCost", "totalTokens"]) {
  test(`daily: dropping row.${field} fails loud`, () => {
    throws(() => validateDaily(daily(omit(dailyRow(), field))));
  });
}
// Codex session fields are cnum/codex.ts territory — asserted end-to-end above, with their
// frozen text, rather than against the validator in isolation.
for (const field of ["sessionFile", "costUSD", "totalTokens"]) {
  test(`codex session: dropping ${field} fails loud (via the frozen downstream guard)`, () => {
    assert.notEqual(sessionsMsg(sessions(omit(sess(), field))), "(no error)");
  });
}
// codex daily TOTALS use `cnum(x ?? 0)`, so absence never reaches cnum and is silently
// zeroed — that is the one place a presence guard is additive.
for (const field of ["costUSD", "totalTokens"]) {
  test(`codex daily: dropping totals.${field} fails loud`, () => {
    throws(() =>
      validateCodexDaily({ daily: [cdRow()], totals: omit({ costUSD: 10, totalTokens: 100 }, field) }),
    );
  });
}

// Each case must be invalid in exactly ONE way. The first version of this test passed
// `{ cost: 1 }` and `{ modelName: "m" }` as whole entries, so every case was ALSO missing
// all four BREAKDOWN_TOKEN_FIELDS — `requireCount` threw first and the two guards this test
// is named for were never reached. Deleting BOTH of them left the suite fully green
// (code review R6). Start from a complete entry and remove one thing.
test("modelBreakdowns entries must keep modelName and cost", () => {
  const bad = (mb) => inst({ ...instRow(), modelBreakdowns: [mb] });
  assert.doesNotThrow(() => validateInstances(bad(mbEntry())), "the baseline entry must be valid");

  // modelName: aggregate.ts falls back to "" for a non-string, collapsing every family to
  // `other`; Python raises AttributeError on a non-falsy non-string (usage.py:91).
  throws(() => validateInstances(bad(omit(mbEntry(), "modelName"))));
  throws(() => validateInstances(bad(rename(mbEntry(), "modelName", "model"))));
  throws(() => validateInstances(bad({ ...mbEntry(), modelName: 42 })));

  // cost: reached via num(), which silently yields 0 — the zeroed-column bug T-006 exists
  // to close.
  throws(() => validateInstances(bad(omit(mbEntry(), "cost"))));
  throws(() => validateInstances(bad(rename(mbEntry(), "cost", "costUSD"))));
  throws(() => validateInstances(bad({ ...mbEntry(), cost: "1" })));
});

// The SHAPE guards, which nothing reached either: no test ever fed a non-array
// `modelBreakdowns`, a non-object entry, a non-object row, or a non-array `daily`. All of
// them survived mutation (code review R6). aggregate.ts:118 skips a non-object breakdown
// entry silently, so removing that one restores exactly the quiet-wrong-table divergence.
test("malformed row and collection SHAPES are rejected, not skipped", () => {
  for (const mbs of [null, 42, "x", {}]) {
    throws(() => validateInstances(inst({ ...instRow(), modelBreakdowns: mbs })));
    throws(() => validateDaily(daily({ ...dailyRow(), modelBreakdowns: mbs })));
  }
  for (const entry of [null, 42, "x", []]) {
    throws(() => validateInstances(inst({ ...instRow(), modelBreakdowns: [entry] })));
    throws(() => validateDaily(daily({ ...dailyRow(), modelBreakdowns: [entry] })));
  }
  for (const row of [null, 42, "x", []]) {
    throws(() => validateInstances({ projects: { "-p": [row] }, totals: { totalCost: 15, totalTokens: 30 } }));
    throws(() => validateDaily({ daily: [row], totals: { totalCost: 5, totalTokens: 50 } }));
  }
  // `daily` present but not an array — requireArray's branch, previously unpinned.
  for (const rows of [42, "x", {}, null]) {
    throws(() => validateDaily({ daily: rows, totals: { totalCost: 5, totalTokens: 50 } }));
  }
});

// The string guards are TYPE guards, not emptiness guards (code review R5). Python indexes
// these directly and an empty value is not an error there: `model_family` is
// `(name or "").lower()` (usage.py:91), which classifies "" as `other` without raising, and
// `day["date"]`/`r["period"]` simply become a blank key. Rejecting "" would exit 1 where
// Python exits 0 — a divergence ALLOWLIST 14 does not sanction, on a value the producer can
// legitimately emit for an unnamed or unresolved model.
test("an EMPTY string is valid for date, period and modelName — only the type is checked", () => {
  assert.doesNotThrow(() => validateInstances(inst({ ...instRow(), date: "" })));
  assert.doesNotThrow(() => validateDaily(daily({ ...dailyRow(), period: "" })));
  assert.doesNotThrow(() =>
    validateInstances(inst({ ...instRow(), modelBreakdowns: [mbEntry({ modelName: "" })] })),
  );
  // The rename/type drift these guards exist for must still be caught.
  throws(() => validateInstances(inst(omit(instRow(), "date"))));
  throws(() => validateInstances(inst({ ...instRow(), date: null })));
  throws(() => validateDaily(daily({ ...dailyRow(), period: 42 })));
});

// --- the collections aggregation silently degrades (code review R1) ---------------------
//
// aggregate.ts:116 falls back to [] and codex.ts:162 falls back to "unclassified", so a
// rename of either produces a clean table with zeroed per-model columns instead of an
// error. Measured safe to require against BOTH producers; EMPTY stays valid.

test("modelBreakdowns renamed or dropped fails loud on both Claude payloads", () => {
  throws(() => validateInstances(inst(omit(instRow(), "modelBreakdowns"))));
  throws(() => validateInstances(inst(rename(instRow(), "modelBreakdowns", "breakdowns"))));
  throws(() => validateDaily(daily({ ...dailyRow(), modelBreakdowns: undefined })));
  throws(() => validateDaily(daily(rename({ ...dailyRow(), modelBreakdowns: [] }, "modelBreakdowns", "models"))));
  // ...but an EMPTY breakdown list is the unclassified bucket and must stay valid.
  assert.doesNotThrow(() => validateInstances(inst({ ...instRow(), modelBreakdowns: [] })));
  assert.doesNotThrow(() => validateDaily(daily({ ...dailyRow(), modelBreakdowns: [] })));
});

for (const field of BREAKDOWN_COUNTERS) {
  test(`modelBreakdowns entries must keep ${field}`, () => {
    const mb = { modelName: "m", cost: 1, ...Object.fromEntries(BREAKDOWN_COUNTERS.map((f) => [f, 1])) };
    assert.doesNotThrow(() => validateInstances(inst({ ...instRow(), modelBreakdowns: [mb] })));
    throws(() => validateInstances(inst({ ...instRow(), modelBreakdowns: [omit(mb, field)] })));
    throws(() =>
      validateInstances(inst({ ...instRow(), modelBreakdowns: [rename(mb, field, `${field}X`)] })),
    );
  });
}

test("codex session 'models' renamed or dropped fails loud", () => {
  // codex.ts:162 silently treats a non-object models as "no models" and buckets every token
  // as unclassified, so this rejection is genuinely additive.
  throws(() => validateCodexSessions(sessions(omit(sess(), "models"))));
  throws(() => validateCodexSessions(sessions(rename(sess(), "models", "modelBreakdowns"))));
  throws(() => validateCodexSessions(sessions({ ...sess(), models: null })));
  // ...but an EMPTY map is the unclassified bucket and must stay valid.
  assert.doesNotThrow(() => validateCodexSessions(sessions({ ...sess(), models: {} })));

  // codex daily rows are NOT consumed, so their models map is not required — requiring it
  // would be validating dead data (code review R2).
  assert.doesNotThrow(() => validateCodexDaily(cdaily(omit(cdRow(), "models"))));
  assert.doesNotThrow(() => validateCodexDaily(cdaily({ ...cdRow(), models: {} })));
});

// Pins the NEGATIVE half of the rule: codex daily rows are dead data (codex.ts:457
// destructures only { grand, grandTok }), so validating them could only ever produce false
// positives. Without this, re-adding row validation goes unnoticed (mutation-tested).
test("codex daily ROWS are not validated, because nothing consumes them", () => {
  for (const row of [
    omit(cdRow(), "date"),
    omit(cdRow(), "costUSD"),
    omit(cdRow(), "totalTokens"),
    rename(cdRow(), "date", "period"),
    rename(cdRow(), "costUSD", "totalCost"),
    {},
    // The NESTED case, which the list above missed entirely: `checkCodexModels` is shared
    // with the session path and required per-model `totalTokens` unconditionally, so a daily
    // row whose models map lost that counter was rejected — a false positive on data
    // codex.ts never reads. The top-level cases all passed straight through it, so the bug
    // survived with this test green (code review R5).
    { ...cdRow(), models: { "gpt-5.5": {} } },
    { ...cdRow(), models: { "gpt-5.5": { tokens: 100 } } },
  ]) {
    assert.doesNotThrow(
      () => validateCodexDaily(cdaily(row)),
      `codex daily rows are unconsumed; rejecting ${JSON.stringify(row)} would be a false positive`,
    );
  }
  // The safe-integer bound still applies, since that is about representability, not schema.
  throws(() => validateCodexDaily(cdaily({ ...cdRow(), totalTokens: 2 ** 53 })));
});

test("codex per-model entries must keep totalTokens", () => {
  // `cnum(m.totalTokens ?? 0)` means ABSENCE is silently zeroed — the additive guard.
  throws(() => validateCodexSessions(sessions({ ...sess(), models: { "gpt-5.5": {} } })));
  throws(() =>
    validateCodexSessions(sessions({ ...sess(), models: { "gpt-5.5": { tokens: 100 } } })),
  );
  // A wrong TYPE is cnum's, with its frozen wording — the validator must not shadow it.
  assert.equal(
    sessionsMsg(sessions({ ...sess(), models: { "gpt-5.5": { totalTokens: "x" } } })),
    "unexpected ccusage codex output: sessions[0].models.gpt-5.5.totalTokens = 'x' (expected a finite non-negative number)",
  );
});

// --- totals ------------------------------------------------------------------------------

test("only the totals a path actually CONSUMES are required", () => {
  // Claude: aggregate.ts:128 reads totals.totalCost and nothing else. totalTokens is never
  // read on this path (usage.py:184/484 sum tokens from rows), so requiring it would turn a
  // still-working payload into a hard failure (code review R2).
  throws(() => validateInstances({ projects: { "-p": [instRow()] }, totals: { totalTokens: 30 } }));
  throws(() => validateDaily({ daily: [dailyRow()], totals: { totalTokens: 50 } }));
  assert.doesNotThrow(() =>
    validateInstances({ projects: { "-p": [instRow()] }, totals: { totalCost: 15 } }),
    "totals.totalTokens is unconsumed on the Claude path and must not be required",
  );
  assert.doesNotThrow(() => validateDaily({ daily: [dailyRow()], totals: { totalCost: 5 } }));

  // Codex: totals.totalTokens IS consumed (codex.ts:145/200), and is enforced there —
  // by cnum for `session` (frozen text) and by the presence guard for `daily` (?? 0).
  assert.notEqual(
    sessionsMsg({ sessions: [sess()], totals: { costUSD: 10 } }),
    "(no error)",
    "codex session totals.totalTokens IS consumed and must fail loud",
  );
  throws(() => validateCodexDaily({ daily: [cdRow()], totals: { costUSD: 10 } }));

  // But it must still be REQUIRED where it decides the empty-result branch.
  throws(() => validateInstances({ totals: { totalCost: 0 } }));
  throws(() => validateDaily({ totals: { totalCost: 0 } }));
});

// ALLOWLIST 7 says the safe-integer bound is "applied everywhere" — but nothing pinned the
// row-level or totals-level sweeps, so removing either was invisible (code review R4
// mutation-tested both as survivors). `cnum` cannot catch these: it accepts 2^53+1, which
// JSON.parse has already rounded.
test("the safe-integer bound really is applied at row and totals level, not just to totalTokens", () => {
  const BIG = 2 ** 53; // first value JSON.parse can no longer represent exactly

  // Row-level counters, both Claude payloads.
  for (const f of ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"]) {
    throws(() => validateInstances(inst({ ...instRow(), [f]: BIG })));
    throws(() => validateDaily(daily({ ...dailyRow(), [f]: BIG })));
  }
  // Totals level, both Claude payloads.
  throws(() =>
    validateInstances({ projects: { "-p": [instRow()] }, totals: { totalCost: 15, totalTokens: BIG } }),
  );
  throws(() => validateDaily({ daily: [dailyRow()], totals: { totalCost: 5, totalTokens: BIG } }));
  // Codex session row + totals (where cnum would happily accept it).
  throws(() => validateCodexSessions(sessions({ ...sess(), inputTokens: BIG })));
  throws(() =>
    validateCodexSessions({ sessions: [sess()], totals: { costUSD: 10, totalTokens: BIG } }),
  );
  // 2^53-1 is still exactly representable and must pass.
  assert.doesNotThrow(() =>
    validateInstances(inst({ ...instRow(), inputTokens: Number.MAX_SAFE_INTEGER })),
  );
});

test("an absent collection with zero cost but positive tokens still fails", () => {
  // Cost is zero for an unpriced/offline model while tokens are positive, so gating the
  // empty-result exemption on cost alone let a rename through as "nothing to report".
  throws(() => validateInstances({ totals: { totalCost: 0, totalTokens: 4200 } }));
  throws(() => validateDaily({ totals: { totalCost: 0, totalTokens: 4200 } }));
});

// --- roots and totals -------------------------------------------------------------------

test("a payload that is not an object, or has no totals, is rejected", () => {
  for (const v of [null, 42, "x", []]) {
    throws(() => validateInstances(v));
    throws(() => validateDaily(v));
    throws(() => validateCodexDaily(v));
  }
  throws(() => validateInstances({}));
  throws(() => validateInstances({ projects: {} }));

  // codex SESSION is excluded on purpose (code review R3): both of those shapes already
  // produce Python's frozen text downstream — a non-object root hits codex.ts:138's
  // "missing 'sessions' list", and an absent/malformed totals reaches cnum via codex.ts:141-145.
  // Rejecting them here would replace both messages. Asserted end-to-end instead, above.
  assert.doesNotThrow(() => validateCodexSessions({ sessions: [] }));
  assert.doesNotThrow(() => validateCodexSessions(42));
});

test("a renamed root is caught, because it looks like data that vanished", () => {
  // `projects` renamed -> absent WITH non-zero totals, the silent-rename signature.
  throws(() =>
    validateInstances({ projectMap: { "-p": [instRow()] }, totals: { totalCost: 15, totalTokens: 30 } }),
  );
  throws(() => validateDaily({ rows: [dailyRow()], totals: { totalCost: 5, totalTokens: 50 } }));
  // `sessions` renamed is codex.ts's own frozen "missing 'sessions' list" — the validator
  // deliberately steps aside so that wording survives (asserted end-to-end above).
  assert.equal(
    sessionsMsg({ sessionList: [sess()], totals: { costUSD: 10, totalTokens: 1 } }),
    "unexpected ccusage codex output: missing 'sessions' list",
  );
});

test("projects must be a MAP, and its values arrays — never a list", () => {
  const totals = { totalCost: 15, totalTokens: 30 };
  throws(() => validateInstances({ projects: [], totals }));
  throws(() => validateInstances({ projects: [instRow()], totals }));
  throws(() => validateInstances({ projects: { "-p": instRow() }, totals })); // value not an array
  throws(() => validateInstances({ projects: { "-p": 5 }, totals }));
});

test("an empty result is still accepted — absence only when totals are zero", () => {
  // Matches the pinned binary: `projects` omitted, `daily`/`sessions` emitted as [].
  assert.doesNotThrow(() =>
    validateInstances({ daily: [], totals: { totalCost: -0.0, totalTokens: 0 } }),
  );
  assert.doesNotThrow(() => validateDaily({ daily: [], totals: { totalCost: 0, totalTokens: 0 } }));
  assert.doesNotThrow(() =>
    validateCodexSessions({ sessions: [], totals: { costUSD: 0, totalTokens: 0 } }),
  );
  assert.doesNotThrow(() =>
    validateCodexDaily({ daily: [], totals: { costUSD: 0, totalTokens: 0 } }),
  );
});

/**
 * Presence must mean OWN presence, exactly as it does for a Python dict.
 *
 * `row[field]` walks the prototype chain, so an inherited value can answer "is this key
 * present / well-typed" for a key the payload does not contain — the same divergence `pyGet`
 * was corrected for in R5, left standing in the validators until R7.
 *
 * Reachability, stated honestly: no ccusage payload can trigger this, because `JSON.parse`
 * never sets a `[[Prototype]]` and none of the validated names live on `Object.prototype`.
 * The inheritance below is SYNTHETIC — it exists to make the contract assertable at all.
 *
 * NOTHING GLOBAL IS MUTATED. An earlier version wrote to `Object.prototype`, set it up
 * OUTSIDE the `try` (so a throw mid-setup leaked), and cleaned up with `delete` rather than
 * restoring the previous descriptor (code review R7). `Object.create` gives each payload its
 * own polluted prototype and cannot affect any other test in the process.
 *
 * Every value inherited below is a VALID one for its field. That matters: an earlier draft
 * inherited the number `1` for `period`, so a missing-period case would have thrown on the
 * TYPE check and passed for the wrong reason, proving nothing about own-key lookup.
 */
const inherit = (proto, ownProps) => Object.assign(Object.create(proto), ownProps);

test("an inherited property never satisfies a required field", () => {
  // Each case: an otherwise-VALID payload in which exactly one field is inherited rather
  // than own. With `own()` it must fail and name that field; with plain `row[field]` the
  // inherited value would satisfy the guard and the payload would validate clean.
  const cases = [
    // requireNumber / requireString / requireCount on a generic daily row.
    ["daily[0].totalCost", () =>
      validateDaily({ totals: { totalCost: 5, totalTokens: 50 },
        daily: [inherit({ totalCost: 5 }, omit(dailyRow(), "totalCost"))] })],
    ["daily[0].period", () =>
      validateDaily({ totals: { totalCost: 5, totalTokens: 50 },
        daily: [inherit({ period: "2026-01-01" }, omit(dailyRow(), "period"))] })],
    ["daily[0].totalTokens", () =>
      validateDaily({ totals: { totalCost: 5, totalTokens: 50 },
        daily: [inherit({ totalTokens: 50 }, omit(dailyRow(), "totalTokens"))] })],
    // The --instances spelling of the same guards.
    ["projects.-p.date", () =>
      validateInstances(inst(inherit({ date: "2026-01-01" }, omit(instRow(), "date"))))],
    // validateModelBreakdowns' own field guards.
    ["modelBreakdowns.modelName", () =>
      validateInstances(inst({ ...instRow(),
        modelBreakdowns: [inherit({ modelName: "m" }, omit(mbEntry(), "modelName"))] }))],
    ["modelBreakdowns.cost", () =>
      validateInstances(inst({ ...instRow(),
        modelBreakdowns: [inherit({ cost: 15 }, omit(mbEntry(), "cost"))] }))],
    ["modelBreakdowns.inputTokens", () =>
      validateInstances(inst({ ...instRow(),
        modelBreakdowns: [inherit({ inputTokens: 1 }, omit(mbEntry(), "inputTokens"))] }))],
    // requirePresent, on the two codex-daily totals.
    ["codex daily totals.costUSD", () =>
      validateCodexDaily({ daily: [], totals: inherit({ costUSD: 10 }, { totalTokens: 0 }) })],
    ["codex daily totals.totalTokens", () =>
      validateCodexDaily({ daily: [], totals: inherit({ totalTokens: 100 }, { costUSD: 0 }) })],
    // requirePresent again, nested one level down in a consumed session models map.
    ["sessions[0].models.gpt-5.5.totalTokens", () =>
      validateCodexSessions(sessions({ ...sess(),
        models: { "gpt-5.5": inherit({ totalTokens: 100 }, {}) } }))],
  ];
  for (const [field, run] of cases) {
    assert.throws(run, (e) => {
      assert.ok(e instanceof UsageError, `${field}: must be a UsageError`);
      assert.ok(
        e.message.includes(field),
        `expected the error to name ${field}, got: ${e.message}`,
      );
      return true;
    }, `an inherited ${field} must not satisfy its guard`);
  }

  // The COLLECTION reads, where inheritance would not merely mislabel a field but hide an
  // entire vanished collection: `own(root, 'projects')`/`own(root, 'daily')` decide the
  // empty-result branch, so an inherited one would make a renamed collection validate clean.
  assert.throws(
    () => validateInstances(inherit({ projects: { "-p": [instRow()] } }, { totals: { totalCost: 15, totalTokens: 30 } })),
    /non-zero totals/,
    "an inherited 'projects' must not stand in for the real collection",
  );
  assert.throws(
    () => validateDaily(inherit({ daily: [dailyRow()] }, { totals: { totalCost: 5, totalTokens: 50 } })),
    /non-zero totals/,
    "an inherited 'daily' must not stand in for the real collection",
  );
  assert.throws(
    () => validateDaily(inherit({ totals: { totalCost: 5, totalTokens: 50 } }, { daily: [dailyRow()] })),
    /has no 'totals' object/,
    "an inherited 'totals' must not satisfy requireRoot",
  );
  // `sessions` is the one collection whose absence is deliberately NOT the validator's to
  // report — codex.ts:138 owns that frozen message, so validateCodexSessions steps aside and
  // simply returns. The observable proof that `own()` is in play is therefore the opposite
  // shape: an inherited `sessions` must be INVISIBLE, so a session inside it that would
  // otherwise be rejected is never examined at all.
  assert.doesNotThrow(
    () =>
      validateCodexSessions(
        inherit(
          { sessions: [{ ...sess(), totalTokens: 2 ** 53 }] },
          { totals: { costUSD: 10, totalTokens: 100 } },
        ),
      ),
    "an inherited 'sessions' must not be walked — its rows are not part of the payload",
  );

  // The OTHER direction, which a "still throws" assertion alone cannot prove: `checkCounters`
  // range-checks only what is PRESENT, so an inherited counter must be skipped rather than
  // examined. Under plain property access this 2^53 would be read and rejected.
  //
  // `omit` is load-bearing here and its absence made this assertion VACUOUS: `instRow()`
  // carries its own `inputTokens: 1`, which shadowed the prototype's 2^53 entirely, so the
  // payload was simply valid and proved nothing (code review R8).
  assert.doesNotThrow(
    () => validateInstances(inst(inherit({ inputTokens: 2 ** 53 }, omit(instRow(), "inputTokens")))),
    "an inherited counter must not be range-checked — own() means own, in both directions",
  );

  // The COLLECTION reads on the same "must be invisible" side. These are the sites where
  // inheritance would be worst: a renamed `modelBreakdowns`/`models` is exactly the
  // silently-zeroed-per-model-column bug this ticket exists to close, so an inherited value
  // standing in for the real key must not rescue it. Each of these survived mutation until
  // now, because only the throwing direction was covered (code review R8).
  const collections = [
    ["projects row modelBreakdowns", () =>
      validateInstances(inst(inherit({ modelBreakdowns: [mbEntry()] }, omit(instRow(), "modelBreakdowns"))))],
    ["daily row modelBreakdowns", () =>
      validateDaily({ totals: { totalCost: 5, totalTokens: 50 },
        daily: [inherit({ modelBreakdowns: [mbEntry()] }, omit(dailyRow(), "modelBreakdowns"))] })],
    ["codex session models", () =>
      validateCodexSessions(sessions(inherit({ models: { "gpt-5.5": { totalTokens: 1 } } }, omit(sess(), "models"))))],
  ];
  for (const [what, run] of collections) {
    assert.throws(run, (e) => e instanceof UsageError, `an inherited ${what} must not stand in for the real key`);
  }

  // And the remaining range-check reads, where inheritance must make the value INVISIBLE
  // rather than examined — the same direction as the counter case above.
  assert.doesNotThrow(
    () => validateInstances({ projects: { "-p": [instRow()] },
      totals: inherit({ totalTokens: 2 ** 53 }, { totalCost: 15 }) }),
    "an inherited claude totals.totalTokens must not be range-checked",
  );
  assert.doesNotThrow(
    () => validateCodexSessions(sessions({ ...sess(),
      models: { "gpt-5.5": inherit({ totalTokens: 2 ** 53 }, { totalTokens: 1 }) } })),
    "an OWN per-model totalTokens must win over the prototype's",
  );
  assert.doesNotThrow(
    () => validateCodexDaily(inherit({ daily: [{ totalTokens: 2 ** 53 }] }, { totals: { costUSD: 0, totalTokens: 0 } })),
    "an inherited codex 'daily' must not be walked",
  );
  assert.doesNotThrow(
    () => validateCodexSessions(inherit({ totals: { totalTokens: 2 ** 53 } }, { sessions: [] })),
    "an inherited session 'totals' must not be range-checked (this path has no requireRoot)",
  );
});

// ALLOWLIST 7 claims the safe-integer bound covers ANY integral field. `validateModelBreakdowns`
// checks the four counters through `requireCount`, but `totalTokens` is not among them (the
// producer never emits it on a breakdown entry, so it must not be REQUIRED) — and swapping
// CLAUDE_TOKEN_FIELDS for BREAKDOWN_TOKEN_FIELDS dropped it from the range sweep entirely,
// narrowing the entry without recording it (code review R8).
test("a breakdown entry's totalTokens is range-checked when present, though not required", () => {
  const mb = (over) => inst({ ...instRow(), modelBreakdowns: [mbEntry(over)] });
  // Absent stays valid — requiring it would reject every real payload.
  assert.doesNotThrow(() => validateInstances(mb({})));
  // Present and representable stays valid.
  assert.doesNotThrow(() => validateInstances(mb({ totalTokens: Number.MAX_SAFE_INTEGER })));
  // Present and already rounded by JSON.parse is rejected.
  assert.throws(
    () => validateInstances(mb({ totalTokens: 2 ** 53 })),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /modelBreakdowns\.totalTokens/);
      return true;
    },
  );
});

// The `directory` guard was the single field read the R7 `own()` sweep missed (R8).
test("an inherited 'directory' does not satisfy the codex session type guard", () => {
  const proto = { directory: "2026/01/01" }; // a VALID value, inherited rather than own
  const s = Object.assign(Object.create(proto), omit(sess(), "directory"));
  // Absent-and-inherited must read as ABSENT, which is legitimate (optional field), so this
  // validates — and it must not be seen as the string on the prototype.
  assert.doesNotThrow(() => validateCodexSessions(sessions(s)));
  // With an own value of the wrong type it must still be rejected, proving the guard runs.
  assert.throws(
    () => validateCodexSessions(sessions({ ...sess(), directory: 42 })),
    /expected a string, null, or absent/,
  );
});

// `requireGenuinelyEmpty` gates the absent-collection exemption on BOTH counters being zero.
// Three existing tests approach this and all three exercise only the TOKENS half, so
// dropping `cost !== 0 ||` survived the whole suite (code review R8). Cost-positive with
// zero tokens is the mirror case: a priced result whose collection vanished.
test("an absent collection with positive COST but zero tokens still fails", () => {
  throws(() => validateInstances({ totals: { totalCost: 15, totalTokens: 0 } }));
  throws(() => validateDaily({ totals: { totalCost: 5, totalTokens: 0 } }));
  // Both zero remains the one legitimate shape.
  assert.doesNotThrow(() => validateInstances({ totals: { totalCost: 0, totalTokens: 0 } }));
  assert.doesNotThrow(() => validateDaily({ totals: { totalCost: 0, totalTokens: 0 } }));
});

// `checkSafeInteger` is guarded by `Number.isInteger(v)` — the bound is about values
// JSON.parse has ALREADY rounded, and a fractional counter is not one of them. Dropping that
// guard would turn every non-integral token count into a hard failure where Python simply
// sums it as a float. Nothing fed a fractional counter, so the narrowing was unstated (R8).
test("a fractional token count is accepted, not treated as an unsafe integer", () => {
  assert.doesNotThrow(() => validateInstances(inst({ ...instRow(), totalTokens: 1.5 })));
  assert.doesNotThrow(() => validateDaily(daily({ ...dailyRow(), totalTokens: 0.25 })));
  assert.doesNotThrow(() => validateInstances(inst({ ...instRow(), inputTokens: 2.5 })));
  // The bound itself still applies to integral values.
  throws(() => validateInstances(inst({ ...instRow(), totalTokens: 2 ** 53 })));
});

// `requireNumber` rejects non-FINITE as well as non-number. Unreachable from JSON.parse
// (which cannot produce Infinity/NaN), but these validators are a public entry point that
// fixture tests call directly, and the finite half was entirely unpinned (R8).
test("requireNumber rejects a non-finite number, not merely a non-number", () => {
  for (const v of [Infinity, -Infinity, NaN]) {
    throws(() => validateInstances(inst({ ...instRow(), totalCost: v })));
    throws(() => validateInstances(inst({ ...instRow(), modelBreakdowns: [mbEntry({ cost: v })] })));
  }
});
