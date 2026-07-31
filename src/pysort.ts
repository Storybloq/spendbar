/**
 * Python string ordering, and the sorts built on it (ISS-012).
 *
 * JS relational operators and `Array.prototype.sort` compare strings by UTF-16 code UNIT;
 * Python's `sorted`, `min` and `max` compare by code POINT. The two disagree for every pair
 * where one side has an astral character (>= U+10000, encoded as a surrogate pair starting
 * at 0xD800) and the other has a BMP character above 0xD800:
 *
 *   a = "\u{10000}"  b = "�"
 *   Python : a > b        (0x10000 > 0xFFFD)
 *   JS     : a < b        (lead surrogate 0xD800 < 0xFFFD)
 *
 * Both implementations exit 0 and print a differently-ordered table, which is the failure
 * mode this port is least able to notice. So no string comparison in the port uses `<`,
 * `>` or a bare `.sort()`; they all come through here.
 *
 * The nine sort sites in usage.py are inventoried in the T-004 plan, section 5.1. Seven are
 * numeric and need only stability, which ES2019 guarantees — but they go through `pySorted`
 * anyway so the property is stated once instead of assumed nine times, and so a later
 * change from a numeric key to a string key cannot silently reintroduce unit ordering.
 */

/**
 * Compare two strings the way CPython does: by code point, then by length.
 *
 * Written without materialising code-point arrays because it runs once per comparison
 * inside every sort. A lone surrogate compares as its own scalar value, which is what
 * CPython does too — `json.loads('"\\ud800"')` yields a one-code-point string there.
 */
export function pyCompareStr(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(j) as number;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  // The two advanced in lockstep over equal code points, so whichever still has code units
  // left is the strictly longer string — Python's "a prefix sorts first".
  if (i < a.length) return 1;
  if (j < b.length) return -1;
  return 0;
}

/**
 * `min(a, b)` / `max(a, b)` for strings, with CPython's tie behaviour.
 *
 * CPython seeds the result with the first argument and replaces it only on a strict
 * improvement, so a tie returns the FIRST argument. That is observable whenever the two
 * are equal-but-distinct objects, and more importantly it is the rule the accumulator
 * loops at usage.py:186-187 rely on.
 */
export function pyMinStr(a: string, b: string): string {
  return pyCompareStr(b, a) < 0 ? b : a;
}

export function pyMaxStr(a: string, b: string): string {
  return pyCompareStr(b, a) > 0 ? b : a;
}

/**
 * A sort key, typed by the shape of what it extracts, so the three key shapes usage.py
 * actually uses stay statically distinguishable and individually testable instead of
 * collapsing into one untyped comparator.
 *
 * There is deliberately no `reverse` option: usage.py has no `reverse=True` anywhere, and
 * expresses every descending order as a negated numeric key. Negation is order-preserving
 * and leaves the sort stable; `reverse=True` in Python reverses the comparison but NOT the
 * relative order of equal elements, which is a third behaviour neither language's default
 * gives you. Not offering it means it cannot be reached for by mistake.
 */
export type SortKey<T> =
  | { kind: "numeric"; key: (item: T) => number }
  | { kind: "string"; key: (item: T) => string }
  | { kind: "tuple"; key: (item: T) => readonly (string | number)[] };

/**
 * `sorted(items, key=...)`: a stable sort that never compares strings as UTF-16.
 *
 * Returns a new array; the input is not mutated, matching `sorted` rather than `.sort()`.
 */
export function pySorted<T>(items: Iterable<T>, spec: SortKey<T>): T[] {
  const out = [...items];
  if (spec.kind === "numeric") {
    const { key } = spec;
    // Subtraction, not `<`: a comparator built from `<` reports "greater" for BOTH
    // (NaN, x) and (x, NaN), which is inconsistent and lets the sort permute unrelated
    // elements. Subtraction yields NaN, and ECMA-262's SortCompare converts a NaN result
    // to +0 — so a NaN key reads as "equal" and the stable sort leaves order untouched.
    //
    // That conversion is the spec's, not ours. An explicit `Number.isNaN(d) ? 0 : d` guard
    // stood here until a mutation survived removing it; measured on this V8, guarded and
    // unguarded agree exactly, at 5 elements (insertion sort) and 200 (TimSort). Keeping a
    // branch no test can kill would imply a hazard that does not exist. The behaviour it
    // was protecting is still pinned by a test, so a hand-rolled sort would be caught.
    return out.sort((a, b) => key(a) - key(b));
  }
  if (spec.kind === "string") {
    const { key } = spec;
    return out.sort((a, b) => pyCompareStr(key(a), key(b)));
  }
  const { key } = spec;
  return out.sort((a, b) => compareTuple(key(a), key(b)));
}

/**
 * Lexicographic tuple comparison, element by element.
 *
 * A mixed pair (string against number) is a hard error rather than an arbitrary order:
 * Python raises TypeError on exactly this comparison, so silently picking a winner would
 * turn a crash into a wrong-but-plausible table. The tuple sites in usage.py have fixed
 * shapes, so reaching this means a key function is inconsistent with its own type.
 */
function compareTuple(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string | number;
    const y = b[i] as string | number;
    if (typeof x === "string" && typeof y === "string") {
      const c = pyCompareStr(x, y);
      if (c !== 0) return c;
      continue;
    }
    if (typeof x === "number" && typeof y === "number") {
      // Both directions, not `x !== y` then a single `<`. With a NaN the latter reports
      // "greater" for BOTH orderings, which is an inconsistent comparator: Array.prototype
      // .sort may then permute unrelated elements, not merely misplace the NaN.
      if (x < y) return -1;
      if (y < x) return 1;
      if (x === y) continue;
      // Unordered (a NaN is involved). Report "equal" so the sort stays total and stable.
      //
      // This is deliberately NOT CPython's behaviour, which is subtler than it looks:
      // tuple comparison shortcuts on IDENTITY, so `(nan, 'a') < (nan, 'b')` is True when
      // both tuples hold the SAME nan object — comparison descends to the next element —
      // while two distinct NaNs are unordered. Measured, not assumed.
      //
      // Emulating that would be unfalsifiable code: every sort key here is a cost, and
      // `cnum` rejects non-finite numbers at the validation boundary, so a NaN cannot reach
      // this function. What it must not do is be *inconsistent* if one ever did.
      return 0;
    }
    throw new TypeError(
      `cannot compare tuple element ${i}: ${typeof x} against ${typeof y} ` +
        `(Python raises TypeError here; a silent ordering would be worse)`,
    );
  }
  return a.length - b.length;
}
