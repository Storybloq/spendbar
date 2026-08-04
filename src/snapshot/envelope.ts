/**
 * Self-contained artifact envelopes.
 *
 * Every published artifact is ONE file carrying its payload, schema version, and checksum
 * together — never split across data/index/checksum files that can version-skew (T-008
 * finding). Validation order is load-bearing and tested by name: shape FIRST, then
 * checksum, so a malformed artifact surfaces as the named contract error rather than as an
 * opaque crypto or parse failure.
 */
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { SnapshotStoreResetError, type ResetReason } from "./errors.js";
import type { ArtifactKind } from "./types.js";
import { defineOwn, hasOwn } from "./intrinsics.js";

/**
 * The reason for one kind's failure — exhaustive over `ArtifactKind` rather than a
 * manifest/else fallback.
 *
 * The fallback shape this replaces reported every pin failure as `generation-unparsable` and
 * every version mismatch as `manifest-schema-version`, so a diagnostic could name an artifact
 * kind the failure had nothing to do with. Every combination below exists in `ResetReason`,
 * which is what makes this assignable without a cast: adding a kind without adding its
 * reasons is a compile error, not a silent mislabel at runtime.
 */
function reasonFor(
  kind: ArtifactKind,
  failure: "unparsable" | "checksum-mismatch" | "schema-version",
): ResetReason {
  return `${kind}-${failure}`;
}

/**
 * The build's schema version. It scopes the store directory (store-v<N>), which is what
 * makes cross-version data untouchable rather than merely untouched: a build never opens
 * another version's directory at all, so an older writer meeting newer-schema data leaves
 * those files byte-identical by construction (T-010 AC 5).
 */
export const SCHEMA_VERSION = 1;

export interface Envelope {
  schemaVersion: number;
  kind: ArtifactKind;
  checksum: string;
  body: unknown;
}

/** The envelope's key set, sorted — the exact shape `encodeEnvelope` writes. */
const ENVELOPE_KEYS: readonly string[] = Object.freeze([
  "body",
  "checksum",
  "kind",
  "schemaVersion",
]);

/** Exactly what `checksumOf` emits: a lowercase hex SHA-256 digest. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A value that is outside the JSON domain, or that would have to be READ to canonicalize. */
export class NonCanonicalValueError extends Error {
  readonly at: string;

  constructor(at: string, detail: string) {
    super(`value at ${at} cannot be canonicalized: ${detail}`);
    defineOwn(this, "name", "NonCanonicalValueError");
    this.at = at;
  }
}

/** Far above anything this schema produces (provenance is three levels), far below the stack. */
const MAX_CANONICAL_DEPTH = 64;

/**
 * Every exotic-object predicate `node:util` exposes, applied as a blocklist.
 *
 * A prototype check is NOT a proof of plainness, and the gap is exploitable rather than
 * theoretical: `Object.setPrototypeOf(new Date(), Object.prototype)` passes
 * `prototype === Object.prototype`, has no own enumerable properties, and canonicalizes to
 * `{}` — as does a re-prototyped `Map`, `Set`, `Promise` or typed array. Their state lives in
 * internal slots, which no descriptor walk can see, so the checksum describes an empty
 * document while the value holds data. Two different documents, one checksum, which is the
 * single failure this function exists to prevent.
 *
 * These predicates read internal slots rather than prototypes, so re-prototyping does not
 * evade them. Enumerated from `util.types` at load rather than hand-listed, so a type Node
 * learns to recognise is refused here without this file being edited — the reverse of a
 * hand-written list, which silently stops covering the cases it was written for.
 *
 * It is a blocklist, and that is stated rather than glossed: it refuses every exotic Node can
 * NAME, not every object that could have an internal slot. A host object from an embedder that
 * `util.types` does not recognise would still reach the descriptor walk. The prototype check
 * below remains the primary defence; this closes the door re-prototyping opens in it.
 */
const EXOTIC_PREDICATES: ReadonlyArray<readonly [string, (value: unknown) => boolean]> =
  Object.freeze(
    Object.entries(nodeTypes as unknown as Record<string, unknown>)
      .filter(
        (entry): entry is [string, (value: unknown) => boolean] => typeof entry[1] === "function",
      )
      .map(([name, is]) => Object.freeze([name, is] as const)),
  );

/**
 * The name of the first `util.types` predicate that claims this value, or null.
 *
 * EXPORTED, because a prototype check is not a plainness proof anywhere — and every module
 * that made one was making the same unsound argument in its own words. `dominance.ts` proved
 * `Object.getPrototypeOf(input) === Object.prototype` and then declared the exotic case
 * "unreachable instead of merely unlikely"; it is not, because a prototype is a settable
 * pointer, so a re-prototyped `Map`, `Date`, `Set`, boxed primitive or typed array passed and
 * canonicalized to `{}` — a source-version manifest silently claiming no offsets at all. One
 * check, one place, used by everything that has to decide whether a value's state is its own
 * properties.
 */
export function exoticKind(object: object): string | null {
  for (const [name, is] of EXOTIC_PREDICATES) {
    if (is(object)) return name;
  }
  return null;
}

/**
 * Canonical JSON: object keys sorted, no incidental whitespace, so the checksum describes the
 * document's content rather than its formatting.
 *
 * Every value is reached through a property DESCRIPTOR, never through `obj[key]`. That is the
 * same rule `dominance.ts` applies to source manifests, and it belongs here even more: the
 * generation payload is caller data, so the naive walk meant an accessor or Proxy trap in a
 * payload ran arbitrary code in the middle of checksumming — after validation, inside the step
 * that is supposed to be describing what was already validated, and with a `try`/`catch` that
 * could contain a throw but not a side effect or a hang.
 *
 * It is also a strict JSON-domain check rather than a serializer that copes. `JSON.stringify`
 * silently turns `undefined` and functions into holes or dropped keys, throws on BigInt, and
 * renders `NaN`/`Infinity` as `null` — so a document could be checksummed as something other
 * than what it holds, and a cycle would blow the stack rather than report anything. Each of
 * those is refused by name, at a path, so the failure says which field.
 */
export function canonicalize(value: unknown): string {
  return canonicalizeAt(value, "$", new Set(), 0);
}

function canonicalizeAt(
  value: unknown,
  at: string,
  seen: Set<object>,
  depth: number,
): string {
  // A named refusal rather than a RangeError. The cycle check catches values that point BACK
  // at themselves; it says nothing about a value that is merely very deep, and a document
  // nested a few hundred levels blew the JS stack — surfacing as an untyped RangeError from
  // whichever frame happened to be unlucky, which no caller classifies and no `catch` here
  // distinguishes from a real failure. The limit is far above anything this schema produces
  // (provenance is three levels) and far below the engine's.
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new NonCanonicalValueError(at, `nesting exceeds ${MAX_CANONICAL_DEPTH} levels`);
  }
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new NonCanonicalValueError(at, "a non-finite number is not JSON");
      }
      // NEGATIVE ZERO is refused, not normalized — the one number `JSON.stringify` silently
      // changes. `JSON.stringify(-0)` is `"0"`, so `-0` and `0` produced the same canonical
      // bytes and the same checksum while `Object.is(-0, 0)` is false: two different documents,
      // one digest, which is the single failure this function exists to prevent and which the
      // comment above claims it does. It is not caught downstream either — a body containing
      // `-0` is WRITTEN as `0`, read back as `0`, and the round-trip check compares the
      // already-normalized value against itself and agrees.
      //
      // Refused rather than normalized, because normalizing would be this module quietly
      // rewriting a caller's document, and every other value JSON cannot carry faithfully
      // (`undefined`, `NaN`, a function, a Symbol) is already a named refusal at a path.
      if (Object.is(value, -0)) {
        throw new NonCanonicalValueError(
          at,
          "negative zero does not round-trip JSON: it would be stored as 0",
        );
      }
      return JSON.stringify(value);
    case "bigint":
      throw new NonCanonicalValueError(at, "BigInt is not JSON");
    case "undefined":
      throw new NonCanonicalValueError(at, "undefined is not JSON");
    case "function":
      throw new NonCanonicalValueError(at, "a function is not JSON");
    case "symbol":
      throw new NonCanonicalValueError(at, "a Symbol is not JSON");
    default:
      break;
  }

  const object = value as object;

  // Identity FIRST, before any inspection: every trap on a revoked Proxy throws, so anything
  // ordered ahead of this turns a hostile input into an opaque crash instead of a named
  // refusal. (Same ordering, same reason, as `canonicalSourceVersion`.)
  if (nodeTypes.isProxy(object)) {
    throw new NonCanonicalValueError(at, "a Proxy cannot be canonicalized");
  }
  if (seen.has(object)) {
    throw new NonCanonicalValueError(at, "the value is cyclic");
  }
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // `Array.isArray` reads an internal slot, so it is true for an Array SUBCLASS and for an
      // array whose prototype has been replaced — and this branch used to accept both without
      // looking. A subclass carries its own prototype, which can hold accessors and methods the
      // descriptor walk never sees, so `class Tagged extends Array {}` canonicalized
      // indistinguishably from the plain array it is not. The object branch has demanded an
      // exact prototype since round 3; there was never a reason for the array branch not to.
      if (Object.getPrototypeOf(object) !== Array.prototype) {
        throw new NonCanonicalValueError(at, "only plain arrays can be canonicalized");
      }
      // Arrays get the SAME total treatment as objects, because an array is an object and can
      // carry anything an object can. Walking indices 0..length-1 and stopping there silently
      // dropped `a.note = "…"` and `a[Symbol()] = …`, so two arrays differing only in those
      // canonicalized identically — a checksum that says "same document" about documents that
      // are not the same is precisely the failure this function exists to prevent.
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw new NonCanonicalValueError(at, "Symbol keys cannot round-trip JSON");
      }
      const descriptors = Object.getOwnPropertyDescriptors(object);
      const parts: string[] = [];
      for (let i = 0; i < object.length; i++) {
        const descriptor = descriptors[i];
        if (descriptor === undefined) {
          throw new NonCanonicalValueError(`${at}[${i}]`, "a sparse array hole is not JSON");
        }
        if (!hasOwn(descriptor, "value")) {
          throw new NonCanonicalValueError(`${at}[${i}]`, "an accessor cannot be canonicalized");
        }
        if (!descriptor.enumerable) {
          throw new NonCanonicalValueError(
            `${at}[${i}]`,
            "a non-enumerable element is dropped by JSON",
          );
        }
        parts.push(canonicalizeAt(descriptor.value, `${at}[${i}]`, seen, depth + 1));
      }
      for (const key of Object.keys(descriptors)) {
        // `length` is the array's own bookkeeping and is never serialized; every other
        // non-index key is data JSON would throw away.
        if (key === "length") continue;
        // An index is decided by SYNTAX, not by numeric coercion. `Number("01")` is 1, and
        // `"01"` is an ordinary named property that JSON drops — so coercing here re-opened
        // the exact collision this loop was added to close, for `"01"`, `"1e0"`, `"+1"`,
        // `" 1 "`, `"-0"` and every other spelling that parses to an in-range number. The
        // round-trip below admits only the canonical spelling of an array index.
        const index = Number(key);
        if (
          String(index) === key &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < object.length
        ) {
          continue;
        }
        throw new NonCanonicalValueError(
          `${at}.${key}`,
          "a named property on an array is dropped by JSON",
        );
      }
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      // A Date, Map, Set, Error or class instance carries its state in internal slots, so it
      // canonicalizes to `{}` — a document that looks rich and checksums as empty.
      throw new NonCanonicalValueError(at, "only plain objects can be canonicalized");
    }
    // ...and the prototype passing does not make it plain. The check above asks what the object
    // INHERITS from, which is a settable pointer: `Object.setPrototypeOf(new Date(), Object.prototype)`
    // satisfies it while the Date's time value sits in an internal slot the walk below cannot
    // reach, so the very failure the prototype check exists to prevent walks straight through it.
    const exotic = exoticKind(object);
    if (exotic !== null) {
      throw new NonCanonicalValueError(
        at,
        `${exotic} describes an object whose state is not own properties, ` +
          "so canonicalizing it would describe a different document",
      );
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      throw new NonCanonicalValueError(at, "Symbol keys cannot round-trip JSON");
    }

    const descriptors = Object.getOwnPropertyDescriptors(object);
    const parts: string[] = [];
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!;
      if (!hasOwn(descriptor, "value")) {
        throw new NonCanonicalValueError(`${at}.${key}`, "an accessor cannot be canonicalized");
      }
      if (!descriptor.enumerable) {
        // REFUSED, not skipped. Skipping matched `JSON.stringify`, and that was the bug: the
        // property is real data on the document, JSON silently discards it, and the checksum
        // is then computed over a value the caller never wrote. Every other way of being
        // unserializable is a named refusal here; this one has no reason to be the exception.
        throw new NonCanonicalValueError(
          `${at}.${key}`,
          "a non-enumerable property is dropped by JSON",
        );
      }
      parts.push(
        `${JSON.stringify(key)}:${canonicalizeAt(descriptor.value, `${at}.${key}`, seen, depth + 1)}`,
      );
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

export function checksumOf(body: unknown): string {
  return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}

/** Serializes an artifact at this build's schema version. */
export function encodeEnvelope(kind: ArtifactKind, body: unknown): string {
  const envelope: Envelope = {
    schemaVersion: SCHEMA_VERSION,
    kind,
    checksum: checksumOf(body),
    body,
  };
  return `${canonicalize(envelope)}\n`;
}

/**
 * A bounded, side-effect-free description of an untrusted value, for an error message.
 *
 * `String(value)` was doing this job and it is the wrong tool twice over: on an object it
 * dispatches to `toString`, which is a lookup through a prototype chain this module does not
 * own, and on a large array or string it interpolates the whole thing into a message that is
 * then carried in an error and logged. Neither is a hazard worth accepting to say "that field
 * had the wrong type".
 */
function describe(value: unknown): string {
  if (value === null) return "null";
  const type = Array.isArray(value) ? "array" : typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    const text = JSON.stringify(value as string | number | boolean);
    return text.length > 60 ? `${text.slice(0, 60)}\u2026` : text;
  }
  return `a value of type ${type}`;
}

/**
 * Parses and validates one artifact.
 *
 * Every failure — unparsable, wrong kind, wrong schema version, checksum mismatch — is a
 * `SnapshotStoreResetError` carrying a distinct `reason` for the log. Callers do not branch
 * on the reason; the writer resets, and a reader quarantines. That is the whole taxonomy.
 */
export function decodeEnvelope(
  kind: ArtifactKind,
  artifactPath: string,
  raw: string,
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      "not JSON",
      artifactPath,
      err,
    );
  }

  // Shape before checksum: a checksum computed over a shape we never validated would
  // report "corrupt" for what is really "not one of our documents at all".
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      "envelope is not an object",
      artifactPath,
    );
  }
  const env = parsed as Record<string, unknown>;
  // The EXACT key set, not merely a superset. Only `body` is covered by the checksum, so an
  // extra envelope field is unauthenticated data riding alongside an artifact that validates
  // — and under this store's one rule, a field the protocol does not define is precisely the
  // "unsupported or ambiguous" state that resets rather than something to ignore.
  //
  // Compared ELEMENT BY ELEMENT rather than by joining with a comma. A key may itself contain
  // a comma, so the joined form is not an injective picture of a key set: a single key literally
  // named `body,checksum,kind,schemaVersion`, or the pair `body,checksum` and `kind,schemaVersion`,
  // renders as the expected string. Neither could go on to pass the field checks below, so
  // nothing was accepted that should not have been — but this check would have reported the
  // wrong reason for the refusal, and a guard that is right only because a later guard rescues
  // it is not the exact-key check this comment says it is.
  const envelopeKeys = Object.keys(env).sort();
  if (
    envelopeKeys.length !== ENVELOPE_KEYS.length ||
    envelopeKeys.some((key, index) => key !== ENVELOPE_KEYS[index])
  ) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      `envelope keys are ${JSON.stringify(envelopeKeys)}, expected exactly ` +
        `${JSON.stringify(ENVELOPE_KEYS)}`,
      artifactPath,
    );
  }
  if (env["kind"] !== kind) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      `envelope declares kind ${describe(env["kind"])}, expected ${kind}`,
      artifactPath,
    );
  }
  if (env["schemaVersion"] !== SCHEMA_VERSION) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "schema-version"),
      `stored schema version ${describe(env["schemaVersion"])} is not ${SCHEMA_VERSION}`,
      artifactPath,
    );
  }
  // The checksum's SHAPE, not merely its type. `checksumOf` emits a 64-character lowercase hex
  // SHA-256 digest and nothing else, so `"zzz"`, an uppercase digest, or a 63-character one is
  // a field this protocol could not have written — a structural defect, which is what
  // `*-unparsable` names. Accepting any string here and letting the comparison below fail
  // reported it as `*-checksum-mismatch`, which says something specific and false: that a
  // well-formed digest disagreed with the body. Shape before checksum, as the doc says.
  const storedChecksum = env["checksum"];
  if (typeof storedChecksum !== "string" || !SHA256_HEX_RE.test(storedChecksum)) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      `checksum is not a 64-character lowercase hex digest, got ${describe(storedChecksum)}`,
      artifactPath,
    );
  }
  let actual: string;
  try {
    actual = checksumOf(env["body"]);
  } catch (err) {
    // A body that cannot be canonicalized cannot be checksummed, so it cannot be this
    // protocol's document whatever the stored digest says. Reported as unparsable rather than
    // as a mismatch, because "we could not describe it" is a different fact from "it does not
    // match" — and JSON.parse output can still be non-canonical (a `__proto__` own key, a
    // value out of the JSON number domain).
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      "body is not canonicalizable",
      artifactPath,
      err,
    );
  }
  if (actual !== storedChecksum) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "checksum-mismatch"),
      "checksum does not match body",
      artifactPath,
    );
  }

  // The stored BYTES must be exactly what this module would have written for this body.
  //
  // Everything above validates the PARSE RESULT, and `JSON.parse` is lossy in a way that
  // matters here: duplicate keys are legal JSON and the last occurrence silently wins, so
  // `{"kind":"pin","kind":"manifest",...}` — or a duplicate inside the body — parses to a
  // document whose surviving value passes the exact-key check, the kind check, and its own
  // checksum, while the file on disk says something else entirely. Nothing derived from the
  // parse can see the discarded text; only the raw bytes can. Re-encoding and comparing also
  // subsumes key ORDER and whitespace, which is exactly the canonical form this protocol
  // claims to store.
  //
  // Re-encoding is inside a `try`, and NOT because the checksum step above already proved the
  // body canonicalizable — it proved something one level shallower. `checksumOf` canonicalizes
  // the body at depth 0; `encodeEnvelope` canonicalizes it nested inside the envelope, at
  // depth 1. A body whose deepest leaf sits at exactly MAX_CANONICAL_DEPTH therefore passes
  // the checksum and then throws a raw `NonCanonicalValueError` out of this function — past
  // every catch in the store, which classifies `SnapshotStoreResetError` and nothing else, so
  // a corrupt file that must reset the cache crashed the reader instead. That is this
  // module's own recurring defect: a value proven to have one property, used as though a
  // different property had been proven.
  //
  // The refusal is also the RIGHT answer on its merits, not merely a safer wrapper: a body
  // this module cannot re-encode is a body it could never have written, so whatever is on
  // disk is not one of ours.
  let reencoded: string;
  try {
    reencoded = encodeEnvelope(kind, env["body"]);
  } catch (err) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      "body cannot be re-encoded as an envelope, so this protocol could not have written it",
      artifactPath,
      err,
    );
  }
  if (raw !== reencoded) {
    throw new SnapshotStoreResetError(
      reasonFor(kind, "unparsable"),
      "stored bytes are not the canonical encoding of their own body " +
        "(duplicate keys, key order, or incidental whitespace)",
      artifactPath,
    );
  }
  return env["body"];
}

/**
 * The manifest's identity, used by readers to detect that the store changed under them
 * (see `readSnapshot`'s optimistic transaction).
 *
 * Identity is a collision-resistant digest over the EXACT validated envelope bytes —
 * deliberately not mtime, size, or inode. Timestamps are coarse enough to repeat inside one
 * transaction, sizes collide trivially, and inodes are reused; any of those would let an
 * ABA replacement (manifest swapped twice, same size and timestamp, different bytes) read
 * as "unchanged" and let the reader serve a view assembled across two publishes. It is also
 * not a digest over selected semantic fields, which would miss a replacement that matters
 * to the transaction while claiming to have checked.
 */
export function manifestIdentity(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
