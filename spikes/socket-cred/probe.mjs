/**
 * T-008 Question 2 — can Node read the peer UID of a Unix-domain-socket connection on macOS
 * without a native build?
 *
 * The answer this probe supports is "no, within Node 22's supported public API" — scoped
 * deliberately, and resting on TWO legs, because neither alone is a measurement:
 *
 *   1. A NAME INVENTORY (that is all a scan can be — review round 1 was right that calling it a
 *      capability detector overclaimed): the full prototype chain, string AND Symbol keys, is
 *      matched against credential-suggestive names. This can false-positive (SO_PEERCRED as an
 *      inert constant) and false-negative (a real capability named getConnectionIdentity), so it
 *      NOMINATES candidates; it decides nothing.
 *   2. SEMANTIC VERIFICATION of every candidate: a nominated member must be invocable (or
 *      readable) and actually YIELD a numeric uid to count. An inert constant does not; a fake
 *      injected capability that returns {uid} does — and the test suite requires both behaviours,
 *      which is what makes the "no" falsifiable.
 *
 * The residual blind spot — a genuine capability under a name the inventory misses — cannot be
 * closed by any scanner without calling every function on the surface. It is closed instead by
 * the recorded review of Node 22's DOCUMENTED net.Socket API (the reviewed surface is printed by
 * this probe and recorded in the findings doc): the documented surface contains no peer-credential
 * member of any name.
 *
 * Run directly (`npm run spike:socket-cred`) to print the finding.
 */
import net from "node:net";

// `peer.?uid` / `peer.?eid` rather than the literal spellings: the inventory must nominate
// `peer_uid` and `peerUid` as readily as `peeruid`, or a real capability is missed at the
// NOMINATION stage and never reaches semantic verification at all (review round 6).
const PATTERN = /cred|ucred|peer.?uid|peer.?eid|getpeereid|so_peer|local_peer/i;
/**
 * `_getpeername` matches nothing above, but near-misses are worth surfacing for the record;
 * this second net catches anything peer-ish so the doc can list what WAS found and why it is
 * not a credential API (an address is not a credential).
 */
const NEARBY = /peer/i;

/** Every key — string and Symbol — at every level of the prototype chain. */
export function enumerateSurface(obj) {
  // An ARRAY keyed by identity, not a Map keyed by rendered name. Two distinct Symbols can share
  // a description, so name-keying let an inert Symbol("peerCred") hide a real capability stored
  // under a *different* Symbol("peerCred") — which contradicts the full-surface claim this
  // function exists to make. String names still dedupe (shadowing is real); Symbols never do.
  const seenStrings = new Set();
  const entries = [];
  let depth = 0;
  for (let o = obj; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o), depth++) {
    for (const k of Reflect.ownKeys(o)) {
      if (typeof k === "symbol") {
        entries.push({ key: k, name: `Symbol(${k.description ?? ""})`, depth });
      } else if (!seenStrings.has(k)) {
        seenStrings.add(k);
        entries.push({ key: k, name: k, depth });
      }
    }
  }
  return entries;
}

/**
 * Names that mean a UID SPECIFICALLY, as opposed to credentials generally.
 *
 * The distinction carries the whole false-positive/false-negative split. `SO_PEERCRED` is a
 * setsockopt option NUMBER — an integer under a credential-ish name that yields nothing. But
 * `peerUid` is an integer under a name that says exactly what the integer is, and treating it as
 * inert would be a FALSE NEGATIVE on the most plausible shape a real API could take. Review round
 * 6 found the probe doing precisely that, which matters because a false negative here is what the
 * gate's recorded "NO" would be resting on.
 */
const UID_SPECIFIC = /peer.?uid|peer.?eid|getpeereid/i;
const isUid = (v) => Number.isInteger(v) && v >= 0;

/**
 * Read `.uid` EXACTLY ONCE from a candidate credential object and return what was read.
 *
 * The predecessor was a boolean `looksLikeCredential(value)` that read `value.uid` to validate it,
 * after which every caller read the same getter AGAIN to build the result message. Round 12 added a
 * try/catch around the boolean and a local for the value, and I described that as "read once" — it
 * was not. Both branches still read twice, so a getter returning 501 and then throwing turned a
 * verified capability into an error, and one returning 501 and then 0 recorded a uid that had never
 * been verified. Review round 13 caught the claim and the code disagreeing.
 *
 * Returning the captured value instead of a boolean is what makes single-read structural rather
 * than a thing each caller has to remember — the same shape as resolving hooks before the link.
 *
 * @returns {{uid: number}|null|{error: Error}} the captured uid, null if this is not a credential
 *   object, or the error the getter threw.
 */
function readCredentialUid(value) {
  if (value === null || typeof value !== "object") return null;
  let uid;
  try {
    uid = value.uid;          // THE single read. Nothing below re-reads the property.
  } catch (error) {
    return { error };
  }
  return isUid(uid) ? { uid } : null;
}

/**
 * Verify one nominated candidate SEMANTICALLY: does it actually yield a peer uid?
 * Returns { name, verified, why }.
 */
export function verifyCandidate(socketLike, key) {
  const name = typeof key === "symbol" ? `Symbol(${key.description ?? ""})` : key;
  let value;
  try {
    value = socketLike[key];
  } catch (err) {
    return { name, verified: false, why: `throws on access: ${err.message}` };
  }
  if (typeof value === "function") {
    try {
      const out = value.call(socketLike);
      // A real peer-credential API needs a CONNECTED socket and would throw ENOTCONN on an
      // unconnected one — which is why probePeerCredentials must be run against an accepted
      // connection, not `new net.Socket()`. The throw is reported below, not swallowed.
      const called = readCredentialUid(out);
      if (called?.error) return { name, verified: false, why: `callable, but its uid getter threw: ${called.error.message}` };
      if (called) return { name, verified: true, why: `callable, returned uid ${called.uid}` };
      // A bare integer counts ONLY under a uid-specific name — callability is not enough.
      //
      // Round 6 accepted any integer from anything callable, reasoning that a constant cannot be
      // invoked so there was no false positive to guard against. Round 7 showed that was wrong:
      // `getPeerCredentials()` returning 0 could be a status code, an errno, a PID or a GID, and
      // the probe would have reported a peer-UID capability that had never been demonstrated. In a
      // gate whose recorded answer is a NEGATIVE, a false positive silently flips the conclusion.
      // Callability tells you the member does something; only the NAME says the integer is a uid.
      if (isUid(out) && UID_SPECIFIC.test(name)) return { name, verified: true, why: `uid-specific callable, returned uid ${out}` };
      return { name, verified: false, why: `callable but returned ${JSON.stringify(out) ?? typeof out} — no uid` };
    } catch (err) {
      return { name, verified: false, why: `callable but threw: ${err.message}` };
    }
  }
  // `value.uid` is read ONCE, inside a guard. A nominated property whose `uid` getter throws used
  // to abort the whole probe — turning one unverifiable nominee into no answer at all, in a gate
  // whose entire output is the answer. Re-reading it for the message also let a stateful accessor
  // report a uid different from the one that was verified (review round 12).
  const carried = readCredentialUid(value);
  if (carried?.error) return { name, verified: false, why: `property whose uid getter threw: ${carried.error.message}` };
  if (carried) return { name, verified: true, why: `property carrying uid ${carried.uid}` };
  // A bare integer counts only under a UID-SPECIFIC name. This is the line that separates
  // `peerUid: 501` (the value IS the answer) from `SO_PEERCRED: 17` (an option NUMBER with no
  // supported setsockopt/getsockopt surface in Node's stdlib to feed it to).
  if (isUid(value) && UID_SPECIFIC.test(name)) return { name, verified: true, why: `uid-specific property carrying uid ${value}` };
  return { name, verified: false, why: `inert value (${typeof value}) — a name is not a capability` };
}

/**
 * The probe. Returns { answer, verified, nominated, nearby, surfaceSize }; `answer` is "yes"
 * ONLY when a nominated candidate passed semantic verification.
 */
export function probePeerCredentials(socketLike) {
  const surface = enumerateSurface(socketLike);
  const nominated = [];
  const nearby = [];
  for (const { key, name } of surface) {
    if (PATTERN.test(name)) nominated.push(verifyCandidate(socketLike, key));
    else if (NEARBY.test(name)) nearby.push(name);
  }
  const verified = nominated.filter((c) => c.verified);
  return {
    answer: verified.length > 0 ? "yes" : "no",
    verified,
    nominated,
    nearby,
    surfaceSize: surface.length,
  };
}

/**
 * Probe against a REAL accepted Unix-domain connection — the only shape a peer-credential API
 * could plausibly work on. Returns the probe result for the server-side accepted socket.
 */
export const MAX_PROBE_TIMEOUT_MS = 60_000;

export async function probeOnConnectedUnixSocket({ timeoutMs = 5000 } = {}) {
  // Third site of the deadline class. serveIdentity validated its timeout, identifyHolder did not
  // until round 14, and this probe still handed `timeoutMs` straight to setTimeout — where 0, a
  // negative, NaN or Infinity fires immediately and reports "the probe timed out" for an operation
  // that was never given a chance, in the function whose whole output is a release-gate answer
  // (review round 15). Validated at entry, before any directory or socket exists.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PROBE_TIMEOUT_MS) {
    throw new Error(
      `timeoutMs must be a positive safe integer no greater than ${MAX_PROBE_TIMEOUT_MS}; ` +
        `got ${typeof timeoutMs === "symbol" ? "a Symbol" : String(timeoutMs)}`,
    );
  }
  const { chmodSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "spendbar-probe-"));
  // mkdtemp takes the umask, so under a restrictive one (0200) the directory comes back 0500 and
  // binding the socket inside it fails — a valid environment producing a probe failure that says
  // nothing about peer credentials. Same umask class as the token, the allocation and the snapshot.
  chmodSync(dir, 0o700);
  const path = join(dir, "p.sock");
  const server = net.createServer();
  let client = null;
  // EVERY accepted socket, not just the first. server.close() waits for accepted connections, so
  // tracking one peer left cleanup able to block forever on any other — in a finally with no
  // deadline, which would hang test:all rather than report anything.
  const accepted = new Set();
  server.on("connection", (c) => accepted.add(c));
  let peer = null;
  // Every wait is bounded and error-subscribed. Unhandled: a bind failure became an uncaught
  // server error, and a stalled accept hung the probe (and test:all) instead of reporting why —
  // this function decides a release gate, so it must produce evidence or a named failure, never
  // silence.
  const bounded = (what, fn) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms on ${path}`)), timeoutMs);
    const settle = (err, v) => { clearTimeout(timer); err ? reject(err) : resolve(v); };
    fn(settle);
  });
  try {
    await bounded("listen", (settle) => {
      server.once("error", (e) => settle(new Error(`listen failed on ${path}: ${e.code ?? e.message}`)));
      server.listen(path, () => settle(null));
    });
    peer = await bounded("accept", (settle) => {
      server.once("error", (e) => settle(new Error(`server errored while accepting: ${e.code ?? e.message}`)));
      server.once("connection", (c) => settle(null, c));
      client = net.connect(path);
      client.on("error", (e) => settle(new Error(`connect failed on ${path}: ${e.code ?? e.message}`)));
    });
    return probePeerCredentials(peer);
  } finally {
    client?.destroy();
    peer?.destroy();
    for (const c of accepted) c.destroy();
    // Bounded close: destroying the tracked sockets should make this immediate, and if it does
    // not, that is a finding to report rather than a hang to sit in.
    //
    // NOT `Promise.race([close, timeout])`. The race settles on the close, but the LOSING timer is
    // never cleared and stays referenced for its full duration — which kept the node process alive
    // and was the real reason `test:spikes` "terminated naturally" in ~5.2s. That number was the
    // leaked 5000ms deadline, not the work. Review round 5 caught it; a leak that sets the
    // suite's runtime is exactly the kind removing --test-force-exit was supposed to expose.
    // Reporting the timeout is not enough — rejecting does not CANCEL `server.close()`. The
    // underlying operation and its handles stay referenced, so the exact wedged-close this bound
    // exists to report could still hold `test:all` open after the error was raised: the hang it was
    // added to prevent, merely narrated. Review round 10. On timeout every socket is destroyed and
    // the server unref'd before rejecting, so a close that will not settle cannot keep the process
    // alive. `settled` guards a late callback from settling a second time.
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        client?.destroy();
        peer?.destroy();
        for (const c of accepted) c.destroy();
        server.unref();
        reject(new Error(`server.close() did not settle within ${timeoutMs}ms on ${path}`));
      }, timeoutMs);
      server.close(() => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve();
      });
    }).then(
      // Cleanup must not REPLACE the evidence. In a bare `.finally` an rmSync failure (EACCES, EIO)
      // discarded the listen/accept/close-timeout error this function exists to report, leaving the
      // gate with a filesystem message instead of its answer. Both are surfaced when both fail.
      (v) => { cleanup(); return v; },
      (err) => {
        try { cleanup(); } catch (cleanupErr) { throw new AggregateError([err, cleanupErr], "probe failed, and its cleanup failed too"); }
        throw err;
      },
    );
    function cleanup() { rmSync(dir, { recursive: true, force: true }); }
  }
}

/**
 * Render the finding. A PURE FUNCTION of (version, result) so both branches are testable.
 *
 * The version-scoped claim lived inside the direct-execution block, so no test could reach it and a
 * mutant that always printed the reviewed-Node-22 sentence left all spike tests green — the round-11
 * fix was real but unpinned, which for an evidence-integrity fix is most of the value missing
 * (review round 12).
 */
export const REVIEWED_MAJOR = 22;

export function renderFinding(nodeVersion, { answer, verified, nominated, nearby, surfaceSize }) {
  const runningMajor = Number(nodeVersion.split(".")[0]);
  const reviewed = runningMajor === REVIEWED_MAJOR;
  const lines = [
    `node v${nodeVersion}, net.Socket instance + full prototype chain (string and Symbol keys)`,
    `surface enumerated : ${surfaceSize} keys`,
    `nominated by name  : ${nominated.length === 0 ? "NONE" : nominated.map((c) => `${c.name} (${c.why})`).join("; ")}`,
    `semantically real  : ${verified.length === 0 ? "NONE" : verified.map((c) => c.name).join(", ")}`,
    `peer-adjacent      : ${nearby.join(", ") || "none"} (addresses, not credentials)`,
    "",
    reviewed
      ? `Reviewed documented surface: net.Socket in the Node ${REVIEWED_MAJOR}.x API docs — address/connect/` +
        `destroy/end/pause/ref/resume/setEncoding/setKeepAlive/setNoDelay/setTimeout/unref/write and ` +
        `properties; no peer-credential member of any name.`
      : `UNVERIFIED: the documented-surface review was performed against Node ${REVIEWED_MAJOR}.x and this is ` +
        `Node ${nodeVersion}. The enumeration above is still valid — it inspects the live object — but the ` +
        `residual blind spot it CANNOT close (a real API under a name the pattern misses) is closed only by a ` +
        `documentation review, and none has been done for this version. Re-review before relying on the answer.`,
  ];
  if (answer !== "no") {
    lines.push("ANSWER CHANGED: a verified credential surface exists — re-evaluate the fallback decision before trusting this build");
  } else if (reviewed) {
    lines.push("ANSWER: no peer-UID API in Node's supported public surface -> T-011 uses the 0700-dir + 0600-token fallback");
  } else {
    lines.push(`ANSWER (enumeration only, Node ${nodeVersion}): nothing verified on the live object; the documented-surface half of this answer is UNVERIFIED for this version`);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const result = await probeOnConnectedUnixSocket();
  console.log(renderFinding(process.versions.node, result));
}
