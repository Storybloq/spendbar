// Differential test: pyRepr() vs CPython repr(). Parity-critical — frozen diagnostics
// embed f"{v!r}" and the codex_bad_cost golden asserts "= True", not "= true".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pyRepr } from "../dist/pyrepr.js";

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
