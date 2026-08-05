/**
 * The snapshot store (T-010).
 *
 * One rule governs every state this store can reach:
 *
 *   any invalid, unsupported, or ambiguous state  =>  atomic reset to empty + rebuild
 *
 * The store is a derived cache over the transcript logs, so there is nothing here worth
 * repairing: a reset costs a recomputation. That is what lets this module be small — no
 * migrations, no partial-recovery branches, no ownership bookkeeping, and exactly one
 * diagnostic (`SnapshotStoreResetError`) whose `reason` is logged and never switched on.
 *
 * Two disciplines run through every function and are each pinned by a test:
 *
 *   - `authority.assertHeld()` immediately precedes EVERY mutation, with no intervening
 *     await. Not just the commit rename: a reset is many mutations, and gating only its
 *     first one would let a writer that lost the lock keep deleting a successor's files.
 *   - After an observed authority loss the store LEAVES residue and reports it. Deleting a
 *     path at a fixed name after losing the lock is how you delete the successor's file.
 */
import {
  SnapshotIdError,
  SnapshotModeError,
  SnapshotNotDominatingError,
  SnapshotPathError,
  SnapshotCommitFailure,
  SnapshotStoreResetError,
  SnapshotWriteContractError,
  SnapshotArtifactTooLargeError,
  snapshotErrorTag,
  snapshotFsErrorKind,
  type ResetReason,
  type SnapshotErrorTag,
} from "./errors.js";
import { assertGuardedAuthority, type LatchingWriteAuthority } from "./authority.js";
import { canonicalSourceVersion, compareSourceVersions } from "./dominance.js";
import { isExplicitInstant } from "./freshness.js";
import {
  SCHEMA_VERSION,
  canonicalize,
  decodeEnvelope,
  encodeEnvelope,
  manifestIdentity,
} from "./envelope.js";
import {
  DIR_MODE,
  FILE_MODE,
  MAX_ARTIFACT_BYTES,
  OWNER_READ,
  MODE_MASK,
  type ArtifactKind,
  type GenerationDoc,
  type ManifestDoc,
  type PinDoc,
  type Provenance,
  type SnapshotFileHandle,
  type SnapshotFs,
  type SnapshotStat,
  type WriteAuthority,
} from "./types.js";

export interface StorePaths {
  root: string;
  manifest: string;
  generationsDir: string;
  pinsDir: string;
  stagingDir: string;
}

const ROOT_ENTRIES = ["manifest.json", "generations", "pins", "staging"] as const;

/**
 * Version-scoped store root. A build reads and writes exactly its own directory and never
 * opens another version's, which is what makes AC 5's "existing files byte-identical after
 * the refusal" true by construction rather than by care: an older writer meeting
 * newer-schema data never addresses those files at all.
 */
export function storePaths(stateDir: string): StorePaths {
  assertSafePathSegment(stateDir);
  // ABSOLUTE, and this is a correctness requirement rather than tidiness. A relative
  // `stateDir` is resolved by the real adapter against `process.cwd()` — which any part of the
  // process can change at any moment — so the same `StorePaths` value would address a
  // different directory before and after a `chdir`, and every containment argument in this
  // module ("the prefix I proved is the prefix the mutation resolves through") would be about
  // a path that had moved. The fake refuses relative paths outright, so the divergence also
  // meant the suite was testing a shape production would have accepted.
  if (!stateDir.startsWith("/")) {
    throw new SnapshotPathError(`stateDir must be an absolute path: ${stateDir}`);
  }
  const root = `${stateDir}/store-v${SCHEMA_VERSION}`;
  return {
    root,
    manifest: `${root}/manifest.json`,
    generationsDir: `${root}/generations`,
    pinsDir: `${root}/pins`,
    stagingDir: `${root}/staging`,
  };
}

/**
 * Fixed staging names — one per artifact kind, not one per invocation.
 *
 * With a single writer there is at most one in-flight publish per kind, so three names is
 * the complete set and residue is bounded by construction: a crashing or looping writer
 * leaves at most three stale files, never a growing set. Bounding the residue is what
 * removes the need for a per-invocation staging lifecycle to track it.
 */
export function stagingPath(paths: StorePaths, kind: ArtifactKind): string {
  return `${paths.stagingDir}/${kind}.json`;
}

/**
 * Artifact IDS, checked with the same grammar the read side already applies to artifact
 * NAMES — because an id becomes a filename, and a filename is a path component.
 *
 * Validating names only on the way in is the asymmetry this closes: a generation id of
 * `../../../etc/pwned` produced a perfectly successful publish that renamed the artifact
 * clean out of the version-scoped root, and the store would not have objected until the next
 * classification, by which point the file was already written wherever it was pointed. The
 * grammar is an allowlist rather than a blocklist of dangerous sequences: it admits ASCII
 * alphanumerics, dot, dash and underscore after a leading alphanumeric, so `/`, `\`, `.`,
 * `..`, a leading dot, NUL, and every non-ASCII form of separator are refused by not being
 * mentioned. The length cap keeps `${id}.json` inside the 255-byte component limit that every
 * filesystem this ships on enforces, so a long id fails here with a named error instead of at
 * the seam with ENAMETOOLONG.
 */
const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ARTIFACT_ID_MAX = 128;

export function assertArtifactId(kind: string, id: unknown): string {
  if (typeof id !== "string") {
    throw new SnapshotIdError(kind, id, "not a string");
  }
  if (id.length === 0 || id.length > ARTIFACT_ID_MAX) {
    throw new SnapshotIdError(kind, id, `length must be 1..${ARTIFACT_ID_MAX}`);
  }
  if (!ARTIFACT_ID_RE.test(id)) {
    throw new SnapshotIdError(kind, id, "does not match the artifact id grammar");
  }
  return id;
}

function assertSafePathSegment(path: string): void {
  if (path.length === 0) {
    throw new SnapshotPathError("empty path");
  }
  for (const part of path.split("/")) {
    if (part === "." || part === ".." ) {
      throw new SnapshotPathError(`path contains ${JSON.stringify(part)}: ${path}`);
    }
  }
  // An empty component anywhere but a leading "/" (absolute paths) is a malformed path.
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === "") {
      throw new SnapshotPathError(`path contains an empty component: ${path}`);
    }
  }
}

/**
 * Was this an "absent path" failure?
 *
 * The check reads the BRAND, never the thrown value: `SnapshotFs` adapters classify their
 * own native errors at the seam (`classifyFsError`), where the value is trusted, and the
 * brand is WeakSet membership by identity — no property read, no Proxy trap, nothing that
 * can run foreign code or hang. Anything unbranded is unknown by definition and propagates
 * untouched, which is the only honest answer for a value this module did not create.
 */
function isNotFound(err: unknown): boolean {
  return snapshotFsErrorKind(err) === "not-found";
}

/**
 * Mode enforcement, masked at 0o7777 so setuid/setgid/sticky are refusal signals: a mode
 * this protocol never writes means something other than this protocol wrote the file.
 * Enforced on READ as well as write — an unkeyed checksum is no defence against whoever
 * can write the file.
 */
function assertMode(fs: SnapshotFs, path: string, expected: number): void {
  const stat = fs.lstat(path);
  if (stat.isSymbolicLink) {
    throw new SnapshotPathError(`${path} is a symlink`);
  }
  const mode = stat.mode & MODE_MASK;
  if (mode !== expected) {
    throw new SnapshotModeError(path, mode, expected);
  }
}

function lstatOrNull(fs: SnapshotFs, path: string): SnapshotStat | null {
  try {
    return fs.lstat(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** The containing directory of a path this module built. */
function parentDir(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * Proves one directory this store OWNS is still the directory it was.
 *
 * Absent, a symlink, a non-directory, or a mode this protocol never writes all mean the
 * container is not ours any more, and nothing may be created or renamed inside it.
 */
function assertOwnedContainer(fs: SnapshotFs, dir: string): void {
  const stat = fs.lstat(dir);
  if (stat.isSymbolicLink) {
    throw new SnapshotPathError(`${dir} is a symlink`);
  }
  if (!stat.isDirectory) {
    throw new SnapshotPathError(`${dir} is not a directory`);
  }
  const mode = stat.mode & MODE_MASK;
  if (mode !== DIR_MODE) {
    throw new SnapshotModeError(dir, mode, DIR_MODE);
  }
}

/**
 * Proves every owned container from the version-scoped root down to `dir`, immediately before
 * a commit.
 *
 * `lstat(targetPath)` alone proves only the FINAL component. It RESOLVES the prefix, so
 * swapping `generations/` for a symlink leaves that check passing while the rename lands
 * wherever the link points — the symlink defence reporting success on the one arrangement it
 * exists to stop. Checking each component this module owns closes the prefix.
 *
 * Three limits, stated rather than implied.
 *
 * The chain stops at the store root: `stateDir` above it is the caller's and this module never
 * creates it, so it cannot vouch for it.
 *
 * This is a check, not a capability. Between the last lstat and the rename there is still a
 * window, because closing it properly needs `openat`/`renameat` relative to a held directory
 * descriptor, which Node does not expose. It narrows the race to instructions and does not
 * eliminate it — the same advisory bound the dominance check carries.
 *
 * And it answers a WEAKER question than it looks like it does, which is the thing to keep in
 * mind when reading its callers: it proves the container is AN acceptable directory, not that
 * it is the SAME directory seen a moment ago. Swapping `generations/` for a different real
 * 0700 directory passes every assertion here. Callers that list a directory and then act on
 * what they found need `containerIdentity`/`assertSameContainer` below, which do compare
 * identity; this one is for the "may I create here at all" question.
 */
function assertOwnedChain(fs: SnapshotFs, paths: StorePaths, dir: string): void {
  assertOwnedContainer(fs, paths.root);
  if (dir !== paths.root) assertOwnedContainer(fs, dir);
}

/**
 * `(dev, ino)` of an owned container, as a comparable token.
 *
 * The chain is proven first, so the identity returned is an identity of something this store
 * is allowed to be using — a token for a symlinked or wrong-moded directory would be a
 * precise answer to the wrong question.
 */
function containerIdentity(fs: SnapshotFs, paths: StorePaths, dir: string): string {
  assertOwnedChain(fs, paths, dir);
  const stat = fs.lstat(dir);
  return `${stat.dev}:${stat.ino}`;
}

/**
 * Proves an owned container is still acceptable AND still the same directory.
 *
 * The second half is the part `assertOwnedChain` cannot do. Every sequence in this module
 * that lists a directory and then mutates what it listed is exposed without it: the entries
 * came from the directory as it was, and an attacker who swaps in a DIFFERENT real 0700
 * directory between the list and the unlink passes an acceptability check unchanged, so the
 * unlinks land in the substitute — deleting names chosen by whoever performed the swap. Mode
 * and type are properties a forgery can reproduce at will; identity is the one property it
 * cannot.
 */
function assertSameContainer(
  fs: SnapshotFs,
  paths: StorePaths,
  dir: string,
  identity: string,
): void {
  const now = containerIdentity(fs, paths, dir);
  if (now !== identity) {
    throw new SnapshotPathError(
      `${dir} was replaced during the operation (was ${identity}, now ${now})`,
    );
  }
}

/**
 * Reads a store file only if the NAME is a non-symlink regular file at exactly FILE_MODE.
 *
 * `readFile` FOLLOWS symlinks, so reading a store path directly asks the filesystem to
 * dereference whatever is sitting at that name and hand back the contents. For the manifest
 * that is the difference between "what this store protects" and "what someone else wrote down
 * for us to act on" — and the manifest's whole job is to name what must not be deleted.
 *
 * Returns null for absent-or-unusable rather than throwing, because every caller's
 * disposition for the two is identical: refuse to act on it.
 */
function readGuarded(fs: SnapshotFs, path: string): string | null {
  const result = readStoreFile(fs, path);
  return result.state === "ok" ? result.raw : null;
}

/**
 * The same guarded read, keeping ABSENT and PRESENT-BUT-NOT-OURS distinct.
 *
 * Classification needs the distinction and the sweep paths do not, which is the whole reason
 * there are two functions. An absent manifest can legitimately mean first-run; a SYMLINK at
 * that name cannot mean anything of the sort, and collapsing the two would classify a store
 * whose manifest had been replaced by a link as a brand-new store — then let the first-run
 * path build on top of it.
 */
type StoreFileRead =
  | { state: "absent" }
  /**
   * `cause` is the seam failure this verdict was derived FROM, held opaquely.
   *
   * Every `unusable` here is reached by catching a classified `SnapshotFsError` and replacing it
   * with a reason and a sentence. Without this field that original was DROPPED at the boundary —
   * including the `TextDecoder` failure `node-fs` goes out of its way to preserve, which is the
   * only thing that says WHERE an artifact's bytes went wrong. The module's rule is that a
   * caught value is never read and never discarded; this struct was honouring the first half and
   * breaking the second, which is how the round that introduced the decoder cause also lost it.
   */
  | { state: "unusable"; reason: ResetReason; detail: string; cause?: unknown }
  | { state: "ok"; raw: string };

function readStoreFile(fs: SnapshotFs, path: string): StoreFileRead {
  // OPEN FIRST, then validate the DESCRIPTOR, then read the same descriptor.
  //
  // The obvious shape — lstat the name, then read the name — was wrong in a way that survived
  // two review rounds looking correct: those are two independent resolutions of a NAME, and a
  // name is not a file. Between them the entry can become a symlink, a FIFO, or a different
  // file, so the read dereferences precisely what the lstat rejected. Every check was real and
  // the interval between them made all of them advisory.
  //
  // `openRead` is O_NOFOLLOW, so a symlink is refused by the kernel rather than resolved, and
  // everything after it is asked of an inode this function is holding open. There is no
  // interval left to lose: the mode that gets checked and the bytes that get read belong to
  // the same file by construction.
  let handle: SnapshotFileHandle;
  try {
    handle = fs.openRead(path);
  } catch (err) {
    if (isNotFound(err)) return { state: "absent" };
    if (snapshotFsErrorKind(err) === "symlink") {
      return {
        state: "unusable",
        reason: "artifact-not-a-regular-file",
        detail: "is a symlink",
        cause: err,
      };
    }
    throw err;
  }
  try {
    const stat = fs.fstat(handle);
    if (!stat.isFile) {
      return {
        state: "unusable",
        reason: "artifact-not-a-regular-file",
        detail: "is not a regular file",
      };
    }
    const mode = stat.mode & MODE_MASK;
    if (mode !== FILE_MODE) {
      return {
        state: "unusable",
        reason: "mode-violation",
        detail: `has mode ${mode.toString(8)}, expected ${FILE_MODE.toString(8)}`,
      };
    }
    try {
      return { state: "ok", raw: fs.readAll(handle, MAX_ARTIFACT_BYTES) };
    } catch (err) {
      // Bigger than this protocol writes, so it is not one of ours whatever it holds. That is
      // the same verdict as a wrong mode or a symlink and takes the same disposition — an
      // unusable artifact — rather than propagating as an I/O fault. The writer refuses to
      // publish above the same bound, so this can never be a file the store itself produced.
      if (snapshotFsErrorKind(err) === "too-large") {
        return {
          state: "unusable",
          reason: "artifact-too-large",
          detail: `is larger than the ${MAX_ARTIFACT_BYTES}-byte artifact limit`,
          cause: err,
        };
      }
      // Bytes that are not valid UTF-8, which this protocol cannot have written: it writes
      // canonical JSON. Same verdict and same disposition as the two above — an unusable
      // artifact — rather than an I/O fault to propagate.
      //
      // This was the gap the strict decoder left. Refusing lossy decoding turned silent U+FFFD
      // substitution into a named failure, and `unparsable` is the reason the store already has
      // for "present, and provably not one of ours" — but the failure was classified `other`,
      // so it fell to the `throw` below and CRASHED the reader instead of resetting the derived
      // cache. A guard whose refusal reaches a caller with no disposition for it is not yet a
      // guard, and this is the sixth time on this ticket that a value proven to have one
      // property was used where a different property had been proven.
      if (snapshotFsErrorKind(err) === "invalid-content") {
        return {
          state: "unusable",
          reason: "artifact-invalid-encoding",
          detail: "is not valid UTF-8, so this protocol did not write it",
          cause: err,
        };
      }
      throw err;
    }
  } finally {
    // Resource cleanup, on every path, and never gated: releasing a read descriptor publishes
    // nothing and removes nothing.
    try {
      fs.close(handle);
    } catch {
      // A failing close on a READ descriptor tells us nothing about the bytes already read.
    }
  }
}

function listOrEmpty(fs: SnapshotFs, dir: string): string[] {
  try {
    return fs.listDir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}


// ---------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------

export type StoreStatus = "first-run" | "usable" | "not-usable";

export interface Classification {
  status: StoreStatus;
  /** Present when usable. */
  manifest?: ManifestDoc;
  /** Present when not-usable. Logged, never branched on. */
  error?: SnapshotStoreResetError;
  /** Generation files present but not referenced by the manifest — ordinary GC input. */
  unreferencedGenerations: string[];
}

/**
 * Classifies the store on ONE read-only pass, with explicit precedence so no observation
 * is ambiguous:
 *
 *   manifest absent + truly empty skeleton      -> first-run (rebuild, nothing to reset)
 *   manifest absent + ANY residue               -> not-usable (reset)
 *   unknown entry in the root                   -> not-usable (reset)
 *   manifest present but invalid in any way     -> not-usable (reset)
 *   manifest present + unreferenced generation  -> USABLE; the orphan is GC input, not a
 *                                                  reset trigger. It is exactly the residue
 *                                                  the commit order promises after a crash
 *                                                  between the generation and manifest
 *                                                  commits, so resetting on it would make
 *                                                  an anticipated, harmless state fatal.
 */
export function classifyStore(fs: SnapshotFs, paths: StorePaths): Classification {
  // The root is proven before it is listed, for the same reason the known directories are:
  // `listDir` FOLLOWS a symlink, so classifying a symlinked root would describe some other
  // directory's contents as if they were the store's — and every path this function builds
  // beneath it would resolve out of the store too.
  const rootStat = lstatOrNull(fs, paths.root);
  if (
    rootStat !== null &&
    !rootStat.isSymbolicLink &&
    rootStat.isDirectory &&
    (rootStat.mode & MODE_MASK) !== DIR_MODE
  ) {
    // The MODE, not only the type. The privacy invariant is "exactly 0700, always", and every
    // artifact directory beneath this one was already checked against it — but the root itself
    // was only ever checked for being a directory, so a 0755 store root (or one carrying a
    // setgid bit) classified as perfectly usable while the whole store was world-traversable.
    return {
      status: "not-usable",
      error: new SnapshotStoreResetError(
        "mode-violation",
        `store root has mode ${(rootStat.mode & MODE_MASK).toString(8)}, expected ${DIR_MODE.toString(8)}`,
        paths.root,
      ),
      unreferencedGenerations: [],
    };
  }
  if (rootStat !== null && (rootStat.isSymbolicLink || !rootStat.isDirectory)) {
    return {
      status: "not-usable",
      error: new SnapshotStoreResetError(
        "unknown-entry",
        `${paths.root} is not a directory`,
        paths.root,
      ),
      unreferencedGenerations: [],
    };
  }

  // Classification is a READ-ONLY pass, but it is a long one: a dozen seam calls, each of
  // which yields. Its verdict is what routes the store to "usable" or to a reset, and every
  // path it inspects is resolved through these four directories — so a container swapped
  // partway through means the second half of the verdict describes a different filesystem from
  // the first half. `assertOwnedChain` cannot see that: it proves a container is AN acceptable
  // directory, and a substitute 0700 directory full of forged artifacts is one. Identity is the
  // property a forgery cannot reproduce, so the pass brackets itself with it.
  const identityOf = (dir: string): string => {
    const st = lstatOrNull(fs, dir);
    if (st === null) return "absent";
    if (st.isSymbolicLink || !st.isDirectory) return "not-a-directory";
    return `${st.dev}:${st.ino}`;
  };
  const containerIdentities = (): string =>
    [paths.root, paths.generationsDir, paths.pinsDir, paths.stagingDir]
      .map(identityOf)
      .join("|");
  const identitiesAtEntry = containerIdentities();
  const containersMoved = (): Classification | null => {
    if (containerIdentities() === identitiesAtEntry) return null;
    return {
      status: "not-usable",
      error: new SnapshotStoreResetError(
        "container-replaced",
        "a store container was replaced while the store was being classified",
        paths.root,
      ),
      unreferencedGenerations: [],
    };
  };

  const rootEntries = listOrEmpty(fs, paths.root);
  for (const entry of rootEntries) {
    if (!(ROOT_ENTRIES as readonly string[]).includes(entry)) {
      return {
        status: "not-usable",
        error: new SnapshotStoreResetError(
          "unknown-entry",
          `unexpected entry ${JSON.stringify(entry)} in store root`,
          `${paths.root}/${entry}`,
        ),
        unreferencedGenerations: [],
      };
    }
  }

  // Inside the known directories, classification must be exhaustive too: an entry that is
  // not a plain 0600 regular file with a conforming name was not written by this protocol,
  // and "we did not write it" is exactly the ambiguity the one rule resolves by resetting.
  // Without this, a symlink or a nested directory under generations/ would slip past
  // classification and then be met by GC's unlink, which is not the place to discover it.
  for (const dir of [paths.generationsDir, paths.pinsDir, paths.stagingDir]) {
    const problem = checkArtifactDir(fs, dir);
    if (problem !== null) {
      return { status: "not-usable", error: problem, unreferencedGenerations: [] };
    }
  }

  // Staging must be empty by the time anything is classified: `startWriter` sweeps it
  // first, so a surviving entry means the sweep could not clear it, and a store whose
  // in-flight artifacts cannot be cleared is not one to build on.
  for (const entry of listOrEmpty(fs, paths.stagingDir)) {
    return {
      status: "not-usable",
      error: new SnapshotStoreResetError(
        "unknown-entry",
        `staging is not empty after the startup sweep: ${entry}`,
        `${paths.stagingDir}/${entry}`,
      ),
      unreferencedGenerations: [],
    };
  }

  // The try opens HERE, not at the decode below.
  //
  // The catch at the bottom converts a tagged `SnapshotModeError` or `SnapshotPathError` into a
  // reset verdict, which is this function's contract: it returns a verdict. But the four seam
  // calls that follow — three directory listings and the manifest read — sat outside it, so the
  // SAME failure classified when it came from a generations/ read and ESCAPED when it came from
  // the manifest. A function whose disposition for a condition depends on which of its own
  // reads produced it has two dispositions, and only one of them is documented.
  try {
  const generationFiles = listOrEmpty(fs, paths.generationsDir);
  const pinFiles = listOrEmpty(fs, paths.pinsDir);
  const stagingFiles = listOrEmpty(fs, paths.stagingDir);

  const manifestRead = readStoreFile(fs, paths.manifest);
  if (manifestRead.state === "unusable") {
    // Present, and provably not one of ours. Not first-run, and not residue: an ambiguous
    // state, which the one rule resets.
    return {
      status: "not-usable",
      error: new SnapshotStoreResetError(
        manifestRead.reason,
        `manifest.json ${manifestRead.detail}`,
        paths.manifest,
        manifestRead.cause,
      ),
      unreferencedGenerations: [],
    };
  }
  if (manifestRead.state === "absent") {
    const residue = [
      ...generationFiles.map((f) => `${paths.generationsDir}/${f}`),
      ...pinFiles.map((f) => `${paths.pinsDir}/${f}`),
      ...stagingFiles.map((f) => `${paths.stagingDir}/${f}`),
    ];
    if (residue.length === 0) {
      return containersMoved() ?? { status: "first-run", unreferencedGenerations: [] };
    }
    return {
      status: "not-usable",
      error: new SnapshotStoreResetError(
        "residue-without-manifest",
        `${residue.length} artifact(s) present with no manifest`,
        residue[0]!,
      ),
      unreferencedGenerations: [],
    };
  }

  const rawManifest = manifestRead.raw;
    const manifest = decodeEnvelope("manifest", paths.manifest, rawManifest) as ManifestDoc;
    assertManifestInvariants(manifest, paths.manifest);

    const referenced = new Set([
      manifest.activeGenerationId,
      ...manifest.retainedGenerationIds,
    ]);
    for (const generationId of referenced) {
      const path = `${paths.generationsDir}/${generationId}.json`;
      const read = readStoreFile(fs, path);
      if (read.state === "absent") {
        throw new SnapshotStoreResetError(
          "generation-missing",
          `manifest references ${generationId}, which is absent`,
          path,
        );
      }
      if (read.state === "unusable") {
        // The THIRD consumer, and the one round 10's fix missed. The grep that found the other
        // two matched on the local's name, so the one place a generation — rather than the
        // manifest — is turned into a reset diagnostic kept dropping the classified seam failure
        // and the decoder cause `StoreFileRead` was changed to preserve. A struct field that is
        // populated and forwarded at two of three sites is not a rule, it is a coincidence.
        throw new SnapshotStoreResetError(
          read.reason,
          `${generationId}.json ${read.detail}`,
          path,
          read.cause,
        );
      }
      const raw = read.raw;
      // Envelope validity is not document validity. A checksum proves the bytes are the ones
      // that were written; it says nothing about whether the body is a generation, nor
      // whether it is THIS generation. Without the id binding below, a checksum-valid
      // generation could be served under another id entirely — copy gen-a.json over
      // gen-b.json and the manifest's reference to gen-b silently resolves to gen-a's data.
      assertGenerationInvariants(decodeEnvelope("generation", path, raw), path, generationId);
    }

    const unreferenced = generationFiles
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((id) => !referenced.has(id));

    return (
      containersMoved() ?? { status: "usable", manifest, unreferencedGenerations: unreferenced }
    );
  } catch (err) {
    const found = snapshotErrorTag(err);
    if (found === "SnapshotStoreResetError") {
      return {
        status: "not-usable",
        error: err as SnapshotStoreResetError,
        unreferencedGenerations: [],
      };
    }
    if (found === "SnapshotModeError" || found === "SnapshotPathError") {
      return {
        status: "not-usable",
        error: new SnapshotStoreResetError(
          "mode-violation",
          // The TAG, not the message. `.message` is an ordinary mutable property on a value
          // this function caught, and these constructors are exported — so a seam able to
          // throw a genuinely tagged error can redefine `message` as a getter and run its code
          // inside the catch that exists to contain the failure. The whole reason
          // classification reads a private WeakMap instead of `instanceof` is to avoid asking
          // a caught value anything; asking it for a string one line later gave that back.
          //
          // The tag is the only thing read, it came from the private map, and it is enough:
          // every reason here leads to the same disposition, and the original value travels
          // by reference for a human who wants to look at it deliberately.
          `classification refused the store with a ${found}`,
          paths.manifest,
          err,
        ),
        unreferencedGenerations: [],
      };
    }
    throw err;
  }
}

/**
 * Is this a filename this protocol could have written?
 *
 * Asked by running the WRITE-side grammar on the base name, rather than by a second regex that
 * merely looks like it. A separate pattern drifted from `assertArtifactId` in exactly the way
 * duplicated rules do: it carried the character class and not the 128-byte length bound, so a
 * 300-character generation name — a name `assertArtifactId` would never have produced — was
 * classified as an ordinary unreferenced generation and handed to GC as collectable, instead of
 * being recognised as foreign state and reset. One grammar, one place.
 */
function isArtifactFileName(entry: string): boolean {
  if (!entry.endsWith(".json")) return false;
  try {
    assertArtifactId("artifact", entry.slice(0, -".json".length));
    return true;
  } catch (err) {
    if (snapshotErrorTag(err) === "SnapshotIdError") return false;
    throw err;
  }
}

/**
 * Validates one known directory's own type, mode, and entries.
 *
 * The split between "reset" and "GC input" is by ENTRY versus CONTENT: a malformed pin
 * DOCUMENT is data GC owns and removes (a lost pin costs a cursor a typed error), but a pin
 * ENTRY that is a symlink, a directory, wrong-mode, or oddly named means something other
 * than this protocol wrote there — which is not a data question and not GC's to decide.
 */
function checkArtifactDir(fs: SnapshotFs, dir: string): SnapshotStoreResetError | null {
  let dirStat;
  try {
    dirStat = fs.lstat(dir);
  } catch (err) {
    if (isNotFound(err)) return null; // absent is a first-run shape, not damage
    throw err;
  }
  if (dirStat.isSymbolicLink || !dirStat.isDirectory) {
    return new SnapshotStoreResetError("unknown-entry", `${dir} is not a directory`, dir);
  }
  if ((dirStat.mode & MODE_MASK) !== DIR_MODE) {
    return new SnapshotStoreResetError(
      "mode-violation",
      `${dir} has mode ${(dirStat.mode & MODE_MASK).toString(8)}, expected 700`,
      dir,
    );
  }

  for (const entry of listOrEmpty(fs, dir)) {
    const path = `${dir}/${entry}`;
    const stat = fs.lstat(path);
    if (stat.isSymbolicLink) {
      return new SnapshotStoreResetError("unknown-entry", `${path} is a symlink`, path);
    }
    if (!stat.isFile) {
      return new SnapshotStoreResetError(
        "unknown-entry",
        `${path} is not a regular file`,
        path,
      );
    }
    if (!isArtifactFileName(entry)) {
      return new SnapshotStoreResetError(
        "unknown-entry",
        `${path} does not match the artifact naming rule`,
        path,
      );
    }
    if ((stat.mode & MODE_MASK) !== FILE_MODE) {
      return new SnapshotStoreResetError(
        "mode-violation",
        `${path} has mode ${(stat.mode & MODE_MASK).toString(8)}, expected 600`,
        path,
      );
    }
  }
  return null;
}

/**
 * Runs the id grammar inside a document validator, where a violation is a reset reason rather
 * than a caller error.
 *
 * The manifest is the one place an id crosses from data back into a PATH: every generation it
 * names is turned into `generations/<id>.json` and read. So a manifest is not merely
 * malformed when it carries `../../x` — it is a manifest that can make the reader open a file
 * outside the store, and it must be refused before that path is ever built.
 */
function checkDocumentId(
  kind: string,
  id: unknown,
  fail: (detail: string, cause?: unknown) => never,
): string {
  try {
    return assertArtifactId(kind, id);
  } catch (err) {
    // The TAG, not `instanceof` — the same reason `isArtifactFileName` next door reads the
    // tag. `instanceof` consults `SnapshotIdError[Symbol.hasInstance]`, which is a writable
    // property on an EXPORTED constructor, so anyone holding the module can make this test
    // answer false. It would then rethrow, and a caller-facing `SnapshotIdError` would escape
    // in place of the reset diagnostic a malformed document is required to produce — turning
    // "this store is unusable, reset it" into "you passed a bad argument".
    if (snapshotErrorTag(err) === "SnapshotIdError") {
      fail(`${kind} id is unusable`, err);
    }
    throw err;
  }
}

/**
 * Proves a document is INERT plain JSON data, before anything reads a property off it.
 *
 * Order is the whole point. Every `assert*Invariants` function below reaches into a
 * caller-supplied object — `g["provenance"]`, `Object.entries(timestamps)`, and so on — and
 * each of those is an ordinary property read that runs an accessor, or a Proxy `get` trap, if
 * the caller put one there. Validation is exactly where that must not happen: it is the step
 * that decides whether the value is acceptable, so code running inside it can observe the
 * checks, return different values to different reads, or simply hang, and a `try`/`catch`
 * around a validator contains none of those.
 *
 * `canonicalize` already refuses Proxies, accessors, Symbol keys, non-plain prototypes and
 * cycles — it just has to run FIRST. Afterwards every read below is a read of plain data.
 *
 * The three checks ahead of it (`null`, `typeof`, `Array.isArray`) are safe to keep there:
 * none of them reads a property, and none is trappable.
 *
 * On the READ path this walk is provably redundant — `decodeEnvelope` had to canonicalize the
 * body already to verify its checksum, so anything reaching a validator from disk is inert by
 * construction. It is not skipped there, and deliberately so: the only way to skip it would be
 * a parameter saying "this one is already safe", and a correctness argument that a caller has
 * to supply correctly is exactly the shape of the stale-manifest bug this ticket already paid
 * for once. The cost is one extra walk of a document that is, by design, small.
 */
function assertInertDocument(
  doc: unknown,
  what: string,
  fail: (detail: string, cause?: unknown) => never,
): void {
  try {
    canonicalize(doc);
  } catch (err) {
    fail(`${what} is not canonicalizable`, err);
  }
}

/**
 * A private copy of a caller's document, taken through canonical form.
 *
 * `assertInertDocument` proves a document inert and then DISCARDS the canonical form it built,
 * so every read afterwards goes back to the caller's object. Nothing freezes that object, and
 * the seam is caller-supplied: a hook fired inside any seam call between the proof and the reads
 * can `Object.defineProperty` a field into an accessor, after which the artifact committed need
 * not be the artifact that was checked. Detaching removes the question instead of answering it,
 * because what comes back is a fresh tree nobody else holds a reference to.
 *
 * Through canonical form rather than by copying properties: a shallow copy leaves the nested
 * trees shared with the caller and the same hook reaches them one level down.
 *
 * Hoisted out of `publishSnapshot`, where it was a local. `createPin` proves inertness the same
 * way and is safe today only because nothing happens to sit between its proof and
 * `commitArtifact`'s encode — an ordering property that is nowhere stated and that any future
 * seam call inserted into that stretch would silently break. One entry point had removed its
 * dependence on that ordering and the other still rested on it; a rule this module enforces at
 * one door and not the other is the exact shape this ticket keeps rediscovering.
 */
function detachDocument<T>(value: T, what: string, fail: (detail: string, cause?: unknown) => never): T {
  try {
    return JSON.parse(canonicalize(value)) as T;
  } catch (err) {
    return fail(`${what} could not be copied into a private document`, err);
  }
}

/**
 * The EXACT own-key set, not merely "the fields I need are present".
 *
 * `decodeEnvelope` already applies this rule to the envelope, and for the same reason it
 * belongs on the documents inside: a field this protocol does not define is, verbatim, the
 * "unsupported or ambiguous" state the one rule resets on. Tolerating extras is how a document
 * written by a NEWER build gets read by an older one as though the parts it recognises were the
 * whole story — which is precisely what version-scoping the store directory exists to prevent,
 * undone one field at a time. Adding a field is a schema change, and a schema change bumps
 * SCHEMA_VERSION.
 *
 * Safe to read keys here because every caller has already proven the document inert.
 */
function assertExactKeys(
  value: Record<string, unknown>,
  what: string,
  expected: readonly string[],
  fail: (detail: string, cause?: unknown) => never,
): void {
  // Compared as SETS. The obvious form — sort both and join them with a comma — compares a
  // rendering rather than a key set, and the rendering is not injective: a key set is not a
  // string, and flattening it into one loses exactly the boundaries the check is about. A
  // document whose single own key is literally
  // `"activeGenerationId,publishedAt,retainedGenerationIds,sourceVersion"` renders to the same
  // text as the four real keys and passes an "exact key set" test with none of them present.
  // Today every field is separately validated afterwards, so each such forgery happens to die
  // one check later on an `undefined` — but that is the downstream validators covering for
  // this one, not this one working, and it holds only for as long as every field of every
  // document is individually read. `assertExactKeys` is supposed to be the check that makes
  // that unnecessary.
  const actual = Object.keys(value);
  const wanted = new Set(expected);
  const missing = [...wanted].filter((key) => !Object.hasOwn(value, key));
  const extra = actual.filter((key) => !wanted.has(key));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `${what} keys are ${JSON.stringify(actual.slice().sort())}, expected exactly ` +
        `${JSON.stringify([...wanted].sort())}`,
    );
  }
}

function requireString(
  value: unknown,
  field: string,
  fail: (detail: string, cause?: unknown) => never,
): string {
  if (typeof value !== "string" || value === "") fail(`${field} is missing or not a string`);
  return value as string;
}

/**
 * The complete key set of every fixed-shape document this protocol writes.
 *
 * `payload`, `fieldCoverage` and `sourceTimestamps` are deliberately NOT here as shapes: the
 * first is opaque caller data and the other two are maps whose keys are field and source names.
 * Everything else is a closed record.
 */
const MANIFEST_KEYS = [
  "activeGenerationId",
  "retainedGenerationIds",
  "publishedAt",
  "sourceVersion",
] as const;
const GENERATION_KEYS = [
  "generationId",
  "publishedAt",
  "sourceVersion",
  "provenance",
  "payload",
] as const;
const PROVENANCE_KEYS = [
  "coverage",
  "fieldCoverage",
  "sourceTimestamps",
  "refreshTier",
  "ccusageVersion",
  "ccusageInvokedAt",
  "timezone",
  "dayBoundaryPolicy",
] as const;
const INTERVAL_KEYS = ["start", "end"] as const;
const PIN_KEYS = ["pinId", "generationId", "until"] as const;

export function assertManifestInvariants(manifest: unknown, path: string): void {
  const fail = (detail: string, cause?: unknown): never => {
    throw new SnapshotStoreResetError("manifest-invariants", detail, path, cause);
  };
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest body is not an object");
  }
  assertInertDocument(manifest, "manifest body", fail);
  const m = manifest as Record<string, unknown>;
  assertExactKeys(m, "manifest body", MANIFEST_KEYS, fail);
  checkDocumentId("generation", m["activeGenerationId"], fail);
  if (!Array.isArray(m["retainedGenerationIds"])) {
    fail("retainedGenerationIds is not an array");
  }
  for (const id of m["retainedGenerationIds"] as unknown[]) {
    checkDocumentId("generation", id, fail);
  }
  if (!(m["retainedGenerationIds"] as string[]).includes(m["activeGenerationId"] as string)) {
    // The active generation must be retained, or the very next GC would delete what the
    // manifest points at.
    fail("activeGenerationId is not among retainedGenerationIds");
  }
  // The SAME instant rule the generation and pin validators apply. A bare `typeof` check was
  // the odd one out, and the gap it left is not cosmetic: `publishedAt` is a document field
  // this protocol writes in one exact shape, so a checksum-valid manifest carrying `"whenever"`
  // — or `"2026-01-01T00:00:00"`, which the spec reads as LOCAL time and therefore means a
  // different instant on every machine — classified as USABLE. "Any invalid or ambiguous state
  // resets" cannot be true while one field of the root document accepts arbitrary text.
  const publishedAt = requireString(m["publishedAt"], "publishedAt", fail);
  if (!isExplicitInstant(publishedAt)) {
    fail("publishedAt is not an instant with an explicit UTC offset");
  }
  try {
    canonicalSourceVersion(m["sourceVersion"]);
  } catch (err) {
    fail("sourceVersion is unusable", err);
  }
}

/**
 * Validates one generation DOCUMENT, and binds it to the id it was fetched under.
 *
 * The binding is the load-bearing half. Everything else here is ordinary shape checking, but
 * `generationId === expectedId` is what makes a generation file non-substitutable: without
 * it, any checksum-valid generation copied over another's filename is served as that other
 * generation, and the manifest's reference means whatever the filesystem happens to hold.
 */
export function assertGenerationInvariants(
  doc: unknown,
  path: string,
  expectedId: string,
): void {
  const fail = (detail: string, cause?: unknown): never => {
    throw new SnapshotStoreResetError("generation-invariants", detail, path, cause);
  };
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    fail("generation body is not an object");
  }
  assertInertDocument(doc, "generation body", fail);
  const g = doc as Record<string, unknown>;
  assertExactKeys(g, "generation body", GENERATION_KEYS, fail);
  const id = checkDocumentId("generation", g["generationId"], fail);
  if (id !== expectedId) {
    fail(
      `generation body declares id ${JSON.stringify(id)} but was read as ` +
        `${JSON.stringify(expectedId)}`,
    );
  }
  const publishedAt = requireString(g["publishedAt"], "publishedAt", fail);
  if (!isExplicitInstant(publishedAt)) {
    fail("publishedAt is not an instant with an explicit UTC offset");
  }
  try {
    canonicalSourceVersion(g["sourceVersion"]);
  } catch (err) {
    fail("sourceVersion is unusable", err);
  }
  assertProvenanceShape(g["provenance"], fail);
  // The payload only has to EXIST here: whether it survives canonicalization was already
  // settled by `assertInertDocument` above, which walked the whole document — payload
  // included — before any of these reads happened. A second, payload-only pass would report
  // the same class of failure later and with less context.
  if (!Object.hasOwn(g, "payload")) fail("payload is missing");
}

/** AC 6's provenance record, checked field by field — it is what freshness is derived from. */
function assertProvenanceShape(value: unknown, fail: (detail: string, cause?: unknown) => never): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("provenance is not an object");
  }
  const p = value as Record<string, unknown>;
  assertExactKeys(p, "provenance", PROVENANCE_KEYS, fail);
  if (!Array.isArray(p["coverage"])) fail("provenance.coverage is not an array");
  for (const interval of p["coverage"] as unknown[]) {
    assertIntervalShape(interval, "provenance.coverage", fail);
  }
  assertIntervalMap(p["fieldCoverage"], "provenance.fieldCoverage", fail);
  const timestamps = p["sourceTimestamps"];
  if (timestamps === null || typeof timestamps !== "object" || Array.isArray(timestamps)) {
    fail("provenance.sourceTimestamps is not an object");
  }
  for (const [source, at] of Object.entries(timestamps as Record<string, unknown>)) {
    if (typeof at !== "string") fail(`provenance.sourceTimestamps.${source} is not a string`);
    if (!isExplicitInstant(at)) {
      fail(`provenance.sourceTimestamps.${source} is not an instant with an explicit UTC offset`);
    }
  }
  for (const field of [
    "refreshTier",
    "ccusageVersion",
    "ccusageInvokedAt",
    "timezone",
    "dayBoundaryPolicy",
  ]) {
    requireString(p[field], `provenance.${field}`, fail);
  }
  if (!isExplicitInstant(p["ccusageInvokedAt"] as string)) {
    fail("provenance.ccusageInvokedAt is not an instant with an explicit UTC offset");
  }
  // The timezone is an IANA zone the reader will hand to `Intl`. An unknown one throws a
  // RangeError out of freshness at query time — long after the generation was accepted, and
  // in a caller that has no idea why. Checked once, here, where it can still be refused.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: p["timezone"] as string });
  } catch (err) {
    // The platform's own failure travels as an opaque cause, exactly as `freshness.ts`'s
    // `assertTimeZone` now does. Round 8 applied that rule to nine catch sites and missed this
    // one, so the SAME check on the two sides of the write/read boundary kept the explanation
    // on one side and dropped it on the other.
    fail(`provenance.timezone is not a known IANA timezone: ${String(p["timezone"])}`, err);
  }
}

/**
 * One coverage interval, checked for what freshness will actually DO with it.
 *
 * Two strings is not enough: `deriveFreshness` parses both as instants and orders the set, so
 * an unparseable bound produces a NaN comparison that silently reports everything covered, and
 * an inverted interval claims a span the generation never had. Refusing them here means a
 * generation cannot be published — or served — in a shape whose freshness answer is nonsense.
 */
function assertIntervalShape(
  value: unknown,
  where: string,
  fail: (detail: string, cause?: unknown) => never,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} holds a non-object interval`);
  }
  const i = value as Record<string, unknown>;
  assertExactKeys(i, `${where} interval`, INTERVAL_KEYS, fail);
  const start = requireString(i["start"], `${where}.start`, fail);
  const end = requireString(i["end"], `${where}.end`, fail);
  // The SAME rule the reader applies. A coverage interval is read back by `deriveFreshness`,
  // and `Date.parse` alone accepts `2026-01-01T00:00:00` — which the spec defines as LOCAL
  // time, so the interval would mean different instants on different machines. Refusing it
  // here means refusing it at publish; accepting it here only moves the failure to query time,
  // in a caller with no idea why, about a document accepted days earlier.
  if (!isExplicitInstant(start)) {
    fail(`${where}.start is not an instant with an explicit UTC offset`);
  }
  if (!isExplicitInstant(end)) {
    fail(`${where}.end is not an instant with an explicit UTC offset`);
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  // `<=`, not `<`. A zero-length interval is not the harmless no-op it looks like: `gapsFor`
  // walks its cursor to `interval.end`, so `[t, t)` sitting inside an uncovered stretch splits
  // the single gap that stretch really is into two adjacent ones, `[cursor, t)` and `[t, end)`.
  // The union is right and the ANSWER is wrong — a caller counting gaps, or showing them, sees
  // two holes where there is one. The reader refuses it for that reason, and this is the side
  // that must agree: accepting it here only moves the failure to query time, on a generation
  // published days earlier, which is the exact defect the paragraph above exists to prevent.
  if (endMs <= startMs) fail(`${where} ends at or before it starts`);
}

function assertIntervalMap(
  value: unknown,
  where: string,
  fail: (detail: string, cause?: unknown) => never,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} is not an object`);
  }
  for (const [key, intervals] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(intervals)) fail(`${where}.${key} is not an array`);
    for (const interval of intervals as unknown[]) {
      assertIntervalShape(interval, `${where}.${key}`, fail);
    }
  }
}

/**
 * Validates one pin DOCUMENT, bound to its filename id.
 *
 * A pin that fails here is not a reset trigger — it is data GC owns and removes, which is the
 * disposition split the classifier already applies. What it must NOT be is trusted: an
 * unvalidated `until` of `{}` compares as unexpired against every timestamp forever, so a
 * malformed pin was pinning a generation for the life of the store.
 */
export function assertPinInvariants(doc: unknown, path: string, expectedId: string): void {
  const fail = (detail: string, cause?: unknown): never => {
    throw new SnapshotStoreResetError("pin-invariants", detail, path, cause);
  };
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    fail("pin body is not an object");
  }
  assertInertDocument(doc, "pin body", fail);
  const p = doc as Record<string, unknown>;
  assertExactKeys(p, "pin body", PIN_KEYS, fail);
  const pinId = checkDocumentId("pin", p["pinId"], fail);
  if (pinId !== expectedId) {
    fail(`pin body declares id ${JSON.stringify(pinId)} but was read as ${JSON.stringify(expectedId)}`);
  }
  checkDocumentId("generation", p["generationId"], fail);
  const until = requireString(p["until"], "until", fail);
  // `until` is COMPARED against a clock by GC, so an ambiguous one expires at a different
  // moment on every machine that reads it.
  if (!isExplicitInstant(until)) {
    fail("until is not an instant with an explicit UTC offset");
  }
}

// ---------------------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------------------

export interface ResetResult {
  removed: string[];
  /** Paths this reset could not remove. The next start retries; nothing is chased here. */
  failed: string[];
  /** Set when the reset stopped because authority was lost. */
  stoppedOnAuthorityLoss: boolean;
  /**
   * Set when the reset stopped because the manifest could not be removed — the one failure
   * that is a hard stop rather than absorbed residue. See `resetStore`.
   */
  stoppedAtManifest: boolean;
}

/**
 * Resets the store to empty.
 *
 * The manifest unlink goes FIRST because the manifest is the only artifact that makes the
 * store observable: from that instant a reader starting fresh sees "no snapshot yet". (A
 * reader already mid-read is handled on the reader's side — see `readSnapshot`'s identity
 * re-check, which is what makes the transition atomic for readers already in flight.)
 *
 * Every individual mutation is gated and the traversal is explicit, never one recursive
 * seam call: a recursive removal behind a single assertion would let a writer that lost the
 * lock mid-sweep keep deleting a successor's freshly published generations.
 */
export function resetStore(
  fs: SnapshotFs,
  authority: LatchingWriteAuthority,
  paths: StorePaths,
): ResetResult {
  // The compiler already refuses a bare `{ assertHeld() {} }` here — `LatchingWriteAuthority`
  // is nominal — but this module ships as JS to callers TypeScript never checked, and the
  // guarantee it protects (AC 8's latch, the terminal-action contract, no resurrection after
  // a loss) is not one to leave resting on a type alone.
  assertGuardedAuthority(authority);
  const removed: string[] = [];
  const failed: string[] = [];

  // Authority loss is tracked by a FLAG set at the gate rather than inferred from whatever
  // reaches the outer catch. The old inference — "anything thrown here must be the
  // assertion" — was simply untrue: a listing or an lstat can fail with EACCES or ENOTDIR,
  // and reporting that as a lost lock sends the service into its kill switch for an ordinary
  // I/O error.
  let authorityLost = false;
  const gate = (): void => {
    try {
      authority.assertHeld();
    } catch (err) {
      authorityLost = true;
      throw err;
    }
  };

  const tryMutate = (path: string, mutate: () => void): boolean => {
    // assertHeld immediately before the mutation, no await between: if it throws, we stop
    // entirely rather than continuing into the successor's store.
    gate();
    try {
      mutate();
      removed.push(path);
      return true;
    } catch (err) {
      if (isNotFound(err)) return true;
      failed.push(path);
      return true;
    }
  };

  try {
    // The root is proven BEFORE anything beneath it is touched. Every path this function
    // mutates is `${paths.root}/...`, so a symlinked root redirects all of them at once: the
    // manifest unlink, the traversal, and the skeleton rebuild would each land in whatever
    // directory the link names. Removing the link itself is both the containment fix and the
    // convergence fix — classification refuses a non-directory root forever otherwise.
    const rootStat = lstatOrNull(fs, paths.root);
    if (rootStat === null) {
      // Nothing to remove. Every path this function deletes is `${paths.root}/...`, so an
      // absent root already IS the empty store and the rebuild is the whole reset. Falling
      // through instead would run the manifest unlink and three directory sweeps against
      // names whose prefix does not exist — each one a fresh resolution through a component
      // that something else is free to create in the meantime, and create as a symlink.
      rebuildSkeleton(fs, gate, paths, "replace");
      return { removed, failed, stoppedOnAuthorityLoss: false, stoppedAtManifest: false };
    }
    if (rootStat.isSymbolicLink || !rootStat.isDirectory) {
      // The root itself is the entry being removed, so `unlink` does not follow it and there
      // is no owned prefix to prove: its parent is the caller's `stateDir`, which this module
      // never created and cannot vouch for. What CAN be re-proven is that the name is still
      // not a directory, so a root that became the real store between the lstat and here is
      // not unlinked on the strength of a stale observation.
      //
      // The re-proof happens BEFORE the gate, not inside it. `tryMutate` asserts authority and
      // then runs its callback, so a seam call in that callback sits BETWEEN the assertion and
      // the mutation — which is precisely the gap AC 8 forbids, reintroduced by the check that
      // was meant to make this branch safer. Everything after `gate()` here is now the unlink
      // and nothing else.
      const rootNow = lstatOrNull(fs, paths.root);
      if (rootNow === null) {
        // Already gone. `tryMutate` would have swallowed the same ENOENT.
      } else if (rootNow.isDirectory && !rootNow.isSymbolicLink) {
        // It became the real store between the classification and here, so the observation
        // this branch was entered on is stale and the unlink must not proceed on it.
        //
        // And NOTHING ELSE proceeds on it either, which is why this returns rather than falling
        // through. `rebuildSkeleton` would `ensureDir` the root — reopening and `fchmod`ing it —
        // and then create three directories inside it: acting on the very directory just refused
        // because this function could not account for it, and returning a result that reads as a
        // completed reset while `failed` names the root it never reset. Refusing to delete
        // something and then writing into it is not a safer disposition than either one alone.
        //
        // Left for the next classification, which observes the directory FROM A FRESH LSTAT
        // rather than through the observation this branch was entered on. That converges: a
        // root that is genuinely the store classifies normally, and one that is not is reset
        // from that fresh observation.
        //
        // Not "exactly as it now is", which is what this said and what round 9 correctly
        // disproved: `startWriter` runs `rebuildSkeleton` before it classifies, and `ensureDir`
        // repairs a wrong-mode directory — deliberately, see the argument there — so the next
        // pass may observe a root whose MODE has been normalised to 0700 first. Everything else
        // about it, including every artifact inside it, is observed as it stands. The claim was
        // too strong; the convergence it was making is not.
        failed.push(paths.root);
        return { removed, failed, stoppedOnAuthorityLoss: false, stoppedAtManifest: false };
      } else {
        tryMutate(paths.root, () => fs.unlink(paths.root));
      }
      rebuildSkeleton(fs, gate, paths, "replace");
      return { removed, failed, stoppedOnAuthorityLoss: false, stoppedAtManifest: false };
    }

    // The root's IDENTITY, captured once and re-proven immediately before EVERY mutation
    // whose path resolves THROUGH it.
    //
    // Proving the root once at the top and then trusting it for the rest of the function was
    // the same defect this file already fixed one level down, left standing at the level
    // above. A reset is dozens of seam calls, and `paths.manifest` is not a file — it is a
    // name re-resolved from `paths.root` on every syscall that mentions it. Swap the root for
    // a symlink anywhere in that stretch and the manifest unlink, and the unlink of a
    // known directory that had gone bad, both land outside the store: the reset becomes a
    // deletion primitive aimed by whoever performed the swap. The per-child loops below
    // already re-prove their prefix before each child; these two mutations did not.
    //
    // What this is NOT: a capability. `gate()` still sits between the last check and the
    // syscall, and the gate calls into a caller-supplied authority that may run arbitrary
    // code — so the residual window is real and includes an adversary's best opportunity.
    // Closing it needs `unlinkat` relative to a held directory descriptor, which Node does
    // not expose. The window shrinks from "the whole reset" to "one call"; it does not close.
    const rootGuard: readonly DirGuard[] = [
      { path: paths.root, dev: rootStat.dev, ino: rootStat.ino },
    ];
    /** A gated mutation of a path beneath the root, refused outright if the root moved. */
    const tryMutateBeneathRoot = (path: string, mutate: () => void): void => {
      if (!guardsIntact(fs, rootGuard)) {
        failed.push(path);
        return;
      }
      tryMutate(path, mutate);
    };

    // The manifest unlink is the ATOMIC VISIBILITY BOUNDARY, and it is the one failure here
    // that is not absorbed. Until it is gone the manifest is still live and still names its
    // generations, so continuing past a failed unlink would delete the files a served
    // manifest points at — manufacturing exactly the structurally corrupt store (a live
    // manifest referencing missing generations) that the whole commit order exists to make
    // unreachable. Ordinary residue may be left behind for the next start; this may not.
    //
    // A DIRECTORY at that name is removed as a tree rather than unlinked. `unlink` gives
    // EISDIR, which took the hard-stop branch and wedged the store PERMANENTLY: classification
    // refuses the directory, the reset cannot remove it, and every subsequent start repeats
    // both — the same non-convergence a nested directory under `staging/` produced. It is also
    // safe to remove, and for a reason worth stating rather than assuming: the hard stop
    // protects a LIVE manifest, and a directory is not one. Neither the reader nor
    // classification can decode it, so nothing is being served from it and no reader depends
    // on it surviving.
    const manifestStat = lstatOrNull(fs, paths.manifest);
    if (manifestStat !== null && manifestStat.isDirectory && !manifestStat.isSymbolicLink) {
      const before = failed.length;
      removeTreeGated(fs, paths.manifest, tryMutate, manifestStat, rootGuard);
      if (failed.length !== before || lstatOrNull(fs, paths.manifest) !== null) {
        return { removed, failed, stoppedOnAuthorityLoss: authorityLost, stoppedAtManifest: true };
      }
    } else {
      if (!guardsIntact(fs, rootGuard)) {
        // The root moved between the observation that chose this branch and the unlink, so
        // `paths.manifest` no longer names the file that was observed. Left for the next
        // start, and reported as a hard stop for the same reason a failed unlink is: nothing
        // below may run while a manifest that might still be live is still there.
        failed.push(paths.manifest);
        return { removed, failed, stoppedOnAuthorityLoss: false, stoppedAtManifest: true };
      }
      gate();
      try {
        fs.unlink(paths.manifest);
        removed.push(paths.manifest);
      } catch (err) {
        if (!isNotFound(err)) {
          failed.push(paths.manifest);
          return { removed, failed, stoppedOnAuthorityLoss: false, stoppedAtManifest: true };
        }
      }
    }

    for (const dir of [paths.generationsDir, paths.pinsDir, paths.stagingDir]) {
      // lstat BEFORE listing. `listDir` FOLLOWS a symlink, so a symlinked `generations/`
      // turned this loop into a recursive delete of whatever it pointed at — a reset used as
      // an arbitrary deletion primitive, on a state classification already calls not-usable.
      // `removeTreeGated`'s non-following check guards the entry it is given, not the prefix
      // it is reached through, so the prefix has to be proven here.
      const stat = lstatOrNull(fs, dir);
      if (stat === null) continue;
      if (stat.isSymbolicLink || !stat.isDirectory) {
        // Unlink the ENTRY, never descend: this removes the link, not its target. Beneath the
        // root, so the root is re-proven first — `${root}/generations` resolves through it on
        // this syscall, not on the lstat that decided the branch.
        tryMutateBeneathRoot(dir, () => fs.unlink(dir));
        continue;
      }
      // The prefix's IDENTITY is kept and re-checked before every child.
      //
      // Proving it once here and then descending was the same defect `removeTreeGated` was
      // fixed for, one level up — and fixing the callee alone made it WORSE than it looked,
      // because the callee's careful per-child identity checks all establish identities
      // BENEATH a prefix that may already have been swapped. Each child is addressed as
      // `dir/entry`, a fresh resolution through this directory, so the directory has to still
      // be this directory each time.
      const identity = `${stat.dev}:${stat.ino}`;
      const stillOurs = (): boolean => {
        const now = lstatOrNull(fs, dir);
        return (
          now !== null &&
          !now.isSymbolicLink &&
          now.isDirectory &&
          `${now.dev}:${now.ino}` === identity
        );
      };
      for (const entry of listOrEmpty(fs, dir)) {
        if (!stillOurs()) {
          // Left for the next start rather than deleted through a prefix we cannot vouch for.
          failed.push(dir);
          break;
        }
        // A foreign entry inside a known directory can be a nested directory, and an
        // `unlink` that fails on it would leave the store un-resettable — classified
        // not-usable forever, reset after reset.
        removeTreeGated(fs, `${dir}/${entry}`, tryMutate, null, [
          { path: dir, dev: stat.dev, ino: stat.ino },
        ]);
      }
    }

    // Unknown entries are why the store was reset in the first place, so a reset that left
    // them would never converge: the next classification would see the same stray entry and
    // reset again, forever. They are removed by an explicit, depth-first, non-following
    // traversal — one gated mutation per path, never a recursive seam call.
    for (const entry of listOrEmpty(fs, paths.root)) {
      if ((ROOT_ENTRIES as readonly string[]).includes(entry)) continue;
      // Same rule as the known directories: every child is resolved through this prefix, so
      // the prefix is re-proven before each one — here and again inside the traversal.
      if (!guardsIntact(fs, rootGuard)) {
        failed.push(paths.root);
        break;
      }
      removeTreeGated(fs, `${paths.root}/${entry}`, tryMutate, null, rootGuard);
    }

    rebuildSkeleton(fs, gate, paths, "replace");
  } catch (err) {
    if (authorityLost) {
      return { removed, failed, stoppedOnAuthorityLoss: true, stoppedAtManifest: false };
    }
    // Not the assertion — an ordinary I/O failure from a listing or an lstat. It propagates
    // as itself rather than being relabelled as a lock loss.
    throw err;
  }

  return { removed, failed, stoppedOnAuthorityLoss: false, stoppedAtManifest: false };
}

/**
 * Removes one unknown entry, depth-first, one gated mutation at a time.
 *
 * `lstat` decides before descending, so a symlinked directory is unlinked as the link it is
 * and never followed out of the store — a reset must not be a way to delete arbitrary paths
 * somebody pointed at us.
 */
/**
 * One directory this traversal has already proven, kept so it can be re-proven.
 *
 * The list is what makes the recursion safe, and it exists because the obvious design is
 * wrong in a way that reads as correct: a frame that re-checks only ITS OWN directory is
 * checking an identity it captured AFTER any ancestor swap that already happened. The child's
 * first act is `lstat(parent/child)`, which resolves through the parent — so if the parent was
 * replaced between the parent frame's check and that lstat, the child captures the SUBSTITUTE's
 * child, finds it perfectly self-consistent on every subsequent check, and deletes a subtree
 * that was never ours. Every frame therefore re-proves the whole chain above it, not just
 * itself.
 */
interface DirGuard {
  path: string;
  dev: bigint;
  ino: bigint;
}

function guardsIntact(fs: SnapshotFs, guards: readonly DirGuard[]): boolean {
  for (const guard of guards) {
    const now = lstatOrNull(fs, guard.path);
    if (
      now === null ||
      now.isSymbolicLink ||
      !now.isDirectory ||
      now.dev !== guard.dev ||
      now.ino !== guard.ino
    ) {
      return false;
    }
  }
  return true;
}

function removeTreeGated(
  fs: SnapshotFs,
  path: string,
  tryMutate: (path: string, mutate: () => void) => boolean,
  expect: SnapshotStat | null = null,
  ancestors: readonly DirGuard[] = [],
): void {
  // The chain ABOVE this entry, before the entry is even looked at. Without this the `lstat`
  // on the next line is itself a resolution through a prefix nobody has vouched for since the
  // caller's own check, which is the window this whole structure exists to close.
  if (ancestors.length > 0 && !guardsIntact(fs, ancestors)) {
    tryMutate(path, () => {
      throw new SnapshotPathError(`${path} was reached through a prefix that changed`);
    });
    return;
  }
  let stat;
  try {
    stat = fs.lstat(path);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }

  // The caller may have DECIDED something about this path on an earlier lstat — the manifest
  // branch does exactly that, choosing tree-removal because it saw a directory. Between that
  // decision and this call the name can become something else entirely, and the something else
  // that matters is a live regular manifest: without this check the traversal would take its
  // file branch and unlink the very artifact the hard stop exists to protect, after which the
  // reset would go on to delete the generations it referenced. Binding the removal to the
  // identity the decision was made on is what makes the two calls one decision.
  if (
    expect !== null &&
    (stat.isSymbolicLink ||
      !stat.isDirectory ||
      stat.dev !== expect.dev ||
      stat.ino !== expect.ino)
  ) {
    tryMutate(path, () => {
      throw new SnapshotPathError(`${path} changed identity before it could be removed`);
    });
    return;
  }

  if (stat.isDirectory && !stat.isSymbolicLink) {
    // This frame's own guard, appended to everything above it. Every check below asks about
    // the WHOLE chain: a frame that vouches only for itself is vouching for an identity it
    // captured after any ancestor swap that had already happened.
    const chain: DirGuard[] = [...ancestors, { path, dev: stat.dev, ino: stat.ino }];
    /** Is every directory from the traversal root down to `path` still the one we approved? */
    const unchanged = (): boolean => guardsIntact(fs, chain);

    const children = listOrEmpty(fs, path);
    // `lstat` proved this was a real directory; `listDir` FOLLOWS whatever the name refers to
    // NOW. Between the two, the directory can be replaced by a symlink, and the children we
    // are about to descend into would be the link target's. Comparing identity across the pair
    // detects that: the names came from the same file the lstat approved, or they did not and
    // this subtree is left alone for the next start.
    //
    // And the SAME hole reopens on every iteration below, which is why the check is inside the
    // loop and not only here. Each child is addressed as `path/child` — a fresh path
    // resolution through this prefix — so a swap landing after child 3 sends children 4..n to
    // the substitute directory. Checking once before the loop would prove the prefix for the
    // first child and vouch, wrongly, for the rest.
    //
    // ANCESTORS are covered too, and by this same check rather than by a separate chain — a
    // point worth making explicitly, because the code does not look like it makes it. `unchanged`
    // re-resolves the FULL pathname `path` from the root on every call, so a swap anywhere above
    // this frame changes what `path` resolves to, and the identity comparison fails. For an
    // ancestor swap to go undetected the substitute would have to expose an entry at this exact
    // path with this exact `(dev, ino)` — which is to say, the same directory, in which case
    // nothing has moved. Directories cannot be hard-linked, so there is no way to manufacture
    // that pair.
    //
    // Stated exactly, because a comment that overclaims here is worse than none: this does NOT
    // make the traversal atomic. It reduces the exposure of each child operation from "the
    // whole traversal" to "one lstat plus one syscall", and the residual is irreducible in
    // Node, which exposes no `unlinkat`/`rmdir` against a held directory descriptor.
    if (!unchanged()) {
      tryMutate(path, () => {
        throw new SnapshotPathError(`${path} was replaced while it was being traversed`);
      });
      return;
    }
    for (const child of children) {
      if (!unchanged()) {
        tryMutate(path, () => {
          throw new SnapshotPathError(`${path} was replaced while it was being traversed`);
        });
        return;
      }
      removeTreeGated(fs, `${path}/${child}`, tryMutate, null, chain);
    }
    if (!unchanged()) {
      tryMutate(path, () => {
        throw new SnapshotPathError(`${path} was replaced while it was being traversed`);
      });
      return;
    }
    tryMutate(path, () => fs.rmdir(path));
    return;
  }
  // A LEAF is a mutation too, and it is reached through the same prefix. Checking the chain
  // only on the directory branch left every actual deletion — which is what a leaf is —
  // unguarded against a swap landing between the caller's check and this unlink.
  if (ancestors.length > 0 && !guardsIntact(fs, ancestors)) {
    tryMutate(path, () => {
      throw new SnapshotPathError(`${path} was reached through a prefix that changed`);
    });
    return;
  }
  tryMutate(path, () => fs.unlink(path));
}

/**
 * What `ensureDir` does about an entry of the WRONG TYPE — a symlink, or anything that is not
 * a directory — occupying a container's name.
 *
 * `replace` is for the rebuild that ENDS a reset: the store has already been judged unusable
 * and emptied, so removing the entry and creating a real directory in its place is the step
 * that converges. `leave` is for the ensure that runs BEFORE classification, where that same
 * removal destroys the evidence classification exists to read.
 *
 * REQUIRED at every call site, with no default. A default is a policy that applies itself, and
 * this one is the difference between "the store was reset, here is why" and "the store never
 * existed" — a caller that has not thought about which side of the reset it is on is exactly
 * the caller that must not inherit an answer.
 */
type WrongTypePolicy = "replace" | "leave";

/**
 * Makes `dir` a real directory this store owns, at exactly 0700. Returns false only when a
 * wrong-type entry was found and `wrongType` said to leave it — in which case nothing was
 * touched and `dir` is still whatever it was.
 *
 * The three cases are distinct on purpose. Absent: create. A real directory with the wrong
 * mode: chmod. A symlink or a non-directory: never chmod — `chmod` follows symlinks, so
 * "repairing the mode" of a symlinked `generations/` silently set the mode of whatever it
 * pointed at, outside the store.
 *
 * That third case is the one with a POLICY, and the policy is round 10's finding. Replacing it
 * unconditionally read as containment, and inside a reset it is: the store has been judged, and
 * the unlink is what stops the next classification refusing the same link forever. But
 * `startWriter` ensures the skeleton BEFORE it classifies, and there the same unlink silently
 * deleted a foreign symlink or file at `generations/` — the exact state whose disposition the
 * one rule spells out — and then handed classification a freshly-created empty directory that
 * looks like a first run. The store was destroyed and reported as never having existed, with no
 * reset reason, no diagnostic, and nothing in `resetError` for an operator to read. `leave`
 * hands the entry to classification untouched; classification refuses it (`unknown-entry`, for
 * the root at its own check and for the three known directories in `checkArtifactDir`), and the
 * reset that follows removes it and rebuilds with `replace`. Same end state, one pass later,
 * with the reason recorded.
 *
 * The MODE repair is unaffected in both policies, deliberately — see the argument at its site.
 */
function ensureDir(
  fs: SnapshotFs,
  gate: () => void,
  dir: string,
  ancestors: readonly DirGuard[],
  wrongType: WrongTypePolicy,
): boolean {
  // The prefix, before every mutation below rather than once for the function. `mkdir`,
  // `unlink` and `openDir` each resolve `dir` from its parent again, and the calls between
  // them — including `gate()` — are opportunities to replace that parent. Without this, the
  // skeleton rebuild that ENDS a reset would create `generations/` inside whatever directory
  // the root had been swapped for, and set 0700 on it there.
  const guarded = (mutate: () => void): void => {
    if (!guardsIntact(fs, ancestors)) {
      throw new SnapshotPathError(`${dir} is reached through a prefix that changed`);
    }
    gate();
    mutate();
  };
  const stat = lstatOrNull(fs, dir);

  if (stat !== null && (stat.isSymbolicLink || !stat.isDirectory)) {
    // Reported, not repaired, when the caller has not yet judged the store. Returning BEFORE
    // the gate is deliberate: nothing is mutated on this path, so there is no mutation for an
    // assertion to precede, and asserting anyway would make an inspection look like a write.
    if (wrongType === "leave") return false;
    guarded(() => fs.unlink(dir));
  }

  if (stat === null || stat.isSymbolicLink || !stat.isDirectory) {
    // One level at a time, with the mode requested at creation AND set on the descriptor
    // after: the mode argument closes the permissive window (umask 022 would otherwise leave
    // 0755 visible until the repair), and the repair closes the restrictive one (umask 0200
    // would otherwise produce a directory the writer cannot use and cannot fix).
    guarded(() => fs.mkdir(dir, DIR_MODE));
    setDirMode(fs, gate, dir, ancestors);
    return true;
  }

  // REPAIRED, not reset, and that is a decision rather than an omission.
  //
  // Round 9 raised this as a hole in the derived-cache rule: the repair runs BEFORE
  // classification, so a `mode-violation` — a reason the rule resets on — is erased before
  // anything can act on it. The narrowing that finding implies was written and then reverted,
  // because the rule it would have overturned is deliberate and already carries its own
  // argument: the line between reset and repair is whether the fix is DETERMINISTIC. A
  // directory mode is — `chmod 0700` and it is exactly what this protocol writes — and the
  // artifacts inside are still classified on their own terms afterwards, so a genuinely foreign
  // directory is still caught by its CONTENTS. Resetting here would discard a healthy store to
  // fix a permission bit. Two tests state that decision explicitly and would have had to be
  // rewritten to accept the change, which is what makes it a disagreement about design and not
  // a defect.
  //
  // What the finding IS right about is recorded at its own site: `resetStore`'s early return
  // for a stale replacement root claimed the next classification would observe that directory
  // as it stands, and this repair means it observes a chmodded one. That claim is now corrected
  // rather than the behaviour.
  if ((stat.mode & MODE_MASK) !== DIR_MODE) {
    setDirMode(fs, gate, dir, ancestors);
  }
  return true;
}

/**
 * Recreates the empty skeleton: the root, then the three known directories inside it. Returns
 * the first container it declined to touch under a `leave` policy, or null when the skeleton
 * is complete.
 *
 * The root's identity is captured AFTER it is ensured — `ensureDir` may have just created it —
 * and every child is created under that captured identity, so a root swapped between the two
 * steps stops the rebuild instead of redirecting it. The root itself gets no guard because it
 * has no owned prefix: its parent is the caller's `stateDir`.
 *
 * A LEFT ROOT returns immediately, before the lstat below. Falling through would hit the
 * "replaced while the skeleton was being rebuilt" throw — reporting a race that did not happen,
 * for a wrong-type root this function was told not to touch and deliberately did not — and
 * would abort the very startup whose next step is the classification that knows what to do
 * about it. The three children are not created inside something that is not a directory either.
 */
function rebuildSkeleton(
  fs: SnapshotFs,
  gate: () => void,
  paths: StorePaths,
  wrongType: WrongTypePolicy,
): string | null {
  if (!ensureDir(fs, gate, paths.root, [], wrongType)) return paths.root;
  const stat = lstatOrNull(fs, paths.root);
  if (stat === null || stat.isSymbolicLink || !stat.isDirectory) {
    throw new SnapshotPathError(
      `${paths.root} was replaced while the store skeleton was being rebuilt`,
    );
  }
  const guard: readonly DirGuard[] = [
    { path: paths.root, dev: stat.dev, ino: stat.ino },
  ];
  // The loop does not stop at the first one left: these are three independent names under a
  // root that has been proven, and a symlinked `pins/` is no reason to leave `staging/` absent.
  // Only the FIRST is reported, because the return value answers "is the skeleton complete",
  // and the complete list of what is wrong is classification's job, not this function's.
  let left: string | null = null;
  for (const dir of [paths.generationsDir, paths.pinsDir, paths.stagingDir]) {
    if (!ensureDir(fs, gate, dir, guard, wrongType) && left === null) left = dir;
  }
  return left;
}

/**
 * Applies DIR_MODE to `dir` through a descriptor.
 *
 * `chmod(2)` takes a pathname and FOLLOWS symlinks, so the pathname form of this repair was a
 * check-then-act on a name: `lstat` said "a real directory with the wrong mode", and the chmod
 * that followed applied to whatever the name meant by then. The interval was not theoretical
 * either — `gate()` sits inside it, and the gate is a call into a caller-supplied authority,
 * so an adversary with a lock-loss handler had a guaranteed opportunity to swap the name and
 * redirect the mode change onto a target outside the store. This is the same mistake the
 * symlink branch above already avoids, left standing in the branch next door.
 *
 * `openDir` is O_NOFOLLOW | O_DIRECTORY, so the kernel refuses a symlink and refuses a
 * non-directory, and `fchmod` acts on the inode that descriptor is bound to. There is no name
 * left to swap.
 */
function setDirMode(
  fs: SnapshotFs,
  gate: () => void,
  dir: string,
  ancestors: readonly DirGuard[] = [],
): void {
  // `openDir` is the one prefix-sensitive step left here — it resolves `dir` from its parent,
  // and everything after it is bound to the descriptor. Proving the prefix before the open is
  // therefore the whole of what this guard can do, and it is enough: a root swapped after the
  // open cannot change which inode `fchmod` lands on.
  if (!guardsIntact(fs, ancestors)) {
    throw new SnapshotPathError(`${dir} is reached through a prefix that changed`);
  }
  const handle = fs.openDir(dir);
  try {
    gate();
    fs.fchmod(handle, DIR_MODE);
    const after = fs.fstat(handle);
    if ((after.mode & MODE_MASK) !== DIR_MODE) {
      throw new SnapshotModeError(dir, after.mode & MODE_MASK, DIR_MODE);
    }
  } finally {
    try {
      fs.close(handle);
    } catch {
      // Releasing a read descriptor publishes nothing and removes nothing.
    }
  }
}

// ---------------------------------------------------------------------------------------
// Writer startup
// ---------------------------------------------------------------------------------------

export interface StartWriterResult {
  status: StoreStatus;
  /** The reset diagnostic, when one was raised. Logged; never branched on. */
  resetError?: SnapshotStoreResetError;
  reset?: ResetResult;
  sweptStaging: string[];
  unreferencedGenerations: string[];
}

/**
 * Prepares the store for writing: sweep staging residue, classify, reset when required.
 *
 * Authority is asserted BEFORE the sweep, not just before each removal — a process that
 * has already lost the lock must not begin a sweep at all, because the fixed staging names
 * it would remove may by then belong to its successor.
 */
export function startWriter(
  fs: SnapshotFs,
  authority: LatchingWriteAuthority,
  paths: StorePaths,
): StartWriterResult {
  // The compiler already refuses a bare `{ assertHeld() {} }` here — `LatchingWriteAuthority`
  // is nominal — but this module ships as JS to callers TypeScript never checked, and the
  // guarantee it protects (AC 8's latch, the terminal-action contract, no resurrection after
  // a loss) is not one to leave resting on a type alone.
  assertGuardedAuthority(authority);
  authority.assertHeld();

  const gate = (): void => authority.assertHeld();
  // `leave`, because this ensure runs BEFORE the classification that decides what the store is.
  // A symlink or a regular file at `generations/` is not a container to be repaired here — it is
  // the state the derived-cache rule resets on, and unlinking it silently turned a destroyed
  // store into one that looks like a first run. See `WrongTypePolicy`.
  const leftInPlace = rebuildSkeleton(fs, gate, paths, "leave");

  // The sweep clears the three names this protocol writes, and NOTHING else.
  //
  // Unlinking whatever it found was wrong twice over. A nested directory in `staging/` gives
  // EISDIR, which propagated and stopped startup before classification could ever route the
  // store to a reset — the store was wedged by the one state the one rule exists to clear.
  // And a foreign file with an odd name or a wrong mode was silently deleted, when
  // classification's whole disposition for "this protocol did not write it" is to reset.
  // Anything not swept here is left for `classifyStore`, which refuses a non-empty staging
  // directory, and for `resetStore`, which removes it with the gated non-following traversal.
  const swept: string[] = [];
  //
  // SKIPPED ENTIRELY when the skeleton was left incomplete. Classification is about to refuse
  // this store and reset it, and the reset removes `staging/` wholesale, so the sweep buys
  // nothing — and when the wrong-type entry IS `staging/`, or anything above it, the sweep
  // cannot even be attempted safely: `lstat` through a non-directory root gives ENOTDIR, which
  // propagated out of startup before classification could run, and `listDir` FOLLOWS a symlink,
  // so a symlinked `staging/` would have this pass enumerating somebody else's directory for
  // three fixed names to delete.
  if (leftInPlace === null) {
    const stagingNames = new Set<string>(
      (["manifest", "generation", "pin"] as ArtifactKind[]).map((kind) => `${kind}.json`),
    );
    // The sweep is a list-then-unlink, so it carries the same obligation as every other one in
    // this module: `staging/` was just proven by `ensureDir`, and every entry below is addressed
    // THROUGH it, so a swap after that proof redirects the unlinks to an external directory that
    // happens to hold a file with one of these three fixed names. The identity is captured here
    // and re-compared before each inspection and each deletion.
    const stagingStat = lstatOrNull(fs, paths.stagingDir);
    const stagingIdentity =
      stagingStat === null ? null : `${stagingStat.dev}:${stagingStat.ino}`;
    const stagingStillOurs = (): boolean => {
      const now = lstatOrNull(fs, paths.stagingDir);
      return (
        now !== null &&
        !now.isSymbolicLink &&
        now.isDirectory &&
        `${now.dev}:${now.ino}` === stagingIdentity
      );
    };
    for (const entry of listOrEmpty(fs, paths.stagingDir)) {
      if (!stagingNames.has(entry)) continue;
      // Residue left in place is bounded and the next start clears it; a deletion through a
      // prefix we cannot vouch for is not recoverable.
      if (!stagingStillOurs()) break;
      const path = `${paths.stagingDir}/${entry}`;
      const stat = lstatOrNull(fs, path);
      if (stat === null) continue;
      // Right name, right type, and a mode this protocol could have PRODUCED — which is not the
      // same test as the mode it finally writes, and the difference destroyed snapshots.
      //
      // `openExclusive` requests FILE_MODE and the kernel masks it, so between that create and the
      // `fchmod` that repairs it, our own staging file legitimately sits at `FILE_MODE & ~umask`.
      // Under an accepted umask carrying 0o200 that is 0400, not 0600. Requiring equality here
      // therefore refused to sweep OUR OWN crash residue: the sweep skipped it, classification
      // then found staging non-empty and returned not-usable, and startWriter reset the store —
      // discarding a prior, complete, valid snapshot because a publish had been interrupted in a
      // window a few instructions wide. AC 1(d) says a crash mid-publish is recoverable by
      // sweeping and never by resetting; for those umasks this was the opposite.
      //
      // A umask can only CLEAR bits, never set them, so every mode our create can yield is a
      // SUBSET of FILE_MODE — and the adapter refuses any umask that clears OWNER_READ, so every
      // such mode still carries that bit. Both halves are needed. Subset alone also admits 0200
      // and 0000, which no permitted umask can produce from a FILE_MODE request: accepting those
      // would have the sweep silently DELETE a foreign file sitting at one of the three fixed
      // staging names, which is the opposite of what the mode test is for. Together the two
      // conditions accept exactly 0600 and 0400 — the only modes this protocol can leave behind —
      // and leave anything else in place for classification to report.
      if (stat.isSymbolicLink || !stat.isFile) continue;
      const stagingMode = stat.mode & MODE_MASK;
      if ((stagingMode & ~FILE_MODE) !== 0) continue;
      if ((stagingMode & OWNER_READ) === 0) continue;
      if (!stagingStillOurs()) break;
      // RESIDUAL, stated rather than implied, because the check above does not close it: the
      // `assertHeld` on the next line is a call into a caller-supplied authority, so between the
      // identity check and the unlink an arbitrary amount of foreign code runs, and `unlink`
      // takes a PATHNAME that is re-resolved through `staging/` at that moment. Node exposes no
      // `unlinkat` against a held directory descriptor, so nothing here can bind the deletion to
      // the directory that was checked. It is the same irreducible shape as the GC deletion
      // window, bounded the same way — one writer at a time, three fixed names, and a derived
      // cache the next publish rebuilds — and it is recorded as a residual on T-010 rather than
      // presented as closed. The assertion still goes immediately before the mutation: AC 8
      // requires that ordering, and reordering the pair would trade a named residual for an
      // unnamed one.
      authority.assertHeld();
      try {
        fs.unlink(path);
        swept.push(path);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
  }

  const classification = classifyStore(fs, paths);
  if (classification.status === "not-usable") {
    const reset = resetStore(fs, authority, paths);
    return {
      status: "not-usable",
      resetError: classification.error,
      reset,
      sweptStaging: swept,
      unreferencedGenerations: [],
    };
  }

  return {
    status: classification.status,
    sweptStaging: swept,
    unreferencedGenerations: classification.unreferencedGenerations,
  };
}

// ---------------------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------------------

export interface PublishCandidate {
  generationId: string;
  sourceVersion: Record<string, number>;
  provenance: Provenance;
  payload: unknown;
  publishedAt: string;
}

export interface PublishWarning {
  stage: string;
  message: string;
}

export type PublishResult =
  | { status: "published"; generationId: string; warnings: PublishWarning[] }
  | { status: "refused"; reason: string; warnings: PublishWarning[] };

/**
 * Publishes one candidate generation and the manifest that activates it.
 *
 * Order is the whole protocol: the generation is committed BEFORE the manifest that
 * references it, so a crash between them leaves at worst a complete unreferenced
 * generation — classified as ordinary GC input, never as damage — and never a live manifest
 * naming a file that is missing.
 *
 * Nothing after the manifest rename may throw. Every value the post-commit path touches is
 * resolved into a plain local before the rename: property access can execute arbitrary code
 * through getters and Proxy traps, and "resolve it beforehand" is the only form of that rule
 * that holds structurally.
 */
export function publishSnapshot(
  fs: SnapshotFs,
  authority: LatchingWriteAuthority,
  paths: StorePaths,
  candidate: PublishCandidate,
  options: { live: ManifestDoc | null; retain?: number },
): PublishResult {
  // The compiler already refuses a bare `{ assertHeld() {} }` here — `LatchingWriteAuthority`
  // is nominal — but this module ships as JS to callers TypeScript never checked, and the
  // guarantee it protects (AC 8's latch, the terminal-action contract, no resurrection after
  // a loss) is not one to leave resting on a type alone.
  assertGuardedAuthority(authority);
  const warnings: PublishWarning[] = [];

  // The ARGUMENTS are proven inert before a single one of their fields is read.
  //
  // `assertInertDocument` inside `assertGenerationInvariants` protects the document this
  // function BUILDS, which is too late for the arguments it builds it FROM: every line below
  // reads `candidate.generationId`, `candidate.sourceVersion`, `candidate.provenance` and
  // `candidate.payload`, and each of those runs an accessor or a Proxy `get` trap if the
  // caller supplied one. Worse than merely running: a trap can return one value to the
  // validation and a different value to the write, so the artifact committed is not the
  // artifact that was checked.
  assertInertDocument(candidate, "candidate", (detail, cause) => {
    throw new SnapshotStoreResetError("generation-invariants", detail, paths.generationsDir, cause);
  });
  assertInertDocument(options, "options", (detail, cause) => {
    throw new SnapshotStoreResetError("generation-invariants", detail, paths.manifest, cause);
  });
  // INERT IS NOT THE SAME AS USABLE, and the gap between them was a real hole. `canonicalize`
  // accepts `null` — it is perfectly valid JSON — so the check above passed it straight through
  // and the first field read below produced `TypeError: Cannot read properties of null (reading
  // 'retain')`: verbatim the incidental failure the read-ordering was introduced to remove. The
  // ordering only ever fixed the ACCESSOR half. (`undefined` was never affected; it takes the
  // default parameter, which is why this went unnoticed.)
  //
  // Checked AFTER inertness, not before: `Array.isArray` is a trapped operation, so asking it
  // about a value not yet proven trap-free is the same mistake one line earlier.
  const rawOptions: unknown = options;
  if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new SnapshotStoreResetError(
      "generation-invariants",
      `options must be an object, got ${rawOptions === null ? "null" : typeof rawOptions}`,
      paths.manifest,
    );
  }

  // The candidate carries exactly the generation document's key set, and it is checked HERE
  // rather than left to `assertGenerationInvariants` below, because that function validates the
  // document this one BUILDS — and it builds it by naming five fields. A sixth field on the
  // candidate is therefore not refused by the exact-key rule; it is silently dropped before the
  // rule ever sees it, which is the one outcome the rule exists to prevent. A newer build
  // handing this one a field it does not know must be told so, exactly as an older build
  // reading a newer document on disk is. Symmetry with `decodeEnvelope` is the whole point:
  // unrecognised input is an unsupported state, not a subset to quietly harvest.
  const candidateFail = (detail: string, cause?: unknown): never => {
    throw new SnapshotStoreResetError("generation-invariants", detail, paths.generationsDir, cause);
  };
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    candidateFail("candidate is not an object");
  }
  assertExactKeys(
    candidate as unknown as Record<string, unknown>,
    "candidate",
    GENERATION_KEYS,
    candidateFail,
  );

  // DETACHED, because proving these arguments inert and then reading them later is the same
  // proof-and-use mismatch this module has closed everywhere else and left standing at its
  // most important site.
  //
  // Inertness is proven ONCE, at entry, and nothing freezes the caller's objects. Between that
  // proof and the reads below sit seam calls — `readGuarded`, `assertOwnedChain`, `lstatOrNull`
  // — and the seam is caller-supplied. A hook fired inside any of them can
  // `Object.defineProperty(candidate, "payload", { get })`, so `publishedAt`, `provenance` and
  // `payload` were read AFTER the window in which they could be replaced: the artifact
  // committed need not be the artifact that was checked, which is precisely what the inertness
  // check exists to guarantee it is.
  //
  // Taken through CANONICAL FORM rather than by copying properties, because a shallow copy
  // leaves the nested `provenance` and `payload` trees shared with the caller and the same hook
  // reaches them one level down. `assertInertDocument` above has already proven both arguments
  // canonicalize, so this re-walk cannot refuse anything that reached it, and what comes back
  // is a fresh tree nobody else holds a reference to. Same rule as `canonicalSourceVersion` and
  // `normalizeIntervals`: one descriptor pass, then use only the copy.
  const doc = detachDocument(candidate, "candidate", candidateFail);
  const opts = detachDocument(options, "options", (detail, cause) => {
    throw new SnapshotStoreResetError("generation-invariants", detail, paths.manifest, cause);
  });

  // Only NOW is a field read off `options`, and the ordering is the finding rather than a
  // preference: `options.retain` used to be read first, so a null `options` produced an
  // incidental TypeError instead of this module's error, and an accessor or a Proxy `get` trap
  // ran caller code ahead of the very check whose job is to prove no such code exists.
  //
  // Validated BEFORE the generation is committed, not implicitly by whatever `Math.max` and
  // `slice` do with it. An unvalidated `retain` of NaN, 1.5, "2" or an object with a `valueOf`
  // reached those two functions and, in the NaN case, produced a manifest that failed its own
  // invariants — AFTER an unreferenced generation had already been written.
  const retain = opts.retain ?? 2;
  if (!Number.isSafeInteger(retain) || retain < 1) {
    throw new SnapshotPathError(
      `retain must be a positive integer (see .retain for the value as supplied, uncoerced)`,
    );
  }

  // The id becomes a filename, so it is checked before any path is built from it — not after
  // the artifact has already been renamed somewhere the grammar would have refused.
  const generationId = assertArtifactId("generation", doc.generationId);

  const candidateVersions = canonicalSourceVersion(doc.sourceVersion);

  // WHAT IS LIVE IS READ FROM DISK. `options.live` is now an expectation the caller states,
  // never the answer.
  //
  // This is the same defect `collectGarbage` was fixed for, left standing in the function that
  // creates the state GC later protects — and the argument there is the argument here: a
  // caller-supplied manifest can be perfectly valid and simply not current, and no amount of
  // validating it can detect that, because nothing about a stale document is invalid. Two
  // failures follow directly. `live: null` while a manifest exists skipped the dominance check
  // ENTIRELY, so a regressed snapshot published straight over the live one — AC 5's whole
  // guarantee, defeated by an argument. And a manifest one publish behind made the candidate
  // dominate offsets nobody holds any more, while regressing against the offsets that are
  // actually live, and then built the retention list from the wrong generation set.
  //
  // Read under the GUARDED read for the reason GC reads it that way: a plain read follows a
  // symlink, and "what am I required to dominate" is exactly the question an attacker would
  // like to answer for us.
  //
  // Through `readStoreFile` rather than `readGuarded`, because the two states `readGuarded`
  // COLLAPSES are the two this function must not confuse. It returns null for absent and for
  // present-but-not-ours alike, so a manifest that is a symlink, a FIFO, wrong-mode, oversized
  // or not valid UTF-8 read as "no live snapshot" — and with `options.live === null` that means
  // the dominance check is skipped and this publish COMMITS OVER it. AC 5's guarantee defeated
  // not by a bad argument this time but by a bad file: a regressed candidate replaces the prior
  // snapshot, and an invalid store repairs itself into a usable-looking one without ever taking
  // the atomic reset the derived-cache rule requires. `readGuarded`'s own doc says the
  // distinction exists for classification and that the sweep paths do not need it; this is a
  // third kind of caller, and it needs it most of all, since it is about to write.
  const liveRead = readStoreFile(fs, paths.manifest);
  if (liveRead.state === "unusable") {
    throw new SnapshotStoreResetError(
      liveRead.reason,
      `manifest.json ${liveRead.detail}`,
      paths.manifest,
      liveRead.cause,
    );
  }
  let live: ManifestDoc | null = null;
  if (liveRead.state === "ok") {
    live = decodeEnvelope("manifest", paths.manifest, liveRead.raw) as ManifestDoc;
    assertManifestInvariants(live, paths.manifest);
  }

  // The caller's belief is still checked, rather than ignored: a caller publishing against a
  // manifest that has since moved is working from a view that is gone, and silently succeeding
  // against the current one would hide that. Compared by canonical bytes, because `live` is a
  // decoded document and `encodeEnvelope` is deterministic over canonical form.
  const declaredLive = opts.live;
  if (declaredLive !== null) {
    assertManifestInvariants(declaredLive, paths.manifest);
  }
  const declaredIdentity =
    declaredLive === null ? null : manifestIdentity(encodeEnvelope("manifest", declaredLive));
  // The same bytes the dominance decision above was made from. `liveRead.state` is `ok` or
  // `absent` by now — `unusable` threw — so this is exactly "the live manifest, or none".
  const actualIdentity = liveRead.state === "ok" ? manifestIdentity(liveRead.raw) : null;
  if (declaredIdentity !== actualIdentity) {
    throw new SnapshotNotDominatingError(
      "incomparable",
      `publish was prepared against a manifest that is not the live one ` +
        `(declared ${declaredIdentity ?? "none"}, on disk ${actualIdentity ?? "none"})`,
    );
  }

  if (live !== null) {
    const liveVersions = canonicalSourceVersion(live.sourceVersion);
    const verdict = compareSourceVersions(candidateVersions, liveVersions);
    if (verdict !== "dominates") {
      // Equal, incomparable and regressed all refuse, with the prior snapshot untouched.
      // Incomparable failing closed is the load-bearing case: a dropped source must never
      // be able to look like progress.
      throw new SnapshotNotDominatingError(
        verdict,
        `candidate ${generationId} does not strictly dominate the live snapshot`,
      );
    }
  }

  const generationDoc: GenerationDoc = {
    generationId,
    publishedAt: doc.publishedAt,
    sourceVersion: candidateVersions,
    provenance: doc.provenance,
    payload: doc.payload,
  };
  const generationPath = `${paths.generationsDir}/${generationId}.json`;

  // Validated on the way OUT as well as the way in. A store that only checks documents when
  // reading them will happily write one it would later have to reset over, and the reset
  // would look like corruption rather than like the writer's own bad candidate.
  assertGenerationInvariants(generationDoc, generationPath, generationId);

  // GENERATION FILES ARE IMMUTABLE. A candidate reusing an existing id is refused here, before
  // anything is staged.
  //
  // Without this the commit is an OVERWRITING rename: `commitArtifact` refuses a symlink at the
  // target and then renames straight over whatever regular file is sitting there. Reuse the
  // active generation's id with higher offsets — which dominance permits, since it compares
  // versions and not names — and the file the LIVE manifest points at is replaced before the
  // new manifest commits. A crash or a failed manifest stage in that window leaves the prior
  // manifest live and serving content it never referenced: precisely the corruption the
  // generation-before-manifest order exists to make unreachable, and precisely the "existing
  // files byte-identical after a refusal" promise AC 5 makes, both defeated through the one
  // door the ordering does not cover.
  //
  // The check is against the DIRECTORY, not against the manifest's reference list, because an
  // unreferenced orphan at that name would be overwritten just as silently — and an orphan is
  // an anticipated post-crash state, not a free name. Refusing converges: GC removes the
  // orphan, and the id is available on the next sweep.
  assertOwnedChain(fs, paths, paths.generationsDir);
  if (lstatOrNull(fs, generationPath) !== null) {
    throw new SnapshotPathError(
      `generation ${JSON.stringify(generationId)} already exists; generation ids are single-use`,
    );
  }

  commitArtifact(fs, authority, paths, "generation", generationPath, generationDoc);

  const retained = buildRetention(live, generationId, retain);
  const manifestDoc: ManifestDoc = {
    activeGenerationId: generationId,
    retainedGenerationIds: retained,
    publishedAt: doc.publishedAt,
    sourceVersion: candidateVersions,
  };
  assertManifestInvariants(manifestDoc, paths.manifest);

  // ---- everything the post-commit path needs, resolved into locals BEFORE the commit ----
  const publishedId = generationId;
  const resultWarnings = warnings;
  // ---------------------------------------------------------------------------------------

  commitArtifact(fs, authority, paths, "manifest", paths.manifest, manifestDoc);

  return { status: "published", generationId: publishedId, warnings: resultWarnings };
}

function buildRetention(
  live: ManifestDoc | null,
  newId: string,
  retain: number,
): string[] {
  const prior = live ? live.retainedGenerationIds.filter((id) => id !== newId) : [];
  // Newest first; the active generation is always index 0 and therefore always retained.
  return [newId, ...prior].slice(0, Math.max(1, retain));
}

/**
 * Stage -> validate -> commit, for one artifact.
 *
 * The staging file is created at a FIXED name under an exclusive create, so an EEXIST means
 * residue from an earlier crash rather than a collision with a concurrent writer (there is
 * only one writer). Staging creation, staging cleanup, and the commit rename are each gated
 * individually: an ungated cleanup at a fixed path is an ABA hazard — after a lock
 * transfer, the file at that name is the successor's.
 */
function commitArtifact(
  fs: SnapshotFs,
  authority: WriteAuthority,
  paths: StorePaths,
  kind: ArtifactKind,
  targetPath: string,
  body: unknown,
): void {
  const staging = stagingPath(paths, kind);
  const targetDir = parentDir(targetPath);
  const encoded = encodeEnvelope(kind, body);
  const bytes = new TextEncoder().encode(encoded);
  // Refused HERE, before anything is created, because the reader refuses the same bound. A
  // writer that could emit an artifact its own reader rejects manufactures a store that
  // classifies as unusable, resets, rebuilds the identical file and resets again — the
  // non-convergent wedge this design treats as a defect, arriving through the one door the
  // read-side cap would have left open.
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new SnapshotArtifactTooLargeError(targetPath, bytes.length, MAX_ARTIFACT_BYTES);
  }

  // The staging directory is proven before anything is created in it. Creating exclusively
  // inside a symlinked `staging/` writes the candidate outside the store and then renames it
  // back in, which is a way to import a file the store never wrote.
  assertOwnedChain(fs, paths, paths.stagingDir);

  authority.assertHeld();
  const handle = fs.openExclusive(staging);

  let staged = true;
  let closed = false;
  // Closing the descriptor is RESOURCE cleanup, not a store mutation: it publishes nothing,
  // removes nothing, and changes no name in the store. So it is deliberately NOT
  // authority-gated and always runs — gating it would make releasing a descriptor
  // conditional on still owning the store, and a writer that lost the lock would leak the
  // fd until the process exited.
  // `close` can report a DELAYED I/O failure — an ENOSPC or EIO the earlier writes were
  // buffered past. So its error is captured rather than discarded, and precedence is
  // explicit: an earlier failure stays primary (close is attached diagnostically), but a
  // close failure with nothing before it is promoted, because it means the staging bytes
  // never landed and there is nothing safe to rename.
  // Two variables, and the reason is not style. `null` was doing double duty as "no close
  // failure yet" AND as a possible thrown value — and the seam's contract does not promise
  // Errors, it promises nothing at all about what a fault throws. A conforming fake that threw
  // `null` from `close` therefore recorded `closeError = null`, which every later check read as
  // "close succeeded", and the rename committed an artifact whose close had failed. The
  // boolean answers "did it fail"; the value is only ever carried for reporting.
  let closeFailed = false;
  let closeError: unknown = null;
  // Whether the throw currently unwinding IS the promoted close failure.
  //
  // The catch used to answer that by comparing `closeError !== err`, which is a guess dressed
  // as a check: the seam may throw ANY value, so a primary failure and a close failure that
  // happen to be the same value — two seams sharing one frozen sentinel is enough — read as
  // "these are the same failure" and the close failure vanished from the report. A flag
  // records what actually happened instead of inferring it from a value comparison.
  let promotedClose = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    try {
      fs.close(handle);
    } catch (err) {
      closeFailed = true;
      closeError = err;
    }
  };

  try {
    // Every mutating seam call carries its own gate, not just the create and the commit:
    // authority can be lost at any point, and a stale writer that keeps writing bytes or
    // chmodding is still mutating a name its successor may already own.
    let written = 0;
    while (written < bytes.length) {
      authority.assertHeld();
      const n = fs.write(handle, bytes, written);
      // A seam reporting no progress would spin this loop forever while authority stays
      // held — a hang, which is worse than a failure because nothing ever reports it. The
      // count is contract-checked rather than trusted: anything outside 1..remaining is a
      // structured pre-commit failure, not an offset to add.
      const remaining = bytes.length - written;
      if (!Number.isSafeInteger(n) || n < 1 || n > remaining) {
        throw new SnapshotWriteContractError(staging, n, remaining);
      }
      written += n;
    }
    // open()'s mode is a umask-filtered REQUEST; set it on the fd and verify it there.
    authority.assertHeld();
    fs.fchmod(handle, FILE_MODE);
    const stat = fs.fstat(handle);
    if ((stat.mode & MODE_MASK) !== FILE_MODE) {
      throw new SnapshotModeError(staging, stat.mode & MODE_MASK, FILE_MODE);
    }
    // CLOSE FIRST, then check. The order here is the whole point, and the obvious order is
    // wrong: `close` is a seam call, so it can run a hook, block, or (on a real filesystem)
    // flush for an unbounded time. Anything it does lands AFTER whatever ran before it, so a
    // close placed after the pathname checks reopens every window they just closed — the
    // staging entry can be swapped during the close and the rename publishes the replacement,
    // with a valid checksum because the replacement carries its own.
    //
    // Nothing below needs the descriptor: `stat` was captured by value from `fstat` above, so
    // the identity comparison works just as well against a closed handle. Closing early costs
    // nothing and makes the checks the last thing before the rename.
    closeOnce();
    // Promoted, not swallowed: with no earlier failure, a failing close IS the failure —
    // the staging file was never completed, so renaming it would publish an artifact whose
    // write did not succeed.
    if (closeFailed) {
      promotedClose = true;
      throw closeError;
    }

    // Symlink-swap defence, immediately before the commit and after every hook above.
    //
    // Both ENDS and the whole owned prefix, not just the target name: `lstat(targetPath)`
    // resolves everything above the final component, so on its own it reports success while
    // a swapped `generations/` sends the rename out of the store entirely. The source side is
    // re-proven too, because the rename reads a name out of `staging/`.
    assertOwnedChain(fs, paths, targetDir);
    // The manifest is the one artifact a commit is MEANT to replace; generations and pins are
    // immutable, so for them an occupied target is a refusal rather than a rename.
    assertNotSymlink(fs, targetPath, kind !== "manifest");

    // The staging side is proven LAST, and its container immediately before its entry.
    // Ordering matters here: `assertStagingIdentity` lstats a path UNDER `staging/`, so if
    // that directory were checked earlier and swapped in between, the identity check would
    // resolve through the new prefix and report whatever it found there. Adjacent checks make
    // the pair meaningful; separated ones each answer about a different filesystem.
    assertOwnedChain(fs, paths, paths.stagingDir);

    // ...and the staging ENTRY, not only the directory holding it. Proving the container says
    // nothing about the file inside it: the staging name can be unlinked and replaced with a
    // different regular file, and the rename would then publish an artifact this writer never
    // wrote. `stat` is the descriptor we wrote and chmodded, so this asks the only question
    // that settles it: is the name I am about to rename still the file I was holding open?
    //
    // This is the last FILESYSTEM call before the rename, and that placement is load-bearing:
    // every check above it can be invalidated by a call below it.
    //
    // What it does NOT do, stated plainly because an earlier version of this comment claimed
    // the ordering closed the race and it does not:
    //
    //   - `authority.assertHeld()` still runs after it. That is required by AC 8 and is not
    //     negotiable, so the interval it introduces is accepted rather than removed.
    //   - only the SOURCE side is re-proven here. The target container was proven further up,
    //     and a swap of `generations/` after that point still redirects the rename. Proving the
    //     target last instead would simply move the hole to the source.
    //
    // Both are the same underlying limitation: `rename(2)` takes two PATHNAMES, and nothing
    // short of `renameat` against held directory descriptors — which Node does not expose —
    // can bind either end. This narrows the exposure to a few instructions and leaves a real,
    // named residual. It is bounded the way the rest of the design is bounded: one writer at a
    // time, and a derived cache the next publish rebuilds.
    assertStagingIdentity(fs, staging, stat);

    authority.assertHeld();
    fs.rename(staging, targetPath);
    staged = false; // the rename consumed the staging name
  } catch (err) {
    closeOnce();
    if (staged) {
      cleanupStaging(fs, authority, staging);
    }
    if (closeFailed && !promotedClose) {
      // Both failures are preserved in a module-owned structure. The thrown value is NEVER
      // written to or read from: it can be frozen, primitive, null, or a Proxy whose traps
      // run arbitrary code, and mutating it to "attach" the close error is a way to lose the
      // exact failure we are trying to report.
      throw new SnapshotCommitFailure(staging, err, closeError);
    }
    throw err;
  } finally {
    // Exactly once, on every path, authority or not.
    closeOnce();
  }
}


/**
 * Proves the staging NAME still refers to the file the descriptor is holding open.
 *
 * The residual this closes is narrow and real: everything above proves the containing
 * directory, and nothing proved the entry. It is deliberately asked of a LIVE descriptor
 * against a name — no ownership is claimed, nothing is inferred about any other process, and
 * this is not the inode revalidation T-008's gate rejected (see `SnapshotStat.dev`, which
 * spells out the difference).
 *
 * Two residuals remain, and neither is closable here. The interval between this check and the
 * rename needs `renameat` against a held directory descriptor, which Node does not expose. And
 * the descriptor has by now been CLOSED — deliberately, so that `close` cannot run after the
 * checks — which means the kernel is free to hand the same inode number to a file created
 * afterwards. A replacement that reuses the identity would pass. Both are accepted, and both
 * are bounded by the single-writer invariant rather than by this function.
 */
function assertStagingIdentity(fs: SnapshotFs, staging: string, open: SnapshotStat): void {
  const named = fs.lstat(staging);
  if (named.isSymbolicLink) {
    throw new SnapshotPathError(`${staging} is a symlink`);
  }
  if (!named.isFile) {
    throw new SnapshotPathError(`${staging} is no longer a regular file`);
  }
  const mode = named.mode & MODE_MASK;
  if (mode !== FILE_MODE) {
    throw new SnapshotModeError(staging, mode, FILE_MODE);
  }
  if (named.dev !== open.dev || named.ino !== open.ino) {
    throw new SnapshotPathError(
      `${staging} was replaced between staging and commit ` +
        `(held ${open.dev}:${open.ino}, name now ${named.dev}:${named.ino})`,
    );
  }
}

/**
 * The commit target: never a symlink, and — for an IMMUTABLE artifact — not there at all.
 *
 * `mustBeAbsent` exists because `rename(2)` REPLACES. The single-use rule for generation ids
 * was enforced by an `lstat` back in `publishSnapshot`, hundreds of instructions and a dozen
 * seam calls before the rename that relies on it, so a regular file appearing at the target in
 * between was silently overwritten — and if that file is the generation the LIVE manifest
 * points at, the prior manifest is left serving content it never referenced. That is the exact
 * corruption the generation-before-manifest ordering exists to make unreachable.
 *
 * Asked HERE it costs no extra seam call — this function already lstats the target — and it
 * sits with the other immediately-before-the-rename checks rather than in another function.
 *
 * What it does NOT do, stated as plainly as its neighbours state theirs: it does not make the
 * commit atomically no-replace. `rename(2)` takes pathnames, so between this check and the
 * syscall the same window remains that the comment above `assertStagingIdentity` describes,
 * and for the same reason. Closing it properly means committing immutable artifacts with
 * `link(2)`, which fails EEXIST rather than replacing — a different commit primitive with a
 * different crash sequence, tracked separately.
 */
function assertNotSymlink(fs: SnapshotFs, path: string, mustBeAbsent = false): void {
  try {
    const stat = fs.lstat(path);
    if (stat.isSymbolicLink) {
      throw new SnapshotPathError(`${path} is a symlink`);
    }
    if (mustBeAbsent) {
      throw new SnapshotPathError(
        `${path} appeared before the commit; this artifact kind is single-use and a rename ` +
          "would replace it",
      );
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * Clears the staging NAME this invocation was using.
 *
 * Deliberately "the name", not "the file this invocation created" — those differ in exactly
 * one case, and it is worth being precise about: if the commit was refused because the staging
 * entry had been REPLACED, what gets unlinked here is the replacement. That is still correct,
 * and for the reason that makes the whole fixed-name scheme work: while authority is held
 * there is by definition no other writer, so anything sitting at our staging name is residue
 * we are entitled to clear, exactly as the startup sweep would.
 *
 * Gated, and deliberately silent about failure: the name is fixed and bounded, so the worst
 * case is one stale file the next start's sweep clears. After an authority loss the file is
 * LEFT in place — by then it may be the successor's, and deleting it would be the very race
 * the gate exists to prevent.
 */
function cleanupStaging(fs: SnapshotFs, authority: WriteAuthority, staging: string): void {
  try {
    authority.assertHeld();
  } catch {
    return; // leave the residue; the successor's sweep owns that name now
  }
  try {
    fs.unlink(staging);
  } catch {
    // Bounded residue, cleared at the next start. Nothing to chase.
  }
}

// ---------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------

export interface SnapshotView {
  generation: GenerationDoc;
  /** Generations the reader refused. Non-empty means a bounded partial (AC 3). */
  quarantined: string[];
}

export type ReadResult =
  | { status: "no-snapshot" }
  | { status: "ok"; view: SnapshotView }
  | { status: "partial"; view: SnapshotView; reason: string };

/**
 * Reads the active snapshot as an optimistic transaction.
 *
 * Unlinking the manifest makes the store unobservable to a reader that STARTS afterwards —
 * it does nothing for a reader already walking artifacts a reset is deleting. So the read
 * brackets itself with the manifest's identity: read it, load everything it references,
 * then read it again. If it vanished or changed, the store moved under us and the answer is
 * "no snapshot" or a retry against the new manifest — never a partial view, and never a
 * corruption report for a file a reset legitimately removed. An artifact that disappears
 * mid-read re-checks the manifest BEFORE it is allowed to count as corruption, for exactly
 * that reason.
 *
 * Every outcome is therefore: the complete old snapshot, the complete new snapshot, or no
 * snapshot.
 */
export function readSnapshot(
  fs: SnapshotFs,
  paths: StorePaths,
  attempts = 3,
): ReadResult {
  // Validated with the same rule `retain` gets, and for the same reason: it is an exported
  // parameter, so "callers pass 3" is not a property of this function. `NaN`, 0 or a negative
  // value makes `attempt < attempts` false on the first test, so every read returns "no
  // snapshot" while the store is perfectly healthy — a silent wrong answer, which is the worst
  // failure mode this module has. `Infinity` retries forever against a manifest that keeps
  // moving, which is a hang. And an object with a `valueOf` runs caller code inside the loop
  // condition on every iteration, in a function whose whole discipline is that caller code does
  // not run during validation. The bound is small because the retry exists to ride out a
  // concurrent publish, not to wait one out.
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16) {
    throw new SnapshotPathError("readSnapshot attempts must be an integer in 1..16");
  }
  // The reader proves its containers too. It mutates nothing, so there is no deletion to
  // contain here — but every path it reads is `${root}/...`, and a symlinked root would
  // silently feed it another directory's manifest and generations, which it would then serve
  // as this store's. The mode contract is enforced on the read side for the same reason: an
  // unkeyed checksum is no defence against whoever can write the file.
  //
  // And it is re-proved as part of the transaction's CLOSING bracket, not only at entry. The
  // bracket exists because the store can move under a reader mid-read; a container swap is
  // exactly that kind of movement, so checking it once at the start would leave the same hole
  // the manifest identity re-check exists to close.
  //
  // IDENTITY, not acceptability. Re-running the assertions only proves the containers are
  // still valid-looking directories, and "valid-looking" is a property anyone can manufacture:
  // swap `generations/` for a different real 0700 directory holding forged artifacts, let the
  // read happen, and both brackets pass while every byte served came from the substitute. The
  // manifest identity check does not cover this either — the manifest is read through the same
  // prefix, so it is the substitute's manifest that gets compared against itself.
  const identifyContainers = (): { root: string; generations: string } | null => {
    try {
      return {
        root: containerIdentity(fs, paths, paths.root),
        generations: containerIdentity(fs, paths, paths.generationsDir),
      };
    } catch (err) {
      // Narrowed for the same reason as every other catch in this reader: a bare one reported
      // a failing disk as "your store looks fine, there is just no snapshot in it". Only this
      // module's own verdicts about the containers mean "not usable".
      if (!isArtifactUnusable(err)) throw err;
      return null;
    }
  };

  const containers = identifyContainers();
  if (containers === null) return { status: "no-snapshot" };

  const containersIntact = (): boolean => {
    const now = identifyContainers();
    return (
      now !== null && now.root === containers.root && now.generations === containers.generations
    );
  };

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Guarded: `readFile` follows symlinks, so an unguarded read hands the reader whatever a
    // symlinked `manifest.json` points at and it would serve that as this store's snapshot.
    const rawManifest = readGuarded(fs, paths.manifest);
    if (rawManifest === null) return { status: "no-snapshot" };
    const identity = manifestIdentity(rawManifest);

    let manifest: ManifestDoc;
    try {
      // Not redundant with `readGuarded`, though it looks it: that proved the name BEFORE the
      // read, and this re-proves it after. The pair brackets the read itself, so a manifest
      // replaced by a symlink or re-moded WHILE it was being read is caught rather than
      // decoded. What it does not catch is an ABA swap for another 0600 regular file — that
      // is what `manifestIdentity` is for, and the two are deliberately different checks.
      assertMode(fs, paths.manifest, FILE_MODE);
      manifest = decodeEnvelope("manifest", paths.manifest, rawManifest) as ManifestDoc;
      assertManifestInvariants(manifest, paths.manifest);
    } catch (err) {
      // A reader never resets; an unusable manifest is simply not a snapshot it can serve.
      // But ONLY this module's verdicts about the artifact mean that. A bare `catch` here
      // turned an EIO or an EACCES — a filesystem that is failing, which the caller must hear
      // about — into "there is no snapshot yet", and swallowed unbranded hostile values that
      // the module's own rule says must propagate untouched.
      if (!isArtifactUnusable(err)) throw err;
      return { status: "no-snapshot" };
    }

    const quarantined: string[] = [];
    let active: GenerationDoc | null = null;
    let restarted = false;

    for (const generationId of [
      manifest.activeGenerationId,
      ...manifest.retainedGenerationIds.filter((id) => id !== manifest.activeGenerationId),
    ]) {
      const path = `${paths.generationsDir}/${generationId}.json`;
      // Guarded, so a symlinked generation is never DEREFERENCED. The mode check below would
      // have refused to serve it either way, but only after the bytes had already been pulled
      // in from wherever the link pointed — and "wherever" can be a 4GB file or a fifo that
      // never returns. Refusing at the name costs nothing and reads nothing.
      const raw = readGuarded(fs, path);
      if (raw === null) {
        // Absent or unusable-at-the-name — re-check the manifest before calling this
        // corruption. A concurrent reset removes referenced generations by design, and
        // reporting that as damage would quarantine a perfectly healthy store.
        if (manifestChanged(fs, paths, identity)) {
          restarted = true;
          break;
        }
        quarantined.push(generationId);
        continue;
      }
      try {
        assertMode(fs, path, FILE_MODE);
        const doc = decodeEnvelope("generation", path, raw);
        // Quarantine covers structural invalidity, not just a failed checksum. A
        // checksum-valid document that is not a generation — or is a DIFFERENT generation
        // wearing this filename — must never be served; that is the one outcome a reader is
        // supposed to make impossible.
        assertGenerationInvariants(doc, path, generationId);
        if (active === null) active = doc as GenerationDoc;
      } catch (err) {
        // Same narrowing: quarantine means "this artifact is not usable", not "any failure
        // while looking at it". An I/O error is not a corrupt generation.
        if (!isArtifactUnusable(err)) throw err;
        quarantined.push(generationId);
      }
      if (active !== null) break;
    }

    if (restarted) continue;

    // Bracket close: if the manifest moved while we were loading, the view we assembled may
    // mix generations from two publishes. Retry against the new one instead of serving it.
    if (manifestChanged(fs, paths, identity)) continue;
    // ...and if a container moved, everything read through it is suspect regardless of what
    // the manifest says, because the manifest itself was read through the same prefix.
    if (!containersIntact()) return { status: "no-snapshot" };

    if (active === null) return { status: "no-snapshot" };
    const view: SnapshotView = { generation: active, quarantined };
    if (quarantined.length > 0) {
      return {
        status: "partial",
        view,
        reason: `${quarantined.length} generation(s) quarantined`,
      };
    }
    return { status: "ok", view };
  }
  return { status: "no-snapshot" };
}


/**
 * Is this a verdict THIS MODULE reached about an artifact, as opposed to a failure that
 * happened while looking at one?
 *
 * The distinction is the whole point. "The checksum does not match" is a fact about the file
 * and the reader should quarantine it; "the disk returned EIO" is a fact about the machine and
 * the caller needs to hear it rather than be told the cache is empty. Only the module's own
 * error types count, plus a branded not-found — which is the documented mid-read race, a file
 * a concurrent reset legitimately removed.
 */
const UNUSABLE_TAGS: ReadonlySet<SnapshotErrorTag> = new Set<SnapshotErrorTag>([
  "SnapshotStoreResetError",
  "SnapshotModeError",
  "SnapshotPathError",
  "SnapshotIdError",
]);

function isArtifactUnusable(err: unknown): boolean {
  if (isNotFound(err)) return true;
  // The BRAND, not `instanceof`. These constructors are exported, so
  // `Object.create(SnapshotPathError.prototype)` produces a value that passes an `instanceof`
  // test — and a value that passes this test is SWALLOWED and reported as "no snapshot".
  // Anything able to throw into the reader could therefore convert a failure the caller must
  // hear about into a quiet empty answer. Identity in a module-private map cannot be answered
  // by a value built to LOOK like one of these types — which is the impostor this branch has
  // to exclude. It does not authenticate the thrower: the constructors are exported, so the
  // injected seam can raise a genuinely tagged error. That is the seam's prerogative either
  // way, since it is the filesystem; see the note on ERROR_TAG in ./errors.ts.
  const found = snapshotErrorTag(err);
  return found !== null && UNUSABLE_TAGS.has(found);
}

function manifestChanged(fs: SnapshotFs, paths: StorePaths, identity: string): boolean {
  // Guarded, so that a manifest replaced mid-read by a SYMLINK reads as "changed" rather than
  // being followed and compared against the target's bytes.
  const raw = readGuarded(fs, paths.manifest);
  if (raw === null) return true;
  return manifestIdentity(raw) !== identity;
}

export type ReadGenerationResult =
  | { status: "no-snapshot" }
  | { status: "not-retained" }
  | { status: "gone" }
  | { status: "ok"; generation: GenerationDoc };

/**
 * Reads ONE generation by id — the reader half of the pin mechanism (T-025 item 2, T-013
 * AC 4). Deliberately NOT manifest-following: `readSnapshot` answers "what is current?",
 * this answers "the generation my cursor pinned", and a publish moving the manifest between
 * the two calls must not move the cursor.
 *
 * Authorization, not path math, decides what is readable: the id must be referenced by the
 * live manifest (active or retained) or by a structurally valid pin. Anything else is
 * `not-retained` — including a malformed id, which is indistinguishable from a hostile one
 * when it arrives inside an MCP cursor, and so gets the same quiet typed answer rather than
 * a throw.
 *
 * Pin EXPIRY is deliberately ignored here: lifecycle is GC's ownership (collectGarbage
 * removes expired pins under the writer's authority), and a reader that second-guessed
 * expiry would refuse a file that is still physically retained — an answer neither fresher
 * nor safer than serving it. The race "expired pin, not yet swept" therefore serves, which
 * is indistinguishable from the same read a moment earlier.
 *
 * The verdict vocabulary follows `readSnapshot`: `no-snapshot` (no usable manifest, or the
 * store kept moving for every attempt), `not-retained` (nothing authorizes this id),
 * `gone` (authorized, but the artifact is absent or unusable while the manifest stands
 * still — a swept pin target or corruption). There is no closing manifest re-check on
 * success: `assertGenerationInvariants` binds the document to the REQUESTED id, so the
 * served bytes cannot be another generation's regardless of what the manifest did
 * mid-read. The container bracket IS re-checked, because every path was read through it.
 */
export function readGeneration(
  fs: SnapshotFs,
  paths: StorePaths,
  id: string,
  attempts = 3,
): ReadGenerationResult {
  // Same exported-parameter rule, bound, and rationale as readSnapshot's.
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16) {
    throw new SnapshotPathError("readGeneration attempts must be an integer in 1..16");
  }
  try {
    assertArtifactId("generation", id);
  } catch (err) {
    if (!isArtifactUnusable(err)) throw err;
    return { status: "not-retained" };
  }

  const identifyContainers = (): { root: string; generations: string; pins: string } | null => {
    try {
      return {
        root: containerIdentity(fs, paths, paths.root),
        generations: containerIdentity(fs, paths, paths.generationsDir),
        // The pins directory joins the bracket here (readSnapshot never reads it), so a
        // pins/ that is replaced AND STAYS replaced is detected exactly as a replaced
        // generations/ is. What the bracket does NOT witness — here or in any caller of
        // containerIdentity — is a swap restored inside the window: closing that needs
        // descriptor-relative reads (`openat`), which Node does not expose; see
        // assertOwnedContainer's advisory-bound note. That residual is also not a privilege
        // gain: pins are unauthenticated hints, so whoever could swap pins/ could mint a
        // structurally valid pin in the real one instead. This is a consistency check
        // against concurrent reset/move, not a boundary against a store-dir writer.
        pins: containerIdentity(fs, paths, paths.pinsDir),
      };
    } catch (err) {
      if (!isArtifactUnusable(err)) throw err;
      return null;
    }
  };
  const containers = identifyContainers();
  if (containers === null) return { status: "no-snapshot" };
  const containersIntact = (): boolean => {
    const now = identifyContainers();
    return (
      now !== null &&
      now.root === containers.root &&
      now.generations === containers.generations &&
      now.pins === containers.pins
    );
  };

  for (let attempt = 0; attempt < attempts; attempt++) {
    const rawManifest = readGuarded(fs, paths.manifest);
    if (rawManifest === null) return { status: "no-snapshot" };
    const identity = manifestIdentity(rawManifest);

    let manifest: ManifestDoc;
    try {
      assertMode(fs, paths.manifest, FILE_MODE);
      manifest = decodeEnvelope("manifest", paths.manifest, rawManifest) as ManifestDoc;
      assertManifestInvariants(manifest, paths.manifest);
    } catch (err) {
      if (!isArtifactUnusable(err)) throw err;
      return { status: "no-snapshot" };
    }

    let authorized =
      manifest.activeGenerationId === id || manifest.retainedGenerationIds.includes(id);
    if (!authorized) {
      // Pin scan, with collectGarbage's read discipline: each pin proves its own name, mode,
      // envelope and invariants, and an unusable pin simply authorizes nothing — a reader
      // neither resets nor repairs.
      for (const entry of listOrEmpty(fs, paths.pinsDir)) {
        if (!entry.endsWith(".json")) continue;
        if (!ARTIFACT_ID_RE.test(entry.slice(0, -".json".length))) continue;
        const path = `${paths.pinsDir}/${entry}`;
        const raw = readGuarded(fs, path);
        if (raw === null) continue;
        try {
          assertMode(fs, path, FILE_MODE);
          const doc = decodeEnvelope("pin", path, raw);
          assertPinInvariants(doc, path, entry.slice(0, -".json".length));
          if ((doc as PinDoc).generationId === id) {
            authorized = true;
            break;
          }
        } catch (err) {
          if (!isArtifactUnusable(err)) throw err;
        }
      }
    }
    if (!authorized) {
      // A publish or pin write may have raced the scan; deny only against a manifest that
      // stood still, otherwise look again at the new state.
      if (manifestChanged(fs, paths, identity)) continue;
      if (!containersIntact()) return { status: "no-snapshot" };
      return { status: "not-retained" };
    }

    const path = `${paths.generationsDir}/${id}.json`;
    const raw = readGuarded(fs, path);
    if (raw === null) {
      if (manifestChanged(fs, paths, identity)) continue;
      if (!containersIntact()) return { status: "no-snapshot" };
      return { status: "gone" };
    }
    try {
      assertMode(fs, path, FILE_MODE);
      const doc = decodeEnvelope("generation", path, raw);
      // The binding half: a checksum-valid document that is a DIFFERENT generation wearing
      // this filename is `gone`, never served — same non-substitutability readSnapshot
      // enforces, bound here to the CALLER'S id.
      assertGenerationInvariants(doc, path, id);
      if (!containersIntact()) return { status: "no-snapshot" };
      return { status: "ok", generation: doc as GenerationDoc };
    } catch (err) {
      if (!isArtifactUnusable(err)) throw err;
      if (manifestChanged(fs, paths, identity)) continue;
      if (!containersIntact()) return { status: "no-snapshot" };
      return { status: "gone" };
    }
  }
  // Every attempt found the store mid-move; same exhaust verdict as readSnapshot.
  return { status: "no-snapshot" };
}

// Freshness lives in ./freshness.ts, re-exported here so readers have one import site.
// It moved out because AC 6's answer depends on the requested FIELDS and on timezone
// agreement, not only on a range, and because local-day arithmetic (DST gap and fold) is a
// self-contained problem that has nothing to do with the commit protocol.
export {
  deriveFreshness,
  localDayBounds,
  // The instant grammar itself, so a caller building provenance can apply the rule the reader
  // will apply rather than discovering it at query time. This module already depends on it for
  // exactly that reason.
  isExplicitInstant,
  FreshnessRequestError,
  type FreshnessRequest,
  type FreshnessResult,
  type FieldFreshness,
} from "./freshness.js";

// ---------------------------------------------------------------------------------------
// Pins and GC
// ---------------------------------------------------------------------------------------

export interface SweepResult {
  removedGenerations: string[];
  removedPins: string[];
  stoppedOnAuthorityLoss: boolean;
  /**
   * No USABLE manifest: absent, or present under a name that is a symlink, a non-regular
   * file, or the wrong mode. Nothing readable says what is protected, so nothing was
   * collected. Both cases route to reset-and-rebuild under the one rule.
   */
  noUsableManifest: boolean;
  /** The manifest changed mid-sweep; the sweep stopped rather than act on a stale view. */
  abortedOnManifestChange: boolean;
}

/**
 * Collects garbage: removes generations that are neither referenced by the live manifest
 * nor protected by an unexpired pin.
 *
 * GC runs ONLY after a successful activation. A failed publish leaves the prior manifest
 * live and triggers no GC at all — the one ordering that keeps the last known-good
 * generation from being collected on the strength of a snapshot that never committed.
 */
export function collectGarbage(
  fs: SnapshotFs,
  authority: LatchingWriteAuthority,
  paths: StorePaths,
  nowIso: string,
): SweepResult {
  // The compiler already refuses a bare `{ assertHeld() {} }` here — `LatchingWriteAuthority`
  // is nominal — but this module ships as JS to callers TypeScript never checked, and the
  // guarantee it protects (AC 8's latch, the terminal-action contract, no resurrection after
  // a loss) is not one to leave resting on a type alone.
  assertGuardedAuthority(authority);
  const removedGenerations: string[] = [];
  const removedPins: string[] = [];
  const empty = {
    removedGenerations,
    removedPins,
    stoppedOnAuthorityLoss: false,
    noUsableManifest: false,
    abortedOnManifestChange: false,
  };

  // GC lists two directories and unlinks what it finds in them, which is the same
  // list-then-mutate shape the reset had — and it had the same hole. `listDir` FOLLOWS a
  // symlink, so with `pins/` pointing at an external tree an ordinary sweep read the target's
  // files, found none of them to be valid pins, classified them as collectable, and deleted
  // them. Proving the containers first is what makes "collect garbage" mean this store's
  // garbage. It throws rather than skipping: a symlinked artifact directory is an ambiguous
  // state, and the one rule says the next start resets it, not that GC quietly works around it.
  //
  // The identities are KEPT, not just checked. Proving acceptability once at the top is not
  // enough for a function shaped like this one: every read and `lstat` below is a
  // seam call that yields, and a directory swapped for a different real 0700 directory after
  // the entry check passes acceptability again while the unlinks land somewhere else
  // entirely. The tokens below are re-compared before each list and before each deletion.
  const pinsId = containerIdentity(fs, paths, paths.pinsDir);
  const generationsId = containerIdentity(fs, paths, paths.generationsDir);

  // The LIVE manifest, read here rather than accepted from the caller.
  //
  // Taking it as a parameter was a loaded gun: a stale-but-perfectly-valid manifest — one
  // publish behind — makes the newly activated generation look unreferenced, so the sweep
  // deletes the generation the on-disk manifest still points at. That is structural
  // corruption produced by the one function this ticket says must be tested adversarially,
  // and no amount of validating the argument could have caught it, because the argument was
  // not invalid. It was just not current. The only defensible source for "what is protected"
  // is the file that defines it.
  //
  // Read through `readGuarded`, because "the file that defines it" has to BE the file. A
  // plain read follows a symlink, so `manifest.json` pointing at an attacker-authored file is
  // enough to supply the protected set — and a protected set is a DELETION LIST by omission.
  // Name a generation the store does not have and every real one becomes collectable. The
  // envelope checksum does not help: a forged manifest carries a checksum over its own body.
  const rawManifest = readGuarded(fs, paths.manifest);
  if (rawManifest === null) {
    // Nothing usable on disk says what is protected, so nothing here may decide it is not. An
    // empty protected set would collect every generation in the store; clearing a store is the
    // reset's job, under the one rule, not a sweep's.
    return { ...empty, noUsableManifest: true };
  }
  const identity = manifestIdentity(rawManifest);
  const manifest = decodeEnvelope("manifest", paths.manifest, rawManifest) as ManifestDoc;
  assertManifestInvariants(manifest, paths.manifest);

  /**
   * Has the manifest moved since we decided what was protected?
   *
   * Guarded on every re-read for the same reason as the first read: a manifest replaced
   * mid-sweep by a SYMLINK must read as "changed", and an unguarded read would follow it and
   * compare the target's bytes. Treating an unusable manifest as changed is also the safe
   * direction — it stops the sweep.
   */
  const stillCurrent = (): boolean => {
    const raw = readGuarded(fs, paths.manifest);
    return raw !== null && manifestIdentity(raw) === identity;
  };

  /** Everything that must still hold immediately before a deletion in `dir`. */
  const mayDelete = (dir: string, id: string): boolean => {
    if (!stillCurrent()) return false;
    assertSameContainer(fs, paths, dir, id);
    return true;
  };

  const protectedIds = new Set([
    manifest.activeGenerationId,
    ...manifest.retainedGenerationIds,
  ]);

  // The generations that actually exist, listed once before anything is removed. A pin naming
  // a generation that is not here protects nothing, and keeping it would leave a pin file
  // alive forever guarding a name that will never come back.
  //
  // Re-proven immediately before the list: reading and validating the manifest above ran
  // several seam calls, and a list taken through a swapped prefix would decide which pins are
  // "guarding a name that will never come back" from a directory that is not ours.
  assertSameContainer(fs, paths, paths.generationsDir, generationsId);
  const existingGenerations = new Set(
    listOrEmpty(fs, paths.generationsDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length)),
  );

  // The sweep's clock. Every pin's expiry is decided against it, so an ambiguous one makes
  // "expired" mean something different depending on where the process happens to run.
  if (typeof nowIso !== "string") {
    // Never interpolated. This branch is reached precisely BECAUSE the value is not a string,
    // so `String(x)` here would call into `Symbol.toPrimitive`/`valueOf`/`toString` on an
    // object the function is in the middle of rejecting — the same coercion hazard removed
    // from SnapshotWriteContractError and SnapshotIdError.
    throw new SnapshotPathError("collectGarbage needs a timestamp string");
  }
  if (!isExplicitInstant(nowIso)) {
    // Safe to interpolate now: it is proven to be a string.
    throw new SnapshotPathError(
      `collectGarbage needs a timestamp with an explicit UTC offset, got: ${nowIso}`,
    );
  }
  const now = Date.parse(nowIso);

  // Pins first, so an expired pin cannot keep a generation alive for one extra sweep.
  assertSameContainer(fs, paths, paths.pinsDir, pinsId);
  for (const entry of listOrEmpty(fs, paths.pinsDir)) {
    const path = `${paths.pinsDir}/${entry}`;
    // The ENTRY-versus-CONTENT split, applied here too.
    //
    // GC used to treat every unreadable entry as a collectable pin, which quietly made it the
    // one place in the store that DELETES foreign state. A symlink, a wrong-mode file, or a
    // name this grammar would never produce all made `readGuarded` return null, which read as
    // "unusable pin" and was unlinked — while `checkArtifactDir` says that exact set of
    // observations means something other than this protocol wrote here, and routes it to a
    // reset. Two functions in the same module disagreeing about the same file, with the
    // destructive one winning because it ran first.
    //
    // Left in place rather than aborted, because the disposition is not GC's to decide: a
    // foreign entry survives the sweep, `classifyStore` refuses the store on the next start,
    // and `resetStore` removes it with the gated non-following traversal. That is what
    // converges. Deleting it here would erase the only evidence classification has.
    if (!isArtifactFileName(entry)) continue;
    const entryStat = lstatOrNull(fs, path);
    if (entryStat === null) continue;
    if (entryStat.isSymbolicLink || !entryStat.isFile) continue;
    if ((entryStat.mode & MODE_MASK) !== FILE_MODE) continue;
    // Guarded like the manifest: a symlinked pin resolves to someone else's file, and a pin
    // that reads as valid and unexpired PREVENTS collection. Unusable is already a defined
    // disposition here (collectable), so this needs no new branch.
    const raw = readGuarded(fs, path);
    let pin: PinDoc | null = null;
    if (raw !== null && entry.endsWith(".json")) {
      try {
        const doc = decodeEnvelope("pin", path, raw);
        // Validated, not merely decoded. Trusting a checksum-valid body meant `until` could
        // be an object, in which case `{} <= "2026-…"` is false and the pin read as
        // unexpired against every timestamp there will ever be — a malformed pin protecting
        // a generation permanently, which is the opposite of the documented disposition.
        assertPinInvariants(doc, path, entry.slice(0, -".json".length));
        pin = doc as PinDoc;
      } catch (err) {
        // NARROWED, for the same reason the reader's catches are. A bare `catch` here converted
        // every failure into permission to DELETE the pin — including a programming error in a
        // validator and any unbranded value thrown from the seam. "This pin is unusable" is a
        // verdict this module reaches about a document; it is not a synonym for "something went
        // wrong nearby".
        //
        // Stated honestly, because the suite cannot currently falsify it: nothing REACHABLE
        // today throws anything else in here. `decodeEnvelope` and `assertPinInvariants` raise
        // `SnapshotStoreResetError` and nothing besides, and the seam calls that could throw an
        // arbitrary value (`readGuarded`) are deliberately outside this block. So this is a
        // guard against a FUTURE validator, not a fix for a live defect, and there is no mutant
        // for it — a mutant that cannot be killed would be one more claim of coverage the tests
        // do not back.
        if (snapshotErrorTag(err) !== "SnapshotStoreResetError") throw err;
        pin = null; // unusable: a lost pin costs a cursor a typed error, never wrong data
      }
    }
    // Three ways to be collectable, one disposition: unusable, elapsed, or guarding a
    // generation that no longer exists.
    const expired =
      pin === null ||
      Date.parse(pin.until) <= now ||
      !existingGenerations.has(pin.generationId);
    if (expired) {
      // Re-checked before EVERY deletion, not once at the top: a publish landing mid-sweep
      // changes what is protected, and the rest of this sweep was planned against the old
      // answer. The container is re-proven in the same breath, because "what is protected"
      // and "which directory am I deleting from" are two different ways to be wrong.
      if (!mayDelete(paths.pinsDir, pinsId)) {
        return { ...empty, abortedOnManifestChange: true };
      }
      try {
        authority.assertHeld();
      } catch {
        return { ...empty, stoppedOnAuthorityLoss: true };
      }
      try {
        fs.unlink(path);
        removedPins.push(path);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      continue;
    }
    // The RETENTION side is re-proven too, and not only the deletion side.
    //
    // A pin read through a substituted `pins/` cannot delete anything, which is why this was a
    // warning rather than a blocker — but it can put an id INTO `protectedIds`, so the sweep
    // retains generations on the strength of a pin from a directory that is not the store's,
    // and then reports success. Under this store's one rule a verdict assembled across two
    // different filesystems is ambiguous, and "ambiguous" is not a thing to report as done.
    // The deletion branch above has re-proven the container since round 5; this branch reads
    // the same file for the opposite decision and was exempt.
    if (!mayDelete(paths.pinsDir, pinsId)) {
      return { ...empty, abortedOnManifestChange: true };
    }
    protectedIds.add(pin!.generationId);
  }

  assertSameContainer(fs, paths, paths.generationsDir, generationsId);
  for (const entry of listOrEmpty(fs, paths.generationsDir)) {
    // Same split as the pin loop above. `endsWith(".json")` alone was not the artifact naming
    // rule — it admitted a leading-dot name, a 300-character name, and any other shape
    // `assertArtifactId` would refuse — so a `.json`-suffixed file this protocol could not have
    // written was collected as an ordinary unreferenced generation instead of being left for
    // classification to refuse.
    if (!isArtifactFileName(entry)) continue;
    const generationId = entry.slice(0, -".json".length);
    if (protectedIds.has(generationId)) continue;
    const path = `${paths.generationsDir}/${entry}`;
    const entryStat = lstatOrNull(fs, path);
    if (entryStat === null) continue;
    if (entryStat.isSymbolicLink || !entryStat.isFile) continue;
    if ((entryStat.mode & MODE_MASK) !== FILE_MODE) continue;
    if (!mayDelete(paths.generationsDir, generationsId)) {
      return { ...empty, abortedOnManifestChange: true };
    }
    try {
      authority.assertHeld();
    } catch {
      return { ...empty, stoppedOnAuthorityLoss: true };
    }
    try {
      fs.unlink(path);
      removedGenerations.push(path);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  return { ...empty };
}

/** Writes a retention pin. Pins are hints: losing one costs a cursor a typed error. */
export function createPin(
  fs: SnapshotFs,
  authority: LatchingWriteAuthority,
  paths: StorePaths,
  pin: PinDoc,
): void {
  // The compiler already refuses a bare `{ assertHeld() {} }` here — `LatchingWriteAuthority`
  // is nominal — but this module ships as JS to callers TypeScript never checked, and the
  // guarantee it protects (AC 8's latch, the terminal-action contract, no resurrection after
  // a loss) is not one to leave resting on a type alone.
  assertGuardedAuthority(authority);
  // Same rule as `publishSnapshot`, and now the same MECHANISM: proven inert, then DETACHED, so
  // every read below is of a private tree. This was a proof followed by reads of the caller's
  // object, which is safe only while nothing seam-touching sits between the two — true today,
  // stated nowhere, and silently broken by any seam call a later change puts in that stretch.
  const doc = detachDocument(pin, "pin", (detail, cause) => {
    throw new SnapshotStoreResetError("pin-invariants", detail, paths.pinsDir, cause);
  });
  // Both ids are path-bearing: `pinId` becomes this file's name, and `generationId` is what
  // GC will later resolve into `generations/<id>.json`.
  const pinId = assertArtifactId("pin", doc.pinId);
  const path = `${paths.pinsDir}/${pinId}.json`;
  assertPinInvariants(doc, path, pinId);
  commitArtifact(fs, authority, paths, "pin", path, doc);
}
