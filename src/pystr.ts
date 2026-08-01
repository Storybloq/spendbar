/**
 * Python string-boundary semantics: the whitespace set, and the two operations built on it.
 *
 * CPython routes `str.split()` (no argument) and `str.strip()` (no argument) through the
 * same `Py_UNICODE_ISSPACE` predicate, so ONE set serves both. Verified by enumeration over
 * U+0000-U+10FFF: there is no code point where `c.strip() == ""` and `c.split() == []`
 * disagree. That is why the split regex and the strip regex below are generated from a
 * single class rather than written twice — two spellings of one set drift silently.
 *
 * The set is spelled out rather than left as `\s` because JS and Python differ in BOTH
 * directions (29 code points vs 25):
 *
 *   Python only:  U+001C-U+001F (the C1 field/group/record/unit separators), U+0085 (NEL)
 *   JS only:      U+FEFF (ZWNBSP, i.e. a byte-order mark)
 *
 * The U+FEFF asymmetry is the reachable one and it is not academic. A BOM-only stream is
 * `""` to JS `.trim()` but `"﻿"` to Python `.strip()`, which inverts every "did the
 * child actually produce output?" test — and ALLOWLIST 12 deliberately preserves a leading
 * BOM, so such a stream reaches these call sites intact. The affected branches decide
 * whether the tool reports failure at all, and in the stderr case supply the message body,
 * both of which are byte-frozen against the oracle.
 */

/** The 29 code points CPython treats as whitespace, as a regex character-class body. */
const PY_SPACE =
  "\\u0009\\u000a\\u000b\\u000c\\u000d\\u001c-\\u001f\\u0020\\u0085\\u00a0" +
  "\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

/** Runs of Python whitespace — the separator `str.split()` uses with no argument. */
export const PY_WHITESPACE = new RegExp(`[${PY_SPACE}]+`);

const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/**
 * Python's `str.strip()`. Not interchangeable with JS `.trim()` — see the set difference
 * above; use this anywhere the result is compared against, or feeds, frozen output.
 */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP, "");
}
