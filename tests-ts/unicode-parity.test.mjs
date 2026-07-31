/**
 * ISS-006, ISS-007 and ISS-012 are one root cause with three symptoms: JS measures and
 * orders strings in UTF-16 code units, CPython in code points. This asserts all three
 * against the live CPython rather than against my reading of it, over a corpus built to
 * put the divergence in every position it can occupy.
 *
 * Same shape as unicode-tables.test.mjs: drive python3, compare, and skip loudly rather
 * than silently if the interpreter is not there.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { encodePath } from "../dist/config.js";
import { padLeft, padRight, pyLen } from "../dist/format.js";
import { pyCompareStr, pyMaxStr, pyMinStr, pySorted } from "../dist/pysort.js";
import { aggProjects, cnum } from "../dist/aggregate.js";
import { createDeps, DEFAULT_CONFIG } from "../dist/context.js";

/**
 * Strings chosen so the astral/BMP boundary lands in every position that matters: alone,
 * leading, trailing, interior, adjacent to U+FFFD (the BMP character that outranks a lead
 * surrogate and so flips the comparison), and as an unpaired surrogate.
 */
const CORPUS = [
  "",
  "a",
  "abc",
  "ab",
  "Beta Product",
  "\u{1F600}",
  "a\u{1F600}b",
  "\u{1F600}a",
  "a\u{1F600}",
  "\u{10000}",
  "�",
  "�a",
  "\u{10FFFF}",
  "퟿",
  "",
  "café",
  "café",
  "日本語",
  "𝐀𝐁",
  "/Users/testuser/Dev/\u{1F600}proj",
  "~/proj",
  "\uD800",
  "  padded  ",
  "x".repeat(30),
  "\u{1F600}".repeat(15),
];

const PY = `
import json, re, sys, functools
corpus = json.loads(sys.stdin.read())
def cmp(a, b):
    return -1 if a < b else (1 if a > b else 0)
print(json.dumps({
    "len":       [len(s) for s in corpus],
    "pad22":     [f"{s:22}" for s in corpus],
    "rpad22":    [f"{s:>22}" for s in corpus],
    "pad0":      [f"{s:0}" for s in corpus],
    "encode":    [re.sub(r"[^A-Za-z0-9]", "-", s) for s in corpus],
    "sorted":    sorted(corpus),
    "min":       min(corpus),
    "max":       max(corpus),
    "pairs":     [[cmp(a, b) for b in corpus] for a in corpus],
}))
`;

/**
 * Ask CPython, distinguishing "no interpreter" from "the oracle broke".
 *
 * The first version of this returned null on ANY non-zero status, and the corpus's lone
 * surrogate made the oracle exit 1 — so every comparison below skipped while the suite
 * reported green. That is the vacuous-verification failure this whole file exists to catch,
 * committed by the file itself. Only ENOENT is a legitimate skip now; a script that ran and
 * failed is a hard error with its stderr attached.
 *
 * (The failure was `json.dumps(ensure_ascii=False)` handing `print` a string containing an
 * unpaired surrogate, which no UTF-8 encoder will accept. `ensure_ascii=True` emits pure
 * ASCII with a `\ud800` escape, which JSON.parse restores exactly — so the lone surrogate
 * stays in the corpus, where it belongs.)
 */
function askPython() {
  const r = spawnSync("python3", ["-c", PY], { input: JSON.stringify(CORPUS), encoding: "utf8" });
  if (r.error?.code === "ENOENT") return null;
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`the CPython oracle failed (exit ${r.status}); refusing to skip:\n${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

const oracle = askPython();

describe("unicode parity with CPython", { skip: oracle === null ? "python3 is unavailable" : false }, () => {
  test("pyLen counts code points, exactly as len() does (ISS-007)", () => {
    assert.deepEqual(CORPUS.map(pyLen), oracle.len);
    // The premise: for at least some of the corpus, .length disagrees. Without this the
    // assertion above would still pass on an ASCII-only corpus and prove nothing.
    assert.ok(
      CORPUS.some((s) => s.length !== pyLen(s)),
      "corpus has no astral strings, so it cannot detect a UTF-16 length",
    );
  });

  test("padRight / padLeft match f-string padding (ISS-007)", () => {
    assert.deepEqual(CORPUS.map((s) => padRight(s, 22)), oracle.pad22);
    assert.deepEqual(CORPUS.map((s) => padLeft(s, 22)), oracle.rpad22);
  });

  test("a string wider than the field comes back unchanged, never truncated", () => {
    // CPython never truncates without an explicit `.N` precision. Framed as preservation
    // rather than truncation so it guards against a future helper that slices to width.
    for (const s of CORPUS) {
      assert.equal(padRight(s, 0), s);
      assert.equal(padLeft(s, 0), s);
      if (pyLen(s) > 5) {
        assert.equal(padRight(s, 5), s);
        assert.equal(padLeft(s, 5), s);
      }
    }
    assert.deepEqual(CORPUS.map((s) => padRight(s, 0)), oracle.pad0);
  });

  test("encodePath replaces one astral character with one dash (ISS-006)", () => {
    assert.deepEqual(CORPUS.map(encodePath), oracle.encode);
    assert.ok(
      CORPUS.some((s) => s.replace(/[^A-Za-z0-9]/g, "-") !== encodePath(s)),
      "corpus cannot distinguish the u-flag regex from the unit-wise one",
    );
  });

  test("pyCompareStr agrees with Python on every ordered pair (ISS-012)", () => {
    const mine = CORPUS.map((a) => CORPUS.map((b) => sign(pyCompareStr(a, b))));
    assert.deepEqual(mine, oracle.pairs);
    // And the divergence it exists to close is real in this corpus.
    const jsUnitwise = CORPUS.map((a) => CORPUS.map((b) => (a < b ? -1 : a > b ? 1 : 0)));
    assert.notDeepEqual(jsUnitwise, oracle.pairs, "corpus cannot detect UTF-16 ordering");
  });

  test("pySorted with a string key matches sorted() (ISS-012)", () => {
    assert.deepEqual(pySorted(CORPUS, { kind: "string", key: (s) => s }), oracle.sorted);
    assert.notDeepEqual([...CORPUS].sort(), oracle.sorted, "corpus cannot detect a bare .sort()");
  });

  test("pyMinStr / pyMaxStr match min() / max() (ISS-012)", () => {
    assert.equal(CORPUS.reduce(pyMinStr), oracle.min);
    assert.equal(CORPUS.reduce(pyMaxStr), oracle.max);
  });
});

/**
 * The end of ISS-012 that is reachable without any renderer: `aggProjects` accumulates
 * first/last with min/max over whatever `date` the payload carried, and ALLOWLIST 14 admits
 * arbitrary strings there. Testing `pyMinStr` alone would leave `<` / `>` free to survive at
 * the call site, which is where the wrong table actually comes from.
 *
 * Expectations come from CPython, not from reasoning about the sentinels. The first draft
 * of this test asserted that `first` would discriminate; it cannot. `first` is seeded with
 * "9999-99-99" and the UTF-16/code-point divergence exists only between astral characters
 * and BMP characters at U+D800 or above — every one of which outranks "9". So the seed wins
 * under either ordering, and only `last` can tell the two apart.
 */
test("aggProjects first/last use code-point order (ISS-012, at the call site)", {
  skip: oracle === null ? "python3 is unavailable" : false,
}, () => {
  const dates = ["\u{10000}", "�"];
  const want = pyMinMax(["9999-99-99", ...dates], ["0000-00-00", ...dates]);

  const deps = createDeps({ CCUSAGE_CMD: "ccusage" }, "/Users/testuser", () => ({ status: 0, stdout: "{}", stderr: "" }), {
    today: () => "20260731",
  });
  const ctx = { deps, config: { ...DEFAULT_CONFIG } };
  const { agg } = aggProjects(ctx, {
    projects: {
      proj: dates.map((date) => ({ date, totalCost: 1, totalTokens: 1, modelBreakdowns: [] })),
    },
    totals: { totalCost: 2 },
  });
  const a = agg.get("proj");
  assert.equal(a.first, want.min);
  assert.equal(a.last, want.max);

  // The premise, stated so this cannot pass by the two orderings agreeing: UTF-16 puts the
  // astral string BELOW U+FFFD, so a `<`/`>` call site picks U+FFFD as `last`.
  assert.ok(dates[0] < dates[1], "UTF-16 order must disagree here, or the test proves nothing");
  assert.notEqual(want.max, dates[1], "the corpus must make the two orderings choose differently");
});

/** min() over the first list and max() over the second, answered by CPython. */
function pyMinMax(forMin, forMax) {
  const r = spawnSync(
    "python3",
    ["-c", "import json,sys;a,b=json.load(sys.stdin);print(json.dumps({'min':min(a),'max':max(b)}))"],
    { input: JSON.stringify([forMin, forMax]), encoding: "utf8" },
  );
  assert.equal(r.status, 0, `the CPython oracle failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe("pySorted key contract", () => {
  test("a numeric key sorts ascending and is stable at ties", () => {
    const rows = [["a", 2], ["b", 1], ["c", 2], ["d", 1]];
    assert.deepEqual(
      pySorted(rows, { kind: "numeric", key: (r) => r[1] }).map((r) => r[0]),
      ["b", "d", "a", "c"],
    );
  });

  test("descending is a negated key, and stays stable — matching usage.py's seven sites", () => {
    const rows = [["a", 2], ["b", 1], ["c", 2], ["d", 1]];
    assert.deepEqual(
      pySorted(rows, { kind: "numeric", key: (r) => -r[1] }).map((r) => r[0]),
      ["a", "c", "b", "d"],
    );
  });

  test("a NaN key leaves order untouched instead of permuting arbitrarily", () => {
    const rows = [["a", NaN], ["b", 1], ["c", NaN]];
    assert.deepEqual(pySorted(rows, { kind: "numeric", key: (r) => r[1] }).map((r) => r[0]), ["a", "b", "c"]);
  });

  test("a tuple key compares element-wise, strings by code point", () => {
    const rows = [
      ["hi", ["b", 1]],
      ["lo", ["a", 9]],
      ["mid", ["a", 10]],
    ];
    assert.deepEqual(
      pySorted(rows, { kind: "tuple", key: (r) => r[1] }).map((r) => r[0]),
      ["lo", "mid", "hi"],
    );
    // Numeric components compare numerically, not as text: 9 < 10.
    const byText = [...rows].sort((x, y) => String(x[1]).localeCompare(String(y[1])));
    assert.notDeepEqual(byText.map((r) => r[0]), ["lo", "mid", "hi"]);
  });

  test("a tuple key with astral strings uses code-point order", () => {
    const rows = [["astral", ["\u{10000}"]], ["fffd", ["�"]]];
    assert.deepEqual(pySorted(rows, { kind: "tuple", key: (r) => r[1] }).map((r) => r[0]), ["fffd", "astral"]);
  });

  test("a mixed-type tuple element throws rather than inventing an order", () => {
    const rows = [["x", ["a"]], ["y", [1]]];
    assert.throws(() => pySorted(rows, { kind: "tuple", key: (r) => r[1] }), TypeError);
  });

  test("pySorted returns a new array and leaves the input alone", () => {
    const input = ["b", "a"];
    const out = pySorted(input, { kind: "string", key: (s) => s });
    assert.deepEqual(input, ["b", "a"]);
    assert.deepEqual(out, ["a", "b"]);
  });
});

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("tuple sort keys containing NaN (code review R1)", () => {
  test("the comparator is CONSISTENT, so the sort cannot permute unrelated rows", () => {
    // The defect being guarded: `if (x !== y) return x < y ? -1 : 1` reports "greater" for
    // both (NaN, v) and (v, NaN). Array.prototype.sort is free to misbehave arbitrarily on
    // an inconsistent comparator, so this asserts antisymmetry directly on the key path.
    const key = (t) => t;
    const pairs = [
      [[NaN, "a"], [NaN, "b"]],
      [[NaN, "a"], [1, "a"]],
      [[1, "a"], [NaN, "a"]],
    ];
    for (const [p, q] of pairs) {
      const fwd = pySorted([p, q], { kind: "tuple", key });
      const rev = pySorted([q, p], { kind: "tuple", key });
      // A consistent comparator that calls the pair "equal" leaves a stable sort untouched.
      assert.deepEqual(fwd, [p, q], `sorting [p,q] reordered ${JSON.stringify([p, q])}`);
      assert.deepEqual(rev, [q, p], `sorting [q,p] reordered ${JSON.stringify([q, p])}`);
    }
  });

  test("a NaN cost cannot reach a tuple key, which is why CPython's semantics are not emulated", () => {
    // The comment in compareTuple rests on this. If validation ever stopped rejecting
    // non-finite numbers, emulating CPython's identity-shortcut tuple comparison would
    // become load-bearing, and this test is what says so.
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => cnum(bad, "probe"), /expected a fin/, `cnum accepted ${bad}`);
    }
  });
});
