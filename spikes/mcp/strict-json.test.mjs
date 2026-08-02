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

import { parseStrictJson, JsonSyntaxError, MAX_DEPTH, MAX_INPUT_CHARS, JsonLimitError } from "./strict-json.mjs";

// The documented bounds, written HERE as independent literals. Every boundary fixture below is
// built from these, not from the exports: fixtures derived from the same constant the
// implementation uses move with it, so an edit changing the limit and its export together kept
// the whole suite green while the documented bound silently changed (review round 2, chunk 14).
const EXPECTED_MAX_DEPTH = 200;
const EXPECTED_MAX_INPUT_CHARS = 50_000_000;

test("the exported bounds are the documented ones", () => {
  assert.equal(MAX_DEPTH, EXPECTED_MAX_DEPTH);
  assert.equal(MAX_INPUT_CHARS, EXPECTED_MAX_INPUT_CHARS);
});

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

/**
 * Structural equality that ignores prototype differences (the parser returns null-proto) and
 * compares primitives with Object.is.
 *
 * It used to round-trip both sides through JSON.stringify, which erases exactly the distinctions
 * a numeric parser can get wrong: -0 serializes as 0, so the `-0` fixture passed whether or not
 * the parser preserved the sign (review round 1, chunk 14).
 */
function assertSameValue(got, want, path = "$") {
  if (Array.isArray(want) || Array.isArray(got)) {
    assert.ok(Array.isArray(got) && Array.isArray(want), `${path}: only one side is an array`);
    assert.equal(got.length, want.length, `${path}: array length`);
    for (let i = 0; i < want.length; i++) assertSameValue(got[i], want[i], `${path}[${i}]`);
    return;
  }
  if (want !== null && typeof want === "object") {
    assert.ok(got !== null && typeof got === "object", `${path}: expected an object`);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${path}: own key sets differ`);
    for (const key of Object.keys(want)) assertSameValue(got[key], want[key], `${path}.${key}`);
    return;
  }
  assert.ok(Object.is(got, want), `${path}: ${String(got)} is not ${String(want)}`);
}

function assertAgrees(text, label = text) {
  const ref = reference(text);
  const got = subject(text);
  assert.equal(got.ok, ref.ok, `acceptance disagrees with JSON.parse for ${label}`);
  if (ref.ok) assertSameValue(got.value, ref.value, `value for ${label}`);
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
  // Numeric edges where a hand-rolled scanner and JSON.parse can legitimately disagree: overflow
  // to Infinity, underflow to zero, and the integers either side of IEEE-754's exact range.
  "1e400",
  "-1e400",
  "1e-400",
  "-1e-400",
  "9007199254740993",
  "-9007199254740993",
  "0.1",
  "1.0000000000000002",
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
  // A for-of over an empty list asserts nothing and reports success, so the list's own size is
  // the first assertion (review round 2, chunk 14).
  assert.ok(VALID.length >= 35, `the accepted-grammar corpus shrank to ${VALID.length}`);
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
  assert.ok(INVALID.length >= 35, `the rejected-grammar corpus shrank to ${INVALID.length}`);
  for (const [text, label] of INVALID) assertAgrees(text, label);
});

test("a raw control character at every forbidden code point is rejected", () => {
  for (let code = 0x00; code <= 0x1f; code++) {
    assertAgrees(`"raw${String.fromCharCode(code)}"`, `raw U+${code.toString(16).padStart(4, "0")}`);
  }
});

// JSON's whitespace is exactly four characters — space, tab, LF, CR — and nothing else. A
// scanner written with /\s/ or a hand-picked subset diverges from JSON.parse in both
// directions, and neither direction was covered: no fixture used tab or CR outside a string,
// and none of the characters JavaScript calls whitespace but JSON does not appeared at all
// (review round 2, chunk 14).
const JSON_WHITESPACE = [
  [" ", "space"],
  ["\t", "tab"],
  ["\n", "LF"],
  ["\r", "CR"],
];

// Whitespace to JavaScript, not to JSON. Every one of these must be REJECTED outside a string.
const NOT_JSON_WHITESPACE = [
  ["\ufeff", "BOM"],
  ["\u00a0", "NBSP"],
  ["\u000b", "vertical tab"],
  ["\u000c", "form feed"],
  ["\u2028", "line separator"],
  ["\u2029", "paragraph separator"],
  ["\u3000", "ideographic space"],
];

test("the four JSON whitespace characters are accepted at every value boundary", () => {
  assert.equal(JSON_WHITESPACE.length, 4, "JSON defines exactly four whitespace characters");
  for (const [ws, label] of JSON_WHITESPACE) {
    // Around the document, and at each structural position inside it.
    assertAgrees(`${ws}{${ws}"a"${ws}:${ws}[${ws}1${ws},${ws}2${ws}]${ws}}${ws}`, `${label} at every boundary`);
    assertAgrees(`${ws}null${ws}`, `${label} around a bare value`);
  }
});

test("characters JavaScript calls whitespace but JSON does not are rejected", () => {
  assert.ok(NOT_JSON_WHITESPACE.length >= 7, "the non-JSON whitespace corpus shrank");
  for (const [ch, label] of NOT_JSON_WHITESPACE) {
    // Leading, trailing and interior — a scanner that skips these anywhere diverges anywhere.
    assertAgrees(`${ch}{"a":1}`, `leading ${label}`);
    assertAgrees(`{"a":1}${ch}`, `trailing ${label}`);
    assertAgrees(`{"a":${ch}1}`, `interior ${label}`);
    // ...and inside a string they are ordinary characters, which is the other half of the claim.
    assertAgrees(`{"a":"x${ch}y"}`, `${label} inside a string value`);
  }
});

test("every truncated literal and every truncated escape is rejected the way JSON.parse rejects it", () => {
  // The end-of-input branches: exactly where an index walks off the end of the text and
  // `text[i]` becomes undefined. A scanner comparing against undefined can accept or crash
  // instead of refusing.
  for (const literal of ["true", "false", "null"]) {
    for (let n = 1; n < literal.length; n++) assertAgrees(literal.slice(0, n), `truncated ${literal} (${n} chars)`);
    assertAgrees(literal, `whole ${literal}`); // the positive control for each
  }
  for (const tail of ["\\", "\\u", "\\u0", "\\u00", "\\u004", "\\n", "\\"]) {
    assertAgrees(`"abc${tail}`, `string ending after ${JSON.stringify(tail)}`);
  }
  assertAgrees('"abc\\', "string ending on a lone backslash");
});

test("every truncation length of a unicode escape is rejected", () => {
  for (const hex of ["", "4", "41", "414"]) {
    assertAgrees(`"\\u${hex}"`, `\\u with ${hex.length} hex digits`);
  }
  assertAgrees('"\\u0041"', "\\u with 4 hex digits (valid)");
});

// --- the ONE intended divergence -------------------------------------------------------------

/**
 * Every duplicate refusal is checked for its TYPE as well as its message. The duplicate tests
 * bypass `subject()`, so without this a parser that threw a bare Error for duplicates — and so
 * escaped the verifier's `catch (e) { if (!(e instanceof JsonSyntaxError)) throw e }` handling —
 * satisfied every assertion here (review round 1, chunk 14).
 */
const isDuplicate = (key) => (error) =>
  error instanceof JsonSyntaxError && error.message.includes(`duplicate key '${key}'`);

test("a duplicated key is refused — the one place this parser differs from JSON.parse", () => {
  const text = '{"a":1,"a":2}';
  assert.equal(reference(text).ok, true, "JSON.parse is supposed to accept this (last wins)");
  assert.equal(JSON.parse(text).a, 2, "the silent last-wins behavior this parser exists to refuse");
  assert.throws(() => parseStrictJson(text), isDuplicate("a"));
});

test("duplicate detection reaches nested objects and repeated keys inside arrays", () => {
  assert.throws(() => parseStrictJson('{"outer":{"b":1,"b":2}}'), isDuplicate("b"));
  assert.throws(() => parseStrictJson('[{"c":1,"c":2}]'), isDuplicate("c"));
  assert.doesNotThrow(() => parseStrictJson('[{"c":1},{"c":2}]'), "distinct objects may share key names");
});

test("duplicate identity is decided after escape decoding, not on how the key was spelled", () => {
  // The gap a textual pre-scan leaves: two keys that differ as source but are the same string
  // once decoded. JSON.parse collapses them silently, which is the whole reason this parser
  // exists — so it must refuse them however they were written (review round 1, chunk 14).
  const SPELLINGS = [
    ['{"a":1,"\\u0061":2}', "a"],
    ['{"\\u0061":1,"a":2}', "a"],
    ['{"a-b":1,"a\\u002db":2}', "a-b"],
    ['{"sla\\\\sh":1,"sla\\u005csh":2}', "sla\\sh"],
    ['{"\\ud83d\\ude00":1,"\\uD83D\\uDE00":2}', "\u{1f600}"],
  ];
  assert.ok(SPELLINGS.length >= 5, `the escaped-duplicate corpus shrank to ${SPELLINGS.length}`);
  for (const [text, key] of SPELLINGS) {
    assert.equal(Object.keys(JSON.parse(text)).length, 1, `JSON.parse should collapse ${text}`);
    assert.throws(() => parseStrictJson(text), isDuplicate(key), `not refused: ${text}`);
  }
});

test("key-shaped text inside a string VALUE is not a duplicate", () => {
  // The opposite failure of the same textual pre-scan: refusing a document because its DATA
  // contains something that looks like a repeated key.
  assertAgrees('{"a":"\\"a\\": 1, \\"a\\": 2"}', "a value quoting a duplicated key");
  assertAgrees('{"a":1,"b":"a"}', "a value equal to another key");
  assertAgrees('{"outer":{"b":1},"other":"{\\"b\\":1,\\"b\\":2}"}', "a value quoting a whole object");
});

// --- prototype pollution ----------------------------------------------------------------------

test("a __proto__ key becomes an ordinary own property, not a prototype mutation", () => {
  // The critical review-round-1 finding: with `{}` + `out[key] = …` this key routes through
  // the inherited setter, creating NO own property — invisible to Object.keys, invisible to
  // the duplicate check, and able to serve inherited values to the verifier's field lookups.
  const parsed = parseStrictJson('{"__proto__":{"status":"pass"}}');
  assert.deepEqual(Object.keys(parsed), ["__proto__"], "__proto__ is not an own enumerable key");
  assert.equal(Object.getPrototypeOf(parsed), null, "the accumulator kept a null prototype");
  assert.equal(parsed.__proto__.status, "pass", "the parsed value was lost");
  assert.equal({}.status, undefined, "Object.prototype was polluted");
});

test("a duplicated __proto__ key is caught like any other duplicate", () => {
  assert.throws(() => parseStrictJson('{"__proto__":1,"__proto__":2}'), isDuplicate("__proto__"));
  assert.throws(() => parseStrictJson('{"__proto__":1,"__prot\\u006f__":2}'), isDuplicate("__proto__"));
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
  const tooDeep = "[".repeat(EXPECTED_MAX_DEPTH + 5) + "]".repeat(EXPECTED_MAX_DEPTH + 5);
  assert.throws(() => parseStrictJson(tooDeep), (e) => e instanceof JsonSyntaxError && /nesting deeper/.test(e.message));
  // The positive control: just inside the limit still parses, so the guard is not vacuous.
  const justInside = "[".repeat(EXPECTED_MAX_DEPTH) + "]".repeat(EXPECTED_MAX_DEPTH);
  assert.doesNotThrow(() => parseStrictJson(justInside));
});

test("an input past the documented size bound is refused, and the bound is not the depth guard", () => {
  // MAX_INPUT_CHARS was exported and documented but never tested, so removing the guard
  // altogether left this suite green while the verifier stayed open to an oversized file
  // (review round 1, chunk 14). Both fixtures are FLAT — nesting cannot be what rejects them.
  // Exactly ONE character over. The fixture used to be two over, so a guard written
  // `> MAX_INPUT_CHARS + 1` satisfied this test while admitting a document past the documented
  // bound — the off-by-one the bound exists to pin (review round 2, chunk 14).
  const overLimit = `"${"a".repeat(EXPECTED_MAX_INPUT_CHARS - 1)}"`;
  assert.equal(overLimit.length, EXPECTED_MAX_INPUT_CHARS + 1, "the fixture must sit exactly one over the bound");
  assert.throws(
    () => parseStrictJson(overLimit),
    (e) => e instanceof JsonSyntaxError && /exceeds/.test(e.message),
  );
  const atLimit = `"${"a".repeat(EXPECTED_MAX_INPUT_CHARS - 2)}"`;
  assert.equal(atLimit.length, EXPECTED_MAX_INPUT_CHARS, "the positive control must sit exactly on the bound");
  assert.equal(parseStrictJson(atLimit).length, EXPECTED_MAX_INPUT_CHARS - 2);
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

// ---------------------------------------------------------------------------
// Review round 2, chunk 10: the header claimed exact JSON.parse acceptance while
// two resource bounds quietly rejected documents JSON.parse accepts.
// ---------------------------------------------------------------------------

test("the two declared exceptions are the ONLY documents JSON.parse accepts and this refuses", () => {
  // Deep nesting: valid JSON, accepted by JSON.parse, refused here — and refused as a LIMIT,
  // not as a syntax error, because telling an operator their evidence is malformed when it is
  // merely deep sends them looking for a typo that does not exist.
  const deep = "[".repeat(EXPECTED_MAX_DEPTH + 1) + "]".repeat(EXPECTED_MAX_DEPTH + 1);
  assert.doesNotThrow(() => JSON.parse(deep), "the fixture is not valid JSON, so it proves nothing");
  assert.throws(() => parseStrictJson(deep), JsonLimitError);
  assert.throws(() => parseStrictJson(deep), /nesting deeper than/);

  // Exactly at the bound is still accepted, so the limit is the documented one.
  const atLimit = "[".repeat(EXPECTED_MAX_DEPTH) + "]".repeat(EXPECTED_MAX_DEPTH);
  assert.doesNotThrow(() => parseStrictJson(atLimit));

  // A limit error is still a JsonSyntaxError, so every caller that fails closed still does.
  assert.ok(new JsonLimitError("x") instanceof JsonSyntaxError);
});

test("an oversized document is refused as a limit, not as malformed", () => {
  const huge = `"${"x".repeat(EXPECTED_MAX_INPUT_CHARS)}"`;
  assert.throws(() => parseStrictJson(huge), JsonLimitError);
  assert.throws(() => parseStrictJson(huge), /exceeds/);
});
