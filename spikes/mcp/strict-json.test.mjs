// Differential tests for the evidence parser (review round 1).
//
// The parser's whole contract is "JSON.parse, except duplicate keys are refused". That is a
// claim about EQUIVALENCE, so the tests are differential: every fixture is fed to both, and
// the only permitted disagreement is the duplicate-key case. A hand-written parser that
// merely "looks right" accepts leading zeros, truncated \u escapes and raw control
// characters — all of which JSON.parse rejects, and all of which would let malformed
// evidence through the verifier.
//
// Runs under `node --test` or directly (`node spikes/mcp/strict-json.test.mjs`).

import test from "node:test";
import assert from "node:assert/strict";

import { parseStrictJson, JsonSyntaxError, MAX_DEPTH } from "./strict-json.mjs";

/** JSON.parse's verdict, as data. */
function reference(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The parser's verdict, as data — any non-JsonSyntaxError escape is itself a failure. */
function subject(text) {
  try {
    return { ok: true, value: parseStrictJson(text) };
  } catch (error) {
    assert.ok(error instanceof JsonSyntaxError, `threw a non-JsonSyntaxError: ${error}`);
    return { ok: false };
  }
}

/** Structural equality that ignores prototype differences (the parser returns null-proto). */
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

function assertAgrees(text, label = text) {
  const ref = reference(text);
  const got = subject(text);
  assert.equal(got.ok, ref.ok, `acceptance disagrees with JSON.parse for ${label}`);
  if (ref.ok) assert.deepEqual(plain(got.value), plain(ref.value), `value disagrees for ${label}`);
}

// --- the accepted grammar ------------------------------------------------------------------

const VALID = [
  "{}",
  "[]",
  "null",
  "true",
  "false",
  "0",
  "-0",
  "0.5",
  "-0.5",
  "1e3",
  "1E3",
  "1e+3",
  "1e-3",
  "-1.5e-3",
  "123456789012345678901234567890",
  '""',
  '"plain"',
  '"with \\" quote"',
  '"escapes \\\\ \\/ \\b \\f \\n \\r \\t"',
  '"unicode \\u0041\\u00e9\\u4e2d"',
  '"surrogate pair \\ud83d\\ude00"',
  '"lone surrogate \\ud83d"',
  '"raw unicode é中🙂"',
  '{"a":1,"b":[1,2,{"c":null}]}',
  '  {  "a"  :  [ 1 , 2 ]  }  ',
  '{"":"empty key"}',
  '["\\u0000 escaped nul"]',
  '[1,2,3]',
  '{"nested":{"deep":{"deeper":[{"x":true}]}}}',
];

test("every valid JSON fixture parses identically to JSON.parse", () => {
  for (const text of VALID) assertAgrees(text);
});

// --- the rejected grammar ------------------------------------------------------------------

const INVALID = [
  ["", "empty input"],
  ["   ", "whitespace only"],
  ["{", "unterminated object"],
  ["[", "unterminated array"],
  ['{"a":1', "missing close brace"],
  ['{"a" 1}', "missing colon"],
  ['{"a":1,}', "trailing comma in object"],
  ["[1,]", "trailing comma in array"],
  ["[1,,2]", "double comma"],
  ["{a:1}", "unquoted key"],
  ["{'a':1}", "single-quoted key"],
  ['"unterminated', "unterminated string"],
  ["01", "leading zero"],
  ["-01", "negative leading zero"],
  ["1.", "trailing decimal point"],
  [".5", "bare fraction"],
  ["-.5", "negative bare fraction"],
  ["+1", "explicit plus"],
  ["1e", "empty exponent"],
  ["1e+", "exponent sign only"],
  ["0x10", "hex literal"],
  ["Infinity", "Infinity"],
  ["-Infinity", "-Infinity"],
  ["NaN", "NaN"],
  ["undefined", "undefined"],
  ["'single'", "single-quoted string"],
  ['"bad \\x41 escape"', "invalid escape character"],
  ['"truncated \\u41"', "truncated unicode escape"],
  ['"invalid \\u41zz"', "non-hex in unicode escape"],
  ['"prefix-hex \\u00gg"', "hex prefix then junk"],
  ['"raw newline\n"', "raw newline in string"],
  ['"raw tab\t"', "raw tab in string"],
  [`"raw nul ${String.fromCharCode(0)}"`, "raw NUL in string"], // constructed: a literal NUL would make this file scan as binary
  ["{} {}", "trailing content"],
  ["[1] [2]", "two documents"],
  ["nulll", "trailing content after null"],
  ["tru", "truncated true"],
];

test("every invalid fixture is rejected, exactly as JSON.parse rejects it", () => {
  for (const [text, label] of INVALID) assertAgrees(text, label);
});

test("a raw control character at every forbidden code point is rejected", () => {
  for (let code = 0x00; code <= 0x1f; code++) {
    assertAgrees(`"raw${String.fromCharCode(code)}"`, `raw U+${code.toString(16).padStart(4, "0")}`);
  }
});

test("every truncation length of a unicode escape is rejected", () => {
  for (const hex of ["", "4", "41", "414"]) {
    assertAgrees(`"\\u${hex}"`, `\\u with ${hex.length} hex digits`);
  }
  assertAgrees('"\\u0041"', "\\u with 4 hex digits (valid)");
});

// --- the ONE intended divergence -------------------------------------------------------------

test("a duplicated key is refused — the one place this parser differs from JSON.parse", () => {
  const text = '{"a":1,"a":2}';
  assert.equal(reference(text).ok, true, "JSON.parse is supposed to accept this (last wins)");
  assert.equal(JSON.parse(text).a, 2, "the silent last-wins behavior this parser exists to refuse");
  assert.throws(() => parseStrictJson(text), /duplicate key 'a'/);
});

test("duplicate detection reaches nested objects and repeated keys inside arrays", () => {
  assert.throws(() => parseStrictJson('{"outer":{"b":1,"b":2}}'), /duplicate key 'b'/);
  assert.throws(() => parseStrictJson('[{"c":1,"c":2}]'), /duplicate key 'c'/);
  assert.doesNotThrow(() => parseStrictJson('[{"c":1},{"c":2}]'), "distinct objects may share key names");
});

// --- prototype pollution ----------------------------------------------------------------------

test("a __proto__ key becomes an ordinary own property, not a prototype mutation", () => {
  // The critical review-round-1 finding: with `{}` + `out[key] = …` this key routes through
  // the inherited setter, creating NO own property — invisible to Object.keys, invisible to
  // the duplicate check, and able to serve inherited values to the verifier's field lookups.
  const parsed = parseStrictJson('{"__proto__":{"status":"pass"}}');
  assert.deepEqual(Object.keys(parsed), ["__proto__"], "__proto__ is not an own enumerable key");
  assert.equal(Object.getPrototypeOf(parsed), null, "the accumulator kept a null prototype");
  assert.equal(plain(parsed.__proto__).status, "pass", "the parsed value was lost");
  assert.equal({}.status, undefined, "Object.prototype was polluted");
});

test("a duplicated __proto__ key is caught like any other duplicate", () => {
  assert.throws(() => parseStrictJson('{"__proto__":1,"__proto__":2}'), /duplicate key '__proto__'/);
});

test("constructor and prototype keys are ordinary own properties too", () => {
  const parsed = parseStrictJson('{"constructor":{"prototype":{"polluted":true}},"prototype":1}');
  assert.deepEqual(Object.keys(parsed).sort(), ["constructor", "prototype"]);
  assert.equal({}.polluted, undefined, "Object.prototype was polluted");
});

test("an inherited field cannot masquerade as a present one", () => {
  // What the verifier does: read a field off a parsed record. A null-prototype object has
  // nothing to inherit, so an absent field is absent.
  const parsed = parseStrictJson("{}");
  assert.equal(parsed.toString, undefined);
  assert.equal(parsed.constructor, undefined);
  assert.equal("status" in parsed, false);
});

// --- bounds --------------------------------------------------------------------------------

test("nesting past the documented depth fails as a JsonSyntaxError, never a RangeError", () => {
  const tooDeep = "[".repeat(MAX_DEPTH + 5) + "]".repeat(MAX_DEPTH + 5);
  assert.throws(() => parseStrictJson(tooDeep), (e) => e instanceof JsonSyntaxError && /nesting deeper/.test(e.message));
  // The positive control: just inside the limit still parses, so the guard is not vacuous.
  const justInside = "[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH);
  assert.doesNotThrow(() => parseStrictJson(justInside));
});

test("non-string input is refused rather than coerced", () => {
  for (const input of [null, undefined, 42, {}, Buffer.from("{}")]) {
    assert.throws(() => parseStrictJson(input), JsonSyntaxError);
  }
});

// --- round-tripping the real evidence ---------------------------------------------------------

test("large realistic documents parse identically", () => {
  const doc = {
    caseList: ["initialize", "tools-list", "tools-call"],
    files: Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`path/to/file-${n}.mjs`, "0".repeat(64)])),
    notes: ["a note with unicode é and a quote \" and a backslash \\"],
    nested: { deep: [{ a: 1 }, { b: [true, false, null, 1.5e-3] }] },
  };
  assertAgrees(JSON.stringify(doc), "generated evidence-shaped document");
  assertAgrees(JSON.stringify(doc, null, 2), "the same document, pretty-printed");
});
