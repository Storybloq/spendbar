#!/usr/bin/env python3
"""Generate src/unicode-tables.ts from the REFERENCE CPython's Unicode database.

Why this exists: V8 and CPython ship different Unicode versions (measured here: Node 22 =
Unicode 16, Python 3.11.6 = Unicode 14, differing on 100 Nd code points). Using JS's own
`\\p{Nd}` / `\\p{C}` at runtime therefore diverges from the Python this port is validated
against — `-<Garay digit>d` would be accepted here and rejected there, and repr would emit
a Unicode-16 letter literally where CPython escapes it as unassigned.

So the tables are pinned to the reference interpreter and committed. Regenerate with:
    python3 scripts/gen-unicode.py
tests-ts/unicode-tables.test.mjs re-runs this and fails if the committed file has drifted.
"""
import os
import sys
import unicodedata

MAX = 0x110000

# The pinned reference. This is a CONTRACT, not a description of whoever runs the script:
# regenerating under a different CPython would silently move Unicode parity, and the drift
# test's advice ("rerun the generator") would then quietly ratify the change. So refuse.
#
# Bumping the reference is allowed but must be deliberate:
#     SPENDBAR_UNICODE_REF=15.1.0 python3 scripts/gen-unicode.py > src/unicode-tables.ts
# followed by re-capturing the goldens against that same interpreter.
REQUIRED_UNICODE = "14.0.0"


def check_interpreter():
    want = os.environ.get("SPENDBAR_UNICODE_REF", REQUIRED_UNICODE)
    have = unicodedata.unidata_version
    if have != want:
        sys.exit(
            f"refusing to generate: this interpreter has Unicode {have}, but the pinned\n"
            f"reference is Unicode {want} (python3 here is {sys.version.split()[0]}).\n"
            f"Generating anyway would change the parity contract silently.\n"
            f"Use a CPython with Unicode {want}, or set SPENDBAR_UNICODE_REF={have} to move\n"
            f"the reference deliberately and re-capture tests/golden/ against it."
        )
    return want


def runs(predicate):
    """Contiguous [start, end] runs of code points satisfying predicate."""
    out = []
    for cp in range(MAX):
        if predicate(cp):
            if out and cp == out[-1][1] + 1:
                out[-1][1] = cp
            else:
                out.append([cp, cp])
    return out


def main():
    version = check_interpreter()
    nd = runs(lambda cp: unicodedata.category(chr(cp)) == "Nd")

    # Every Nd run must be a whole number of aligned ten-digit blocks, so the value of a
    # code point is (cp - run_start) % 10. Verify against int() rather than assume it.
    for start, end in nd:
        length = end - start + 1
        if length % 10:
            sys.exit(f"Nd run U+{start:04X}..U+{end:04X} is not a multiple of 10")
        for cp in range(start, end + 1):
            if int(chr(cp)) != (cp - start) % 10:
                sys.exit(f"Nd value mismatch at U+{cp:04X}")

    nonprint = runs(lambda cp: not chr(cp).isprintable())

    def fmt(rs):
        return "\n".join(f"  [0x{a:x}, 0x{b:x}]," for a, b in rs)

    src = f'''/**
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *     python3 scripts/gen-unicode.py
 *
 * Unicode tables pinned to the REFERENCE CPython this port is validated against, because
 * V8 ships a newer Unicode database than CPython does and the two disagree. Using JS's
 * native \\p{{Nd}} / \\p{{C}} at runtime would diverge from Python on every code point
 * assigned in only one of the two versions (code review R3).
 *
 * Reference: CPython Unicode {version}. The interpreter's own patch version is
 * deliberately NOT recorded here — any CPython carrying this Unicode database produces a
 * byte-identical file, which is what lets the drift test compare exactly.
 */

/** Contiguous runs of category Nd. A code point's value is (cp - start) % 10. */
export const ND_RANGES: readonly (readonly [number, number])[] = [
{fmt(nd)}
];

/** Contiguous runs where CPython's str.isprintable() is false. */
export const NON_PRINTABLE_RANGES: readonly (readonly [number, number])[] = [
{fmt(nonprint)}
];

export const UNICODE_VERSION = "{version}";

/** Binary search: index of the range containing cp, or -1. */
function findRange(ranges: readonly (readonly [number, number])[], cp: number): number {{
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {{
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return mid;
  }}
  return -1;
}}

/** CPython: unicodedata.category(ch) == "Nd". */
export function isDecimalDigit(cp: number): boolean {{
  return findRange(ND_RANGES, cp) !== -1;
}}

/** CPython: int(ch) for a decimal digit; -1 if not one. */
export function decimalValue(cp: number): number {{
  const i = findRange(ND_RANGES, cp);
  if (i === -1) return -1;
  return (cp - ND_RANGES[i][0]) % 10;
}}

/** CPython: str.isprintable() for a single code point. */
export function isPrintableCodePoint(cp: number): boolean {{
  return findRange(NON_PRINTABLE_RANGES, cp) === -1;
}}
'''
    sys.stdout.write(src)


if __name__ == "__main__":
    main()
