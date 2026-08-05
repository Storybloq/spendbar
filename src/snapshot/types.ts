/**
 * Snapshot store seams and shared types (T-010).
 *
 * The store is a DERIVED CACHE over the transcript logs: everything in it can be rebuilt
 * from ccusage at any time. That single fact is what licenses the store's central rule —
 * any invalid, unsupported, or ambiguous state is reset and rebuilt, never repaired — and
 * it is why nothing here fsyncs (process-crash atomic, not power-loss durable).
 *
 * Every filesystem operation goes through `SnapshotFs`, and every mutation is preceded by
 * `WriteAuthority.assertHeld()` with no intervening await. Both are seams so the whole
 * failure matrix is injected rather than simulated, following v0.1's `RuntimeDeps` split
 * (src/context.ts): the core performs no I/O of its own.
 *
 * The seam is SYNCHRONOUS on purpose. "assertHeld() immediately before the mutation, with
 * no intervening awaits" (T-010 AC 8, T-008 findings 3.5) is a property you can read off
 * the source only when there is no await to intervene.
 */

/** Result of `lstat`/`fstat`. `mode` is the raw mode; callers mask it themselves. */
export interface SnapshotStat {
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /**
   * Filesystem identity — `(dev, ino)` together, because an inode number is only unique
   * within a device.
   *
   * This is NOT the inode revalidation T-008's gate rejected. That was a LOCK mechanism:
   * recording a lockfile's inode and re-reading it later to decide whether this process still
   * owned the singleton, which fails because the file outlives its owner and the check races
   * the very takeover it is trying to detect. This is the opposite question and it has an
   * answer: "is the name I am about to rename still the file I am holding open?" — comparing
   * a live descriptor against a name, with no ownership claim and nothing inferred about any
   * other process. The commit path uses it for exactly that; nothing here uses it to decide
   * who holds the lock, which remains `WriteAuthority`'s and only `WriteAuthority`'s.
   *
   * The owner has been asked to rule on whether the T-008 constraint, read literally, forbids
   * this too (recorded on T-010 as `ownerDecisionRequired`). Removing it is one function and
   * these two fields.
   *
   * `bigint`, not `number`, and that is a correctness requirement rather than a preference:
   * inode numbers are 64-bit on every filesystem the store runs on, and XFS and btrfs hand
   * out values above 2^53 in ordinary use. Coerced to a double, two distinct files can land
   * on the SAME value — which turns every identity comparison here into a check that silently
   * passes for the wrong file, in the exact scenario the check exists to catch.
   */
  dev: bigint;
  ino: bigint;
}

/** Opaque open-file handle. The seam never exposes a raw fd number to the core. */
export interface SnapshotFileHandle {
  readonly __brand: "SnapshotFileHandle";
}

/**
 * The filesystem seam.
 *
 * ERROR CONTRACT, and it is not optional: EVERY failure crossing this boundary must be wrapped
 * with `classifyFsError` from ./errors.js. The core deliberately never reads `.code` — or any
 * other property — off a thrown value, because doing so runs an accessor or a Proxy trap at
 * the exact seam that exists to keep foreign code out of the store. It recognises absence,
 * existence and symlink refusal ONLY by the classification the adapter recorded, keyed by
 * object identity in a private WeakMap.
 *
 * So an adapter that throws a native ENOENT untouched is not merely unidiomatic — it is
 * BROKEN. The core will not treat it as absence, and a missing file will surface as an
 * unhandled failure. The per-method notes below name the CLASSIFICATION the adapter must
 * record — `not-found`, `exists`, `symlink`, `too-large`, `invalid-content` — and never an
 * errno string, because naming the errno is what invites an adapter to throw one and assume the
 * core will look.
 *
 * MODE CONTRACT, equally not optional, and written down here because the core came to DEPEND on
 * it before anyone had stated it. `openExclusive` and `mkdir` take `FILE_MODE`/`DIR_MODE` as a
 * REQUEST, which a umask may narrow; an adapter must never widen it, and must never narrow it
 * past `OWNER_READ`. `createNodeSnapshotFs` delivers the second half by refusing, at
 * construction, any umask that would clear that bit.
 *
 * The core relies on it in a place that is not obvious from the call: the startup staging sweep
 * removes residue whose mode is a SUBSET of `FILE_MODE` and still carries `OWNER_READ`, which is
 * exactly the set an adapter obeying this contract can produce between `openExclusive` and the
 * `fchmod` that repairs it. Requiring `FILE_MODE` exactly there was a real defect: the sweep
 * refused its own crash residue, classification then found staging non-empty, and startup RESET
 * the store, destroying a complete prior snapshot. Accepting any subset was the opposite defect,
 * silently deleting foreign files at the three fixed staging names. An adapter that hands back a
 * staging file without `OWNER_READ` reintroduces the first one, so this is a contract rather
 * than an observation. The in-tree `FakeFs` enforces the same umask boundary for this reason.
 */
export interface SnapshotFs {
  /**
   * Reads a whole file as UTF-8, FOLLOWING symlinks. Throws a `classifyFsError`-branded
   * not-found error when absent.
   *
   * Deliberately not used for store artifacts any more — see `openRead`. It remains on the
   * seam because the conformance suite pins the fake to the adapter on it, and because
   * following is the correct behaviour for a path the store did not build.
   */
  readFile(path: string): string;
  /**
   * Opens for READING without following a symlink in the final component (`O_NOFOLLOW`),
   * failing with a `symlink`-CLASSIFIED seam error if one is there.
   *
   * Classified, not coded. An adapter that throws a native ELOOP untouched satisfies the
   * sentence this used to contain and is still broken: the core never reads `.code`, so that
   * error is unrecognised and a symlinked artifact surfaces as an unhandled failure instead of
   * a refusal. The preamble said so; these per-method notes said otherwise, and an implementer
   * reads the method they are implementing.
   *
   * This exists because `lstat(path)` followed by `readFile(path)` is two resolutions of the
   * same NAME, and a name is not a file: between the two calls the entry can become a symlink,
   * a FIFO, or a different file, and the "guarded" read then dereferences precisely what the
   * guard rejected. A descriptor is bound to an inode, so opening once and validating THAT
   * descriptor removes the interval instead of narrowing it.
   */
  openRead(path: string): SnapshotFileHandle;
  /**
   * Reads a whole open descriptor as UTF-8, refusing at `maxBytes`.
   *
   * The bound is a parameter and not the adapter's business to choose, but it is also not
   * optional: a store artifact is a file at a fixed name that anything able to write the
   * directory can replace, so an unbounded read is an unbounded allocation driven by a file
   * the store did not write. It is enforced against bytes ACTUALLY READ rather than against a
   * size stat, because the file can grow between the two. Over the limit throws a
   * `too-large`-classified seam error, which the store treats as one more unusable artifact.
   * Named by CLASSIFICATION rather than by errno, for the reason stated at the top of this
   * interface: naming `EFBIG` invites an adapter to throw one and assume the core will look,
   * and the core never looks.
   *
   * STRICT UTF-8, and this is a requirement rather than a default. The bytes must be decoded
   * fatally and invalid input must throw an `invalid-content`-classified error. Substituting
   * U+FFFD — which `Buffer.toString("utf8")` does silently — lets corrupted bytes parse as
   * JSON, checksum correctly, and compare equal to canonical form, all three running on the
   * REPLACED string; and it makes a file holding an invalid byte hash identically to one
   * holding a literal U+FFFD, defeating the exact ABA detection `manifestIdentity` provides.
   * An adapter that decodes leniently, or that classifies invalid bytes as `other`, silently
   * disables the reset path `readStoreFile` takes for a corrupt artifact.
   */
  readAll(handle: SnapshotFileHandle, maxBytes: number): string;
  /**
   * Opens a DIRECTORY without following a final-component symlink, for descriptor-relative
   * mode work.
   *
   * `chmod(path)` follows symlinks, so repairing a directory's mode by pathname is only safe
   * for as long as nothing replaces the name between the check and the call — and every
   * authority assertion in between is a call into caller-supplied code. `fchmod` on a
   * descriptor opened `O_NOFOLLOW | O_DIRECTORY` cannot be redirected: the descriptor is bound
   * to the inode that was proven.
   */
  openDir(path: string): SnapshotFileHandle;
  /**
   * Lists one directory's entry names. Throws a `not-found`-classified error when absent.
   *
   * An entry name that cannot be represented as UTF-8 — invalid bytes, or one that decodes but
   * does not round-trip — must throw and must classify as `other`, NEVER as `invalid-content`.
   * The two look alike and their dispositions are opposites. `invalid-content` means "an
   * artifact we can address and have decided is not ours", which the store resets on; an
   * unaddressable NAME cannot be reset on, because the store cannot name the file in order to
   * delete it, so a reset would report work it could not perform and would be re-attempted
   * forever. That one propagates instead (ISS-069 tracks carrying such names faithfully end to
   * end, which is the complete fix). An adapter must not decode entry names leniently either:
   * a replaced name does not address the file, so the store would unlink a name that is not
   * there, take the ENOENT for success, and meet the same entry again on the next pass.
   */
  listDir(path: string): string[];
  /** `lstat` — never follows symlinks; that is the point of using it. */
  lstat(path: string): SnapshotStat;
  /** Exclusive create (`wx`). Throws an `exists`-classified error when the path exists. */
  openExclusive(path: string): SnapshotFileHandle;
  /**
   * Writes from `offset` and returns the number of bytes actually written — ONE syscall,
   * not a loop. Short writes are real, and the retry loop belongs in the core so that each
   * retry can carry its own `assertHeld()`: a loop hidden inside the seam would keep
   * mutating the staging inode after the writer lost the lock.
   */
  write(handle: SnapshotFileHandle, bytes: Uint8Array, offset: number): number;
  /**
   * Sets the mode on the OPEN FD. `open()`'s mode argument is a umask-filtered request,
   * not a setting, so the mode is always applied after open and verified on the fd.
   */
  fchmod(handle: SnapshotFileHandle, mode: number): void;
  fstat(handle: SnapshotFileHandle): SnapshotStat;
  close(handle: SnapshotFileHandle): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  /**
   * Creates ONE level AT `mode`. Recursive mkdir modes are umask-filtered; the store never
   * uses it.
   *
   * The mode is a parameter rather than a constant applied afterwards because `mkdir(2)`
   * takes one and the alternative has a real window: creating at the default 0777 and
   * chmodding to 0700 a moment later leaves the directory group- and world-traversable under
   * the ordinary umask 022 for as long as that gap lasts. A mode here is still a
   * umask-filtered REQUEST, so callers must keep the chmod after it for the restrictive
   * direction (umask 0200) — this closes the permissive window, it does not replace the
   * chmod.
   */
  mkdir(path: string, mode: number): void;
  rmdir(path: string): void;
}

/*
 * Deliberately ABSENT from this seam: a pathname `chmod`.
 *
 * It used to be here, and the store used it to repair a directory's mode. `chmod(2)` follows
 * symlinks and takes a name, so that repair was a check-then-act on a name whose meaning could
 * change in between — and the interval contained an authority assertion, which is a call into
 * caller-supplied code. Mode repair now goes through `openDir` + `fchmod`, which is bound to an
 * inode. The operation is removed rather than merely unused, because a seam that still offers
 * it is an invitation to reach for it again, and the next caller will not have read this
 * paragraph.
 */

/**
 * The RAW, inner authority — T-011's `PortLock.assertHeld` implements this.
 *
 * `assertHeld` throws when this process no longer holds the singleton. The store calls it
 * immediately before every mutation it performs, so a writer that lost the lock mid-flow
 * stops at the next boundary instead of racing its successor.
 *
 * This type is NOT what the store's entry points accept, and the distinction matters enough to
 * state here: they require a `LatchingWriteAuthority` built by `createWriteAuthority`, which
 * wraps one of these and adds the loss latch, the terminal-action contract, and the refusal to
 * resurrect after an observed loss. A `PortLock` goes IN to that factory; the result of the
 * factory is what goes in to the store. Passing a bare object satisfying this interface is
 * rejected at compile time (the class is nominal) and at runtime (membership in a
 * module-private WeakSet — `instanceof` is forgeable via `Object.create`).
 */
export interface WriteAuthority {
  assertHeld(): void;
}

/**
 * The largest artifact this protocol will write, and the largest it will read.
 *
 * Both directions, and the symmetry is the point rather than belt-and-braces: a reader-only cap
 * turns a legitimately oversized payload into a store that classifies as unusable, resets,
 * rebuilds the same oversized file, and resets again — the non-convergent wedge this design
 * treats as a defect class, not a degraded mode. Refusing at PUBLISH means an over-large
 * payload is the writer's error, reported to the writer, and never becomes a store state.
 *
 * 64 MiB is far above anything this schema produces (a generation is usage totals and
 * provenance, measured in kilobytes) and far below a size that could exhaust a process.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** File and directory modes this store writes, and the mask every check uses. */
export const MODE_MASK = 0o7777;
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/**
 * Owner read, which the adapter guarantees survives the umask.
 *
 * `createNodeSnapshotFs` refuses any mask that clears this bit, because a directory the store
 * cannot reopen is one it cannot repair. That refusal is what makes the bit dependable
 * elsewhere: a `mkdir(DIR_MODE)` or `openExclusive(FILE_MODE)` performed by this protocol always
 * yields a mode that still carries it, so a store file lacking it was not written by this
 * protocol whatever its name. Defined here, beside the modes it constrains, rather than
 * privately in the adapter — the adapter enforces the rule and the store RELIES on it, and the
 * two had no shared statement of what the rule was.
 */
export const OWNER_READ = 0o400;

/** Artifact kinds, which are also the fixed staging names (see `stagingPath`). */
export type ArtifactKind = "manifest" | "generation" | "pin";

export interface CoverageInterval {
  start: string;
  end: string;
}

/**
 * Per-dataset provenance recorded on every generation (T-010 AC 6).
 *
 * Coverage intervals are UTC INSTANTS, never local wall-clock text. A local day is not 24
 * hours — America/Vancouver's spring-forward day is 23 and its fall-back day is 25 — so a
 * wall-clock interval is ambiguous exactly twice a year, in the fold, and short by an hour
 * in the gap. `timezone` and `dayBoundaryPolicy` describe how a requested local day maps
 * ONTO those instants; they never change what an interval means.
 */
export interface Provenance {
  coverage: CoverageInterval[];
  /**
   * Coverage per field, which is what makes freshness a per-request answer rather than a
   * global flag: a field can be covered for a range the snapshot as a whole is not, and vice
   * versa. A field ABSENT from this map has made no claim and is therefore not covered —
   * the same "absence is not zero" rule dominance.ts applies to sources.
   */
  fieldCoverage: Record<string, CoverageInterval[]>;
  sourceTimestamps: Record<string, string>;
  refreshTier: string;
  ccusageVersion: string;
  /**
   * The instant this service INVOKED ccusage — the fact the writer can prove. Deliberately
   * not "fetchedAt": ccusage embeds pricing at build time and reports no fetch timestamp,
   * so a fetch-shaped name would misrepresent (N-007 decision 2, ISS-077). Renamed from
   * `ccusageFetchedAt`; the exact-key invariant means a pre-rename snapshot classifies to
   * reset, which is the accepted pre-release consequence recorded in T-025.
   */
  ccusageInvokedAt: string;
  timezone: string;
  dayBoundaryPolicy: string;
}

export interface GenerationDoc {
  generationId: string;
  publishedAt: string;
  /** Per-source offsets. Never a scalar; see dominance.ts. */
  sourceVersion: Record<string, number>;
  provenance: Provenance;
  payload: unknown;
}

export interface ManifestDoc {
  activeGenerationId: string;
  retainedGenerationIds: string[];
  publishedAt: string;
  sourceVersion: Record<string, number>;
}

export interface PinDoc {
  pinId: string;
  generationId: string;
  until: string;
}
