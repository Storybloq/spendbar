/**
 * Python-parity number/string formatting.
 *
 * Every numeric string this CLI emits must match CPython's format-spec output
 * byte-for-byte (parity contract, tests/golden/ALLOWLIST.md). CPython rounds the
 * EXACT BINARY VALUE of the double, half-even at true ties. Neither
 * `Intl.NumberFormat({roundingMode:'halfEven'})` (rounds the shortest decimal
 * repr: 2.675 -> "2.68" vs Python "2.67") nor `toFixed` (rounds half-away on
 * exactly-representable midpoints: 0.125 -> "0.13" vs Python "0.12") reproduces
 * it. See spikes/rounding/RESULTS.md — 123,576-value differential corpus, 0
 * mismatches, and it catches 17k+ divergences from each naive approach.
 *
 * Algorithm: decode IEEE-754 bits -> |x| = M * 2^E (BigInt M), compute
 * M * 10^decimals * 2^E exactly, and at E<0 compare the exact remainder against
 * 2^(k-1): above rounds up, below rounds down, exactly equal is a true binary
 * tie -> half-even. No floating-point intermediate ever exists.
 */

const _buf = new ArrayBuffer(8);
const _view = new DataView(_buf);

function bitsOf(x: number): bigint {
  _view.setFloat64(0, x);
  return _view.getBigUint64(0);
}

function group3(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface FixedOpts {
  /** Thousands separators (Python's `,` in the format spec). */
  grouping?: boolean;
  /** Force a leading `+` on non-negative values (Python's `+`). */
  sign?: boolean;
}

/**
 * CPython `f"{x:.<decimals>f}"` (optionally `,` grouped, `+` signed) for any double.
 * Non-finite values render as CPython does: `nan`, `inf`, `-inf`.
 */
export function pyFixed(x: number, decimals: number, opts: FixedOpts = {}): string {
  if (Number.isNaN(x)) return opts.sign ? "+nan" : "nan";
  if (!Number.isFinite(x)) {
    if (x > 0) return opts.sign ? "+inf" : "inf";
    return "-inf";
  }

  const bits = bitsOf(x);
  const negative = (bits >> 63n) & 1n ? true : false;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const mantBits = bits & 0xf_ffff_ffff_ffffn;

  // |x| = M * 2^E, exactly.
  let M: bigint;
  let E: number;
  if (expBits === 0) {
    M = mantBits; // subnormal (and +-0)
    E = -1074;
  } else {
    M = mantBits | 0x10_0000_0000_0000n;
    E = expBits - 1075;
  }

  const scale = 10n ** BigInt(decimals);
  const N = M * scale;

  let scaled: bigint;
  if (E >= 0) {
    scaled = N << BigInt(E); // exact integer, no rounding needed
  } else {
    const k = BigInt(-E);
    const q = N >> k;
    const r = N - (q << k);
    const half = 1n << (k - 1n);
    if (r > half) scaled = q + 1n;
    else if (r < half) scaled = q;
    else scaled = (q & 1n) === 0n ? q : q + 1n; // true binary tie -> half-even
  }

  const digits = scaled.toString().padStart(decimals + 1, "0");
  const intPart = decimals > 0 ? digits.slice(0, -decimals) : digits;
  const fracPart = decimals > 0 ? digits.slice(-decimals) : "";

  const body = (opts.grouping ? group3(intPart) : intPart) + (decimals > 0 ? "." + fracPart : "");
  const prefix = negative ? "-" : opts.sign ? "+" : "";
  return prefix + body;
}

/** CPython `f"{n:,}"` for an integral value. */
export function pyThousands(n: number): string {
  if (!Number.isFinite(n)) return pyFixed(n, 0);
  const negative = n < 0 || Object.is(n, -0);
  // Integral by contract (token counts); trunc guards against float drift in sums.
  const abs = Math.abs(Math.trunc(n));
  return (negative && abs !== 0 ? "-" : negative ? "-" : "") + group3(abs.toString());
}

// ---------------------------------------------------------------- usage.py helpers

/** usage.py `money(x)` -> f"${x:,.2f}" */
export function money(x: number): string {
  return "$" + pyFixed(x, 2, { grouping: true });
}

/** usage.py `fmt(n)` -> f"{n:,}" */
export function fmt(n: number): string {
  return pyThousands(n);
}

/** usage.py `pct(part, whole)` -> percentage as a float (formatting is the caller's job). */
export function pct(part: number, whole: number): number {
  return whole ? (part / whole) * 100 : 0.0;
}

// ---------------------------------------------------------------- width/alignment

/**
 * CPython `len(s)`: the number of CODE POINTS (ISS-007).
 *
 * `s.length` is UTF-16 code units, so it counts every astral character twice. Padding
 * computed from it emits one space too few per astral character, in every column of every
 * renderer, and the trigger is user-controlled — the config `renames` map takes arbitrary
 * strings and project names come from paths. `renderTable`'s rule length is `len(hdr)` for
 * the same reason.
 *
 * Counted rather than `[...s].length` because this runs per cell per row, and an unpaired
 * surrogate counts as one code point here exactly as it does in CPython.
 */
export function pyLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** CPython `f"{s:<width>}"` for a string: left-aligned, never truncates. */
export function padRight(s: string, width: number): string {
  const len = pyLen(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

/** CPython `f"{s:><width>}"` for a string: right-aligned, never truncates. */
export function padLeft(s: string, width: number): string {
  const len = pyLen(s);
  return len >= width ? s : " ".repeat(width - len) + s;
}

/** CPython `f"{x:><width>,.<decimals>f}"` in one call. */
export function num(x: number, width: number, decimals: number, opts: FixedOpts = {}): string {
  return padLeft(pyFixed(x, decimals, opts), width);
}

/**
 * Python truthiness for JSON values.
 *
 * The cases that bite: an empty dict `{}` and an empty list `[]` are FALSY in Python and
 * TRUTHY in JavaScript, so `if not u`, `if b.get("isGap")` and `a or b` all change meaning
 * under a literal transcription. Measured against the oracle for each site that uses it.
 */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return Boolean(v);
}
