/**
 * CPython `repr()` for the value kinds that appear inside byte-frozen diagnostics.
 *
 * Parity-critical, not cosmetic: `cnum`'s message embeds `f"{v!r}"`, and the captured
 * golden `codex_bad_cost` asserts
 *   `unexpected ccusage codex output: sessions[0].costUSD = True (expected ...)`
 * — capital `True`. Plain JS stringification emits `true` and breaks byte parity.
 *
 * Scope: values that can come out of `JSON.parse` (null, boolean, number, string, array,
 * object). Verified against `python3 -c "print(repr(x))"` in the unit tests.
 */
import { isPrintableCodePoint } from "./unicode-tables.js";

/** CPython `repr()` of a float, as used inside f-string `!r` interpolation. */
function reprNumber(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  // JSON has no int/float distinction, but Python's json.loads produces an int for a
  // number written without a fraction/exponent, and repr(int) has no ".0". JS cannot
  // recover that distinction after parsing, so mirror json.loads: integral -> int repr.
  if (Number.isInteger(v)) {
    // -0 parses from JSON "-0" as an int in Python (repr -> "0"), so drop the sign.
    return Object.is(v, -0) ? "0" : v.toString();
  }
  // Both languages pick the shortest round-tripping decimal, but they disagree on WHEN to
  // go scientific and how to spell the exponent (code review R1):
  //   Python: scientific iff exp < -4 or exp >= 16; exponent always >= 2 digits ("1e-07")
  //   JS:     scientific iff exp < -6 or exp >= 21; exponent unpadded          ("1e-7")
  // toExponential() with no argument yields the same shortest digits, so switch on its
  // exponent and only hand-build the scientific form.
  const sci = v.toExponential(); // e.g. "1.5e-7"
  const at = sci.indexOf("e");
  const mantissa = sci.slice(0, at);
  const exp = Number(sci.slice(at + 1));
  if (exp >= -4 && exp < 16) {
    // In this range JS toString() is always positional and matches Python exactly.
    return v.toString();
  }
  const sign = exp < 0 ? "-" : "+";
  return `${mantissa}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/**
 * CPython `str.isprintable()`: false for every Other (Cc/Cf/Cs/Co/Cn) and Separator
 * (Zs/Zl/Zp) code point, with ASCII space the single exception.
 *
 * The earlier `code < 0x20 || code === 0x7f` test was ASCII-only, so U+0085 (Cc),
 * U+00A0 (Zs), U+200B (Cf) and U+2028 (Zl) were emitted literally where CPython escapes
 * them — a byte-parity break in any diagnostic carrying a non-ASCII value (code review R2).
 *
 * The table is pinned to the reference CPython rather than using JS's `\p{C}`/`\p{Z}`:
 * V8 ships a newer Unicode database, so a code point assigned in Unicode 16 but unassigned
 * in CPython's version is printable here and escaped there (code review R3).
 */
function isPrintable(cp: number): boolean {
  return isPrintableCodePoint(cp);
}

/** CPython's escape width: \xNN below U+0100, \uNNNN below U+10000, else \UNNNNNNNN. */
function escapeCodePoint(cp: number): string {
  if (cp < 0x100) return "\\x" + cp.toString(16).padStart(2, "0");
  if (cp < 0x10000) return "\\u" + cp.toString(16).padStart(4, "0");
  return "\\U" + cp.toString(16).padStart(8, "0");
}

/** CPython `repr()` of a str: single quotes preferred, backslash escapes, \n \r \t. */
function reprString(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (!isPrintable(code)) out += escapeCodePoint(code);
    else out += ch;
  }
  return quote + out + quote;
}

/** CPython `repr()` for JSON-derived values. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return reprNumber(v);
  if (typeof v === "string") return reprString(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    return "{" + entries.map(([k, val]) => `${reprString(k)}: ${pyRepr(val)}`).join(", ") + "}";
  }
  return String(v);
}
