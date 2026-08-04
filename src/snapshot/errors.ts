/**
 * Which of this module's error types produced a value — recorded by IDENTITY, not read off it.
 *
 * `err instanceof SnapshotPathError` was doing this job and it is not a proof of provenance.
 * `instanceof` walks a prototype chain, and the constructors here are exported, so
 * `Object.create(SnapshotPathError.prototype)` produces a value that passes — as does anything
 * whose constructor redefines `Symbol.hasInstance`. That matters because the reader BRANCHES on
 * the answer: a value that impersonates one of these types is reported as "this artifact is
 * unusable" and swallowed, when the module's own rule says an unrecognised failure must
 * propagate untouched. A private `WeakMap` reads nothing off the value — exactly the argument
 * `FS_ERROR_KIND` below already makes for filesystem classification.
 *
 * WHAT THE TAG PROVES, exactly: this value was produced by one of the constructors below.
 * That is strictly more than `instanceof` proves — no prototype graft, `Object.create`, or
 * `Symbol.hasInstance` can obtain it — and it is strictly less than "this module raised it".
 * The constructors are exported, so any code holding this module can call one; `new
 * SnapshotPathError("…")` thrown from a seam carries a genuine tag.
 *
 * That residue is deliberate rather than unnoticed, and it cannot be closed by hiding the
 * constructors: `store.ts` raises every one of these types from another module, so a tag
 * granted only to "internal" call sites would have to be granted to an export anyway. It also
 * would not buy anything. The only code positioned to throw into the store's `catch` blocks is
 * the injected `SnapshotFs`, and a seam that wants a read to come back empty does not need to
 * forge an error — it supplies the bytes. The tag's job is to keep a value that never came
 * from these constructors, including one built to look like one, from steering control flow.
 * It does that; it does not authenticate the thrower, and nothing here should be read as
 * claiming it does.
 */
import { types as nodeTypes } from "node:util";

import { defineOwn, hasOwn, ownDescriptor, weakGet, weakSet } from "./intrinsics.js";

/**
 * `util.types.isProxy`, captured at module load.
 *
 * `nodeTypes` is an ordinary mutable object, so `nodeTypes.isProxy` is a property read on a
 * value any code in the realm can write to — and replacing it with `() => false` puts the
 * revoked-proxy hazard this guard exists for straight back. Same rule as `./intrinsics.js`.
 */
const IS_PROXY = nodeTypes.isProxy;

const ERROR_TAG = new WeakMap<object, SnapshotErrorTag>();

export type SnapshotErrorTag =
  | "SnapshotStoreResetError"
  | "SnapshotNotDominatingError"
  | "SourceVersionManifestError"
  | "SnapshotModeError"
  | "SnapshotPathError"
  | "SnapshotIdError"
  | "AuthorityHandlerContractError"
  | "AuthorityLostError"
  | "SnapshotWriteContractError"
  | "SnapshotCommitFailure"
  | "SnapshotArtifactTooLargeError";

function tag(err: object, name: SnapshotErrorTag): void {
  weakSet(ERROR_TAG, err, name);
}

/** The tag this module recorded, or null for anything it did not create. */
export function snapshotErrorTag(err: unknown): SnapshotErrorTag | null {
  if (typeof err !== "object" || err === null) return null;
  return weakGet(ERROR_TAG, err) ?? null;
}

/**
 * Snapshot store errors.
 *
 * There is exactly ONE diagnostic for an unusable store, and it is an observability record
 * rather than a control-flow branch: every `reason` leads to the same disposition (reset,
 * then rebuild). Earlier revisions of this design carried a four-error taxonomy with a
 * different recourse per condition; the derived-cache verdict removed the need for any of
 * it, and with it the temptation to route on error identity or — worse — on message text.
 */

export type ResetReason =
  | "manifest-unparsable"
  | "manifest-checksum-mismatch"
  | "manifest-schema-version"
  | "manifest-invariants"
  | "generation-missing"
  | "generation-unparsable"
  | "generation-checksum-mismatch"
  | "generation-schema-version"
  | "generation-invariants"
  // Pins get their own reasons rather than borrowing the generation ones. A diagnostic that
  // names the wrong artifact kind is worse than a vague one: it sends a reader looking in
  // generations/ for a file that was always in pins/.
  | "pin-unparsable"
  | "pin-checksum-mismatch"
  | "pin-schema-version"
  | "pin-invariants"
  | "unknown-entry"
  | "residue-without-manifest"
  | "mode-violation"
  // A store file whose NAME is not a plain regular file: a symlink, a directory, a device.
  // Distinct from "mode-violation" because the disposition reasoning differs — a wrong mode is
  // a file of ours we refuse to trust, while this one may not be ours at all.
  | "artifact-not-a-regular-file"
  // Larger than this protocol will ever write, so it is not one of ours whatever it contains.
  | "artifact-too-large"
  // Bytes that are not valid UTF-8. This protocol writes canonical JSON, so it did not write
  // them — the same "not one of ours" verdict as the two neighbours, reached by encoding rather
  // than by size or file type.
  | "artifact-invalid-encoding"
  // A store container was swapped while a read-only classification pass was walking it, so the
  // verdict describes two different filesystems. Ambiguous, and therefore reset.
  | "container-replaced"
  | "unsafe-artifact-id";

/**
 * Raised when the store must be reset. `reason` exists to be LOGGED, not switched on:
 * nothing in this module branches on it, and a test asserts that.
 */
export class SnapshotStoreResetError extends Error {
  readonly reason: ResetReason;
  readonly detail: string;
  readonly artifactPath: string | null;
  /**
   * The failure this one was raised in response to, when there was one.
   *
   * Held OPAQUELY — never inspected, stringified, or copied onto anything — so that a caller
   * converting one of this module's failures into a reset diagnostic does not have to read a
   * property off a value it caught. `message` is mutable and these constructors are exported,
   * so reading one is a call into somebody else's code at the exact seam that exists to keep
   * foreign code out. Same rule as `SnapshotCommitFailure` and `AuthorityHandlerContractError`.
   */
  readonly cause: unknown;

  constructor(
    reason: ResetReason,
    detail: string,
    artifactPath: string | null = null,
    cause: unknown = undefined,
  ) {
    super(`snapshot store reset required (${reason}): ${detail}`);
    defineOwn(this, "name", "SnapshotStoreResetError");
    tag(this, "SnapshotStoreResetError");
    this.reason = reason;
    this.detail = detail;
    this.artifactPath = artifactPath;
    this.cause = cause;
  }
}

/** A publish refused because the candidate did not strictly dominate the live snapshot. */
export class SnapshotNotDominatingError extends Error {
  readonly verdict: "equal" | "incomparable" | "regressed";

  constructor(verdict: "equal" | "incomparable" | "regressed", detail: string) {
    super(`snapshot publish refused (${verdict}): ${detail}`);
    defineOwn(this, "name", "SnapshotNotDominatingError");
    tag(this, "SnapshotNotDominatingError");
    this.verdict = verdict;
  }
}

/** A source-version manifest that cannot be trusted to compare (hostile or malformed). */
export class SourceVersionManifestError extends Error {
  constructor(detail: string) {
    super(`invalid sourceVersion manifest: ${detail}`);
    defineOwn(this, "name", "SourceVersionManifestError");
    tag(this, "SourceVersionManifestError");
  }
}

/** A file or directory whose mode is not exactly what this protocol writes. */
export class SnapshotModeError extends Error {
  readonly path: string;
  readonly observedMode: number;
  readonly expectedMode: number;

  constructor(path: string, observedMode: number, expectedMode: number) {
    super(
      `refusing ${path}: mode ${observedMode.toString(8)} is not ${expectedMode.toString(8)}`,
    );
    defineOwn(this, "name", "SnapshotModeError");
    tag(this, "SnapshotModeError");
    this.path = path;
    this.observedMode = observedMode;
    this.expectedMode = expectedMode;
  }
}

/**
 * A publish refused because the encoded artifact is larger than this protocol will read back.
 *
 * A WRITER error, deliberately, and raised before anything is staged. The alternative — write
 * it and discover at the next start that it cannot be read — produces a store that resets,
 * rebuilds the same file, and resets again forever.
 */
export class SnapshotArtifactTooLargeError extends Error {
  readonly path: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(path: string, bytes: number, limit: number) {
    super(`refusing to write ${path}: ${bytes} bytes exceeds the ${limit}-byte artifact limit`);
    defineOwn(this, "name", "SnapshotArtifactTooLargeError");
    tag(this, "SnapshotArtifactTooLargeError");
    this.path = path;
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** A state path that is a symlink, or contains a dot, dot-dot, or empty component. */
export class SnapshotPathError extends Error {
  constructor(detail: string) {
    super(`unsafe snapshot path: ${detail}`);
    defineOwn(this, "name", "SnapshotPathError");
    tag(this, "SnapshotPathError");
  }
}

/**
 * An artifact id that is not safe to put in a path.
 *
 * Generation and pin ids become FILENAMES, so an id is a path component and must be checked
 * as one. The store already refused foreign names on the way in (`ARTIFACT_NAME_RE`); this is
 * the same grammar applied on the way out, because validating names only when reading them
 * means a `../../` id is rejected the round after it has already been written outside the
 * store.
 */
export class SnapshotIdError extends Error {
  readonly kind: string;
  readonly id: unknown;

  constructor(kind: string, id: unknown, detail: string) {
    // Like SnapshotWriteContractError: the offending value is never coerced into the message,
    // because an id can arrive from a decoded document and be any JSON value at all.
    super(`unsafe ${kind} id (${detail}); see .id for the value as supplied, uncoerced`);
    defineOwn(this, "name", "SnapshotIdError");
    tag(this, "SnapshotIdError");
    this.kind = kind;
    this.id = id;
  }
}

/**
 * The lock-loss handler did not take terminal action.
 *
 * T-010 AC 8 requires that the handler terminate the process or irreversibly disable
 * publishing — "a quietly-returning handler is not allowed". Intent is not inspectable, so
 * the contract is made explicit: the handler either throws, or returns the sentinel
 * `"terminated"` to state that it has taken terminal action. Anything else is this error.
 */
export class AuthorityHandlerContractError extends Error {
  /**
   * The lock-loss error that triggered the handler, when there was one.
   *
   * Held OPAQUELY: never inspected, stringified, or copied onto anything. The value came out
   * of a caller-supplied authority, so it may be frozen, primitive, or a revoked Proxy, and
   * reading a message off it would replace the contract violation being reported with an
   * arbitrary failure. Same rule as `SnapshotCommitFailure`, and the same reason: when two
   * failures arrive together, keep both and interpret neither.
   */
  readonly lockLossCause: unknown;

  constructor(
    detail = 'lock-loss handler returned without taking terminal action (must throw or return "terminated")',
    lockLossCause: unknown = undefined,
  ) {
    super(detail);
    defineOwn(this, "name", "AuthorityHandlerContractError");
    tag(this, "AuthorityHandlerContractError");
    this.lockLossCause = lockLossCause;
  }
}

/** Any use of an authority that has already observed a loss. */
export class AuthorityLostError extends Error {
  constructor(detail = "write authority was lost") {
    super(detail);
    defineOwn(this, "name", "AuthorityLostError");
    tag(this, "AuthorityLostError");
  }
}

/**
 * The `SnapshotFs.write` seam reported an impossible byte count.
 *
 * The core loops over short writes, so a seam returning 0 would spin that loop forever
 * while authority stayed held — a hang, which is worse than a failure because nothing ever
 * reports it. A negative or oversized count would corrupt offset accounting instead. Both
 * are refused here as a pre-commit failure rather than trusted as an offset.
 */
export class SnapshotWriteContractError extends Error {
  readonly path: string;
  readonly reported: unknown;
  readonly remaining: number;

  constructor(path: string, reported: unknown, remaining: number) {
    // The message interpolates NOTHING the seam returned. `String(x)` is a call into the
    // value's own code the moment it is an object: `Symbol.toPrimitive`, `valueOf` and
    // `toString` are all reachable that way, and a Proxy can make any of them throw, hang, or
    // mutate state — which would replace the bounded contract failure being reported with an
    // arbitrary one. The value is preserved by REFERENCE in `.reported` for a human to
    // inspect deliberately; nothing on this path coerces it.
    super(
      `write on ${path} reported a byte count outside 1..${remaining} ` +
        `(see .reported for the value as returned, uncoerced)`,
    );
    defineOwn(this, "name", "SnapshotWriteContractError");
    tag(this, "SnapshotWriteContractError");
    this.path = path;
    this.reported = reported;
    this.remaining = remaining;
  }
}

/**
 * A pre-commit failure that carries BOTH the operation's primary error and a close failure
 * that arrived alongside it.
 *
 * The two are held as opaque fields and are never inspected, stringified, or copied onto
 * each other. Values thrown by an injected seam are not guaranteed to be extensible Error
 * objects — they may be frozen, sealed, primitive, null, or a revoked Proxy — so writing a
 * property onto one, or reading a message out of it, can execute arbitrary code or throw,
 * replacing the very failure this type exists to preserve. That is the same rule the commit
 * path already applies to post-commit values, applied to errors: this message is FIXED and
 * derived from nothing the caller threw.
 */
export class SnapshotCommitFailure extends Error {
  readonly stagingPath: string;
  readonly primaryError: unknown;
  readonly closeError: unknown;

  constructor(stagingPath: string, primaryError: unknown, closeError: unknown) {
    super(
      `snapshot commit failed at ${stagingPath}; the descriptor also failed to close ` +
        `(see .primaryError and .closeError)`,
    );
    defineOwn(this, "name", "SnapshotCommitFailure");
    tag(this, "SnapshotCommitFailure");
    this.stagingPath = stagingPath;
    this.primaryError = primaryError;
    this.closeError = closeError;
  }
}

/**
 * Filesystem outcomes, classified AT THE SEAM.
 *
 * The core must never inspect a thrown value to decide what happened. Reading `.code` off
 * an arbitrary error is a call into someone else's code the moment that value is a Proxy or
 * carries an accessor: it can mutate state, recurse, or never return, and a `try`/`catch`
 * around it contains only the throw, not the side effect or the hang. So classification
 * happens once, inside the trusted `SnapshotFs` adapter, which knows it is looking at a
 * native `fs` error — and the core branches only on this branded result.
 */
export type SnapshotFsErrorKind =
  | "not-found"
  | "exists"
  /**
   * A read refused because it passed the caller's byte bound (EFBIG). Classified rather than
   * left as "other" because the store's disposition for it is specific and already defined:
   * an artifact this protocol could not have written, which is one more unusable file, not an
   * I/O fault to propagate.
   */
  | "too-large"
  /**
   * An artifact's BYTES are not valid UTF-8 (EILSEQ), so this protocol did not write them —
   * it writes canonical JSON and nothing else.
   *
   * Classified for the same reason `too-large` is: the store's disposition is already defined
   * and specific. Left as `other`, the decoder's refusal PROPAGATED out of `readStoreFile`,
   * which handles only absence and symlinks and rethrows the rest — so a corrupt artifact
   * crashed the reader instead of resetting the derived cache. The strict decoder was added to
   * turn silent U+FFFD substitution into a named failure, and the name reached a caller that
   * had no disposition for it.
   *
   * This is artifact CONTENT only. A directory ENTRY NAME that does not round-trip is a
   * different condition with a deliberately different outcome — it still propagates, because
   * the store cannot address such a name to delete it and must not report a reset it could not
   * perform (ISS-069). The adapter marks that one `EBADMSG` precisely so the two do not share
   * a classification.
   */
  | "invalid-content"
  /**
   * `O_NOFOLLOW` met a symlink at the final component (ELOOP), or a path prefix was not a
   * directory (ENOTDIR). Classified because `readStoreFile` needs to tell "there is nothing
   * here" from "there is something here that is not one of ours" — the distinction between a
   * first-run store and one whose manifest has been replaced by a link.
   */
  | "symlink"
  | "other";

/**
 * The classification lives HERE, keyed by object identity — not on the error object.
 *
 * A `WeakSet` brand plus a `kind` property read is only half a boundary: the brand proves
 * this module created the object, but the property it then reads is ordinary, mutable, and
 * reachable by anyone holding the instance. `classifyFsError` is exported, so a caller can
 * obtain a genuinely branded error, overwrite `kind` — or redefine it as a throwing getter —
 * and throw it into the core, which would either misclassify it or run foreign code at the
 * exact seam that exists to prevent both. A `WeakMap` closes that: `get` is an identity
 * lookup that reads nothing off the value, so the classification a caller receives is the one
 * `classifyFsError` recorded and cannot be edited afterwards.
 *
 * WHAT THIS DOES NOT PROVE, stated because the distinction decides how much weight the core
 * may put on it: an entry in this map proves the value came from `classifyFsError` and that
 * its recorded kind is untouched. It does NOT prove which caller invoked `classifyFsError`,
 * and it cannot — `SnapshotFs` is a pluggable seam, the in-tree `FakeFs` is a second adapter,
 * and any adapter must be able to hand the core a classified error. So a seam CAN mint a
 * `not-found` it did not observe.
 *
 * That is not a hole this brand is failing to close; it is the trust boundary sitting where
 * the design puts it. The seam IS the filesystem: anything it could achieve by forging a
 * classification it can achieve by returning different bytes, and the core has no independent
 * view to check either against. The brand exists to stop a value that never went through an
 * adapter at all — an arbitrary throw from inside a payload, or a lookalike carrying its own
 * `kind` field — from steering recovery. It does that.
 */
const FS_ERROR_KIND = new WeakMap<object, SnapshotFsErrorKind>();

/**
 * NOT exported as a constructor, only as a type.
 *
 * Exporting the class made `new SnapshotFsError("not-found", …)` a second way into the map
 * above, one that skips the classifier entirely — so the brand's meaning was "either the
 * classifier ran, or somebody said so", which is a strictly weaker claim than the one the
 * comment makes. Nothing outside this file ever constructed one (the tests assert on `.name`),
 * so narrowing it costs nothing and leaves exactly one door: `classifyFsError`.
 */
class SnapshotFsError extends Error {
  readonly kind: SnapshotFsErrorKind;
  readonly op: string;
  readonly path: string;
  readonly cause: unknown;

  constructor(kind: SnapshotFsErrorKind, op: string, path: string, cause: unknown) {
    super(`snapshot fs ${op} on ${path} failed (${kind})`);
    defineOwn(this, "name", "SnapshotFsError");
    // Kept as a public field for logging and debugging only. It is NOT what the core reads;
    // the private map above is. Mutating it changes a label, never a decision.
    this.kind = kind;
    this.op = op;
    this.path = path;
    this.cause = cause;
    weakSet(FS_ERROR_KIND, this, kind);
  }
}

/**
 * Reads the recorded kind, or null for anything this module did not classify.
 *
 * `WeakMap.get` is keyed by object IDENTITY: it invokes no Proxy trap and reads no property,
 * so an unbranded or hostile value is classified as unknown without ever being touched. A
 * primitive or null simply is not a key.
 */
export function snapshotFsErrorKind(err: unknown): SnapshotFsErrorKind | null {
  if (typeof err !== "object" || err === null) return null;
  return weakGet(FS_ERROR_KIND, err) ?? null;
}

export type { SnapshotFsError };

/**
 * Classifies a native fs error at the adapter boundary, where the value is trusted.
 *
 * `.code` is read through an OWN DATA DESCRIPTOR rather than with `cause.code`. This is the
 * one place in the store permitted to inspect a native error, and the permission is for
 * reading a field — not for running whatever a getter or an inherited property decides to do.
 * `cause` reaches here from a `catch`, and an adapter can be handed a value it did not create,
 * so a throwing or hanging accessor at `.code` would replace the classification being computed
 * with an arbitrary failure at the exact seam that exists to prevent one. A descriptor read
 * invokes nothing, and anything that is not an own string is simply not a code.
 */
export function classifyFsError(op: string, path: string, cause: unknown): SnapshotFsError {
  let kind: SnapshotFsErrorKind = "other";
  const code = ownErrnoCode(cause);
  if (code === "ENOENT") kind = "not-found";
  else if (code === "EEXIST") kind = "exists";
  // ELOOP is what O_NOFOLLOW raises on a final-component symlink; ENOTDIR is the prefix form.
  else if (code === "ELOOP" || code === "ENOTDIR") kind = "symlink";
  else if (code === "EFBIG") kind = "too-large";
  else if (code === "EILSEQ") kind = "invalid-content";
  return new SnapshotFsError(kind, op, path, cause);
}

function ownErrnoCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  // `Object.getOwnPropertyDescriptor` is NOT trap-free.
  //
  // Reading the descriptor instead of the property was the fix for a hostile GETTER at `.code`,
  // and it does prevent that — but the descriptor read is itself a proxy trap. A `Proxy` whose
  // `getOwnPropertyDescriptor` handler runs arbitrary code runs it here, and a REVOKED proxy
  // throws on the operation itself. Either one replaces the classification being computed with
  // an arbitrary failure, at the one seam in this module set that exists to stop exactly that —
  // the same defect as the getter, one level up, reintroduced by the fix for it.
  //
  // A Proxy is REFUSED on identity, before the descriptor read — not merely contained.
  //
  // The previous version wrapped the read in try/catch and justified it by claiming there is no
  // reliable test for a proxy. That claim was simply false, and false in a module set that
  // already disproves it: `freshness.ts` calls `node:util.types.isProxy` for exactly this
  // purpose, three modules away. Containment also only handles a trap that THROWS — a handler
  // that returns normally still runs arbitrary code and side effects inside the one function
  // permitted to inspect a native error, which is the thing this boundary exists to prevent.
  //
  // `isProxy` inspects the object's internal type without invoking any trap, and answers for a
  // revoked proxy too. An error that is a proxy is not one of the runtime's, so it carries no
  // errno worth reading: `other`, which is the verdict for any error without a code.
  if (IS_PROXY(cause)) return null;
  // The try/catch stays as well. `isProxy` rules out the trap; it does not rule out an exotic
  // host object whose own descriptor lookup throws, and a throw escaping here would replace the
  // classification being computed with an arbitrary failure.
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = ownDescriptor(cause, "code");
  } catch {
    return null;
  }
  if (descriptor === undefined || !hasOwn(descriptor, "value")) return null;
  return typeof descriptor.value === "string" ? descriptor.value : null;
}
