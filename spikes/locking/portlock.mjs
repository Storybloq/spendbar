/**
 * T-008 — the primitive that replaced the lockfile: a kernel-held loopback port.
 *
 * `lock.mjs` (candidate B) is kept next door as evidence that the file-based design cannot work:
 * `lock.race.test.mjs` drives two contenders through the takeover window and BOTH enter. Every
 * race in it comes from having to reclaim stale filesystem state, and Node exposes no atomic
 * compare-and-delete with which to reclaim it safely.
 *
 * So don't reclaim anything. Hold a resource the kernel releases on process death:
 *
 *   bind 127.0.0.1:<port>  -> second bind gets EADDRINUSE while the holder lives
 *                          -> after SIGKILL the port is immediately rebindable, even when the
 *                             holder had an ESTABLISHED accepted connection (measured; TIME_WAIT
 *                             applies to the connection 4-tuple, not the listening socket)
 *                          -> nothing is left behind to race over
 *
 * THE HAZARD THIS FILE EXISTS TO CONTAIN: the kernel ties the port to the listening SOCKET, not
 * to the process. A stray close, an error path, or a dropped reference releases the lock while
 * this process is still doing protected work — the same bug as the lockfile, just relocated. So
 * the server is private and never handed out, release awaits the close callback, and a close this
 * process did not request permanently marks the lock LOST: `held` goes false, every later
 * `assertHeld()` throws, and the default `onLost` handler throws too.
 *
 * That is deliberately weaker than what this header used to claim ("FATAL rather than recoverable").
 * This module cannot stop a caller: a caller may supply an `onLost` that simply returns, and work
 * already in flight keeps running until it next asks. So the accurate division is that the
 * PRIMITIVE makes loss permanent and unmissable at the next check, and the CALLER owes it two
 * things — guard every irreversible commit with `assertHeld()`, and in `onLost` terminate or
 * irreversibly disable publishing. The findings document already assigns those to the downstream
 * tickets; the file-level claim was the stronger, false one (review round 15).
 *
 * `exclusive: true` is passed but is NOT what provides exclusion. Measured: two separate
 * processes get EADDRINUSE on the second bind with `exclusive` false exactly as with it true.
 * The guarantee comes from the kernel's address/port binding rule. The option only prevents
 * cluster handle-sharing, a mode spendbar does not use, so it is defence in depth with no test
 * asserting it — claiming otherwise would be an untestable claim.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import net from "node:net";

/** The lock was lost while still held. Never recoverable — see the file header. */
export class PortLockLost extends Error {}
/** The environment cannot support the primitive. Distinct from contention, deliberately. */
export class PortLockUnavailable extends Error {}
/**
 * The allocated port is held by something that is not us, or by something we cannot identify.
 * Its own class because the ONLY correct response is to refuse startup: it must not be caught
 * alongside environment errors, and it must never be handled by allocating a different port.
 */
export class PortLockForeignHolder extends Error {}

const HOST = "127.0.0.1";
/**
 * The IANA dynamic range, and the range macOS was MEASURED to use
 * (`net.inet.ip.portrange.first/last` = 49152-65535 on the gate machine).
 *
 * This is an OBSERVATION, and it is deliberately not the acceptance rule. It used to be both, and
 * review round 10 caught what that costs: Linux's default `net.ipv4.ip_local_port_range` is
 * 32768-60999, so a perfectly valid kernel assignment of, say, 45000 was rejected as "outside the
 * range spendbar requires" and startup failed on a correctly configured host. My own platform
 * measurements missed it completely, because they simulated `process.platform` — which changes
 * which tests run and nothing whatsoever about the kernel's ephemeral range. A portability claim
 * that a simulation cannot test is a claim that was never tested.
 */
export const DYNAMIC_MIN = 49152;
export const DYNAMIC_MAX = 65535;
/**
 * The ACCEPTANCE rule: any non-privileged port.
 *
 * What actually has to be true of an allocated port is that it is not a privileged or well-known
 * one — and a port the kernel handed out in response to `listen(0)` satisfies that by construction,
 * whatever range this host configures. Narrowing it further does not buy safety; it only makes a
 * correct kernel a failure.
 */
export const USABLE_MIN = 1024;
export const USABLE_MAX = 65535;
const CHALLENGE_TIMEOUT_MS = 2000;
/**
 * Ceiling for an injected challenge deadline. Generous enough for the tests that need a deadline
 * far from the measured behaviour (30s), small enough that a typo cannot park connections for a
 * day. `setTimeout` silently truncates past ~24.8 days, so anything above this is a bug either way.
 */
export const MAX_CHALLENGE_TIMEOUT_MS = 60_000;

/**
 * The one rule for every challenge deadline, because there are two entry points and only one of
 * them had it.
 *
 * `serveIdentity` validated its injected `challengeTimeoutMs`; the sibling `identifyHolder` passed
 * `timeoutMs` straight to `setTimeout`, where 0, a negative, NaN or Infinity fires immediately and
 * classifies a HEALTHY incumbent as indeterminate — a wrong answer to the one question this
 * protocol exists to answer — while a Symbol or BigInt rejects from timer setup with an error that
 * names neither the parameter nor the contract. Same class, same file, one of two sites, found in
 * review round 14. Extracted rather than copied so a third caller cannot repeat it.
 */
function assertTimeout(ms, what) {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_CHALLENGE_TIMEOUT_MS) {
    throw new PortLockUnavailable(
      `${what} must be a positive safe integer no greater than ${MAX_CHALLENGE_TIMEOUT_MS}; ` +
        `got ${typeof ms === "symbol" ? "a Symbol" : String(ms)}`,
    );
  }
  return ms;
}
/**
 * The identity reply is written AFTER the challenger's FIN, so the server must keep its writable
 * side open past the peer's half-close. This has to be a server option — assigning
 * `socket.allowHalfOpen` inside the connection handler is too late to change how the socket was
 * constructed, and the reply is then discarded.
 */
const HALF_OPEN = { allowHalfOpen: true };
/** Bumped whenever the transcript's shape changes, so old and new builds cannot authenticate. */
const PROTOCOL = "spendbar-portlock/1";

/**
 * The authenticated transcript, DOMAIN-SEPARATED.
 *
 * An HMAC over the nonce alone proves only that the responder holds the per-user token — not that
 * it is the same lock purpose, the same allocation, or even the same protocol version. Since one
 * token covers the whole user, a *different* spendbar endpoint would authenticate as the healthy
 * singleton and a starting process would exit believing the wrong thing was running. Every field
 * that distinguishes one lock from another therefore goes into the MAC, length-prefixed so
 * ("ab","c") and ("a","bc") cannot produce the same input.
 */
function transcript(token, { purpose, allocationId, nonce }) {
  // Required, not optional. String(undefined) is "undefined", so two callers that both omitted
  // these fields produced the SAME transcript and authenticated as each other — reproduced:
  // serveIdentity({}) + identifyHolder({}) answered "instance". Domain separation that a caller
  // can silently opt out of is not domain separation.
  for (const [name, v] of [["purpose", purpose], ["allocationId", allocationId]]) {
    if (typeof v !== "string" || v === "") {
      throw new PortLockUnavailable(`${name} must be a non-empty string; the identity domain cannot be left unset`);
    }
  }
  const h = createHmac("sha256", token);
  for (const part of [PROTOCOL, String(purpose), String(allocationId)]) {
    h.update(`${Buffer.byteLength(part)}:${part}\n`);
  }
  return h.update(nonce).digest();
}

/**
 * Fail-closed classification of a bind failure. Exported because it must be testable DIRECTLY.
 *
 * It was inlined at the bind site first, and the mutation sweep showed why that was wrong: every
 * port I could reliably make fail (port 1, out-of-range values) is rejected by the range guard
 * before `listen` is ever called, so the mutant "treat every bind error as contention" survived
 * the whole suite. The classification is real logic and needs its own test, not a test that
 * happens to route around it.
 *
 * ONLY EADDRINUSE is contention. Everything else — a sandbox forbidding loopback, a descriptor
 * limit, an address that does not exist — is an environment failure. Reporting those as
 * contention tells the user "another instance is running" and sends them hunting a process that
 * does not exist; worse, in the startup path it would route into holder diagnosis rather than a
 * named error.
 */
export function classifyBindError(code) {
  return code === "EADDRINUSE" ? "contention" : "environment";
}

/** The measured-macOS observation. Used by the environment-precondition test, never to reject. */
/**
 * Every accepted socket, tracked from the moment the server exists.
 *
 * `server.close()` stops accepting but WAITS for accepted connections to end, so any socket nobody
 * destroys pins the close forever. Tracking used to start inside `serveIdentity()`, which left a
 * real window: a client accepted between `acquire()` and identity registration was never recorded,
 * and `release()` then waited on it indefinitely. Reproduced before fixing — connect, let the accept
 * complete, register identity, release: it hung until killed, a local denial of service reachable by
 * any process that can reach the loopback port (review round 12).
 *
 * A WeakMap rather than a field on PortLock because `publishAllocation` closes servers too — the
 * losing candidate and the pre-publication error path — and those have no PortLock at all. One
 * mechanism for every close is the point; the previous split is what allowed one path to be fixed
 * while the others stayed broken.
 *
 * `net.Server` has no `closeAllConnections()` — that is `http.Server`, and assuming otherwise cost
 * a debugging session earlier in this ticket.
 */
const TRACKED = new WeakMap();

/**
 * Create a server that is watched BEFORE it can accept anything.
 *
 * Exported because a caller supplying its own reservation (the storm's children do) otherwise has
 * no way to hand over a server whose earlier connections are trackable. `net.Server` exposes no
 * list of accepted sockets — `getConnections()` returns a COUNT — so a socket accepted before we
 * attach a handler is unreachable forever, and `closeServer` would wait on it indefinitely.
 *
 * That is not hypothetical: round 13 reproduced it. `watchConnections` used to be called on the
 * injected server after it had already been listening, and the comment beside it even observed that
 * such a server "has been accepting since before this call" — the risk was written down and then
 * not handled, because attaching a `connection` listener does nothing about connections already
 * accepted. The loser path hung for the full bound.
 *
 * So the invariant is ENFORCED rather than hoped for: publishAllocation rejects a server it did not
 * see created. An unenforceable convention in a comment is what produced the bug.
 */
export function createWatchedServer() {
  const server = net.createServer(HALF_OPEN);
  watchConnections(server);
  return server;
}

/** Idempotent: adopting a server that publishAllocation already watched must not double-register. */
function watchConnections(server) {
  const existing = TRACKED.get(server);
  if (existing) return existing;
  const sockets = new Set();
  TRACKED.set(server, sockets);
  server.on("connection", (c) => {
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
  });
  return sockets;
}

/**
 * Last-resort disposal for a listener whose orderly close never completed.
 *
 * `closeServer` awaits the close callback, and that await is exactly what wedges when a connection
 * the tracker never saw is still open. A caller who bounds the close with a timer learns that it
 * failed, but racing a timer does not cancel the close — the server stays referenced and pins the
 * event loop, so a test runner that reports "release wedged" still hangs on exit and the diagnostic
 * never reaches anyone. Detaching the handle is the only thing that lets the failure be reported.
 *
 * This is disposal, NOT release: it abandons the port without publishing anything, so it is only
 * ever correct in teardown after an orderly release has already failed.
 *
 * It does NOT unref the server. The first version did, as defence in depth, and a mutant removing
 * that line survived — so it was measured rather than argued about: once `close()` has been
 * REQUESTED, the listening handle is already detached and the server alone no longer holds the loop
 * open. What holds it is the connections, which is why destroying them is the whole job. A test
 * built to make unref load-bearing could not be made to fail without it. Documented rather than
 * quietly kept: an unfalsifiable line reads as protection and provides none.
 */
export function disposeServer(server) {
  const sockets = TRACKED.get(server);
  if (sockets) {
    for (const c of sockets) c.destroy();
    sockets.clear();
  }
  // Detaches the listening handle if a close was never requested; harmless if one is in flight.
  try { server.close(); } catch { /* already closing */ }
}

/** The ONLY way this module closes a listener: destroy what it accepted, then close and await. */
function closeServer(server) {
  const sockets = TRACKED.get(server);
  if (sockets) {
    for (const c of sockets) c.destroy();
    sockets.clear();
  }
  return new Promise((resolve) => server.close(resolve));
}

export const inDynamicRange = (p) =>
  Number.isInteger(p) && p >= DYNAMIC_MIN && p <= DYNAMIC_MAX;

/** The acceptance rule applied to every port this module binds, adopts, or reads back. */
export const isUsablePort = (p) =>
  Number.isInteger(p) && p >= USABLE_MIN && p <= USABLE_MAX;

/**
 * Establish the ONE port every contender will agree on, WRITE-ONCE.
 *
 * The obvious version of this — bind port 0, read back what the kernel gave you, persist it — is
 * not a lock at all, and plan review round 4 caught it. Kernel exclusion only applies once every
 * contender is bidding for the SAME address and port; port 0 is precisely the absence of that
 * agreement. Measured with 8 real first-run children:
 *
 *     distinct candidate ports before publish : 8 of 8
 *
 * Eight listeners, eight processes each believing it held the singleton. That is candidate B's
 * split-owner failure wearing a different hat.
 *
 * So the allocation is published with `link()`, which never clobbers: exactly one child's
 * candidate becomes the allocation, and every loser closes its ephemeral listener and re-bids for
 * the winning port, where the kernel rule finally applies. Re-measured:
 *
 *     distinct AGREED ports : 1        holders : 1        blocked : 7
 *
 * WHY `link()` IS RIGHT HERE AND WRONG FOR THE LOCK. `lock.mjs` failed because a lock file must be
 * RECLAIMED — its owner dies, so somebody has to judge it abandoned and take it, and that judgement
 * cannot be made safely with the calls Node exposes. An allocation is **never** reclaimed. It is
 * write-once configuration that is supposed to outlive every process. "Never clobbers" is a fatal
 * limitation for a lock and exactly the property an allocation needs.
 *
 * There is deliberately NO automatic re-allocation. Re-allocating on collision reintroduces the
 * same race: several contenders would each pick a different replacement and start on different
 * ports. A foreign listener is a named error that refuses startup; rotation is an explicit offline
 * operation that first proves no instance is running.
 *
 * @returns {{port:number, published:boolean, server:net.Server|null, warning:Error|null}}
 *   `published` is true only for the process whose candidate won the link — useful to tests, never
 *   a grant of ownership; the bind decides that. `server` is the winner's RETAINED listener (null
 *   for a loser). `warning` is non-null when publication succeeded but a step after the link
 *   failed — currently only the durability fsync. It is reported rather than thrown because the
 *   link is irreversible: the caller owns the port regardless, and throwing would tempt a caller
 *   into releasing a listener the allocation permanently names.
 */
export async function publishAllocation(allocPath, { tag = randomBytes(8).toString("hex"), hooks = {}, server } = {}) {
  // A caller may hand in its OWN already-listening server (the storm's children do, so the
  // distinct-candidate state is constructed and observable in the test, not internal). Either
  // way the reservation is continuous: the socket that reserved the port is the socket the
  // winner keeps.
  // An injected reservation MUST come from createWatchedServer(). See that function for why this
  // cannot be a convention: sockets accepted before tracking starts are permanently unreachable,
  // and the close paths below would wait on them forever.
  if (server && !TRACKED.has(server)) {
    throw new PortLockUnavailable(
      "the supplied server was not created by createWatchedServer(); connections it accepted before " +
        "this call cannot be tracked, and closing it could then block forever",
    );
  }
  let probe = server ?? null;
  if (!probe) {
    probe = createWatchedServer();
    await new Promise((resolve, reject) => {
      // Removed on success, exactly as acquire() does. This listener is RETAINED and adopted as
      // the lock, so a bind-phase handler left attached would swallow the adopted listener's
      // first real error into a promise that has already settled — losing operational evidence
      // on the one socket whose failures matter most.
      const onError = (e) => reject(new PortLockUnavailable(`cannot bind an ephemeral port: ${e.code ?? e.message}`));
      probe.once("error", onError);
      probe.listen({ host: HOST, port: 0, exclusive: true }, () => {
        probe.removeListener("error", onError);
        resolve();
      });
    });
  }
  let port;
  try {
    port = probe.address().port;
    // Binding 0 asks for the CONFIGURED ephemeral range, which is a sysctl tunable — it does not
    // promise the IANA range. Measured on the dev machine as 49152-65535, but that is a
    // measurement, not an invariant, so the actual assignment is checked rather than assumed.
    if (!isUsablePort(port)) {
      throw new PortLockUnavailable(
        `kernel assigned ${port}, outside ${USABLE_MIN}-${USABLE_MAX}; a privileged or invalid ` +
          "port cannot hold an allocation",
      );
    }
    const { published, postLinkError } = publishCandidate(allocPath, tag, port, hooks);

    if (published) {
      // THE WINNER KEEPS ITS LISTENER. The first version closed the probe before publishing and
      // review round 1 was right that this poisons the protocol: in the close-to-rebind gap an
      // unrelated process can take the port, and the write-once allocation then PERMANENTLY
      // names a port the winner never owned — permanently, because re-allocation is forbidden
      // by design. The port named in the allocation has therefore been continuously bound by
      // its publisher since before publication; there is no window.
      //
      // And this return is UNCONDITIONAL on success of anything that happens after the link. No
      // read-back is consulted: `link()` created the path atomically from OUR candidate, and the
      // allocation is write-once, so a successful link already proves the file names `port`.
      // Making the retention conditional on a subsequent read (as the first version did) meant a
      // transient read failure closed the listener and stranded the allocation. A post-link
      // durability failure is reported on the result instead — the caller owns a live listener
      // either way, which is the property that must never be lost.
      return { port, published: true, server: probe, warning: postLinkError };
    }
    // Loser: its reserved port lost the election and is now worthless. Close and adopt.
    const agreed = readAllocation(allocPath);
    await closeServer(probe);
    return { port: agreed, published: false, server: null, warning: null };
  } catch (err) {
    // Reachable ONLY before publication succeeds — a bad ephemeral assignment, a candidate that
    // could not be written, or a loser whose read-back failed. In every one of those this process
    // owns no allocation, so releasing the port is correct. Once `published` is true the function
    // has already returned above and cannot arrive here; that ordering is the whole fix for the
    // stranded-allocation hole, so nothing may be added between the link and that return.
    await closeServer(probe);
    throw err;
  }
}

/**
 * Write the whole buffer; writeSync may legally write short, and a short write followed by link
 * would publish permanently-truncated coordination state through the write-once path.
 *
 * EXPORTED and injectable purely so the loop is testable. My own mutation sweep found that
 * replacing the `while` with an `if` left the whole suite green — real writes to a local file never
 * return short, so nothing exercised the loop. `auth.mjs`'s writeAll already took injection for
 * this exact reason; this one had the same hazard and none of the coverage.
 */
export function writeAllSync(fd, buf, { write = writeSync } = {}) {
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new PortLockUnavailable(`write made no progress at offset ${off}`);
    off += n;
  }
}

function fsyncDirOf(path) {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publishCandidate(allocPath, tag, port, hooks = {}) {
  // EVERY hook is resolved BEFORE the link, never after it.
  //
  // Third time for this same bug, and the reason it kept recurring is that I kept fixing the
  // statement instead of the rule. Round 6: the fsync threw. Round 7: the rmSync in a bare
  // `finally` threw. Round 8: `hooks.removeCandidate ?? ...` was evaluated after the link, and a
  // getter or Proxy trap on `hooks` throws during the PROPERTY ACCESS itself — escaping the
  // post-link capture just like its two predecessors, closing the retained listener, and stranding
  // the allocation on an unbound port.
  //
  // Reading them up here makes the rule structural rather than a thing to remember: after
  // `linkSync` there is nothing left to evaluate that could throw except calls already inside the
  // capture.
  const afterCandidateWrite = hooks.afterCandidateWrite;
  const afterLink = hooks.afterLink;
  const removeCandidate = hooks.removeCandidate ?? ((p) => rmSync(p, { force: true }));
  // Injectable for the same reason every other boundary operation here is: a non-EEXIST link
  // failure (EACCES, ENOENT, EMFILE, EXDEV) is a real filesystem outcome whose cleanup path was
  // unreachable from a test, and an unreachable path is an unverified one. Resolved up here with
  // the rest, so it cannot throw during property access after the candidate exists.
  const link = hooks.link ?? linkSync;

  // Complete file first, then publish by linking. The allocation pathname is therefore never
  // observable holding a partial record — the failure mode that made the lockfile's
  // open("wx")-then-write version destroy live locks on its happy path.
  const candidate = `${allocPath}.${tag}.tmp`;
  const fd = openSync(candidate, "wx", 0o600);
  // The guard opens the instant the candidate EXISTS. Everything between here and the link can
  // throw — the fchmod, the write, the fsync, the mode check, the `afterCandidateWrite` hook — and
  // every one of those paths used to leave an owned `.tmp` beside the allocation, because the only
  // cleanup ran after the link attempt. The sibling path in auth.mjs learned this in round 11 and
  // this one had not (review round 14); it is the same "the guard must cover every statement that
  // can throw, not the ones in view" rule, on its fourth site.
  try {
  try {
    // fchmod AFTER open. The mode argument to open() is filtered through the process umask, so it
    // is a REQUEST, not a setting — and `readAllocation` below demands EXACTLY 0600.
    //
    // Measured: under `umask 0200` the candidate is created 0400, `link()` publishes that mode
    // WRITE-ONCE, and every subsequent `readAllocation()` throws "expected exactly 600" forever.
    // The publisher reports success and the next startup can never read the allocation it just
    // wrote. Unrepairable by retry, because the allocation is never rewritten.
    //
    // FOUND IN REVIEW ROUND 13, one round after the identical bug was fixed in `publishToken` and
    // the very same round in which "fixing a class in one place and not its siblings" was written
    // into the findings document as this ticket's most persistent defect. I fixed the instance I
    // was shown instead of searching for the class — again.
    //
    // The audit claimed here in round 13 — "every file-creating call in the spike was checked, and
    // this was the only other one whose mode is later asserted" — was itself too narrow, and round
    // 14 proved it: `publish.mjs` created snapshots with `writeFileSync` and no mode at all, so they
    // committed 0644 under the ordinary umask and every local user could read the account's usage
    // data. The qualifier "whose mode is later asserted" is exactly what let it through — I audited
    // for files that would FAIL a later check rather than for files created without a mode, which is
    // the actual hazard. Fixed there in round 14; the rule is now that every file this spike creates
    // is opened, fchmod'd and verified on the fd. (`lock.mjs` has the same shape and is deliberately
    // left alone: it is the recorded evidence of the REJECTED design, and repairing it would alter
    // the artefact.)
    fchmodSync(fd, 0o600);
    writeAllSync(fd, Buffer.from(JSON.stringify({ port, version: 1 })));
    fsyncSync(fd);
    // Verified on the fd before anything irreversible happens: fail closed rather than publish a
    // permanently unreadable allocation.
    const mode = fstatSync(fd).mode & 0o7777;
    if (mode !== 0o600) {
      throw new PortLockUnavailable(`refusing to publish an allocation candidate with mode ${mode.toString(8)}; expected exactly 600`);
    }
  } finally {
    closeSync(fd);
  }
  if (afterCandidateWrite) afterCandidateWrite(candidate);
  } catch (err) {
    // Pre-link, so we published nothing and own the candidate outright. Removing it must not
    // replace the real cause: a cleanup failure here is strictly less informative than the error
    // that got us here.
    try { removeCandidate(candidate); } catch { /* the original error is the one worth reporting */ }
    throw err;
  }
  let published = false;
  let postLinkError = null;
  let preLinkError = null;
  try {
    link(candidate, allocPath);
    // IRREVERSIBLE from this line on. The allocation now permanently names this process's port,
    // and there is no re-allocation by design.
    published = true;
    if (afterLink) afterLink(candidate);
    // Directory fsync: the candidate's bytes were durable before the link; this makes the LINK
    // durable. Coordination state gets the fsync the snapshots deliberately do not (plan §3.5.4
    // scopes the no-fsync decision to the derived cache, not to this).
    fsyncDirOf(allocPath);
  } catch (err) {
    // A failure BEFORE the link means we published nothing: EEXIST is the ordinary "someone else
    // won" outcome, anything else is a real error. A failure AFTER the link is categorically
    // different and must NOT propagate as a plain throw — see publishAllocation. Review round 6
    // found the old code rethrowing here, which sent the caller into a generic catch that closed
    // the listener while the allocation stayed on disk: a permanent allocation naming an unbound
    // port, free for any unrelated process to take, and unfixable because re-allocation is
    // forbidden. That is the exact split-owner failure this whole protocol exists to prevent.
    if (!published) {
      // CAPTURED, not thrown. Throwing here exits before the cleanup step below, so every non-EEXIST
      // link failure — EACCES, ENOENT, EMFILE, EXDEV — stranded the candidate we had just created.
      // The round-14 guard covered the write path and stopped at the link, which is the same
      // partial-fix shape as every other instance: I guarded the statements I had been shown a
      // failure in. Cleanup now runs for every unpublished outcome and the original error is
      // rethrown after it (review round 15).
      if (err.code !== "EEXIST") preLinkError = err;
    } else {
      postLinkError = err;
    }
  }
  // CLEANUP IS ITS OWN STEP, and its failure obeys the same rule as every other post-link failure.
  //
  // This was a `finally { rmSync(...) }`, which sits OUTSIDE the capture above — so an rmSync that
  // threw after a successful link escaped straight past it into publishAllocation's catch, which
  // closed the retained listener and rethrew. Exactly the stranded-allocation failure the capture
  // was added to eliminate, surviving one layer out. Review round 7 found it, and the lesson is the
  // one this file keeps re-learning: the fix has to be the RULE ("nothing after the link may throw")
  // applied to every statement after the link, not a guard wrapped around the statements I happened
  // to be looking at.
  //
  // Before publication a cleanup failure is genuinely fatal — we own nothing, so there is no
  // listener worth preserving and the caller should hear about it.
  try {
    removeCandidate(candidate);
  } catch (err) {
    if (!published) preLinkError ??= err;
    else postLinkError ??= err;
  }
  if (preLinkError) throw preLinkError;
  return { published, postLinkError };
}

/**
 * Read the allocation, failing closed on anything unexpected.
 *
 * This file is correctness-critical coordination state, not a discovery hint — I framed it as the
 * latter and review round 4 corrected it. If two processes can observe different values, the
 * machine has two valid port locks. So nothing here repairs, defaults, or heals: a malformed
 * allocation is an error, because the alternative is silently minting a second singleton.
 */
export function readAllocation(allocPath) {
  // NOT converted to single-read locals, deliberately, and recorded so the next sweep does not
  // re-litigate it. The validators in auth.mjs and the credential probe were fixed because their
  // inputs are CALLER-SUPPLIED — injected stats and foreign socket objects are the documented,
  // supported input there, so an accessor can run between two reads and return different values.
  // Here `st` is a real fs.Stats from the lstat two lines down and `parsed` comes from JSON.parse
  // with no reviver: both are plain data, no accessor exists to run, and re-reading is a textual
  // duplicate rather than a second observation. Converting it would spread the appearance of the
  // rule to a place the rule does not apply, which makes the real instances harder to spot.
  const st = lstatSync(allocPath, { throwIfNoEntry: false });
  if (!st) throw new PortLockUnavailable(`no allocation at ${allocPath}`);
  if (!st.isFile()) throw new PortLockUnavailable(`allocation at ${allocPath} is not a regular file`);
  if (st.uid !== process.getuid()) throw new PortLockUnavailable(`allocation at ${allocPath} is owned by uid ${st.uid}`);
  // EXACT 0600 — "no group/world bits" admitted 0700, which this protocol never writes, and a
  // mode we never write means something else wrote the file we are about to trust. Masked at
  // 0o7777, not 0o777, so setuid/setgid/sticky cannot slip through the same reasoning (04600 is
  // not 0600 either).
  if ((st.mode & 0o7777) !== 0o600) {
    throw new PortLockUnavailable(`allocation at ${allocPath} has mode ${(st.mode & 0o7777).toString(8)}, expected exactly 600`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(allocPath, "utf8"));
  } catch (err) {
    throw new PortLockUnavailable(`allocation at ${allocPath} is not valid JSON: ${err.message}`);
  }
  if (parsed?.version !== 1) {
    throw new PortLockUnavailable(`allocation at ${allocPath} has version ${parsed?.version}, expected 1; a version this build does not know is not a version it may guess about`);
  }
  if (!isUsablePort(parsed.port)) {
    throw new PortLockUnavailable(`allocation at ${allocPath} holds port ${parsed.port}, outside ${USABLE_MIN}-${USABLE_MAX}`);
  }
  return parsed.port;
}

/**
 * Ask whoever holds a port to prove it is us, over the shared 0600 token.
 *
 * EADDRINUSE on its own says only "occupied" — it cannot tell a healthy spendbar instance from
 * an unrelated program that happens to hold the port, and those need opposite responses (exit
 * quietly vs. refuse startup with a named foreign-holder error). A plaintext greeting would be spoofable by anything that can bind the
 * port, so the reply is an HMAC over a nonce the challenger chose.
 *
 * Returns "instance" | "foreign" | "indeterminate". NONE of these ever rotates or rewrites the
 * allocation: "foreign" means refuse startup with a named error, because automatic re-allocation
 * recreates the split-owner race (see publishAllocation). "indeterminate" is a real outcome and
 * never collapses into either of the others: a timeout means we do not know, and acting on a
 * guess is how a live instance gets evicted.
 */
export const NONCE_BYTES = 32;

export function identifyHolder(port, token, { purpose, allocationId, timeoutMs = CHALLENGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    // Inside the executor, so an invalid deadline REJECTS rather than throwing synchronously out of
    // a promise-returning function. The distinction is not cosmetic: a caller written as
    // `identifyHolder(...).catch(...)` never sees a synchronous throw, so validating outside would
    // trade one uncaught failure mode for another. Checked before the socket is opened either way.
    assertTimeout(timeoutMs, "timeoutMs");
    const nonce = randomBytes(NONCE_BYTES);
    const expected = transcript(token, { purpose, allocationId, nonce });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done("indeterminate"), timeoutMs);
    const sock = net.connect({ host: HOST, port });
    const chunks = [];
    sock.on("connect", () => sock.end(nonce));   // FIN marks the request boundary
    sock.on("data", (d) => {
      chunks.push(d);
      const got = Buffer.concat(chunks);
      if (got.length < expected.length) return;
      // Length is checked separately because timingSafeEqual THROWS on a length mismatch, and a
      // throw is itself a length oracle. Both paths return the same answer.
      done(got.length === expected.length && timingSafeEqual(got, expected) ? "instance" : "foreign");
    });
    // A refused connection means the port was released between our bind attempt and now. That is
    // not evidence of a foreign holder, so it must not be reported as one.
    sock.on("error", () => done("indeterminate"));
    sock.on("close", () => done("indeterminate"));
  });
}

/**
 * THE STARTUP ORCHESTRATION — the piece the gate's headline claims actually rest on.
 *
 * Review round 6 was right that this was missing. `publishAllocation`, `PortLock.acquire` and
 * `identifyHolder` were each tested in isolation, while T-008's acceptance criteria and the
 * findings document both asserted the *composed* behaviour: that a foreign holder produces a named
 * startup refusal and never causes re-allocation. Nothing drove that path, so the surviving mutant
 * was a startup routine that receives "foreign" and cheerfully carries on — or, far worse, picks
 * another port and mints a second singleton. Every existing test stayed green either way, because
 * no test was the caller.
 *
 * Composed here so it can be driven, and so T-011 inherits a shape rather than a description.
 *
 * @returns {{role:"holder", port, lock, warning}} when this process is the singleton, or
 *   {{role:"already-running", port}} when a verified instance of OURS already holds it.
 * @throws {PortLockForeignHolder} when the holder is not ours, or cannot be identified. NEITHER
 *   case re-allocates: "indeterminate" is not quietly folded into either answer, because a
 *   challenge that timed out means we do not know, and evicting a live instance on a guess is the
 *   split-owner failure arriving by a politer route.
 */
export async function startSingleton(allocPath, token, { purpose, allocationId, timeoutMs, onLost } = {}) {
  /**
   * A holder that cannot identify itself is, to the next start, indistinguishable from a foreign
   * process — so registration is part of BECOMING the holder, not an extra step the caller is
   * trusted to remember. Review round 7: startSingleton returned holders that never registered, so
   * two ordinary starts would have classified the healthy incumbent as "indeterminate" and refused.
   * The test that was supposed to cover this called serveIdentity by hand and so proved nothing.
   */
  const serving = (lock) => { lock.serveIdentity(token, { purpose, allocationId }); return lock; };
  // Validate the identity domain BEFORE anything is published. A holder that starts and only then
  // discovers it cannot describe itself is indistinguishable, from outside, from a foreign process.
  transcript(token, { purpose, allocationId, nonce: Buffer.alloc(0) });
  let outcome;
  try {
    outcome = await publishAllocation(allocPath, {});
  } catch (err) {
    if (!(err instanceof PortLockUnavailable) || !existsSync(allocPath)) throw err;
    // The allocation already exists and our ephemeral candidate lost or could not be established;
    // fall through to bidding for the agreed port.
    outcome = { port: readAllocation(allocPath), published: false, server: null, warning: null };
  }

  if (outcome.published) {
    // Continuous hold: the listener that reserved the port becomes the lock without ever closing.
    try {
      return { role: "holder", port: outcome.port, lock: serving(new PortLock({ onLost }).adopt(outcome.server)), warning: outcome.warning };
    } catch (err) {
      // adopt() refuses a listener that is no longer bound (round 5's fix). In that case there is
      // nothing left to hold — but if it ever refuses for any OTHER reason, the retained listener
      // would be bound with no reference to it anywhere, which is the leak shape this file spends
      // most of its length preventing. Closing here is unconditional and costs nothing when the
      // server was already dead.
      await closeServer(outcome.server);
      throw err;
    }
  }

  const lock = new PortLock({ onLost });
  if (await lock.acquire(outcome.port) === "acquired") {
    return { role: "holder", port: outcome.port, lock: serving(lock), warning: null };
  }

  // Occupied. WHO holds it decides everything, and only the authenticated answer counts.
  // (Every holder above registered serveIdentity, so a healthy incumbent CAN answer this.)
  const who = await identifyHolder(outcome.port, token, { purpose, allocationId, timeoutMs });
  if (who === "instance") return { role: "already-running", port: outcome.port };
  throw new PortLockForeignHolder(
    `the allocated port ${HOST}:${outcome.port} is held by ${who === "foreign" ? "a process that is not spendbar" : "a holder that did not answer the identity challenge"}; ` +
      "refusing to start. The allocation is write-once and is deliberately NOT replaced: allocating " +
      "a different port here would let two instances run at once, which is the failure this design exists to prevent.",
  );
}

export class PortLock {
  /** Private and never returned: no caller can close what it cannot reach. */
  #server = null;
  /** The listener whose close is in flight; see `release()` and `__forceDispose()`. */
  #closing = null;
  #port = null;
  #released = false;
  #lost = null;
  #onLost;
  /** Live challenge connections, so release() can end them instead of waiting on them. */

  /**
   * @param onLost called if the listener closes without `release()` having asked it to. The
   *   default throws on the next tick, because the safe response to unprovable exclusivity is to
   *   crash, not to continue holding a lock that is gone. Tests override it to observe the event.
   */
  constructor({ onLost } = {}) {
    this.#onLost = onLost ?? ((err) => { throw err; });
  }

  /**
   * A PortLock is SINGLE-USE. Re-acquiring after release used to "succeed" while `held` stayed
   * false and `release()` returned false — reproduced: the second listener was bound and then
   * leaked until process exit, with the object insisting it held nothing. Rebinding is a fresh
   * lock's job; reusing a spent object hides which listener is live.
   */
  #assertFresh(what) {
    // Loss is checked FIRST. After an unexpected close #server is still set, so an
    // #server-first order reported "already holding" for a lock that is provably not held —
    // the least accurate of the three available diagnoses, for the most dangerous state.
    if (this.#lost) throw this.#lost;
    if (this.#released) throw new Error(`this lock was already released; ${what}() on a spent lock would bind a listener it could never release — construct a new PortLock`);
    if (this.#server) throw new Error(`already holding; ${what}() is not re-entrant`);
  }

  get port() { return this.#port; }
  /** True only while this process can still prove it is the sole holder. */
  get held() { return this.#server !== null && !this.#released && this.#lost === null; }
  get lostReason() { return this.#lost; }

  /**
   * Adopt an ALREADY-BOUND listener as the lock — the publication winner's path. The winner has
   * held its port continuously since before the allocation named it; closing that listener to
   * "acquire properly" would open exactly the poisoning window the redesign removed. Wires the
   * same unexpected-close fatality as acquire().
   */
  adopt(server) {
    this.#assertFresh("adopt");
    // VALIDATE BEFORE MUTATING. The first version assigned #server and then read
    // `server.address().port` — so adopting a listener that had already closed threw a TypeError
    // on the null address while #server stayed set, leaving the lock reporting `held === true`
    // with nothing bound. Worse, the close event had already fired, so no loss witness could ever
    // correct it: a permanently false claim of exclusivity, which is the exact failure this whole
    // file exists to make impossible. Found in review round 5.
    const addr = server.listening ? server.address() : null;
    if (!addr || typeof addr !== "object" || addr.address !== HOST || !isUsablePort(addr.port)) {
      throw new PortLockLost(
        `refusing to adopt a listener that is not bound to ${HOST} on a usable port ` +
          `(listening=${server.listening}, address=${JSON.stringify(addr)}); the port it reserved ` +
          "is gone, and adopting it would claim exclusivity this process cannot prove",
      );
    }
    // REFUSED, not silently watched. `watchConnections` here only starts tracking at adoption time,
    // so a raw server that had already accepted an idle socket handed the lock a connection nothing
    // could reach: `release()` waits for it forever and `__forceDispose()` cannot destroy what the
    // tracker never saw. That is precisely the wedge `publishAllocation` was taught to refuse in
    // round 13 — and adopt(), its sibling entry point, kept accepting it for two more rounds
    // (review round 15). Both doors now have the same lock.
    if (!TRACKED.has(server)) {
      throw new PortLockUnavailable(
        "adopt() requires a server created by createWatchedServer(); connections accepted before " +
          "adoption cannot be tracked, and release() could then block forever",
      );
    }
    server.once("close", () => {
      if (this.#released) return;
      this.#lost = new PortLockLost(
        `the lock on ${HOST}:${this.#port} closed without release(); this process can no longer prove ` +
          "it is the only holder and must not continue its protected work",
      );
      this.#onLost(this.#lost);
    });
    // Only now does this object claim to hold anything.
    this.#server = server;
    this.#port = addr.port;
    return this;
  }

  /**
   * One attempt. Resolves "acquired" or "occupied"; throws PortLockUnavailable for anything that
   * is an environment problem rather than contention.
   *
   * No retry loop. Retrying turns "exactly one winner" into "everyone wins eventually", which
   * makes a contention test look green while proving nothing about mutual exclusion.
   */
  async acquire(port) {
    this.#assertFresh("acquire");
    if (!isUsablePort(port)) throw new PortLockUnavailable(`port ${port} is outside ${USABLE_MIN}-${USABLE_MAX}`);
    // One creation path, watched before it can accept anything.
    const server = createWatchedServer();
    // Errors after a successful listen must not be swallowed by the acquire-time handler.
    const outcome = await new Promise((resolve, reject) => {
      const onError = (err) => {
        if (classifyBindError(err.code) === "contention") return resolve("occupied");
        reject(new PortLockUnavailable(`cannot bind ${HOST}:${port}: ${err.code ?? err.message}`));
      };
      server.once("error", onError);
      server.listen({ host: HOST, port, exclusive: true }, () => {
        server.removeListener("error", onError);
        resolve("acquired");
      });
    });
    if (outcome !== "acquired") return outcome;

    this.#server = server;
    this.#port = port;
    // From here the listener closing is the lock vanishing. Nothing else in this file may treat
    // that as ordinary.
    server.once("close", () => {
      if (this.#released) return;
      this.#lost = new PortLockLost(
        `the lock on ${HOST}:${port} closed without release(); this process can no longer prove ` +
          "it is the only holder and must not continue its protected work",
      );
      this.#onLost(this.#lost);
    });
    return "acquired";
  }

  /**
   * Serve the identification challenge (§3.4). Reply is an HMAC over the challenger's nonce, so
   * the answer cannot be replayed against a different nonce or forged without the token.
   */
  /**
   * @param challengeTimeoutMs how long an accepted challenge connection may stay idle before it is
   *   dropped. Injectable ONLY so tests can separate "released promptly" from "waited the deadline
   *   out" by orders of magnitude instead of by a few hundred milliseconds — a threshold close to
   *   the real deadline is a wall-clock performance bar wearing a semantic label, and can fail
   *   correct code on a descheduled runner (review round 10).
   */
  serveIdentity(token, { purpose, allocationId, challengeTimeoutMs = CHALLENGE_TIMEOUT_MS } = {}) {
    if (!this.held) throw new Error("refusing to answer identity challenges without holding the lock");
    // VALIDATED AT REGISTRATION, because it is injectable state on a security-relevant path and an
    // unchecked value fails in three distinct ways, none of them at the point of the mistake:
    // a Symbol or BigInt throws from inside the `connection` handler and takes the holder down;
    // 0, negative, NaN or Infinity are silently clamped by setTimeout to fire immediately, so every
    // challenge is dropped before it can be answered and a healthy instance becomes indistinguishable
    // from a dead one; and an arbitrarily large value widens the idle-connection window without
    // bound. Registration is the only place all three are cheap to catch — the same "fail where the
    // mistake is, not where it surfaces" rule the identity-domain check above already follows
    // (review round 11).
    assertTimeout(challengeTimeoutMs, "challengeTimeoutMs");
    // Fail at REGISTRATION, not at the first challenge: a server that starts and only later
    // refuses to identify itself looks, from outside, exactly like a foreign holder.
    transcript(token, { purpose, allocationId, nonce: Buffer.alloc(0) });
    this.#server.on("connection", (c) => {
      // Tracked so release() can end connections rather than wait on them.
      //
      // This tracking IS load-bearing, and is pinned — see the note beside `release()`. It carried
      // an "untested defence in depth" disclaimer for several rounds after three mutation attempts
      // survived; those attempts failed because the test measured against the hard-coded 2000ms
      // challenge deadline, not because the property was untestable. Injecting the deadline
      // separated correct behaviour from the mutant by three orders of magnitude and the mutant now
      // dies. Left here as a pointer because a stale disclaimer understates real coverage, and a
      // reader who believes it will not trust a guarantee they actually have (review round 11).
      const drop = () => c.destroy();
      // A challenger that connects and says nothing must not pin the connection open either.
      const deadline = setTimeout(drop, challengeTimeoutMs);
      // BUFFER to exactly NONCE_BYTES. TCP is a byte stream: the first 'data' event may carry a
      // fragment of the nonce (a valid holder would then MAC a partial nonce and be classified
      // foreign — a correctness bug, found in review) or the nonce plus trailing garbage (which
      // must be a protocol violation, not silently ignored input).
      // Reply only at the REQUEST BOUNDARY (the challenger half-closes after its nonce), never
      // at "32 bytes have arrived". Replying on the byte count made over-long rejection
      // segmentation-dependent: a 33-byte request delivered as 32+1 got its HMAC sent before the
      // trailing byte arrived, so "over-long requests are dropped" held only for the framings the
      // test happened to produce.
      const chunks = [];
      let got = 0;
      c.on("data", (d) => {
        chunks.push(d);
        got += d.length;
        if (got > NONCE_BYTES) { clearTimeout(deadline); drop(); }   // cannot become valid
      });
      c.on("end", () => {
        clearTimeout(deadline);
        if (got !== NONCE_BYTES) return drop();
        c.end(transcript(token, { purpose, allocationId, nonce: Buffer.concat(chunks) }));
      });
      c.on("close", () => clearTimeout(deadline));
      c.on("error", drop);
    });
  }

  /**
   * Throws if lock loss has been OBSERVED. Call it before protected work as damage limitation —
   * and understand precisely what it is not: the kernel releases the port before JavaScript is
   * dispatched the close event, so a contender may already hold the port while #lost is still
   * null and this still returns true. It cannot race backwards (once loss is observed it is
   * permanent), but it is NOT fencing; a commit whose correctness depends on exclusion at the
   * instant of the write needs atomic commit semantics of its own (plan §3.3, §3.5).
   */
  assertHeld() {
    if (this.#lost) throw this.#lost;
    if (!this.held) throw new PortLockLost("lock is not held");
    return true;
  }

  /**
   * TEST ONLY. Closes the listener the way a stray error path would — without going through
   * `release()` — so the lock-loss detector can be proven to fire.
   *
   * This exists because the server is private for exactly the reason that makes the failure hard
   * to test: no caller can reach it. Simulating the close from outside the class would test the
   * simulation. Named `__` so it cannot be mistaken for API, and it is the ONLY way in.
   */
  async __forceUnexpectedClose() {
    const server = this.#server;
    if (!server) throw new Error("not holding");
    await new Promise((resolve) => server.close(resolve));
  }

  /** Idempotent, and awaits the close callback — "requested close" is not "closed". */
  async release() {
    if (!this.#server || this.#released) return false;
    this.#released = true;
    const server = this.#server;
    this.#server = null;
    // Held until the close RESOLVES, not until it is requested. `#server` is nulled above so the
    // lock reads as not-held immediately, which is correct — but it also made a wedged close
    // unreachable from outside, and a wedged close is precisely the state someone needs to reach in
    // to dispose of (review round 13). The child-exit branch of bootstrap.test.mjs already forcibly
    // detached its handles on timeout; the lock branch beside it had nothing to detach with.
    this.#closing = server;
    // Destroy tracked challenge connections FIRST. `server.close()` stops accepting but waits for
    // existing connections to end, so a client that simply never closes its socket would make
    // release hang while still holding the port.
    //
    // This was recorded for several rounds as untested defence in depth, because three mutations
    // removing it all survived. They survived for a reason worth keeping: the test measured against
    // the hard-coded 2000ms challenge deadline, so the mutant released at ~2000ms and any threshold
    // loose enough to tolerate scheduler noise was also loose enough to admit it. Making the
    // deadline injectable (`serveIdentity({ challengeTimeoutMs })`) separates correct behaviour from
    // the mutant by three orders of magnitude, and it is now pinned. The general lesson: a mutant
    // that survives every threshold usually means the wrong quantity is being measured.
    try {
      await closeServer(server);
    } finally {
      this.#closing = null;
    }
    return true;
  }

  /**
   * Detach the underlying listener after an orderly `release()` has failed to complete.
   *
   * Test-and-teardown affordance, named `__` like `__forceUnexpectedClose` so it cannot be mistaken
   * for API. Returns whether there was anything to dispose of, so a caller can tell "the wedge was
   * cleaned up" from "there was no wedge and the diagnostic is about something else".
   */
  __forceDispose() {
    const server = this.#server ?? this.#closing;
    if (!server) return false;
    this.#server = null;
    this.#closing = null;
    this.#released = true;
    disposeServer(server);
    return true;
  }
}
