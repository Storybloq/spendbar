/**
 * T-008 — the socket credential FALLBACK, since no peer-UID API exists (see probe.mjs).
 *
 * Design: a 0700 runtime directory + a 0600 high-entropy token that every client must present.
 * The filesystem's permission checks stand in for the peer credentials the kernel won't tell us.
 * The DIRECTORY is the primary isolation boundary and is validated as strictly as the token —
 * code review round 1 caught that the first version validated only the token, which guards the
 * credential while leaving the room it lives in unexamined.
 *
 * The path rules come from measurement, not caution:
 *
 *   TRUNCATION  macOS does not reject an over-long sun_path — it SILENTLY binds the 104-byte
 *               prefix while listen() succeeds and server.address() returns the full path (it
 *               lies). Measured: a different path sharing the first 104 bytes connects to that
 *               server. So over-long paths are rejected BEFORE listen is ever called, on BYTE
 *               length of the CANONICAL path — /tmp is a symlink to /private/tmp, so the string
 *               the kernel sees is 8 bytes longer than the one the caller wrote.
 *   SYMLINKS    the trusted root is realpath'd FIRST, then symlinks strictly below it are
 *               refused. The obvious "reject any symlinked component" rule would reject the
 *               service's own required path, because /tmp itself is a symlink on macOS.
 *   TRAVERSAL   "/tmp/../etc/svc.sock" starts with "/tmp/" and so passed the first version's
 *               prefix check — reproduced before fixing: it returned a canonical path OUTSIDE
 *               the root. Dot, dot-dot, and empty components are now rejected outright; there is
 *               no legitimate reason for a runtime socket path to contain any of them.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { dirname, sep } from "node:path";

export class AuthError extends Error {}

/** The measured macOS sun_path capacity. Byte 105 onward is silently discarded by the kernel. */
export const SUN_PATH_MAX = 104;
export const TOKEN_BYTES = 32;
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2;

/**
 * Write the WHOLE buffer, looping. writeSync returns a byte count and is permitted to write
 * short; a short write followed by fsync and link would publish permanently-malformed
 * coordination state through the write-once path, which no later run can repair. Exported for
 * direct short-write testing via an injected write function.
 */
export function writeAll(fd, buf, { write = writeSync } = {}) {
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new AuthError(`write made no progress at offset ${off} of ${buf.length}`);
    off += n;
  }
}

/** fsync the DIRECTORY so the link() publication itself survives power loss, not just the data. */
function fsyncDir(dir) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Validate the runtime directory — the primary isolation boundary. Injected stats for the same
 * reason as validateTokenStat: the foreign-owner branch must be testable without a second user.
 */
export function validateRuntimeDirStat(st, { uid = process.getuid() } = {}) {
  if (!st) throw new AuthError("runtime directory is missing");
  // Each MEMBER read once, then examined — `typeof st.X === "function" ? st.X() : st.X` reads the
  // property twice, so a getter could pass the typeof check and then hand back a non-function, or
  // return a different predicate than the one that was type-checked. Same class as the uid/mode
  // fields below and as the credential probe in round 13; these are the last two sites of it in the
  // caller-supplied-stat surface (review round 15).
  const dirMember = st.isDirectory;
  const linkMember = st.isSymbolicLink;
  const isDir = typeof dirMember === "function" ? dirMember.call(st) : dirMember;
  const isLink = typeof linkMember === "function" ? linkMember.call(st) : linkMember;
  if (isLink) throw new AuthError("runtime directory path is a symlink; refusing to operate through it");
  if (!isDir) throw new AuthError("runtime directory path is not a directory");
  // Read ONCE each, then judged and reported from the captured values. Every one of these was
  // `if (st.X !== ...) throw new AuthError(\`... ${st.X} ...\`)` — validate, then re-read the same
  // property to build the message. That is the identical shape round 13 found in the credential
  // probe, in the two functions whose ENTIRE documented design is that the stat is injected by the
  // caller, so a stateful accessor is not hypothetical here: it is the supported input. Found by
  // sweeping for the rule rather than the symptom (review round 15).
  const dirUid = st.uid;
  const dirMode = st.mode & 0o7777;
  if (dirUid !== uid) throw new AuthError(`runtime directory is owned by uid ${dirUid}, not ${uid}`);
  // EXACT 0700, not "no group/world bits": 0500 would break us confusingly later, and anything
  // else is evidence the directory was not created by this protocol. Same rule as the token.
  // 0o7777, not 0o777: masking at nine bits discards setuid, setgid and sticky, so 01700, 02700
  // and 04700 all passed an "exactly 700" check. This protocol never creates those modes, and the
  // whole point of exact-mode validation is that a mode we never write means something else wrote
  // the thing we are about to trust. Found in review round 5.
  if (dirMode !== 0o700) {
    throw new AuthError(`runtime directory mode is ${dirMode.toString(8)}, expected exactly 700`);
  }
  return true;
}

export function assertRuntimeDir(dir, { uid = process.getuid(), lstat = lstatSync } = {}) {
  validateRuntimeDirStat(lstat(dir, { throwIfNoEntry: false }), { uid });
  return dir;
}

/**
 * Validate a socket path BEFORE it is ever given to listen().
 *
 * Returns the canonical path that is safe to bind. Throws AuthError otherwise. The contract the
 * tests enforce: on any throw, `listen` has not been called — there is no "bind then check"
 * fallback, because the post-listen check was measured to be self-confirming (a planted socket
 * inode at the full path makes it pass while the real endpoint is the truncated prefix).
 */
export function assertBindablePath(requestedPath, { root = "/tmp", realpath = realpathSync, lstat = lstatSync } = {}) {
  if (!requestedPath.startsWith(root + sep)) {
    throw new AuthError(`${requestedPath} is not under the trusted root ${root}`);
  }
  const relative = requestedPath.slice(root.length + 1);
  // Reject traversal BEFORE building any path. A textual prefix check alone passes
  // "/tmp/../etc/svc.sock" — reproduced, it escaped to /private/tmp/../etc — and normalizing
  // afterwards would be a second chance to get the same thing wrong. There is no legitimate
  // ".", "..", or empty component in a runtime socket path, so the rule is refusal, not repair.
  for (const component of relative.split(sep)) {
    if (component === "" || component === "." || component === "..") {
      throw new AuthError(`${requestedPath} contains a ${JSON.stringify(component)} component; refusing a path that can escape or alias the trusted root`);
    }
  }
  // Canonicalize ONLY the trusted root. Resolving the full path would resolve the very symlinks
  // the walk below refuses — the guard's own test caught that in the first implementation. The
  // root's symlinkness (/tmp -> private/tmp on macOS) is legitimate and resolved here.
  let canonicalRoot;
  try {
    canonicalRoot = realpath(root);
  } catch (err) {
    throw new AuthError(`trusted root ${root} cannot be canonicalized: ${err.code ?? err.message}`);
  }
  const canonical = canonicalRoot + sep + relative;

  // BYTE length of the CANONICAL form. String.length under-counts multibyte paths, and the
  // pre-realpath form under-counts by the /tmp -> /private/tmp expansion (26 vs 34 bytes for the
  // real runtime path) — both were review findings, both are now the tested quantity.
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > SUN_PATH_MAX) {
    throw new AuthError(
      `socket path is ${bytes} bytes canonical (${canonical}); the kernel would silently bind ` +
        `the ${SUN_PATH_MAX}-byte prefix and every API would still report success`,
    );
  }

  // No symlinks STRICTLY BELOW the root. lstat, not stat: stat follows the link and reports the
  // healthy directory it points at. The final component is skipped — it is the socket we are
  // about to create and may not exist yet.
  let walk = canonicalRoot;
  for (const component of relative.split(sep).slice(0, -1)) {
    walk += sep + component;
    if (lstat(walk).isSymbolicLink()) {
      throw new AuthError(`${walk} is a symlink below the trusted root; refusing to bind through it`);
    }
  }
  return canonical;
}

/**
 * Publish the per-user token WRITE-ONCE, same protocol as the port allocation and for the same
 * measured reason: exclusive-create-then-write exposes an empty token to a concurrent first-run,
 * which would then misclassify a genuine holder as foreign. link() publishes only complete files.
 *
 * `hooks.beforeLink` lets a test hold one publisher INSIDE the race window — after its candidate
 * is complete, before it links — while another publisher completes. That is the deterministic
 * version of the concurrency this protocol exists for; two back-to-back calls exercise none of it.
 *
 * Returns the token (winner's own, or the validated incumbent's).
 */
export function publishToken(tokenPath, { tag = randomBytes(8).toString("hex"), hooks = {} } = {}) {
  const candidate = `${tokenPath}.${tag}.tmp`;
  // Resolved BEFORE the candidate exists, and invoked INSIDE the cleanup guard.
  //
  // Two defects in one line, both already fixed in the allocation path and both still here: reading
  // `hooks.beforeLink` is a property access that a getter or Proxy trap can make throw, and calling
  // it happened outside the `finally` that removes the candidate — so a throwing hook left a `.tmp`
  // behind. The allocation path needed three review rounds to learn that every hook must be
  // resolved before the irreversible step and every post-candidate statement must sit inside the
  // guard; this is the same file's other publication path, unfixed until round 11. Fixing a class
  // in one place and not its sibling is the recurring shape of this ticket's defects.
  const beforeLink = hooks.beforeLink;
  const removeCandidate = hooks.removeCandidate ?? ((f) => rmSync(f, { force: true }));
  // Injectable so the POST-LINK branches are reachable from a test. Both of these run after the
  // token is public, so both must degrade to warnings — and a branch no test can enter is a branch
  // whose contract is unverified (review round 13).
  const syncDir = hooks.syncDir ?? fsyncDir;

  // THE GUARD OPENS HERE, before the candidate exists — not after it is written.
  //
  // A throw from the write or the fsync (ENOSPC, EIO) previously stranded a partial `.tmp`, because
  // the only cleanup started once both had succeeded. Same rule, same file, one publication path
  // later than the last time it was fixed.
  let linked = false;
  let postLinkError = null;
  // The pre-link failure is CAPTURED, not rethrown from the catch.
  //
  // Rethrowing there exits the function before the cleanup step below, so a throwing hook left its
  // candidate behind — which is the exact defect this restructure was meant to fix, reintroduced by
  // the restructure itself and caught by the test written for the original. Cleanup runs on every
  // path; the original error is preserved and thrown after it.
  let preLinkError = null;
  let generated = null;
  // Set ONLY by a successful exclusive create, and it gates the cleanup below.
  //
  // Cleanup used to run unconditionally, so a candidate-NAME collision — `openSync(candidate,"wx")`
  // failing EEXIST because another attempt is mid-publish under the same tag — deleted a file this
  // call never created, destroying that publisher's in-progress candidate. The same EEXIST was also
  // misread as "we lost the token link" even though `linkSync` was never reached, so the failure was
  // swallowed and the function went on to read a token that need not exist. Two bugs from one
  // conflated errno (review round 14). EEXIST means "we lost" only when it comes from the link.
  let candidateOwned = false;
  let lostTheLink = false;
  try {
    const fd = openSync(candidate, "wx", 0o600);
    candidateOwned = true;
    try {
      // fchmod AFTER open, because the mode argument to open() is filtered through the process
      // umask and is therefore a REQUEST, not a setting.
      //
      // Measured: under `umask 0200` the candidate is created 0400. `linkSync` then publishes that
      // mode write-once, and `readToken` refuses it — "token mode is 400, expected exactly 600" —
      // so startup is permanently broken and cannot be repaired by retrying, because the token is
      // never rewritten. A valid umask silently bricking the install is the worst class of bug this
      // gate looks for: correct code, correct config, permanently wrong result. fchmod ignores the
      // umask, and the mode is verified on the fd before anything is published (review round 12).
      fchmodSync(fd, 0o600);
      // RETAINED, so the winning path never re-reads the published file. `readToken` does an lstat,
      // a read and a full validation, every one of which can throw — and after `linkSync` the token
      // is public and write-once, so a transient failure there reported "publication failed" for a
      // token that is permanently published. Post-link, there is nothing left to learn from the
      // filesystem that we do not already hold in this variable (review round 13).
      generated = randomBytes(TOKEN_BYTES).toString("hex");
      writeAll(fd, Buffer.from(generated));
      fsyncSync(fd);   // a coordination input, not a derived cache: fsynced, unlike snapshots
      const mode = fstatSync(fd).mode & 0o7777;
      if (mode !== 0o600) {
        throw new AuthError(`refusing to publish a token candidate with mode ${mode.toString(8)}; expected exactly 600`);
      }
    } finally {
      closeSync(fd);
    }
    if (beforeLink) beforeLink();
    try {
      linkSync(candidate, tokenPath);
    } catch (err) {
      // Scoped to the link, which is the only place EEXIST carries this meaning: another writer
      // published the token first, we published nothing, and adopting theirs is correct.
      if (err.code !== "EEXIST") throw err;
      lostTheLink = true;
    }
    if (!lostTheLink) linked = true;   // IRREVERSIBLE from here: the token is public.
    // The candidate was durable; now make the PUBLICATION durable. Without the directory fsync
    // the link itself can vanish on power loss, leaving the durable bytes unreachable — the
    // "allocation/token are fsynced" claim in the findings doc covers the link, not just the data.
    if (linked) syncDir(dirname(tokenPath));
  } catch (err) {
    if (!linked) {
      preLinkError = err;
    } else {
      // Post-link failures must NOT surface as publication failures. The token is already public
      // and write-once, so reporting an error here would tell the caller to retry something that
      // can never be redone — the identical rule the write-once port allocation needed three rounds
      // to learn, applied to this file's own irreversible boundary.
      postLinkError = err;
    }
  }
  // Cleanup is its own step under the same rule — and only for a candidate WE created. Removing a
  // path this call did not create is not cleanup, it is deleting someone else's file.
  try {
    if (candidateOwned) removeCandidate(candidate);
  } catch (err) {
    // A cleanup failure never replaces a real cause: if the publication already failed, that error
    // is what the caller needs to see.
    if (!linked) preLinkError ??= err;
    else postLinkError ??= err;
  }
  if (preLinkError) throw preLinkError;
  // ONE stable shape, always. The previous version returned a bare string unless the caller opted
  // into `warnings: true`, which made the return type depend on an argument AND — worse — meant the
  // default call shape silently discarded `postLinkError`. A durability warning that only the
  // callers who already suspect a problem can see is not a warning; the common path is exactly the
  // one that needs to hear it (review round 13). A conditional return type is a trap regardless of
  // what it carries.
  //
  // The winner returns the token it generated; only the EEXIST loser reads the file, because only
  // the loser needs to learn a value it does not have.
  const token = linked ? generated : readToken(tokenPath);
  return { token, warning: postLinkError };
}

/**
 * Ownership/shape validation with INJECTED stat results — this is the required gate. Plan §4:
 * a mandatory test that needs root to construct a foreign-owned file makes the gate infeasible
 * on an ordinary dev machine, which is a different failure from a vacuous skip. The privileged
 * variant is separate integration evidence; THIS function is what must be provably correct, and
 * injection is what makes every branch reachable without privileges.
 */
export function validateTokenStat(st, { uid = process.getuid() } = {}) {
  if (!st) throw new AuthError("token file is missing");
  const fileMember = st.isFile;   // read once, same rule as the runtime-directory members above
  if (typeof fileMember === "function" ? !fileMember.call(st) : !fileMember) {
    throw new AuthError("token path is not a regular file (a symlink or directory in its place is an attack, not a config style)");
  }
  const tokenUid = st.uid;                 // read once each, same rule as the runtime directory above
  const tokenMode = st.mode & 0o7777;
  const tokenSize = st.size;
  if (tokenUid !== uid) throw new AuthError(`token is owned by uid ${tokenUid}, not ${uid}`);
  // EXACT 0600. The first version checked only group/world bits, which admitted 0700 — an
  // executable token is not more dangerous, but it is not a file this protocol wrote, and
  // "something else wrote your credential" is precisely what fail-closed exists to surface.
  // 0o7777 for the same reason as the runtime directory: 04600 is not 0600.
  if (tokenMode !== 0o600) {
    throw new AuthError(`token mode is ${tokenMode.toString(8)}, expected exactly 600`);
  }
  if (tokenSize !== TOKEN_HEX_LENGTH) {
    throw new AuthError(`token is ${tokenSize} bytes, expected ${TOKEN_HEX_LENGTH}; a short token is a truncated write, not a weaker credential`);
  }
  return true;
}

export function readToken(tokenPath) {
  validateTokenStat(lstatSync(tokenPath, { throwIfNoEntry: false }));
  const raw = readFileSync(tokenPath, "utf8");
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new AuthError("token content is not 64 lowercase hex chars; refusing to use it");
  }
  return raw;
}

/**
 * Token comparison with a single code path for every rejection.
 *
 * Both inputs are hashed and the DIGESTS compared with timingSafeEqual, so a wrong-length
 * presentation takes the same path as wrong bytes — there is no early return to observe, and
 * timingSafeEqual's own length-mismatch throw (itself a length oracle) can never fire because
 * digests are fixed-size. The earlier version returned early on length mismatch and merely
 * asserted both rejections LOOKED the same; review round 1 was right that this overclaimed
 * "constant-time" while containing a timing branch. Token length is public and fixed, so the
 * length is not a secret — but one code path is one code path, and now the comment matches it.
 */
export function tokenMatches(presented, actual, { compare = timingSafeEqual } = {}) {
  // The comparator is injectable ONLY so the single-code-path property can be asserted rather than
  // merely asserted-about. My mutation sweep added an early `if (lengths differ) return false`
  // and the whole suite stayed green — so the documented claim that wrong-length and wrong-byte
  // rejections share one path was, at that point, unpinned prose. The test now requires that the
  // comparator IS reached with two equal-length digests even for inputs of different lengths,
  // which no early-return version can satisfy.
  const digest = (v) => createHash("sha256").update(Buffer.from(String(v))).digest();
  return compare(digest(presented), digest(actual));
}
