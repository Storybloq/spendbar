/**
 * T-008 §3.5 — snapshot publish WITHOUT a lock.
 *
 * The gate's second reversal: T-010's single-writer requirement was assumed, not derived. Writing
 * a complete temp file and `rename()`ing it over the target is atomic — a reader sees the old
 * file or the new one, never a torn one.
 *
 * That is STRUCTURAL integrity only, and the distinction is not pedantic: concurrent rename
 * publishers cannot tear the file, but a stale one CAN regress semantic freshness (demonstrated
 * in publish.test.mjs, not argued). So the single-service topology is still required for
 * monotonic publication — what the gate removed is the need for a LOCK, not the need for one
 * writer at a time.
 *
 * What rename does NOT buy, and how each limit is handled here:
 *
 *   structural atomicity only   the snapshot is ONE self-contained file with an embedded
 *                               checksum. Split it across data+index+checksum and readers can mix
 *                               generations; no single rename fixes that.
 *   no ordering                 a slow writer with older inputs can rename AFTER a newer one and
 *                               regress the target. The publisher re-reads the live snapshot
 *                               immediately before renaming and declines unless its own manifest
 *                               DOMINATES. That check is read-then-rename — the same TOCTOU shape
 *                               the lockfile died of — so it is ADVISORY: under the port lock it
 *                               never fires; under an unexpected second writer the worst outcome
 *                               is a stale snapshot, self-corrected next publish, never a torn one.
 *   no durability               no fsync, by decision. The snapshot is a derived cache over the
 *                               transcript logs; power loss costs a recomputation, not data.
 *                               (The allocation and token ARE fsynced — different boundary.)
 *
 * `sourceVersion` is a manifest of per-source offsets, NOT a scalar maximum — a single max cannot
 * order divergent input sets across multiple transcript files, clock changes, or deletions, so a
 * numerically greater snapshot could still omit data. Dominance is defined below; incomparable
 * manifests fail closed.
 */
import { isProxy } from "node:util/types";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const NO_HOOKS = Object.freeze({});

/**
 * Does `candidate` dominate `live`? The rule, stated once and tested directly:
 *
 *   - every source retained from `live` must be present in `candidate` at an offset >= live's;
 *     a MISSING source is incomparable, not "greater" — a snapshot that silently dropped an
 *     input set must never win on the strength of the inputs it kept;
 *   - a TRUNCATED source (candidate offset < live) is a regression;
 *   - at least one thing must ADVANCE: an offset strictly greater, or a source `live` has
 *     never seen. Equal-everywhere is not dominance; republishing identical inputs is waste,
 *     not progress.
 *
 * Returns "dominates" | "equal" | "regressed" | "incomparable". Callers publish ONLY on
 * "dominates" — everything else fails closed, including the case we cannot rank.
 */
function assertValidManifest(m, which) {
  // Review round 1: unvalidated offsets coerce. NaN compares false with everything (so a NaN
  // candidate neither regresses nor is incomparable — it sails through), numeric strings compare
  // lexically past 10 digits, and negatives/floats are not offsets. Fail closed on ALL of it:
  // dominance over garbage is not an ordering, and "publish anyway" is how data disappears.
  if (m === null || typeof m !== "object") {
    throw new TypeError(`${which} manifest is not a plain record`);
  }
  // A Proxy manifest is REFUSED FIRST — before the prototype is even read.
  //
  // Round 6 hardened against a Proxy by reading each value exactly once, which fixed divergent
  // getters. Round 9 rejected Symbol keys, which fixed `Object.keys`'s structural blind spot. Round
  // 10 showed the two together are still not enough: an `ownKeys` trap may legally hide a
  // configurable own Symbol property, and that hidden source is then absent from the published
  // manifest — the same source-loss that can turn a genuine "incomparable" into a clean "dominates"
  // and overwrite a snapshot we do not dominate. Calling `Object.keys` after `Reflect.ownKeys` also
  // hands a stateful trap a second, independently-answerable observation.
  //
  // I had recorded this as UNDETECTABLE, having checked that every enumeration API routes through
  // the same [[OwnPropertyKeys]] internal method. That was the wrong conclusion from a correct
  // observation: `util.types.isProxy` answers directly, without enumerating anything. Second time
  // this ticket I have declared something undetectable and been shown otherwise — the pattern is
  // that "I could not find a way" keeps getting written down as "there is no way".
  //
  // Refusing rather than supporting is the honest resolution: a manifest is coordination state that
  // decides whether a live snapshot gets overwritten, no legitimate caller passes a Proxy (real
  // manifests come from JSON.parse or plain construction), and an object whose key set cannot be
  // trusted cannot be validated at all. This module fails closed on everything else it cannot
  // verify; this is the same rule.
  if (isProxy(m)) {
    throw new TypeError(`${which} manifest is a Proxy; manifests must be plain records, because a Proxy's ownKeys trap can hide sources that would then be silently dropped from the published manifest`);
  }
  // "Not an array" was too weak, and the gap is not theoretical: a Date has no enumerable
  // offsets, so it validated and checksummed as {} — while the outer JSON.stringify serialized
  // it as a STRING. publishSnapshot returned "published" for a snapshot readSnapshot then
  // rejected as corrupt. Reproduced. The validated value and the published bytes have to be the
  // same thing, so the shape is pinned: plain object, no toJSON, data properties only.
  const proto = Object.getPrototypeOf(m);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${which} manifest has a custom prototype (${proto?.constructor?.name ?? "unknown"}); only plain records serialize to what was validated`);
  }
  if (Object.hasOwn(m, "toJSON")) {
    throw new TypeError(`${which} manifest defines toJSON, so its serialized form would differ from the value that was validated`);
  }
  // Build a CANONICAL plain copy from a single descriptor pass, and return it — every downstream
  // step then uses this object and never touches `m` again.
  //
  // Validating in place was not enough, and review round 6 named the escape: a Proxy whose
  // prototype is Object.prototype passes every structural check above, reports a well-behaved
  // `{value: 1}` from the descriptor trap, and then has its `get` trap return something else during
  // checksumming and again during JSON.stringify. publishSnapshot reports "published" and
  // readSnapshot rejects the file. Same publish-success/read-failure class as the Date manifest and
  // the Buffer payload, reached a third way — which is the tell that validating the INPUT is the
  // wrong shape of fix. Reading each value exactly once and publishing that reading closes the
  // class rather than another instance of it: whatever the traps do afterwards is unobservable,
  // because nothing reads them again.
  const canonical = {};
  // Symbol keys are REJECTED, not skipped. `Object.keys` ignores them, so a manifest carrying one
  // canonicalized to a copy silently missing that source and published successfully — the same
  // source-loss class as the `__proto__` setter below, arriving through a different door. Losing a
  // source is precisely the input the incomparable rule exists to catch, so dropping it quietly can
  // turn a genuine "incomparable" into a clean "dominates". Found in review round 9.
  for (const key of Reflect.ownKeys(m)) {
    if (typeof key === "symbol") {
      throw new TypeError(`${which} manifest has a Symbol-keyed property (${String(key)}); manifest sources must be string keys, and a Symbol key would be silently dropped from the published copy`);
    }
  }
  for (const source of Object.keys(m)) {
    const d = Object.getOwnPropertyDescriptor(m, source);
    if (!("value" in d)) {
      throw new TypeError(`${which} manifest property ${JSON.stringify(source)} is an accessor; it could return a different value each time it is read`);
    }
    if (!Number.isSafeInteger(d.value) || d.value < 0) {
      throw new TypeError(`${which} manifest offset for ${JSON.stringify(source)} is ${JSON.stringify(d.value)}; offsets are non-negative safe integers`);
    }
    // defineProperty, NOT assignment. `canonical[source] = v` invokes Object.prototype's legacy
    // `__proto__` SETTER when source is "__proto__", so the property is silently not created:
    // JSON.parse('{"__proto__":1,"a":2}') canonicalized to {"a":2}. A dropped source is the exact
    // input the incomparable rule exists to catch, so this turned a would-be "incomparable" into a
    // clean "dominates" and published a snapshot missing an entire transcript file. Review round 7.
    Object.defineProperty(canonical, source, { value: d.value, enumerable: true, writable: true, configurable: true });
  }
  return canonical;
}

/**
 * The payload is JSON TEXT, and that has to be enforced rather than assumed.
 *
 * Exactly the manifest bug one level out, found by review round 5: `createHash.update()` happily
 * accepts a Buffer or Uint8Array, but the outer `JSON.stringify` serializes a Buffer as
 * `{"type":"Buffer","data":[…]}`. So `publishSnapshot(t, Buffer.from("x"), m)` returned
 * "published", and `readSnapshot` then handed that OBJECT back to `createHash.update()`, which
 * throws — an unreadable snapshot created by a call that reported success. Reproduced.
 *
 * The rule is the one the manifest already follows: the value that was checksummed and the value
 * that round-trips through the file must be the same thing. For a payload that means a string.
 */
function assertValidPayload(p, which) {
  if (typeof p !== "string") {
    throw new TypeError(
      `${which} payload is ${p === null ? "null" : typeof p}; snapshot payloads are JSON text, ` +
        "because anything else checksums as one value and deserializes as another",
    );
  }
}

export function compareManifests(rawCandidate, rawLive) {
  // Compare the CANONICAL readings, never the raw inputs — otherwise a proxy could rank one way
  // here and serialize another way in publishSnapshot.
  const candidate = assertValidManifest(rawCandidate, "candidate");
  const live = assertValidManifest(rawLive, "live");
  let advanced = false;
  // Object.hasOwn, not `in` / property lookup: inherited names make Object.prototype look like a
  // data source. Reproduced — a live source named "toString" reads as PRESENT in an empty
  // candidate (so a snapshot that dropped it ranks "equal" instead of incomparable), and a new
  // candidate source named "constructor" reads as already-known (so a real advance does not
  // count). Both mis-rank exactly the cases dominance exists to catch.
  for (const [source, offset] of Object.entries(live)) {
    if (!Object.hasOwn(candidate, source)) return "incomparable";
    const c = candidate[source];
    if (c < offset) return "regressed";
    if (c > offset) advanced = true;
  }
  for (const source of Object.keys(candidate)) {
    if (!Object.hasOwn(live, source)) advanced = true;
  }
  return advanced ? "dominates" : "equal";
}

// Over manifest AND payload. The first version checksummed only the payload — but the manifest
// is what dominance DECIDES on, so a corrupted or edited manifest would pass "checksum-valid"
// while silently changing which later snapshots may publish. JSON.stringify with sorted keys is
// the deterministic encoding; the checksum field itself is excluded by construction.
const checksum = (manifest, payload) =>
  createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(manifest).sort())))
    .update("\u0000")
    .update(payload)
    .digest("hex");

/** The mode every snapshot and candidate must have, exactly. */
export const SNAPSHOT_MODE = 0o600;
/** Snapshots live in a private directory, same rule as the runtime dir in auth.mjs. */
export const SNAPSHOT_DIR_MODE = 0o700;

/**
 * `mkdir -p` that produces EXACTLY 0700 at every level it creates, under any umask.
 *
 * Three attempts, because each of the obvious ones is wrong in a way worth recording:
 *
 *   `mkdirSync(dir, {recursive:true})`            — umask-derived, so 0755 under the ordinary 022:
 *                                                   other users can list the snapshot directory and
 *                                                   learn which sources exist and when they changed.
 *   `mkdirSync(dir, {recursive:true, mode:0700})` — mkdir's mode is umask-FILTERED exactly like
 *                                                   open's, so under umask 0200 the first level is
 *                                                   created 0500 and creating anything inside it
 *                                                   then fails EACCES. (The no-mode version fails
 *                                                   there too, at 0577 — this is not a regression
 *                                                   introduced by asking for 0700.)
 *   recursive + chmod afterwards                  — recursive mkdir returns only the TOPMOST path it
 *                                                   created, so the directory actually holding the
 *                                                   snapshot keeps the umask mode. My first fix did
 *                                                   this and the test caught it.
 *
 * So: create one level at a time and chmod each immediately, which makes the directory writable
 * before the next level needs it. Existing directories are left alone — re-permissioning a
 * directory this code did not create would be a different bug, not a fix for this one.
 */
function mkdirPrivate(dir) {
  const missing = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) {
    missing.unshift(d);
    if (dirname(d) === d) break;      // reached the filesystem root
  }
  for (const d of missing) {
    mkdirSync(d);
    chmodSync(d, SNAPSHOT_DIR_MODE);
  }
}

/**
 * Create the candidate with an EXACT mode, verified on the fd before anything is published.
 *
 * The original default was `writeFileSync(f, text)`, which takes the process umask: under the usual
 * 022 the snapshot committed at 0644 and every local user could read the account's usage data. This
 * is the THIRD site of the umask class in this spike — the token learned it in round 12, the port
 * allocation in round 13, and the snapshot was still writing world-readable files in round 14, found
 * by the reviewer immediately after I recorded a "deliberate sibling audit" that swept teardowns and
 * hooks and never thought to sweep file creation. Auditing for one class is not auditing.
 *
 * fchmod after open, not a mode argument, because open()'s mode is filtered through the umask and is
 * therefore a request. Snapshots are deliberately NOT fsynced (they are a derived cache, unlike the
 * token and the allocation), so this writes and closes without one.
 */
function writeCandidateSecurely(file, text) {
  const fd = openSync(file, "wx", SNAPSHOT_MODE);
  try {
    fchmodSync(fd, SNAPSHOT_MODE);
    const buf = Buffer.from(text);
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`snapshot write made no progress at offset ${off} of ${buf.length}`);
      off += n;
    }
    const mode = fstatSync(fd).mode & 0o7777;
    if (mode !== SNAPSHOT_MODE) {
      throw new Error(`refusing to publish a snapshot candidate with mode ${mode.toString(8)}; expected exactly ${SNAPSHOT_MODE.toString(8)}`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The mode/type/ownership contract, in ONE place, applied on both sides of the rename.
 *
 * `SNAPSHOT_MODE` was documented as the rule for "every snapshot and candidate" while only the
 * default writer enforced it — so a snapshot left at 0644 by an older build, or planted by another
 * process, was read and trusted without complaint. A rule enforced on one path is a rule the
 * document overstates (review round 15). The checksum does not help here: it is unkeyed, so anyone
 * who can write the file can write a consistent one.
 */
function assertPublishable(path, what = "snapshot") {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) throw new Error(`no ${what} at ${path}`);
  // Captured once each — same rule as the credential validators; these are ordinary fs.Stats here,
  // but reading a value twice to judge it and then report it is the habit that produced three bugs.
  const isFile = st.isFile();
  const uid = st.uid;
  const mode = st.mode & 0o7777;
  if (!isFile) throw new Error(`${what} at ${path} is not a regular file (a symlink or directory in its place is an attack, not a config style)`);
  if (uid !== process.getuid()) throw new Error(`${what} at ${path} is owned by uid ${uid}, not ${process.getuid()}`);
  if (mode !== SNAPSHOT_MODE) {
    throw new Error(`${what} at ${path} has mode ${mode.toString(8)}; expected exactly ${SNAPSHOT_MODE.toString(8)}`);
  }
  return st;
}

/** Read a snapshot, verifying its embedded checksum. Returns null for absent; throws for torn. */
export function readSnapshot(target) {
  // Absent is a legitimate answer (first run); anything PRESENT must satisfy the same contract the
  // writer promises, or the documented mode rule is enforced on exactly one of the two paths.
  if (!existsSync(target)) return null;
  assertPublishable(target);
  let raw;
  try {
    raw = readFileSync(target, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const doc = JSON.parse(raw);
  // SHAPE BEFORE INTEGRITY, for the payload specifically: checksum() feeds it to
  // createHash.update(), which throws its own opaque TypeError on a non-string. Validating after
  // the checksum would mean a stored `{"type":"Buffer",...}` payload surfaced as an internal
  // crypto error instead of the named contract violation it is.
  assertValidPayload(doc.payload, "stored");
  if (checksum(doc.manifest, doc.payload) !== doc.checksum) {
    throw new Error(`snapshot at ${target} fails its checksum: torn or hand-edited`);
  }
  // A checksum proves the bytes are the ones that were written; it says nothing about whether
  // they were valid when written. A snapshot published by an older or buggier build can be
  // perfectly intact and still carry offsets no ordering can rank.
  assertValidManifest(doc.manifest, "stored");
  return doc;
}

/**
 * Publish via complete-temp-file-then-rename. Returns "published" | "declined:<why>".
 *
 * `hooks.afterDominanceCheck` exists so a test can hold this writer INSIDE the TOCTOU window —
 * after it judged itself newer, before it renamed. That is how the documented limit is
 * demonstrated deterministically instead of being hidden behind "advisory" and never shown.
 */
export async function publishSnapshot(target, payload, rawManifest, { hooks = NO_HOOKS } = {}) {
  // UNCONDITIONAL. Validation used to happen only inside compareManifests, which runs only when
  // a live snapshot exists — so the FIRST publish could persist NaN/string/negative offsets, and
  // readSnapshot then accepted them because their checksum matched. Fail-closed that a fresh
  // install can walk around is not fail-closed.
  // ONE reading of the caller's manifest. `manifest` from here down is our own plain object, so the
  // value that is compared, the value that is checksummed and the value that is written are
  // provably identical no matter what the caller handed in.
  const manifest = assertValidManifest(rawManifest, "candidate");
  // Before the target is touched, and before anything is checksummed — a payload that cannot round
  // -trip must never reach the rename.
  assertValidPayload(payload, "candidate");
  const live = readSnapshot(target);
  if (live !== null) {
    const rank = compareManifests(manifest, live.manifest);   // already canonical
    if (rank !== "dominates") return `declined:${rank}`;
  }
  // Every hook this function uses is resolved ONCE, here, before anything is written — including
  // the two that used to be read twice as `if (hooks.X) await hooks.X()`. That idiom performs two
  // property accesses, so a getter (or Proxy trap) returning a function on the first read and
  // something else on the second gets to choose what runs AFTER the guard has decided it exists.
  // It is the same double-read defect round 13 found in the credential probe, and the comment below
  // already claimed "resolved before the commit path, like every other hook in this spike" while
  // `beforeCommit` was read late and twice — the claim was true of two hooks out of four
  // (review round 14, found by auditing for the class rather than being told).
  const afterDominanceCheck = hooks.afterDominanceCheck;
  const beforeCommit = hooks.beforeCommit;
  const writeCandidate = hooks.writeCandidate ?? writeCandidateSecurely;
  const removeCandidate = hooks.removeCandidate ?? ((f) => rmSync(f, { force: true }));

  if (afterDominanceCheck) await afterDominanceCheck();

  const tmp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  // The DIRECTORY too, not just the file. The snapshot is 0600 now, but it lived in a directory
  // created with no mode at all — 0755 under the ordinary umask — so other local users could list
  // it and learn which sources exist and when they were written. auth.mjs states the rule this
  // violates in its own header ("The DIRECTORY is the primary isolation boundary and is validated
  // as strictly as the token"), which is the point: the rule was already written down in a sibling
  // module while this call ignored it. Found by sweeping every file-creating call for "is the mode
  // explicit and verified" rather than for the symptom I had just been shown (review round 15).
  //
  // chmod after mkdir for the same reason as fchmod after open: mkdir's mode argument is filtered
  // through the umask, so `{ mode: 0o700 }` alone yields 0500 under umask 0200 and publication then
  // fails on its own directory. Only a directory this call CREATED is adjusted — recursive mkdir
  // returns the first path it made, or undefined — because re-permissioning a directory someone
  // else created would be a different bug, not a fix for this one.
  mkdirPrivate(dirname(target));

  // The cleanup guard opens BEFORE the candidate is written, not just around the rename. Previously
  // a throw from `writeFileSync` (ENOSPC, EACCES) or from `beforeCommit` left the `.tmp` behind,
  // because the only `finally` started after both had succeeded — so every failure path littered,
  // and repeated failures accumulated residue next to the live snapshot. Review round 11, and the
  // same "the guard has to cover every statement that can throw, not the ones I was looking at"
  // rule that the write-once allocation needed three rounds to learn.
  let committed = false;
  try {
    writeCandidate(tmp, JSON.stringify({ manifest, payload, checksum: checksum(manifest, payload) }));
    // `beforeCommit` fires with the COMPLETE temp file on disk, one syscall from publication —
    // the widest window an atomicity mutant could exploit. The observation test reads the target
    // here (review: the earlier hook fired before the temp file even existed, so an in-place
    // mutant that trashed the target right after it would still have shown old-then-new).
    if (beforeCommit) await beforeCommit(tmp);
    // Verified AFTER the hook and immediately before the rename, which is the only placement that
    // means anything. Checking first left a window in which `beforeCommit` could chmod the candidate
    // to 0644, or replace it with a symlink to someone else's file, and the rename then committed
    // the object the check had already approved — so the guarantee held against an injected writer
    // and not against an injected hook (review round 15).
    //
    // lstat, not stat: stat follows symlinks and would report the mode of the REFERENT, so a symlink
    // pointing at a legitimate 0600 file passed while the symlink itself was what got published.
    assertPublishable(tmp);
    renameSync(tmp, target);
    committed = true;   // IRREVERSIBLE: the new snapshot is live from here.
  } finally {
    // NOTHING RUNS AFTER A SUCCESSFUL COMMIT. `rmSync(force)` suppresses ENOENT but not EACCES,
    // EIO or a failed path lookup, so an unconditional removal could throw AFTER the target had
    // already been replaced — reporting a failed publish while the new snapshot was live, and
    // sending the caller to retry something that already happened. Same rule as the write-once
    // allocation and the write-once token: past the irreversible step, nothing may throw
    // (review round 12). After a commit the rename has already consumed the candidate, so there
    // is nothing to remove either.
    if (!committed) removeCandidate(tmp);
  }
  return "published";
}

/**
 * THE MUTANT — an in-place writer, which is the thing rename-publish exists to not be.
 *
 * Kept here, exported, and driven by the test because plan review round 4 was right that a
 * free-running reader loop is probabilistic: it can miss every torn window and pass against a
 * broken writer. This writer exposes hooks that HOLD it after truncation and after a partial
 * write, so the reader is synchronized INTO each window and the torn state is observed
 * deterministically — proving the reader's checksum check can actually catch what rename-publish
 * prevents.
 */
export async function publishInPlaceMutant(target, payload, rawManifest, { hooks = NO_HOOKS } = {}) {
  const manifest = assertValidManifest(rawManifest, "candidate");
  // Resolved once, for the same reason as the real publisher. This function's job is to be wrong
  // about ATOMICITY specifically; being additionally wrong about hook resolution would blur what
  // the mutant demonstrates.
  const afterTruncate = hooks.afterTruncate;
  const afterPartialWrite = hooks.afterPartialWrite;
  writeFileSync(target, "");                             // truncate: the old snapshot is now gone
  if (afterTruncate) await afterTruncate();
  const doc = JSON.stringify({ manifest, payload, checksum: checksum(manifest, payload) });
  writeFileSync(target, doc.slice(0, Math.floor(doc.length / 2)), { flag: "a" });
  if (afterPartialWrite) await afterPartialWrite();
  writeFileSync(target, doc.slice(Math.floor(doc.length / 2)), { flag: "a" });
  return "published";
}
