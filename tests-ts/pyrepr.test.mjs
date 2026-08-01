// Differential test: pyRepr() vs CPython repr(). Parity-critical — frozen diagnostics
// embed f"{v!r}" and the codex_bad_cost golden asserts "= True", not "= true".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pyRepr } from "../dist/pyrepr.js";
import { money } from "../dist/format.js";

// Each case: [jsValue, pythonExpression]. Python side is evaluated by python3 so the
// expectation is generated, never hand-written.
const CASES = [
  [true, "True"],
  [false, "False"],
  [null, "None"],
  [0, "0"],
  [-0, "-0"],
  [1, "1"],
  [42, "42"],
  [-17, "-17"],
  [1.5, "1.5"],
  [-2.25, "-2.25"],
  [1e21, "1e21"],
  [0.1, "0.1"],
  // Float repr: Python goes scientific at exp < -4 (JS waits for -6) and pads the
  // exponent to two digits (JS does not). Code review R1.
  [1e-5, "1e-05"],
  [1e-7, "1e-07"],
  [-1.5e-7, "-1.5e-07"],
  [0.0001, "0.0001"],
  [1.25e-4, "1.25e-04"],
  [9.87e-13, "9.87e-13"],
  ["", "''"],
  ["hi", "'hi'"],
  ["it's", `"it's"`],
  ['say "hi"', `'say "hi"'`],
  ["tab\there", "'tab\\there'"],
  ["nl\nhere", "'nl\\nhere'"],
  ["back\\slash", "'back\\\\slash'"],
];

test("pyRepr matches CPython repr", () => {
  const exprs = CASES.map(([, py]) => py);
  const script = `print("\\n".join(repr(x) for x in [${exprs.join(",")}]))`;
  const out = spawnSync("python3", ["-c", script], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const expected = out.stdout.replace(/\n$/, "").split("\n");

  CASES.forEach(([js], i) => {
    assert.equal(pyRepr(js), expected[i], `case ${i}: ${JSON.stringify(js)}`);
  });
});

// usage.py:106 is `sys.exit(f"bad relative date {s!r}: ...")` — the quoting comes from
// repr, so a value containing a quote or backslash must match CPython exactly.
test("pyRepr matches CPython repr for adversarial diagnostic strings", () => {
  const cases = ["-'d", '-"d', "-\\d", "-a'b\"c\\d", "-\td", "-\nd", "-\x01d", "-é'd"];
  const script =
    "import sys,json\n" +
    "for s in json.loads(sys.argv[1]): print(repr(s))\n";
  const out = spawnSync("python3", ["-c", script, JSON.stringify(cases)], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const expected = out.stdout.replace(/\n$/, "").split("\n");
  cases.forEach((s, i) => assert.equal(pyRepr(s), expected[i], `case ${i}: ${JSON.stringify(s)}`));
});

// CPython escapes every non-printable code point (Cc/Cf/Cs/Co/Cn and all Zs except ASCII
// space, plus Zl/Zp) as \xNN, \uNNNN or \UNNNNNNNN. An ASCII-only test emitted U+0085,
// U+00A0, U+200B and U+2028 literally (code review R2).
test("pyRepr escapes non-printable Unicode exactly as CPython does", () => {
  const points = [
    0x00, 0x07, 0x1b, 0x7f, 0x80, 0x85, 0xa0, 0xad, 0x20, 0x2000, 0x200b, 0x2028, 0x2029,
    0x3000, 0xfeff, 0xe000, 0x10ffff, 0x1f600, 0xd7ff, 0x0300, 0x00e9, 0x05d0,
  ];
  const cases = points.map((cp) => "a" + String.fromCodePoint(cp) + "b");
  const script =
    "import sys,json\n" + "for s in json.loads(sys.argv[1]): print(repr(s))\n";
  const out = spawnSync("python3", ["-c", script, JSON.stringify(cases)], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const expected = out.stdout.replace(/\n$/, "").split("\n");
  cases.forEach((s, i) => {
    assert.equal(pyRepr(s), expected[i], `U+${points[i].toString(16).toUpperCase()}`);
  });
});

test("pyRepr of a boolean is capitalized (the codex_bad_cost golden)", () => {
  assert.equal(
    `unexpected ccusage codex output: sessions[0].costUSD = ${pyRepr(true)} (expected a finite non-negative number)`,
    "unexpected ccusage codex output: sessions[0].costUSD = True (expected a finite non-negative number)",
  );
});

/**
 * ALLOWLIST entry 9, the success-path half (ISS-008).
 *
 * Entry 9 used to claim the int/float token distinction "never affects a computed figure or
 * a success-path byte". The bare token `-0` is a counterexample: Python parses it to `int`
 * 0, which has no sign, so `f"{v:,.2f}"` is `0.00`; `JSON.parse` gives float `-0`, which
 * formats as `-0.00`. `cnum` accepts it, so both sides exit 0 and print different bytes.
 *
 * These tests exist because that entry has now had an overstated claim found in it in five
 * consecutive review rounds. Prose is what kept being wrong, so the fix is to hold the
 * corrected prose to a measurement — including the part that says what does NOT diverge.
 */
const MONEY_TOKENS = ["-0", "-0.0", "0", "0.0", "-1", "-1.0", "1e2", "0.005", "-0.004"];

/** `f"${v:,.2f}"` — usage.py's money(), evaluated by CPython from the raw JSON token. */
function pythonMoney(tokens) {
  const script =
    "import sys, json\n" +
    "for t in json.loads(sys.argv[1]):\n" +
    "    v = json.loads(t)\n" +
    '    print(f"${v:,.2f}")\n';
  const out = spawnSync("python3", ["-c", script, JSON.stringify(tokens)], { encoding: "utf8" });
  if (out.error?.code === "ENOENT") return null;
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.replace(/\n$/, "").split("\n");
}

const moneyOracle = pythonMoney(MONEY_TOKENS);

test("money() agrees with CPython on every token EXCEPT the sanctioned `-0` (ISS-008)", {
  skip: moneyOracle === null ? "python3 is unavailable" : false,
}, () => {
  const got = MONEY_TOKENS.map((t) => money(JSON.parse(t)));
  const diverged = MONEY_TOKENS.filter((t, i) => got[i] !== moneyOracle[i]);

  // The exception is exactly one token, and it is the one entry 9 now names. Asserting the
  // SET rather than just the known case is what makes this a guard: a new divergence shows
  // up here rather than silently joining an already-sanctioned one.
  assert.deepEqual(diverged, ["-0"], `unexpected money divergences: ${diverged.join(", ")}`);
  assert.equal(money(JSON.parse("-0")), "$-0.00");
  assert.equal(moneyOracle[MONEY_TOKENS.indexOf("-0")], "$0.00");

  // And the near-miss that makes the entry's wording precise: the FLOAT token keeps its sign
  // in Python, so `-0.0` agrees. Only the integer token loses it.
  assert.equal(money(JSON.parse("-0.0")), "$-0.00");
  assert.equal(moneyOracle[MONEY_TOKENS.indexOf("-0.0")], "$-0.00");
});

/**
 * The refutation, kept as a test so it stays true (ISS-008, entry 7).
 *
 * ISS-008 also proposed unchecked cost fields as a success-path counterexample, on the
 * grounds that Python keeps integers above 2^53 exact. It does — but no cost reaches output
 * as an integer: `.2f` converts to binary64 on both sides, and every cost accumulator in
 * usage.py is seeded `0.0`, so summation is float arithmetic in both languages. If either of
 * those ever stops being true, entry 7's stated reason for stopping at token counters is
 * void, and this test is what says so.
 */
test("an out-of-safe-range cost cannot change a printed byte (ISS-008, entry 7)", {
  skip: moneyOracle === null ? "python3 is unavailable" : false,
}, () => {
  const BIG = "9007199254740993"; // 2^53 + 1: exact as a Python int, unrepresentable as f64
  const single = pythonMoney([BIG]);
  assert.equal(money(JSON.parse(BIG)), single[0], "a single huge cost must format identically");

  // The summation case, which is the only way Python's exact ints could have shown through.
  // Python's accumulator is a float, so `0.0 + 9007199254740993 + 1` is float arithmetic —
  // the same value JS computes.
  const script =
    "import sys, json\n" +
    "acc = 0.0\n" +
    "for t in json.loads(sys.argv[1]): acc += json.loads(t)\n" +
    'print(f"${acc:,.2f}")\n';
  const out = spawnSync("python3", ["-c", script, JSON.stringify([BIG, "1"])], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const jsAcc = [BIG, "1"].reduce((n, t) => n + JSON.parse(t), 0);
  assert.equal(money(jsAcc), out.stdout.trim(), "float accumulators must agree across languages");

  // The premise, stated so it cannot rot: this value really is beyond exact f64.
  assert.ok(!Number.isSafeInteger(JSON.parse(BIG)));
  assert.notEqual(String(JSON.parse(BIG)), BIG, "JSON.parse must round it, or there is nothing to test");
});
