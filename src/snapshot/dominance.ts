/**
 * Dominance over per-source offset manifests (T-010 AC 7).
 *
 * `sourceVersion` is a MANIFEST of per-source offsets, never a scalar max. The
 * counterexample the scalar hides is the whole reason: source A advancing while source B
 * regresses produces a larger maximum and a strictly worse snapshot, so a scalar comparison
 * publishes data loss and calls it progress.
 *
 * Verdicts: dominates / equal / incomparable / regressed. ONLY strict dominance publishes,
 * and incomparable fails closed — a dropped source must never convert incomparable into
 * dominates, which is why a missing key is read as "no claim" rather than as zero.
 *
 * The hygiene here is not defensive decoration: these manifests are built from data the
 * store did not author, and every clause below is a failure the T-008 spike reproduced.
 */
import { types as nodeTypes } from "node:util";

import { exoticKind } from "./envelope.js";
import { SourceVersionManifestError } from "./errors.js";
import { hasOwn } from "./intrinsics.js";

export type DominanceVerdict = "dominates" | "equal" | "incomparable" | "regressed";

declare const CANONICAL_SOURCE_VERSION: unique symbol;

/**
 * A manifest that has been through `canonicalSourceVersion`.
 *
 * Nominal, for the same reason `LatchingWriteAuthority` is: `compareSourceVersions` used to
 * take `Record<string, number>`, which every raw caller object satisfies — including one with
 * accessors, unsafe integers, a Proxy, or a `NaN` offset. `NaN` is the one that does real
 * damage silently: it is neither `>` nor `<`, so a regressed source reads as no change and the
 * comparison answers `dominates` on a snapshot that lost data. The brand makes the
 * precondition a type error rather than a convention, and the runtime re-canonicalization
 * below covers the JS callers the compiler never sees.
 */
export type CanonicalSourceVersion = Readonly<Record<string, number>> & {
  readonly [CANONICAL_SOURCE_VERSION]: true;
};

/**
 * Builds a canonical plain copy of a source-version manifest.
 *
 * One descriptor pass, and comparison/checksumming/serialization use ONLY this copy — so a
 * getter or Proxy trap in the input cannot observe a different value later than it did
 * during validation.
 */
export function canonicalSourceVersion(input: unknown): CanonicalSourceVersion {
  // Identity check FIRST: every trap on a revoked Proxy throws, so any other inspection
  // ordered before this one turns a hostile input into an opaque crash.
  if (nodeTypes.isProxy(input)) {
    throw new SourceVersionManifestError("manifest is a Proxy");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SourceVersionManifestError("manifest is not a plain object");
  }
  // "Not an array and not null" is not "plain". A Date, a Map, a Set, an Error, or any class
  // instance passes that test and then canonicalizes to `{}`, because their state lives in
  // internal slots rather than in own enumerable properties — so a manifest that LOOKS like a
  // rich object publishes as one claiming no source offsets at all, which is precisely the
  // "no claim" value the comparison treats as incomparable. Requiring the prototype to be
  // Object.prototype or null makes that unreachable instead of merely unlikely. (Null is
  // allowed because this function's own output has a null prototype and is re-validated on
  // the publish path.)
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SourceVersionManifestError("manifest is not a plain object (unexpected prototype)");
  }
  // ...and passing the prototype check does NOT make it plain. The paragraph above claimed the
  // exotic case was made "unreachable instead of merely unlikely" by that check, and it was
  // not: a prototype is a settable pointer, so `Object.setPrototypeOf(new Map([...]), Object.prototype)`
  // satisfies it while the Map's entries sit in internal slots no descriptor walk can see. The
  // result is the exact failure the check was written to prevent — a manifest that LOOKS rich
  // canonicalizing to `{}`, i.e. one claiming no source offsets at all, which then publishes as
  // the version record for a snapshot whose real offsets are gone.
  //
  // `envelope.ts` has refused this since round 3 and this module was arguing the unsound
  // version of the same point in its own words. Same predicate, one place.
  const exotic = exoticKind(input);
  if (exotic !== null) {
    throw new SourceVersionManifestError(
      `manifest is a ${exotic}, whose state is not own properties, so it would canonicalize ` +
        "to a manifest claiming no source offsets",
    );
  }
  if (Object.getOwnPropertySymbols(input).length > 0) {
    // Symbol keys cannot round-trip JSON, so a manifest carrying them would compare
    // differently before and after persistence.
    throw new SourceVersionManifestError("manifest has Symbol keys");
  }

  const out: Record<string, number> = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!hasOwn(descriptor, "value")) {
      throw new SourceVersionManifestError(`source ${JSON.stringify(key)} is an accessor`);
    }
    if (descriptor.enumerable !== true) {
      // REFUSED, not copied. `Object.keys(descriptors)` sees non-enumerable keys, and copying
      // one into the canonical object as `enumerable: true` would PROMOTE data JSON drops into
      // data the checksum covers — a manifest that persists differently from how it compared.
      // envelope.ts refuses a non-enumerable property for exactly this reason; this function
      // was silently doing the opposite, which is worse than either rule applied consistently.
      throw new SourceVersionManifestError(
        `source ${JSON.stringify(key)} is non-enumerable`,
      );
    }
    const value = descriptor.value;
    // SAFE integer, not merely integer. Above 2^53 a double cannot represent consecutive
    // integers, so two genuinely different source offsets collapse onto one value and compare
    // EQUAL — which turns the per-source monotonicity signal into a silent "no progress" (or,
    // paired with a real advance elsewhere, into a false `dominates`). Same failure mode, same
    // fix, as the bigint inode identities in types.ts.
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new SourceVersionManifestError(
        `source ${JSON.stringify(key)} offset is not a safe integer`,
      );
    }
    if (value < 0) {
      throw new SourceVersionManifestError(
        `source ${JSON.stringify(key)} offset is negative`,
      );
    }
    // NEGATIVE ZERO slips past both checks above — `Number.isSafeInteger(-0)` is true and
    // `-0 < 0` is false — and a manifest carrying one is a manifest this store cannot publish:
    // `canonicalize` refuses `-0` outright, because `JSON.stringify` would silently store it
    // as `0` and give two different documents one checksum. So without this clause the store
    // has one function producing exactly what another refuses, and the refusal arrives late,
    // from envelope.ts, about a value this function already declared canonical. Refused here,
    // where the message can still name the source.
    if (Object.is(value, -0)) {
      throw new SourceVersionManifestError(
        `source ${JSON.stringify(key)} offset is negative zero, which cannot be persisted`,
      );
    }
    // defineProperty, not assignment: a source legitimately named "__proto__" must survive
    // as an ordinary own key rather than mutating the prototype chain.
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  // Frozen, not merely non-writable per key: the individual descriptors above stop a key
  // being CHANGED, and freezing stops one being ADDED. Without it the "canonical copy" is
  // still extensible, so a source offset could be appended after validation and before the
  // comparison or the checksum reads it — the same observe-a-different-value-later failure
  // the single descriptor pass exists to close, arriving through a different door.
  return Object.freeze(out) as CanonicalSourceVersion;
}

/**
 * Compares two canonical manifests.
 *
 * A key present in one and absent in the other is NOT read as zero — absence is "no claim",
 * which makes the pair incomparable. Reading it as zero is precisely the substitution that
 * lets a dropped source masquerade as progress.
 */
export function compareSourceVersions(
  candidateInput: CanonicalSourceVersion,
  liveInput: CanonicalSourceVersion,
): DominanceVerdict {
  // Re-canonicalized rather than trusted, and this is the same belt-and-braces
  // `assertGuardedAuthority` applies to the authority: the brand above is a compile-time
  // guarantee, and this module ships as JS to callers TypeScript never checked. The operation
  // is idempotent (asserted by test), so a genuinely canonical argument passes through
  // unchanged and a raw one is refused here rather than silently compared.
  const candidate = canonicalSourceVersion(candidateInput);
  const live = canonicalSourceVersion(liveInput);
  const keys = new Set([...Object.keys(candidate), ...Object.keys(live)]);
  let anyGreater = false;
  let anyLess = false;

  for (const key of keys) {
    const hasCandidate = Object.hasOwn(candidate, key);
    const hasLive = Object.hasOwn(live, key);
    if (!hasCandidate || !hasLive) {
      return "incomparable";
    }
    const c = candidate[key]!;
    const l = live[key]!;
    if (c > l) anyGreater = true;
    else if (c < l) anyLess = true;
  }

  if (anyGreater && anyLess) return "incomparable";
  if (anyGreater) return "dominates";
  if (anyLess) return "regressed";
  return "equal";
}
