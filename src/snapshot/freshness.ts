/**
 * Reader-side freshness (T-010 AC 6).
 *
 * Freshness is a question about WHAT YOU ASKED FOR, so it is answered per request and never
 * stored. There is deliberately no `stale` field anywhere in the store: the same generation is
 * fresh for yesterday and stale for today, fresh for `cost` and stale for `tokens`, and a
 * flag written at publish time can only be right for one of those readings. Every boolean
 * this module returns is a function of the request that produced it.
 *
 * Instants, not wall clocks. Coverage intervals are UTC instants and comparisons here are
 * numeric, so `2026-01-01T00:00:00Z` and `2026-01-01T00:00:00.000Z` are the same moment
 * rather than two different strings. Local days reach that world through `localDayBounds`,
 * which is where DST lives.
 */
import { types as nodeTypes } from "node:util";

import { exoticKind } from "./envelope.js";
import type { CoverageInterval, Provenance } from "./types.js";
import { defineOwn, hasOwn } from "./intrinsics.js";

export class FreshnessRequestError extends Error {
  /**
   * `options` carries the caught value that provoked this error, by reference and unread.
   *
   * The module set's rule is that a caught value is opaque: never inspected, never interpolated
   * into a message, and never DROPPED either — the last of which is the part this class could
   * not honour, because it had nowhere to put one. `assertTimeZone` was discarding the platform's
   * own account of why a zone was unknown, which for an ICU build without a zone database is the
   * entire explanation an operator needs.
   */
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`invalid freshness request: ${detail}`, options);
    defineOwn(this, "name", "FreshnessRequestError");
  }
}

export interface FreshnessRequest {
  /** UTC instant. */
  start: string;
  /** UTC instant, exclusive. */
  end: string;
  /** Fields to answer for. Omitted means "the range only". */
  fields?: string[];
  /** The querying timezone. Omitted means "do not check" (T-013 enforces it in production). */
  timezone?: string;
}

export interface FieldFreshness {
  covered: boolean;
  gaps: CoverageInterval[];
}

export interface FreshnessResult {
  covered: boolean;
  gaps: CoverageInterval[];
  fields: Record<string, FieldFreshness>;
  sourceTimestamps: Record<string, string>;
  /** The snapshot's timezone differs from the query's — the whole answer is invalidated. */
  timezoneMismatch: boolean;
}


/**
 * A results object that hostile field names cannot corrupt.
 *
 * `results[field] = ...` looks harmless until a caller asks about a field named `__proto__`,
 * which sets the object's PROTOTYPE instead of creating an own key — so that field's answer
 * silently vanishes, and `constructor` or `toString` collide with inherited properties. This
 * is the third place in the module where a name from data is used as a key (source manifests
 * and artifact ids are the others), and it gets the same treatment: a null prototype, and
 * `defineProperty` rather than assignment.
 */
function emptyFieldResults(): Record<string, FieldFreshness> {
  return Object.create(null) as Record<string, FieldFreshness>;
}

function defineField(
  into: Record<string, FieldFreshness>,
  field: string,
  value: FieldFreshness,
): void {
  Object.defineProperty(into, field, { value, enumerable: true, writable: false, configurable: false });
}

/**
 * The requested field list, checked rather than assumed — this crosses an API boundary.
 *
 * Reached through DESCRIPTORS, never by iterating the caller's array. `for (const f of fields)`
 * runs the array's iterator, and every element read is a property access: a Proxy `get` trap or
 * an accessor at an index therefore executes caller code inside the validator whose whole job
 * is to judge the caller's input — and a trap can hand one value to the check and a different
 * one to the use. It is the same rule `canonicalize` applies to array payloads, including the
 * syntax-not-coercion test for what counts as an index.
 */
function normalizeFields(fields: unknown): string[] {
  if (fields === undefined) return [];
  if (typeof fields !== "object" || fields === null) {
    throw new FreshnessRequestError("fields is not an array");
  }
  // Identity FIRST: every trap on a revoked Proxy throws, including the ones `Array.isArray`
  // and `getOwnPropertyDescriptors` would need, so anything ordered ahead of this turns a
  // hostile argument into an incidental TypeError instead of this module's error.
  if (nodeTypes.isProxy(fields)) {
    throw new FreshnessRequestError("fields is a Proxy");
  }
  if (!Array.isArray(fields)) {
    throw new FreshnessRequestError("fields is not an array");
  }
  // The PROTOTYPE, exactly `Array.prototype` — the same rule `normalizeIntervals` states at
  // length and this function was quietly exempt from. `Array.isArray` reads an internal slot,
  // so it is true for a subclass and for an array whose prototype was replaced outright; both
  // were accepted here while the identical shape was refused two functions down.
  //
  // Nothing dispatches to a method on `fields` TODAY, so this closes no live hole. It is a
  // consistency fix in a defence-in-depth boundary, and that is the whole argument for it: the
  // doctrine written on `normalizeIntervals` is that proving a value acceptable says nothing
  // about what happens when someone later CALLS a method on it, and an exemption that survives
  // only because the current code happens not to make such a call is exactly the assumption
  // that stops holding when the next line is added. It also makes the neighbouring test's name
  // true — "read through descriptors, never iterated" was permitting an array whose
  // `Symbol.iterator` had been overridden.
  if (Object.getPrototypeOf(fields) !== Array.prototype) {
    throw new FreshnessRequestError("fields has an unexpected prototype");
  }
  if (Object.getOwnPropertySymbols(fields).length > 0) {
    throw new FreshnessRequestError("fields has Symbol keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(fields);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const descriptor = descriptors[i];
    if (descriptor === undefined) {
      throw new FreshnessRequestError(`fields[${i}] is a hole`);
    }
    if (!hasOwn(descriptor, "value")) {
      throw new FreshnessRequestError(`fields[${i}] is an accessor`);
    }
    if (!descriptor.enumerable) {
      throw new FreshnessRequestError(`fields[${i}] is non-enumerable`);
    }
    const field = descriptor.value;
    if (typeof field !== "string" || field === "") {
      throw new FreshnessRequestError("fields holds a non-string");
    }
    // Duplicates would define the same key twice, and the second define throws on a
    // non-configurable property — a confusing failure for a harmless request.
    if (seen.has(field)) continue;
    seen.add(field);
    out.push(field);
  }
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    const index = Number(key);
    if (
      String(index) === key &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < fields.length
    ) {
      continue;
    }
    throw new FreshnessRequestError(`fields carries a named property ${JSON.stringify(key)}`);
  }
  return out;
}

/**
 * A date-only form, or a date-time form that names its offset. Nothing else.
 *
 * The exclusion is the point. `Date.parse("2026-01-01T00:00:00")` — no `Z`, no offset — is
 * defined by the spec to mean LOCAL time, so the same stored provenance produced a different
 * instant on a laptop in Vancouver and a CI worker in UTC, and the freshness answer moved with
 * the machine. A date-only form has no such problem: the spec fixes it to UTC.
 */
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):?(\d{2})))?$/;

/** Days in a month, with the full Gregorian leap rule — not the divisible-by-4 shorthand. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The instant this string names, or null.
 *
 * Matching the shape and then trusting `Date.parse` is NOT enough, and the gap is silent:
 * `Date.parse("2026-02-30")` does not fail, it returns 2026-03-02. So a request for a date
 * that does not exist was answered — confidently, about a different range than the caller
 * named — and the same applies to `2026-04-31` and to any February 29th in a common year. The
 * calendar fields are therefore checked against a NON-NORMALIZING calendar before `Date.parse`
 * is consulted at all. This is the same defect `localDayBounds` already guards with its probe
 * round-trip; the string path never got the same treatment.
 */
function parseInstant(value: string): number | null {
  const match = INSTANT_RE.exec(value);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, frac, offSign, offH, offM] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (h !== undefined) {
    // 0..23, so `24:00` is refused rather than accepted as the next day's midnight: it is a
    // second spelling of one instant, and this module's whole instant story is that one moment
    // has one meaning. `toIso` never emits it.
    if (Number(h) > 23 || Number(mi) > 59) return null;
    if (s !== undefined && Number(s) > 59) return null;
    // PRECISION THIS MODULE CANNOT REPRESENT IS REFUSED, not silently truncated.
    //
    // The grammar took 1..9 fractional digits and every comparison here is a millisecond
    // number, so `.000000001Z` and `.000000000Z` — two different instants — collapsed to the
    // same value. That is not a rounding nicety: a request for the nanosecond range between
    // them became `end <= start`, which `gapsFor` answers as "no gaps", so a range the store
    // holds no data for was reported COVERED. Sub-millisecond digits are therefore accepted
    // only when they are zero; a non-zero one is a value this representation would have to lie
    // about, and the honest answer is to refuse it.
    if (frac !== undefined && /[1-9]/.test(frac.slice(3))) return null;
    // An offset is a real UTC offset, not any two digits. `+99:99` matched the shape and then
    // parsed to whatever the engine felt like.
    if (offSign !== undefined && (Number(offH) > 23 || Number(offM) > 59)) return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Is this a string naming one unambiguous instant?
 *
 * Exported so the WRITER can apply the same rule the reader does. Tightening only this module
 * would have moved the failure rather than fixed it: a generation published with a
 * timezone-less coverage interval would sail through validation and then throw out of
 * freshness at QUERY time, in a caller with no idea why, about a document accepted days
 * earlier. Provenance instants are refused at publish for exactly the reason the IANA timezone
 * is — it can still be refused there.
 */
export function isExplicitInstant(value: string): boolean {
  return typeof value === "string" && parseInstant(value) !== null;
}

/**
 * Proves an argument is a plain, inert object and returns ITS OWN VALUES — the copy every
 * caller then reads from.
 *
 * These two functions are documented as runtime API boundaries, and a boundary that reads
 * `request.start` before knowing `request` is an object is not one: `null` gives an incidental
 * TypeError rather than the documented `FreshnessRequestError`, and an accessor or a Proxy
 * `get` trap runs caller code inside the validator that exists to judge the caller's input.
 *
 * Proving inertness and then reading `request["start"]` off the ARGUMENT was the same
 * proof-and-use mismatch `normalizeIntervals` documents, one level up. The prototype check
 * below refuses a custom prototype, but `Object.prototype` itself is shared and WRITABLE: a
 * caller (or anything else in the process) that installs a getter named `start`, `year`,
 * `coverage` or `timezone` on `Object.prototype` owns no descriptor on this value, passes every
 * check here, and then runs on each read — six times per `deriveFreshness` call, measured. The
 * effect is worse than "code ran": a provenance with NO own `timezone` was accepted, because
 * the inherited getter answered for it, so the mismatch comparison that invalidates the whole
 * answer was decided by a property the snapshot does not have.
 *
 * So this returns a null-prototype record holding exactly the own DATA values, built with
 * `defineProperty` because the keys can be `__proto__`. An absent optional field is absent from
 * the copy — `Object.hasOwn(copy, "fields")` is false — rather than being looked up again.
 */
function plainOwnValues(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new FreshnessRequestError(`${what} is not an object`);
  }
  // Identity BEFORE `Array.isArray`, which is itself a trappable operation on a revoked Proxy
  // and would escape as an incidental TypeError. Same ordering, same reason, as
  // `canonicalSourceVersion` and `canonicalize`.
  if (nodeTypes.isProxy(value)) {
    throw new FreshnessRequestError(`${what} is a Proxy`);
  }
  if (Array.isArray(value)) {
    throw new FreshnessRequestError(`${what} is not an object`);
  }
  // "Not an array and not null" is not "plain", and refusing accessors on the OWN properties is
  // not enough on its own: a custom prototype can carry an INHERITED getter for `start` or
  // `year`, which owns no descriptor here and still runs when the field is read below. This is
  // the check dominance.ts and envelope.ts already make; its absence here was the hole.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FreshnessRequestError(`${what} has an unexpected prototype`);
  }
  // And the prototype passing is not plainness — a prototype is settable, so a re-prototyped
  // Map or Date satisfies the line above while its state sits in internal slots. Here that
  // reads as a container with no own fields, which currently surfaces as "…coverage is
  // missing" rather than as anything wrong with the container — a true statement about a
  // misleading question. Same predicate envelope.ts and dominance.ts use, so all three modules
  // answer "is this value's state its own properties?" the same way.
  const exotic = exoticKind(value);
  if (exotic !== null) {
    throw new FreshnessRequestError(`${what} is a ${exotic}, whose state is not own properties`);
  }
  // SYMBOL keys first, because the descriptor loop below cannot see them: `Object.entries`
  // returns string keys only, so an enumerable Symbol ACCESSOR passed this validator untouched
  // — and then ran, because object spread copies enumerable own symbols too. The one place
  // that bites is `{ ...provenance.sourceTimestamps }`, which is exactly a spread of a
  // caller-supplied container immediately after it was declared inert. The other containers in
  // this module have refused Symbol keys since round 3; this one was the exception by omission.
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new FreshnessRequestError(`${what} has Symbol keys`);
  }
  const own = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!hasOwn(descriptor, "value")) {
      throw new FreshnessRequestError(`${what}.${key} is an accessor`);
    }
    // NON-ENUMERABLE is refused, not copied. `Object.getOwnPropertyDescriptors` returns these
    // and the copy below was marking them enumerable, so this module read a field that
    // canonicalization DROPS: `JSON.stringify` visits enumerable own string keys only. A
    // provenance whose `timeZone` or `coverage` was non-enumerable therefore answered freshness
    // questions here while the generation written to disk contained no such field — the read
    // side of the boundary honouring data the write side had silently discarded, which is the
    // same write/read disagreement this ticket has now found in four other places. Refusing is
    // the right disposition rather than dropping it too: a caller that hid a field did not mean
    // what the document appears to say, and answering from a value that will not survive being
    // stored is worse than saying so. `normalizeFields` has refused non-enumerable elements
    // since round 7; this made the same module disagree with itself.
    if (!descriptor.enumerable) {
      throw new FreshnessRequestError(
        `${what}.${key} is a non-enumerable own property, which canonicalization drops`,
      );
    }
    Object.defineProperty(own, key, { value: descriptor.value, enumerable: true });
  }
  return own;
}

/**
 * A mandatory field, read from the copy — absent means absent, not "ask the prototype".
 *
 * `own["timezone"]` on a null-prototype object is already safe from inherited getters, but it
 * cannot tell a field holding `undefined` from a field that is not there, and those are
 * different requests. The distinction is the whole point of the copy, so it is spelled out.
 */
function requiredOwn(own: Record<string, unknown>, what: string, key: string): unknown {
  if (!Object.hasOwn(own, key)) {
    throw new FreshnessRequestError(`${what}.${key} is missing`);
  }
  return own[key];
}

/** An optional field: present-and-undefined and absent are both "not given". */
function optionalOwn(own: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(own, key) ? own[key] : undefined;
}

/**
 * A FRESH array of fresh intervals, built from the caller's descriptors.
 *
 * Validating the caller's array in place and then handing that same array onward was not
 * enough, and the reason is the one this module keeps rediscovering: proving a value is
 * acceptable says nothing about what happens when someone later CALLS a method on it.
 * `gapsFor` does `intervals.map(...)`, and `map` can be an OWN property — a plain array with
 * `a.map = () => [...]` has an own key the index loop never looks at, and an Array subclass can
 * override it on its prototype. Either way caller code runs after the array was declared
 * usable, inside the function computing the coverage answer.
 *
 * So nothing of the caller's array survives this: the prototype must be exactly
 * `Array.prototype`, no own key other than `length` and canonical in-range indices is allowed,
 * and what comes back is a new array of new objects. That is the same "one descriptor pass,
 * then use only the copy" rule `canonicalSourceVersion` applies.
 *
 * Each element is also CHECKED FOR DIRECTION here, and the parsed bounds are kept. An interval
 * whose end is at or before its start is not a small oddity to sort around: `gapsFor` sorts by
 * start and advances a cursor to `interval.end`, so `[9,5)` against a `[0,10)` question moved
 * the cursor BACKWARDS and emitted overlapping, out-of-order gaps `[0,9)` and `[5,10)` — an
 * answer that is not a set of gaps at all. Refusing it at the boundary is the only place the
 * check belongs, because by `gapsFor` the interval is already indistinguishable from data.
 */
interface NormalizedInterval extends CoverageInterval {
  startMs: number;
  endMs: number;
}

function normalizeIntervals(value: unknown, what: string): NormalizedInterval[] {
  if (typeof value !== "object" || value === null) {
    throw new FreshnessRequestError(`${what} is not an array`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new FreshnessRequestError(`${what} is a Proxy`);
  }
  if (!Array.isArray(value)) {
    throw new FreshnessRequestError(`${what} is not an array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new FreshnessRequestError(`${what} has an unexpected prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new FreshnessRequestError(`${what} has Symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out: NormalizedInterval[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[i];
    if (descriptor === undefined) {
      throw new FreshnessRequestError(`${what}[${i}] is a hole`);
    }
    if (!hasOwn(descriptor, "value")) {
      throw new FreshnessRequestError(`${what}[${i}] is an accessor`);
    }
    // Same rule as `normalizeFields` above and `plainOwnValues` below, for the same reason:
    // canonicalization drops a non-enumerable element, so an interval only this module can see
    // is one the stored generation does not contain. Three loops in this file read elements
    // through descriptors and only one of them applied this.
    if (!descriptor.enumerable) {
      throw new FreshnessRequestError(`${what}[${i}] is non-enumerable`);
    }
    // Each interval gets the same container proof the request does, and is then read from the
    // COPY — so a `toString`, an own getter, or an inherited one on `Object.prototype` cannot
    // reach the comparison either.
    const interval = plainOwnValues(descriptor.value, `${what}[${i}]`);
    const start = requireInstant(requiredOwn(interval, `${what}[${i}]`, "start"), `${what}[${i}].start`);
    const end = requireInstant(requiredOwn(interval, `${what}[${i}]`, "end"), `${what}[${i}].end`);
    if (end.ms <= start.ms) {
      throw new FreshnessRequestError(
        `${what}[${i}] ends at or before it starts: ${start.text} .. ${end.text}`,
      );
    }
    out.push({ start: start.text, end: end.text, startMs: start.ms, endMs: end.ms });
  }
  // Every OTHER own key is refused, which is what closes the own-`map` hole rather than merely
  // stepping around it: `length` is the array's own bookkeeping, an in-range canonical index is
  // data, and anything else — `map`, `sort`, `constructor`, `"01"` — is a property JSON would
  // drop and a name a later call could dispatch to.
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    const index = Number(key);
    if (String(index) === key && Number.isInteger(index) && index >= 0 && index < value.length) {
      continue;
    }
    throw new FreshnessRequestError(`${what} carries a named property ${JSON.stringify(key)}`);
  }
  return out;
}

/**
 * The string AND the instant it names, parsed once.
 *
 * Returning both is what lets the parse happen exactly at the boundary. `gapsFor` used to
 * re-parse every bound on every call, which read like defence and was not: by then the values
 * had already been proven, so the checks could not fail and their `where` error messages were
 * unreachable — dead re-validation that also cost a parse per interval per field per query.
 */
function requireInstant(value: unknown, what: string): { text: string; ms: number } {
  if (typeof value !== "string") {
    throw new FreshnessRequestError(`${what} is not a string`);
  }
  const ms = parseInstant(value);
  if (ms === null) {
    throw new FreshnessRequestError(
      `${what} must be a real date or an instant with an explicit UTC offset, got: ${value}`,
    );
  }
  return { text: value, ms };
}

/**
 * The PROVENANCE, proven inert before any of its fields are read.
 *
 * `request` was validated exhaustively here and `provenance` was not validated at all, and both
 * arrive through the same exported function — so the argument for one is the argument for the
 * other. In production this value comes from a decoded generation and is already inert, but
 * `deriveFreshness` is exported and T-013 is the caller: the type annotation is absent at
 * runtime. Concretely, a `provenance.coverage` that was not an array reached `.map` and
 * produced an incidental `TypeError` instead of this module's error, and an accessor on
 * `timezone` or `sourceTimestamps` ran caller code during the comparison that decides whether
 * the whole answer is invalidated.
 */
interface UsableProvenance {
  coverage: NormalizedInterval[];
  fieldCoverage: Record<string, NormalizedInterval[]>;
  sourceTimestamps: Record<string, string>;
  timezone: string;
}

function normalizeProvenance(provenance: unknown): UsableProvenance {
  const p = plainOwnValues(provenance, "provenance");

  const coverage = normalizeIntervals(
    requiredOwn(p, "provenance", "coverage"),
    "provenance.coverage",
  );

  // Null-prototype and `defineProperty`, because these keys are FIELD NAMES from data: a field
  // called `__proto__` written with plain assignment sets the prototype instead of a key, and
  // `constructor`/`toString` collide with inherited properties. Same treatment the results
  // object already gets. The entries come from the proven COPY, not from the argument.
  const rawFieldCoverage = plainOwnValues(
    requiredOwn(p, "provenance", "fieldCoverage"),
    "provenance.fieldCoverage",
  );
  const fieldCoverage = Object.create(null) as Record<string, NormalizedInterval[]>;
  for (const [field, intervals] of Object.entries(rawFieldCoverage)) {
    Object.defineProperty(fieldCoverage, field, {
      value: normalizeIntervals(intervals, `provenance.fieldCoverage.${JSON.stringify(field)}`),
      enumerable: true,
    });
  }

  // Source timestamps are INSTANTS, held to the same grammar as every other instant here.
  //
  // Checking only `typeof value === "string"` meant `{"ccusage": "whenever"}` was copied
  // through to `result.sourceTimestamps` untouched — and this is the field a caller uses to
  // decide how old the data is, so junk here is not inert, it is a wrong answer wearing the
  // shape of a right one. The module refuses an unanchored instant everywhere else for exactly
  // the reason it must here: a bare `2026-01-01T00:00:00` means a different moment per machine.
  const rawSourceTimestamps = plainOwnValues(
    requiredOwn(p, "provenance", "sourceTimestamps"),
    "provenance.sourceTimestamps",
  );
  const sourceTimestamps = Object.create(null) as Record<string, string>;
  for (const [source, value] of Object.entries(rawSourceTimestamps)) {
    const instant = requireInstant(
      value,
      `provenance.sourceTimestamps.${JSON.stringify(source)}`,
    );
    Object.defineProperty(sourceTimestamps, source, { value: instant.text, enumerable: true });
  }

  const timezone = requiredOwn(p, "provenance", "timezone");
  if (typeof timezone !== "string") {
    throw new FreshnessRequestError("provenance.timezone is not a string");
  }
  // A REAL zone, not any string. The mismatch rule compares the query's zone to this one, and
  // string equality made two nonexistent zones "agree" — so a snapshot stamped `Mars/Olympus`
  // answered a `Mars/Olympus` query as fully covered, with the zone check reporting no problem.
  // The same `Intl` probe `localDayBounds` already applies to the query side; the stored side
  // was exempt.
  assertTimeZone(timezone);
  return { coverage, fieldCoverage, sourceTimestamps, timezone };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The uncovered parts of [startMs, endMs), given a set of covering intervals.
 *
 * An empty or inverted REQUEST range yields no gaps rather than one running backwards:
 * `end <= start` asks about no time at all, and the honest answer to "is nothing covered" is
 * yes. An inverted stored INTERVAL is a different matter and never reaches here —
 * `normalizeIntervals` refuses it, because the cursor walk below assumes `end > start` and
 * quietly produces overlapping out-of-order gaps when that does not hold.
 *
 * The bounds arrive already parsed. Re-deriving them here was dead re-validation: every value
 * had been proven at the boundary, so the checks could not fail.
 */
function gapsFor(
  intervals: NormalizedInterval[],
  startMs: number,
  endMs: number,
): CoverageInterval[] {
  if (endMs <= startMs) return [];

  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);

  const gaps: CoverageInterval[] = [];
  let cursor = startMs;
  for (const interval of sorted) {
    if (interval.endMs <= cursor) continue;
    if (interval.startMs > cursor) {
      const gapEnd = Math.min(interval.startMs, endMs);
      if (gapEnd > cursor) gaps.push({ start: toIso(cursor), end: toIso(gapEnd) });
    }
    if (interval.endMs > cursor) cursor = interval.endMs;
    if (cursor >= endMs) break;
  }
  if (cursor < endMs) gaps.push({ start: toIso(cursor), end: toIso(endMs) });
  return gaps;
}

/**
 * Derives freshness for one request against one generation's provenance.
 *
 * Timezone mismatch invalidates EVERYTHING rather than being reported alongside a coverage
 * answer. v0.2's rule is query-tz-must-match-snapshot-tz (re-bucketing is explicitly future
 * work), so a snapshot bucketed by America/Vancouver days cannot answer a UTC-day question at
 * all — its intervals are correct instants that were chosen to line up with a different set
 * of day boundaries. Returning "covered, but note the timezone differs" would invite exactly
 * the reading that rule exists to forbid.
 */
export function deriveFreshness(
  provenance: Provenance,
  request: FreshnessRequest,
): FreshnessResult {
  // Everything below reads the NORMALIZED copy, never the argument. Validating the argument
  // and then using the argument is what left `intervals.map` reachable: the proof and the use
  // were of two different things that merely looked alike. The same applies one level up — the
  // request's own fields are read from `req`, so nothing inherited from `Object.prototype` can
  // answer for a field the caller did not supply.
  const req = plainOwnValues(request, "request");
  const usable = normalizeProvenance(provenance);
  const startMs = requireInstant(requiredOwn(req, "request", "start"), "request.start").ms;
  const endMs = requireInstant(requiredOwn(req, "request", "end"), "request.end").ms;
  const fields = normalizeFields(optionalOwn(req, "fields"));
  const sourceTimestamps = { ...usable.sourceTimestamps };

  const timezone = optionalOwn(req, "timezone");
  if (timezone !== undefined && typeof timezone !== "string") {
    throw new FreshnessRequestError("timezone is not a string");
  }
  // A REAL zone on the query side too, and refused rather than reported as a mismatch.
  //
  // Without this a request for `Mars/Olympus` against an `America/Vancouver` snapshot came back
  // `timezoneMismatch: true`, which reads as "your snapshot is bucketed by a different zone"
  // — a diagnosis that is simply false when the requested zone does not exist. `localDayBounds`
  // already probes the query zone; the two entry points into this module disagreed about
  // whether an unknown zone is a request error.
  if (timezone !== undefined) assertTimeZone(timezone);
  if (timezone !== undefined && timezone !== usable.timezone) {
    // A FRESH array per answer, not one shared across every field and the result.
    //
    // Handing the same array object to N field results and to the top level meant a caller who
    // sorted or spliced one field's gaps silently rewrote every other field's — and the
    // summary's. Nothing in this module mutates them, which is exactly why the aliasing was
    // invisible: the bug belonged to whoever received the result.
    //
    // The intervals are NOT frozen here. They were, in this branch alone, out of five places
    // this module builds a gap — so `result.gaps[0]` was writable after a covered query and
    // frozen after a mismatched one, and a caller who normalized the result in place worked
    // until the day the zones differed. One policy across every branch is worth more than
    // partial immutability in one of them; freezing all five is a separate, deliberate change.
    const whole = (): CoverageInterval[] =>
      endMs > startMs ? [{ start: toIso(startMs), end: toIso(endMs) }] : [];
    const fieldResults = emptyFieldResults();
    for (const field of fields) {
      defineField(fieldResults, field, { covered: false, gaps: whole() });
    }
    return {
      covered: false,
      gaps: whole(),
      fields: fieldResults,
      sourceTimestamps,
      timezoneMismatch: true,
    };
  }

  const gaps = gapsFor(usable.coverage, startMs, endMs);

  const fieldResults = emptyFieldResults();
  for (const field of fields) {
    // Absence is "no claim", not "covered like everything else" — the same rule dominance.ts
    // applies to a missing source. A field the generation never recorded coverage for is one
    // the reader must not describe as fresh.
    if (!Object.hasOwn(usable.fieldCoverage, field)) {
      defineField(fieldResults, field, {
        covered: false,
        gaps: endMs > startMs ? [{ start: toIso(startMs), end: toIso(endMs) }] : [],
      });
      continue;
    }
    const fieldGaps = gapsFor(usable.fieldCoverage[field]!, startMs, endMs);
    defineField(fieldResults, field, { covered: fieldGaps.length === 0, gaps: fieldGaps });
  }

  return {
    covered: gaps.length === 0,
    gaps,
    fields: fieldResults,
    sourceTimestamps,
    timezoneMismatch: false,
  };
}

/**
 * The UTC instants bounding one LOCAL calendar day — the bridge between "what the user asked
 * for" (a day on a wall calendar) and "what the store recorded" (instants).
 *
 * A local day is not 24 hours. In America/Vancouver, 2026-03-08 is 23 hours and 2026-11-01 is
 * 25; computing a day's end by adding 86_400_000 to its start silently drops an hour of
 * coverage every spring and double-counts one every autumn. The end is therefore the NEXT
 * day's midnight, computed the same way as the start.
 *
 * Three things are CHECKED rather than assumed, because each of them fails silently otherwise:
 *
 *   - the calendar fields are real. `Date.UTC(2026, 1, 30)` does not reject February 30th, it
 *     quietly returns March 2nd — so an out-of-range day would produce confident bounds for a
 *     different date than the caller named.
 *   - the timezone exists. `Intl` throws a RangeError for an unknown zone, which would escape
 *     as something other than this module's error.
 *   - local midnight actually OCCURS, and occurs exactly ONCE. Several IANA zones transition AT
 *     midnight (America/Havana, Asia/Beirut, Chile), where 00:00 either does not exist or
 *     happens twice — and a whole local day can be skipped outright, as Pacific/Apia's
 *     2011-12-30 was. Both halves are checked, and they are genuinely different questions:
 *     existence is settled by formatting a candidate back in the requested zone and requiring
 *     it to read as exactly that date at 00:00:00, while uniqueness needs the instants on BOTH
 *     sides of any nearby transition to be evaluated, because a fold produces two instants that
 *     each pass the existence check. A day with an ambiguous boundary is refused rather than
 *     resolved by preference: the two answers differ by the length of the transition, and
 *     silently picking one would attribute an hour of coverage to whichever day this function
 *     happened to favour.
 */
export function localDayBounds(
  timeZone: string,
  day: { year: number; month: number; day: number },
): { start: string; end: string } {
  // The CONTAINER before its fields, and then only the container's OWN values. Reading
  // `day.year` first means a null argument throws an incidental TypeError instead of this
  // module's error; an accessor or Proxy runs caller code inside the function that is supposed
  // to be validating the caller's input; and an inherited `year` getter on `Object.prototype`
  // owns nothing here and would still have answered on every read.
  const d = plainOwnValues(day, "day");
  if (typeof timeZone !== "string") {
    throw new FreshnessRequestError("timeZone is not a string");
  }
  // 0..9999, NOT the full ECMAScript Date range.
  //
  // The wider range was incoherent with this module's own instant grammar: `toIso` emits
  // EXPANDED ISO years outside 0..9999 (`-000001`, `+010000`) and `INSTANT_RE` accepts only
  // four digits, so `localDayBounds` could return bounds that `deriveFreshness` would then
  // refuse — one function producing values another rejects. Narrowing is the right side to fix:
  // this store answers questions about API usage, and a coverage interval in year -271821 is
  // not a case worth carrying a second date grammar for.
  const year = assertCalendarField(requiredOwn(d, "day", "year"), "year", 0, 9999);
  const month = assertCalendarField(requiredOwn(d, "day", "month"), "month", 1, 12);
  const dayOfMonth = assertCalendarField(requiredOwn(d, "day", "day"), "day", 1, 31);
  assertTimeZone(timeZone);

  // The requested date must survive UTC normalization, or it was never a real date.
  const probe = new Date(utcMs(year, month, dayOfMonth));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== dayOfMonth
  ) {
    throw new FreshnessRequestError(`${year}-${month}-${dayOfMonth} is not a real calendar date`);
  }

  const start = zonedMidnightMs(timeZone, year, month, dayOfMonth);
  // Roll the calendar date forward with UTC arithmetic (which has no DST) and convert that
  // NEXT LOCAL midnight, rather than adding a fixed span to the instant we just computed.
  const nextUtc = new Date(utcMs(year, month, dayOfMonth + 1));
  const end = zonedMidnightMs(
    timeZone,
    nextUtc.getUTCFullYear(),
    nextUtc.getUTCMonth() + 1,
    nextUtc.getUTCDate(),
  );
  if (end <= start) {
    throw new FreshnessRequestError(
      `${timeZone} has no local day ${year}-${month}-${dayOfMonth}`,
    );
  }
  // The BOUNDS, not only the requested year, must be four-digit ISO.
  //
  // Narrowing the input range to 0..9999 was necessary and not sufficient, and the edges are
  // exactly where it fails: the end of 9999-12-31 is local midnight on 10000-01-01, and local
  // midnight on 0000-01-01 in any positive-offset zone falls in year -1 UTC. `toISOString`
  // renders both in EXPANDED form (`+010000-…`, `-000001-…`), which `INSTANT_RE` refuses — so
  // this function would hand `deriveFreshness` a bound `deriveFreshness` rejects. That is the
  // same one-function-produces-what-another-refuses defect the narrowing was meant to remove,
  // surviving at the two dates the narrowing did not reach.
  const startIso = toIso(start);
  const endIso = toIso(end);
  if (!isExplicitInstant(startIso) || !isExplicitInstant(endIso)) {
    throw new FreshnessRequestError(
      `local day ${year}-${month}-${dayOfMonth} in ${timeZone} has UTC bounds outside ` +
        `the four-digit ISO year range this module represents`,
    );
  }
  return { start: startIso, end: endIso };
}

/**
 * `Date.UTC`, without the two-digit-year rule.
 *
 * `Date.UTC(26, 0, 1)` is 1926, not year 26 — a legacy remap that applies to every year in
 * 0..99 and silently produces an instant nineteen centuries from the one requested. Every
 * arithmetic path in this module goes through here so the remap cannot reach any of them, and
 * `setUTCFullYear` is the documented way to set the year the caller actually meant.
 */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  // The year is set BEFORE normalization, not corrected after it.
  //
  // Correcting afterwards was wrong in a way that looked right: `Date.UTC(0, 1, 29)` normalizes
  // in 1900, which is not a leap year, so year 0's real February 29th became March 1st and was
  // then stamped back to year 0 — a valid date reported as invalid. Rolling a day forward from
  // 0099-12-31 was worse: it normalized to 2000-01-01 and the correction set the year back to
  // 99, so "the next day" was the same year's January 1st. Month and day overflow have to be
  // resolved in the year the caller meant, which is what the three-argument `setUTCFullYear`
  // does.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  return date.getTime();
}

function assertCalendarField(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new FreshnessRequestError(`${what} must be an integer in ${min}..${max}`);
  }
  return value;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch (err) {
    // The native failure travels as an opaque cause rather than being dropped. It is never
    // inspected here — the named error is the meaningful one and `timeZone` is already in its
    // message — but discarding it leaves an operator with a refusal and no account of what the
    // platform actually said, which for an ICU build missing a zone database is the whole
    // explanation. Same rule the store applies to every other caught value.
    throw new FreshnessRequestError(`unknown timezone: ${timeZone}`, { cause: err });
  }
}

function zonedMidnightMs(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): number {
  const asIfUtc = utcMs(year, month, day, 0, 0, 0);

  /** Does this instant read, in this zone, as exactly the midnight we asked for? */
  const readsAsMidnight = (instantMs: number): boolean => {
    const parts = zonedParts(timeZone, instantMs);
    return (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === 0 &&
      parts.minute === 0 &&
      parts.second === 0
    );
  };

  // EXISTENCE and UNIQUENESS are two different questions, and only the first was being asked.
  //
  // The two-pass refinement below converges on one instant, and verifying that instant reads
  // back as midnight proves midnight EXISTS. It cannot prove midnight happened only ONCE,
  // because it never looks at the other side of a transition — so a zone whose clock goes BACK
  // at midnight (a fold: 00:00 occurs, then occurs again an hour later) returned whichever side
  // the refinement happened to land on, silently, with no indication that the day's boundary
  // was ambiguous. The doc above claimed uniqueness was checked. It was not.
  //
  // Both sides are therefore evaluated explicitly: the offsets a day either side of the target
  // bracket any transition within it, and each yields a candidate instant.
  const DAY_MS = 86_400_000;
  const candidates = new Set([
    asIfUtc - offsetMsAt(timeZone, asIfUtc - DAY_MS),
    asIfUtc - offsetMsAt(timeZone, asIfUtc + DAY_MS),
    // Two passes: the first offset is read at the wrong instant (we do not yet know the
    // instant), the second at the candidate it produced. They differ only across a transition,
    // and re-reading there is what lands on the correct side of it.
    asIfUtc - offsetMsAt(timeZone, asIfUtc - offsetMsAt(timeZone, asIfUtc)),
  ]);

  const valid = [...candidates].filter(readsAsMidnight);
  if (valid.length === 0) {
    // Local midnight did not occur: a transition AT midnight that skipped it, or a whole
    // skipped local day (Pacific/Apia's 2011-12-30). No instant is the right answer.
    const parts = zonedParts(timeZone, asIfUtc - offsetMsAt(timeZone, asIfUtc));
    throw new FreshnessRequestError(
      `${timeZone} has no local midnight on ${year}-${month}-${day} ` +
        `(it reads as ${parts.year}-${parts.month}-${parts.day} ` +
        `${parts.hour}:${parts.minute}:${parts.second})`,
    );
  }
  if (valid.length > 1) {
    // Midnight happened twice. Picking one silently would make a day's boundary depend on an
    // implementation detail of the refinement, and the two answers differ by the transition —
    // an hour of coverage, attributed to whichever day this function happened to prefer.
    throw new FreshnessRequestError(
      `${timeZone} has an ambiguous local midnight on ${year}-${month}-${day}: ` +
        `it occurs at ${valid.map(toIso).sort().join(" and ")}`,
    );
  }
  return valid[0]!;
}

/**
 * The UTC offset, in milliseconds, that `timeZone` was at a given instant.
 *
 * Derived from `Intl` rather than from a table, so it tracks whatever tzdata the runtime
 * carries instead of a copy that goes stale.
 */
function offsetMsAt(timeZone: string, instantMs: number): number {
  const parts = zonedParts(timeZone, instantMs);
  const localAsUtc = utcMs(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - instantMs;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(timeZone: string, instantMs: number): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const raw: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    raw[part.type] = part.value;
  }
  // `hour12: false` still renders midnight as "24" in some ICU versions.
  const hour = Number(raw["hour"]) === 24 ? 0 : Number(raw["hour"]);
  const year = raw["era"] === "BC" ? 1 - Number(raw["year"]) : Number(raw["year"]);
  return {
    year,
    month: Number(raw["month"]),
    day: Number(raw["day"]),
    hour,
    minute: Number(raw["minute"]),
    second: Number(raw["second"]),
  };
}

