/**
 * T-008 §3.6 — adversarial tests for the kernel-held port lock.
 *
 * Every test here is written so it CAN fail. The ones that would otherwise pass vacuously say so
 * in a comment naming the mutant they exist to kill, because three separate findings in plan
 * review were "this test would pass even if the property did not hold".
 *
 * Run: node --test spikes/locking/portlock.test.mjs
 */
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";

const PROTOCOL = "spendbar-portlock/1";   // mirrors portlock.mjs; a divergence must break these tests
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { DARWIN_ONLY, POSIX_ONLY } from "../platform.mjs";

import {
  DYNAMIC_MAX, DYNAMIC_MIN, NONCE_BYTES, PortLock, PortLockForeignHolder, PortLockUnavailable,
  MAX_CHALLENGE_TIMEOUT_MS, USABLE_MAX, USABLE_MIN, classifyBindError, createWatchedServer,
  disposeServer,
  identifyHolder, isUsablePort, publishAllocation, readAllocation, startSingleton, writeAllSync,
} from "./portlock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Harness-level bound, independent of any implementation deadline. */
const WAIT_MS = 15_000;
const dirs = [];
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "spendbar-portlock-"));
  dirs.push(d);
  return d;
};

/**
 * EVERY socket-holding resource is registered the instant it exists, and torn down by cleanup that
 * runs whether the test passed, failed, or threw.
 *
 * Without this the file only released resources on its happy path, and review round 5 named the
 * consequence precisely: a mutant that fails an assertion before the explicit release leaves locks
 * bound and up to 20 IPC-connected children alive, so `test:spikes` REPORTS the failure and then
 * never terminates. That is not hypothetical — it happened during this round's `test:all` run:
 * the storm failed, 18 children stayed alive on their IPC channels, and the runner sat for
 * 876 SECONDS against a 15s test timeout before it was freed by hand.
 *
 * A suite that cannot terminate on failure is worse than one that skips: it converts a red result
 * into a hang, which is the vacuous-skip sin in a different costume.
 */
const live = { locks: new Set(), servers: new Set(), sockets: new Set(), kids: new Set() };
const track = (kind, v) => { live[kind].add(v); return v; };
// Tracked constructors, used INSTEAD of the raw ones throughout. Registration at the construction
// site is the point: anything registered only after a later assertion is exactly what leaks when
// that assertion is the one that fails.
const newLock = (opts) => track("locks", new PortLock(opts));
const connect = (...a) => {
  const sock = net.connect(...a);
  // Probe sockets RECORD their errors instead of throwing them at the process.
  //
  // Several tests here exist precisely because `release()` destroys attached connections, so the
  // client end legitimately sees ECONNRESET — that RST is the asserted behaviour, not a fault. With
  // no `error` listener Node escalates it to an uncaughtException, and because it lands after the
  // test that caused it has already resolved, the runner blames whichever test is unlucky enough to
  // be running. That is how it presented: an intermittent failure attributed to a test that had
  // nothing to do with it, roughly one run in three.
  //
  // Recorded rather than swallowed, so nothing is hidden: the errors stay inspectable on the socket,
  // and every test that cares about a connection failing attaches its own handler and asserts on it.
  sock.errors = [];
  sock.on("error", (e) => sock.errors.push(e));
  return track("sockets", sock);
};
const createServer = (...a) => {
  const srv = net.createServer(...a);
  // ACCEPTED sockets are tracked too. net.Server has no closeAllConnections() (that is
  // http.Server), and server.close() waits for live connections — so an accepted socket nobody
  // holds a reference to is exactly what makes a close hang forever.
  srv.on("connection", (c) => track("sockets", c));
  return track("servers", srv);
};

/**
 * Bound a promise WITHOUT leaking the losing timer.
 *
 * `Promise.race([work, timeoutPromise])` settles correctly but leaves the timer armed and
 * referenced for its full duration. Round 5's sharpest finding: those leaked deadlines were what
 * held the process open, so the ~5.2s "natural termination" I reported as evidence of no leaks was
 * itself the leak — the suite was waiting out a 5000ms timer, not doing work.
 */
function deadline(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const exited = (child) => new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("exit", r)));

after(async () => {
  // REPORT what had to be reclaimed, rather than absorbing it. There is a real tension here: a
  // safety net that silently releases what a test forgot to release makes that omission invisible,
  // which is the same "green for the wrong reason" problem the net exists to prevent. So the net
  // stays (a hang is strictly worse than a hidden leak) but it is not silent — on a passing run
  // these counts should be zero, because every success path releases explicitly, and anything
  // non-zero on green is a leak to go and find.
  // Counts what is still LIVE, not what was ever created. The first version reported set sizes and
  // so printed "locks=18 kids=20" on a fully green run, because the registry never deregisters —
  // a diagnostic whose number means nothing is worse than none at all.
  const stillLive = {
    locks: [...live.locks].filter((l) => l.held).length,
    servers: [...live.servers].filter((s) => s.listening).length,
    sockets: [...live.sockets].filter((s) => !s.destroyed).length,
    kids: [...live.kids].filter((c) => c.exitCode === null && c.signalCode === null).length,
  };
  const leaked = Object.entries(stillLive).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
  // Concurrent and individually BOUNDED. Awaiting each release serially meant one wedged cleanup
  // blocked every remaining resource and the temp-directory removal — cleanup that can itself hang
  // is not cleanup, it is the failure mode with extra steps (review round 6).
  // Cleanup FAILURES ARE REPORTED, not discarded. allSettled plus a swallowed catch meant a wedged
  // release or a child that never emits `exit` left a referenced listener or IPC handle behind
  // while the hook reported success — the runner could still hang, and the teardown would have said
  // nothing (review round 7). Racing a timer does not cancel the underlying operation, so on a
  // child-exit timeout the channel and stdio are forcibly detached before the failure is raised.
  //
  // And a leak is a FAILURE, not a log line. This printed to stderr and then quietly reclaimed
  // everything, so a passing test that forgot to release a lock, server, socket or child still
  // exited 0 — which made the deliverable's "zero reclaimed resources on a green run" a claim
  // nothing enforced. It is recorded as a problem here and thrown at the end, AFTER cleanup has
  // run, so the leak is reported without the suite also being left unable to terminate.
  const problems = [];
  if (leaked.length) problems.push(`a passing run leaked resources: ${leaked.join(" ")} — every success path must release explicitly`);
  for (const s of live.sockets) s.destroy();
  for (const r of await Promise.allSettled([
    // Bounded AND disposed on timeout, matching the child branch below. Found by auditing for
    // siblings after the identical gap was fixed in bootstrap.test.mjs (round 13) — this file is
    // where the child-detach rule was written in the first place, and its lock/server branch never
    // got it. Sixth instance of this ticket's dominant defect, and the first one an audit caught
    // rather than a reviewer. A timer bounds how long we WAIT; it cancels nothing, so without this
    // the diagnostic below is raised into a runner that a wedged listener keeps alive.
    ...[...live.locks].map(async (l) => {
      try { await deadline(l.release(), 5_000, "lock release wedged"); }
      catch (err) { l.__forceDispose(); throw err; }
    }),
    ...[...live.servers].map(async (s) => {
      try { await deadline(new Promise((r2) => s.close(r2)), 5_000, "server close wedged"); }
      catch (err) { disposeServer(s); throw err; }
    }),
  ])) if (r.status === "rejected") problems.push(String(r.reason?.message ?? r.reason));
  // Ask first, then insist. `abandon` exercises the child's own exit path; SIGKILL is the backstop
  // for a child that is wedged, because cleanup itself must be bounded — an unbounded cleanup wait
  // reintroduces exactly the hang it exists to prevent.
  // `connected` guards the already-exited children, and the callback absorbs the channel closing
  // underneath us mid-send: without a callback `send()` reports that failure ASYNCHRONOUSLY, so a
  // try/catch never sees it and it surfaces as an uncaughtException that fails the file after every
  // test has already passed.
  for (const c of live.kids) { if (c.connected) c.send("abandon", () => {}); }
  // One shared budget for all children, not 5s each serially, and the SIGKILL fallback WAITS for
  // the exit — returning straight after signalling left IPC handles live and the process open.
  for (const r of await Promise.allSettled([...live.kids].map(async (c) => {
    try {
      await deadline(exited(c), 5_000, `child ${c.pid} ignored abandon`);
    } catch {
      try { c.kill("SIGKILL"); } catch { /* already dead */ }
      try {
        await deadline(exited(c), 5_000, `child ${c.pid} survived SIGKILL`);
      } catch (err) {
        // Detach so a child that will not die cannot hold this process open through its IPC
        // channel or stdio pipes, THEN report it. Reporting without detaching would name the leak
        // and still hang on it.
        try { c.disconnect(); } catch { /* channel already gone */ }
        for (const pipe of [c.stdin, c.stdout, c.stderr]) pipe?.destroy();
        c.unref();
        throw err;
      }
    }
  }))) if (r.status === "rejected") problems.push(String(r.reason?.message ?? r.reason));

  // Per-directory, and failures COLLECTED rather than thrown. An unguarded loop aborts on the first
  // removal error, so the remaining directories are never attempted AND the raw filesystem
  // exception replaces every leak diagnostic already gathered above — the teardown loses exactly
  // the information it exists to report (review round 11).
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); }
    catch (err) { problems.push(`remove ${d}: ${err.message}`); }
  }
  if (problems.length) throw new Error(`teardown could not reclaim everything: ${problems.join("; ")}`);
});

/** A port nobody else in the suite uses, obtained from the kernel rather than guessed. */
async function freePort() {
  const { port, server } = await publishAllocation(join(workdir(), "a.alloc"));
  track("servers", server);
  // Procurement only: this test wants a known-free port, not the lock, so the winner's retained
  // listener is closed. Production code adopts it (PortLock.adopt) — see bootstrap.test.mjs for
  // the adversary that proves why.
  await new Promise((r) => server.close(r));
  live.servers.delete(server);
  return port;
}

test("exclusion: a second acquire reports occupied, and the FIRST keeps the lock", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const a = newLock();
  const b = newLock();
  assert.equal(await a.acquire(port), "acquired");
  assert.equal(await b.acquire(port), "occupied");
  // The mutant this kills: a design where the loser's bind "succeeds" and both proceed — exactly
  // what the lockfile did. Asserting only that b !== "acquired" would miss a's lock being taken.
  assert.equal(a.held, true);
  assert.equal(b.held, false);
  assert.equal(a.assertHeld(), true);
  await a.release();
  assert.equal(await b.acquire(port), "acquired", "released port is immediately re-acquirable");
  await b.release();
});

test("REGRESSION: a released lock is spent — reacquiring it would bind a listener it can never release", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const a = newLock();
  assert.equal(await a.acquire(port), "acquired");
  await a.release();

  // The reproduced bug: a.acquire(port) returned "acquired" while a.held stayed FALSE and
  // a.release() returned false — the second listener was bound and leaked until process exit,
  // with the object insisting it held nothing. The exclusion test above does NOT cover this: it
  // reacquires with `b`, which is still fresh, so removing the released-state guard leaves it
  // green. This test exists to fail when that guard goes.
  await assert.rejects(() => a.acquire(port), /already released/);
  assert.throws(() => a.adopt({ address: () => ({ port }) }), /already released/);

  // And the port is genuinely free — the refused reuse bound nothing.
  const fresh = newLock();
  assert.equal(await fresh.acquire(port), "acquired", "the spent lock's refusal left no listener behind");
  await fresh.release();
});

test("REGRESSION: a lock lost to an unexpected close is also spent", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const lost = [];
  const l = newLock({ onLost: (e) => lost.push(e) });
  await l.acquire(port);
  await l.__forceUnexpectedClose();
  assert.equal(lost.length, 1);
  await assert.rejects(() => l.acquire(port), /can no longer prove/);
});

test("REGRESSION: adopting an already-closed listener is refused, and never reports held", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The reproduced bug: adopt() assigned #server and THEN read server.address().port. If the
  // publication winner's listener closed in the handoff window, address() is null, `.port` threw —
  // and #server was already set, so `held` returned TRUE for a lock bound to nothing. No later
  // witness could repair it, because the close event had already fired before adopt() subscribed.
  //
  // NOT covered by any existing test: every other adopt path hands over a live listener, so the
  // mutant that moves the assignment back above the validation stays green without this.
  const { port, server } = await publishAllocation(join(workdir(), "closed.alloc"));
  track("servers", server);
  await new Promise((r) => server.close(r));   // the handoff window, made deterministic
  live.servers.delete(server);

  const lock = newLock();
  assert.throws(() => lock.adopt(server), /refusing to adopt/);
  assert.equal(lock.held, false, "a refused adoption must not leave the lock claiming exclusivity");
  assert.equal(lock.port, null);

  // And the claim it refused to make was the correct one to refuse: the port really is free.
  const fresh = newLock();
  assert.equal(await fresh.acquire(port), "acquired", "the port was genuinely unheld");
  await fresh.release();
});

test("REGRESSION: a failure AFTER the link never strands the allocation on an unbound port", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The critical bug, found in review round 6. `link()` is the irreversible moment: once it
  // succeeds the allocation permanently names this process's port, and re-allocation is forbidden
  // by design. But the durability fsync (and the read-back) ran AFTER it, inside a try whose catch
  // closed the listener and rethrew. So an EIO from the fsync produced the worst reachable state:
  // a permanent allocation naming a port NOBODY holds, free for any unrelated process to bind —
  // the split-owner failure the whole protocol exists to prevent, reached through the error path.
  //
  // afterLink fires between linkSync and the fsync, so throwing from it reproduces exactly that
  // window without having to stub a private function.
  const alloc = join(workdir(), "postlink.alloc");
  const boom = new Error("EIO: simulated directory fsync failure after link");

  let outcome;
  await assert.doesNotReject(async () => {
    outcome = await publishAllocation(alloc, { hooks: { afterLink: () => { throw boom; } } });
  }, "a post-link failure must not propagate as a throw — the caller has to be handed its listener");
  track("servers", outcome.server);

  assert.equal(outcome.published, true, "the link succeeded, so publication succeeded");
  assert.equal(outcome.warning, boom, "the durability failure is reported, not swallowed");
  assert.ok(outcome.server, "and the winner still owns its listener");
  assert.equal(outcome.server.listening, true, "which is still bound");
  assert.equal(readAllocation(alloc), outcome.port, "the allocation names the port we hold");

  // THE assertion: the allocated port is genuinely still reserved. Under the bug this bind
  // succeeded, which is what "stranded allocation" means in practice.
  const adversary = newLock();
  assert.equal(await adversary.acquire(outcome.port), "occupied",
    "the allocated port must still be held — a post-link error must never release it");

  await new Promise((r) => outcome.server.close(r));
  live.servers.delete(outcome.server);
});

test("REGRESSION: a CLEANUP failure after the link also never strands the allocation", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The same critical bug one layer out, found in review round 7. Capturing post-link errors was
  // not enough while candidate removal still sat in a bare `finally` OUTSIDE that capture — an
  // rmSync that threw after a successful link escaped past it into publishAllocation's catch, which
  // closed the retained listener and rethrew. Identical stranded allocation, different statement.
  //
  // The lesson, and why this test exists separately from the afterLink one: the rule is "NOTHING
  // after the link may throw", and only a test per post-link statement can hold that rule. The
  // afterLink injection returns before cleanup runs, so it cannot catch this mutant at all.
  const alloc = join(workdir(), "cleanupfail.alloc");
  const boom = new Error("EACCES: simulated candidate cleanup failure after link");

  let outcome;
  await assert.doesNotReject(async () => {
    outcome = await publishAllocation(alloc, { hooks: { removeCandidate: () => { throw boom; } } });
  }, "a post-link CLEANUP failure must not propagate either");
  track("servers", outcome.server);

  assert.equal(outcome.published, true);
  assert.equal(outcome.warning, boom, "the cleanup failure is reported as a warning");
  assert.equal(outcome.server.listening, true, "the retained listener survived the cleanup failure");
  assert.equal(readAllocation(alloc), outcome.port);

  const adversary = newLock();
  assert.equal(await adversary.acquire(outcome.port), "occupied",
    "the allocated port must still be held after a failed cleanup");

  await new Promise((r) => outcome.server.close(r));
  live.servers.delete(outcome.server);
});

test("REGRESSION: a throwing GETTER on the hooks object never strands the allocation either", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // Round 8, and the third instance of one bug. Rounds 6 and 7 fixed two post-link statements that
  // could throw (the fsync, then the cleanup). Both fixes were correct and both missed the point:
  // `hooks.removeCandidate ?? ...` was still being EVALUATED after the link, and property access is
  // not a safe operation — a getter or a Proxy `get` trap runs arbitrary code and can throw, from a
  // line that reads like nothing but a default.
  //
  // The fix was structural rather than local: every hook is now read into a local BEFORE the link,
  // so post-link there is nothing left to evaluate. This test is the one that would have caught the
  // class instead of the instance, which is why it exercises the *access* and not a throwing
  // function — the test above already covers the latter, and passes against the buggy code.
  const alloc = join(workdir(), "gettertrap.alloc");
  let reads = 0;
  const hooks = {};
  Object.defineProperty(hooks, "removeCandidate", {
    enumerable: true,
    get() { reads++; throw new Error("simulated hostile getter on hooks.removeCandidate"); },
  });

  // OUR OWN socket goes in, so the thing under test is reachable afterwards. The first version let
  // publishAllocation create the probe internally and then "checked" for a leak by binding a port
  // from freePort() — a DIFFERENT, freshly allocated port. That assertion could not fail: it tested
  // an unrelated socket while claiming, in its own comment, to test "the port the failed attempt
  // would have used". A mutant dropping the catch-path `probe.close()` satisfied every assertion
  // and merely left an untracked listener behind. Review round 10.
  // createWatchedServer, not the local helper: publishAllocation now refuses a server it did not
  // see created, because sockets accepted before tracking begins can never be closed (round 13).
  // Still registered with the suite's resource tracker so a failure here cannot leak it.
  const probe = track("servers", createWatchedServer());
  probe.on("connection", (c) => track("sockets", c));
  await new Promise((r) => probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r));
  const probePort = probe.address().port;

  await assert.rejects(() => publishAllocation(alloc, { hooks, server: probe }), /hostile getter/,
    "a hook that cannot even be resolved is a caller error and should surface");
  assert.equal(reads, 1, "the hostile getter really did run (a getter never read proves nothing)");

  // THE assertion, and the one that fails against the mutant. Resolving the hook before the link
  // means the throw lands while the operation is still abortable: no link was attempted, so no
  // allocation exists to be stranded, and publishAllocation's catch is free to close the probe.
  // Resolve it after the link instead and this file EXISTS — naming a port that the same catch has
  // just unbound. That is the difference between a clean failure and a permanently poisoned
  // allocation, and it is one line of placement.
  assert.equal(existsSync(alloc), false,
    "a failure before publication must leave NO allocation behind");

  // And THE SPECIFIC SOCKET was released — asserted on the object itself, then confirmed against
  // the kernel by taking the exact port back. Either check alone is weaker than it looks:
  // `listening === false` is the module's own bookkeeping, and a successful bind alone could be
  // satisfied by a port that was never held.
  assert.equal(probe.listening, false, "the failed publication closed the listener it was given");
  live.servers.delete(probe);
  const after = newLock();
  assert.equal(await after.acquire(probePort), "acquired",
    "and the kernel agrees the port it reserved is free");
  await after.release();
});

// ------------------------------------------------------------------ composed startup (criterion 3)
//
// These exist because review round 6 found T-008's criteria and the findings document both
// asserting a COMPOSED behaviour — "a foreign holder is diagnosed and refuses startup, and the
// allocation is never replaced" — that no test drove. The primitives were each covered; the caller
// that combines them was not, so the surviving mutant was any startup path that receives "foreign"
// and continues, or worse allocates a second port. A claim nothing exercises is a claim, not
// evidence.

test("startup: first run publishes, holds, and its allocation is durable", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const alloc = join(workdir(), "start.alloc");
  const started = await startSingleton(alloc, randomBytes(32), { purpose: "writer", allocationId: "a1" });
  track("locks", started.lock);
  assert.equal(started.role, "holder");
  assert.equal(started.lock.held, true);
  assert.equal(readAllocation(alloc), started.port);
  await started.lock.release();
});

test("startup: a SECOND start against our own live instance reports already-running, and never re-allocates", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const alloc = join(workdir(), "start.alloc");
  const token = randomBytes(32);
  const domain = { purpose: "writer", allocationId: "a1" };

  const first = await startSingleton(alloc, token, domain);
  track("locks", first.lock);
  // NO manual serveIdentity. Review round 7: calling it here made the test self-confirming — a
  // startSingleton that never registers identity still passed, while two ordinary starts would
  // have classified the healthy incumbent as "indeterminate" and refused to start. Registration is
  // part of becoming the holder, so two unassisted calls are the only honest way to assert it.
  const allocBefore = readFileSync(alloc, "utf8");

  const second = await startSingleton(alloc, token, domain);
  assert.equal(second.role, "already-running", "an authenticated instance of ours is not a foreign holder");
  assert.equal(second.port, first.port);
  assert.equal(readFileSync(alloc, "utf8"), allocBefore, "the write-once allocation was not rewritten");
  assert.equal(first.lock.held, true, "and the incumbent was not disturbed");
  await first.lock.release();
});

test("startup: after the holder is gone, a fresh start RECOVERS on the persisted port", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // Crash recovery seen through the composed path, which is where it actually matters: the
  // allocation survives, the port does not, and the next start must take the SAME port rather than
  // treat the existing allocation as an obstacle. The three startup tests around this one all end
  // with a live holder or a refusal, so none of them covers the ordinary restart — the single most
  // common thing this code will ever do.
  const alloc = join(workdir(), "start.alloc");
  const token = randomBytes(32);
  const domain = { purpose: "writer", allocationId: "a1" };

  const first = await startSingleton(alloc, token, domain);
  track("locks", first.lock);
  const port = first.port;
  await first.lock.release();                     // stands in for the holder dying: the port frees

  const second = await startSingleton(alloc, token, domain);
  track("locks", second.lock);
  assert.equal(second.role, "holder", "the port was free, so this process is the singleton");
  assert.equal(second.port, port, "and it recovered onto the PERSISTED port, not a new one");
  assert.equal(second.lock.held, true);
  assert.equal(readAllocation(alloc), port, "the write-once allocation is unchanged");
  await second.lock.release();
});

test("startup: a FOREIGN holder refuses startup by name and does NOT allocate another port", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const alloc = join(dir, "start.alloc");
  const token = randomBytes(32);
  const domain = { purpose: "writer", allocationId: "a1" };

  // Establish the allocation, then replace its holder with something that is NOT us: a listener
  // answering the challenge with the wrong token. This is the realistic hazard — the port is
  // machine-wide, so any local process can be sitting on it.
  const first = await startSingleton(alloc, token, domain);
  // Registered BEFORE anything can throw. The lock is released on the next line, but if that
  // release ever regresses — or an assertion between here and it fails — teardown has no way to
  // reach a listener held privately inside a lock it was never told about, so a red test becomes a
  // hung suite. The file claims every socket-holding resource is registered immediately; these two
  // startSingleton sites were the exceptions (review round 14).
  track("locks", first.lock);
  const port = first.port;
  await first.lock.release();

  const impostorLock = newLock();
  assert.equal(await impostorLock.acquire(port), "acquired");
  impostorLock.serveIdentity(randomBytes(32), domain);   // right shape, wrong secret

  const allocBefore = readFileSync(alloc, "utf8");
  await assert.rejects(
    () => startSingleton(alloc, token, domain),
    PortLockForeignHolder,
    "a holder that fails the challenge must refuse startup, not be worked around",
  );

  // THE assertion the criteria actually rest on: nothing was re-allocated. Under the mutant that
  // "recovers" by picking a new port, this file changes and a second singleton is born.
  assert.equal(readFileSync(alloc, "utf8"), allocBefore, "the allocation must be untouched");
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("start.alloc")), ["start.alloc"],
    "no replacement or candidate allocation was created");
  await impostorLock.release();

  // The same refusal for a port BELOW macOS's ephemeral range, read off disk — which is what
  // widening the acceptance rule to "any non-privileged port" newly admits (round 10: the old rule
  // rejected anything under 49152 outright, but it also rejected valid Linux assignments, which is
  // why it had to go).
  //
  // The question the widening raises is whether a corrupt or hostile allocation can now steer this
  // process at an unrelated local service. It can point us at one; it cannot make us adopt it. The
  // defence was never the range check — it is the challenge — and this asserts that directly rather
  // than trusting the argument. 40000 is deliberately outside 49152-65535, so the old rule would
  // have refused this allocation at the range check and never reached the challenge at all.
  const lowAlloc = join(dir, "low.alloc");
  // A FIXED port would be an environment dependency dressed as an assertion: anything else on the
  // machine holding it turns a correct run red. Scan a small band below macOS's ephemeral range for
  // one that is genuinely free, and if the whole band is occupied say so loudly — an environment
  // this test cannot run in is a reportable fact, not a reason to pass quietly.
  //
  // A FRESH lock per attempt: PortLock is deliberately single-use, so retrying on the same instance
  // would throw "already holding" rather than move to the next port. On this machine 40000 was free
  // on the first pass, so the retry path never executed and the defect would have sat here until
  // some other host had 40000 taken — the same shape as an untested error branch.
  let LOW_PORT = null;
  let impostorLow = null;
  for (let p = 40000; p <= 40020 && LOW_PORT === null; p++) {
    const attempt = newLock();
    if (await attempt.acquire(p).catch(() => null) === "acquired") { LOW_PORT = p; impostorLow = attempt; }
  }
  assert.ok(LOW_PORT !== null, "no free port in 40000-40020 to test the sub-ephemeral case with");
  // Serving identity with the WRONG secret, exactly as above: it answers promptly and is classified
  // foreign. A decoy that never registers identity would instead leave the challenge waiting out its
  // full deadline on a connection nothing ever closes — slow, and testing the timeout rather than
  // the classification.
  impostorLow.serveIdentity(randomBytes(32), domain);
  // 0600, because readAllocation refuses a world-readable allocation — writing this fixture with the
  // default 0644 made the call fail on the MODE check instead, which would have made the assertion
  // below pass for entirely the wrong reason.
  writeFileSync(lowAlloc, JSON.stringify({ port: LOW_PORT, version: 1 }), { mode: 0o600 });
  const lowBefore = readFileSync(lowAlloc, "utf8");
  await assert.rejects(
    () => startSingleton(lowAlloc, token, domain),
    PortLockForeignHolder,
    "a port we cannot authenticate refuses startup regardless of which range it falls in",
  );
  assert.equal(readFileSync(lowAlloc, "utf8"), lowBefore, "and that allocation is untouched too");
  await impostorLow.release();
});

test("startup: an UNIDENTIFIABLE holder also refuses — indeterminate never collapses into either answer", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const alloc = join(dir, "start.alloc");
  const token = randomBytes(32);
  const domain = { purpose: "writer", allocationId: "a1" };

  const first = await startSingleton(alloc, token, domain);
  track("locks", first.lock);   // same reason as above
  const port = first.port;
  await first.lock.release();

  // A holder that accepts the connection and then says nothing at all. Distinct from "foreign":
  // we do not know what it is. Treating that as "instance" would exit believing a healthy service
  // is running; treating it as free would start a second writer. Both are wrong, so it refuses.
  const muteConns = [];
  const mute = createServer((c) => muteConns.push(c));
  await new Promise((r) => mute.listen({ host: "127.0.0.1", port }, r));

  const allocBefore = readFileSync(alloc, "utf8");
  await assert.rejects(
    () => startSingleton(alloc, token, { ...domain, timeoutMs: 300 }),
    PortLockForeignHolder,
    "a challenge that times out means we do not know — and acting on a guess is how a live instance gets evicted",
  );
  assert.equal(readFileSync(alloc, "utf8"), allocBefore, "still no re-allocation");

  // Destroy the accepted sockets first: the handler never reads, so each stays PAUSED and
  // close() would wait on it forever — the same "no data listener means no end event" trap that
  // bit the impostor server earlier in this suite.
  for (const c of muteConns) c.destroy();
  await new Promise((r) => mute.close(r));
  live.servers.delete(mute);
});

test("the allocation write loops until complete; a zero-progress write is an error, not a spin", () => {
  // Pure, and found by my own mutation sweep: turning the `while` into an `if` left every test
  // green, because writeSync never returns short for a small local-file write. A short write
  // published through the write-once path would be PERMANENTLY truncated coordination state, so
  // the loop is load-bearing precisely in the conditions no test naturally produces.
  const sink = [];
  const oneByte = (fd, buf, off) => { sink.push(buf[off]); return 1; };
  writeAllSync(1, Buffer.from("hello"), { write: oneByte });
  assert.equal(Buffer.from(sink).toString(), "hello", "every byte reached the fd despite 1-byte writes");

  // A write making no progress must terminate loudly rather than spin forever.
  assert.throws(() => writeAllSync(1, Buffer.from("x"), { write: () => 0 }), /no progress/);
});

test("release() does not return until the port is ACTUALLY free, even with a client attached", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // What this asserts is the OBSERVABLE contract: once release() resolves, the port is immediately
  // re-bindable even though a client was attached.
  //
  // What it does NOT assert is that awaiting the close CALLBACK is what achieves it: libuv frees the
  // port during the `close()` call itself, so this test alone stays green against a bare
  // `server.close()`. That mutant is pinned by the test immediately below instead.
  const port = await freePort();
  const token = randomBytes(32);
  const lock = newLock();
  await lock.acquire(port);
  lock.serveIdentity(token, { purpose: "writer", allocationId: "a1" });

  const idle = connect({ host: "127.0.0.1", port });
  await new Promise((r) => idle.once("connect", r));

  assert.equal(await lock.release(), true);
  // IMMEDIATELY — no tick of slack. If release() resolved on a merely-requested close, this bind
  // gets EADDRINUSE.
  const successor = newLock();
  assert.equal(await successor.acquire(port), "acquired",
    "release() resolved before the port was actually free");
  await successor.release();
});

test("an INJECTED reservation holding a pre-accepted socket still closes promptly when it loses", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The path the previous regression did NOT cover, and the one that was actually still broken.
  //
  // That test builds its listener through `PortLock.acquire()`, where tracking is installed before
  // `listen()` — so deleting tracking from the INJECTED-server path left it green while the loser
  // and pre-publication error paths could still wedge forever. Review round 13 named the gap and
  // the repro confirmed it: a socket accepted before `publishAllocation` was called hung the loser
  // close for the full bound.
  //
  // `net.Server` exposes no list of accepted sockets (`getConnections()` returns a count), so such a
  // socket is unreachable and the fix has to be structural: publishAllocation refuses any server it
  // did not see created.
  const dir = workdir();
  const alloc = join(dir, "injected.alloc");
  const seed = await publishAllocation(alloc);          // so our candidate LOSES
  track("servers", seed.server);

  const probe = track("servers", createWatchedServer());
  probe.on("connection", (c) => track("sockets", c));
  await new Promise((r) => probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r));
  const probePort = probe.address().port;

  const idle = connect({ host: "127.0.0.1", port: probePort });
  await new Promise((r) => idle.once("connect", r));
  await new Promise((r) => setTimeout(r, 250));         // the ACCEPT completes before the call

  const outcome = await deadline(
    publishAllocation(alloc, { server: probe }),
    5_000,
    "the losing publication hung on a socket accepted before it was called",
  );
  assert.equal(outcome.published, false, "precondition: this candidate lost, so it must close its probe");
  assert.equal(outcome.port, seed.port, "and it adopted the winner's port");
  assert.equal(probe.listening, false, "the losing probe was closed despite holding a pre-accepted socket");
  live.servers.delete(probe);

  const successor = newLock();
  assert.equal(await successor.acquire(probePort), "acquired", "and the kernel agrees its port is free");
  await successor.release();
  await new Promise((r) => seed.server.close(r));
  live.servers.delete(seed.server);
});

test("a restrictive umask cannot publish a permanently-unreadable ALLOCATION", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The same umask trap that bricked the token, in the allocation — found one round AFTER the token
  // fix, and in the very round where "fixing a class in one place and not its siblings" was written
  // into the findings doc as this ticket's most persistent defect. I fixed the instance I was shown
  // instead of auditing for the class.
  //
  // Measured: under `umask 0200` the candidate is created 0400, `link()` publishes that mode
  // write-once, and every later `readAllocation()` throws "expected exactly 600" forever. The
  // publisher reports success and no subsequent startup can read what it just wrote.
  //
  // Child process because `process.umask()` is global and would leak into every later test.
  const dir = workdir();
  const script = join(dir, "umask-child.mjs");
  const alloc = join(dir, "port.alloc");
  writeFileSync(script, `
    import { publishAllocation, readAllocation } from ${JSON.stringify(join(HERE, "portlock.mjs"))};
    import { statSync } from "node:fs";
    process.umask(0o200);
    const out = await publishAllocation(${JSON.stringify(alloc)});
    const mode = (statSync(${JSON.stringify(alloc)}).mode & 0o7777).toString(8);
    let readBack = null, error = null;
    try { readBack = readAllocation(${JSON.stringify(alloc)}); } catch (e) { error = e.message; }
    await new Promise((r) => out.server.close(r));
    process.stdout.write(JSON.stringify({ published: out.published, mode, readBack, port: out.port, error }));
  `);
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: WAIT_MS, killSignal: "SIGKILL" });
  assert.equal(r.error, undefined, `child was killed rather than finishing: ${r.error?.message}`);
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.published, true, "precondition: the publication succeeded");
  assert.equal(out.mode, "600", "the allocation must be exactly 600 regardless of the umask in force");
  assert.equal(out.error, null, `readAllocation must accept what publishAllocation published, got: ${out.error}`);
  assert.equal(out.readBack, out.port, "and it reads back the port that was published");
});

test("a listener whose close never completes can still be DISPOSED of, so the process exits", { skip: POSIX_ONLY, timeout: WAIT_MS }, () => {
  // Review round 13: bootstrap.test.mjs bounded `release()` with a timer and, on timeout, threw a
  // "lock release wedged" diagnostic — into a runner that could not exit to print it. Racing a timer
  // does not cancel the close; the listener and everything it accepted stay referenced. The
  // child-exit branch three lines below the lock branch had force-detached its handles since round
  // 6. Same file, same hook, same failure mode, one of two branches fixed.
  //
  // The measurement is PROCESS EXIT, because that is the property. Asserting `server.listening` went
  // false would pass on a server that still pins the event loop, which is the bug itself.
  //
  // First draft of this test built the wedge from an UNTRACKED socket and failed, correctly: that
  // case is the one disposal can never fix — nothing can reach the socket — which is why
  // createWatchedServer is enforced at the boundary instead. The wedge disposal actually answers is
  // a tracked connection that simply never closes, so that is what this builds.
  const dir = workdir();
  const script = join(dir, "dispose-child.mjs");
  writeFileSync(script, `
    import net from "node:net";
    import { createWatchedServer, disposeServer } from ${JSON.stringify(join(HERE, "portlock.mjs"))};
    const server = createWatchedServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const client = net.connect(server.address().port, "127.0.0.1");
    client.on("error", () => {});                 // disposal resets it; an unhandled reset would exit 1
    await new Promise((r) => client.once("connect", r));
    client.unref();                               // so the ONLY handles holding this process are the
                                                  // server and the connection it accepted
    await new Promise((r) => setTimeout(r, 50));  // let the accept land before closing
    server.close();                               // stops accepting; WAITS for the live connection
    setTimeout(() => {
      process.stdout.write("wedged");             // proves the close really had not completed
      if (process.env.DISPOSE === "1") disposeServer(server);
      // No process.exit(): whether this process terminates is the entire assertion.
    }, 250).unref();
  `);
  const wedged = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 4_000 });
  assert.equal(wedged.stdout, "wedged", `precondition: the close should still be pending; child said: ${wedged.stderr}`);
  assert.equal(wedged.signal, "SIGTERM", "precondition: an undisposed listener pins the process open forever");

  const disposed = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 4_000, env: { ...process.env, DISPOSE: "1" } });
  assert.equal(disposed.stdout, "wedged", "the same wedge was reached");
  assert.equal(disposed.signal, null, `disposeServer must let the process exit; it was killed by the timeout instead: ${disposed.stderr}`);
  assert.equal(disposed.status, 0, "and exit cleanly");
});

test("__forceDispose reports whether there was actually a wedge to clean up", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The boolean is what lets teardown distinguish "the wedge was cleaned up" from "the diagnostic is
  // about something else entirely". A hatch that always returned true would make the report lie.
  const lock = newLock();
  const port = await freePort();
  assert.equal(await lock.acquire(port), "acquired");
  assert.equal(lock.__forceDispose(), true, "a held lock has a listener to dispose of");
  assert.equal(lock.held, false, "and disposal leaves it reading as not-held");
  assert.equal(lock.__forceDispose(), false, "a second call has nothing left to do and says so");

  const untouched = newLock();
  assert.equal(untouched.__forceDispose(), false, "a lock that never acquired anything reports no wedge");
});

test("a release still in flight is REACHABLE by __forceDispose", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The whole point of the hatch is the wedged case, and `release()` nulls `#server` on its first
  // line — so without the handoff to `#closing` the hatch finds nothing to dispose of at exactly the
  // moment it is needed, and teardown's emergency branch becomes a no-op that still reports success.
  //
  // No artificial wedge is needed to pin this: the close resolves on a callback, so between calling
  // release() and awaiting it there is a synchronous window where the lock holds a listener that
  // `#server` no longer points at. A close that merely takes longer is the same state for longer.
  const lock = newLock();
  const port = await freePort();
  assert.equal(await lock.acquire(port), "acquired");

  const releasing = lock.release();                       // deliberately NOT awaited yet
  assert.equal(lock.__forceDispose(), true, "the listener whose close is in flight must still be reachable");
  await releasing;

  const successor = newLock();
  assert.equal(await successor.acquire(port), "acquired", "and the port is genuinely free afterwards");
  await successor.release();
});

test("REGRESSION: a PRE-LINK failure removes the allocation candidate", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The cleanup only ran after the link was attempted, so everything between creating the candidate
  // and linking it — the fchmod, the write, the fsync, the mode check, the afterCandidateWrite hook
  // — stranded an owned `.tmp` next to the allocation on failure. The sibling publication path in
  // auth.mjs got this guard in round 11; this one was still missing it in round 14. Fourth site of
  // the "guard every statement that can throw, not the ones in view" rule.
  const dir = workdir();
  const alloc = join(dir, "guard.alloc");
  const boom = new Error("simulated failure with the candidate already on disk");
  await assert.rejects(
    () => publishAllocation(alloc, { hooks: { afterCandidateWrite: () => { throw boom; } } }),
    /simulated failure/,
  );
  assert.deepEqual(readdirSync(dir), [], "no allocation, and no candidate left beside it");

  // The control: the same path publishes cleanly once the hook behaves, so the guard did not
  // simply break publication.
  const out = await publishAllocation(alloc);
  track("servers", out.server);
  assert.equal(out.published, true);
  assert.deepEqual(readdirSync(dir), ["guard.alloc"], "exactly the allocation, no residue");
  await new Promise((r) => out.server.close(r));
  live.servers.delete(out.server);
});

test("REGRESSION: a non-EEXIST LINK failure also removes the candidate", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // Round 14's guard covered creating and writing the candidate and stopped at the link, so every
  // link failure that is not EEXIST rethrew before the cleanup step and stranded the `.tmp`. The
  // regression test written for that guard threw from afterCandidateWrite — BEFORE the link — so it
  // stayed green over the surviving half. Fixing the statements I was shown a failure in, again
  // (review round 15).
  const dir = workdir();
  const alloc = join(dir, "linkfail.alloc");
  const boom = Object.assign(new Error("simulated EACCES on link"), { code: "EACCES" });
  await assert.rejects(
    () => publishAllocation(alloc, { hooks: { link: () => { throw boom; } } }),
    /simulated EACCES on link/,
    "the ORIGINAL link error must survive the cleanup, not be replaced by it",
  );
  assert.deepEqual(readdirSync(dir), [], "and no candidate is left behind");

  // EEXIST stays what it always was: not an error, just a lost race — so it must NOT be rethrown.
  const winner = await publishAllocation(alloc);
  track("servers", winner.server);
  const loser = await publishAllocation(alloc, { tag: "loser" });
  assert.equal(loser.published, false, "the loser reports it did not publish");
  assert.deepEqual(readdirSync(dir), ["linkfail.alloc"], "and it cleaned up its own candidate");
  await new Promise((r) => winner.server.close(r));
  live.servers.delete(winner.server);
  if (loser.server) { await new Promise((r) => loser.server.close(r)); }
});

test("adopt() REFUSES an untrackable server, exactly as publishAllocation does", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The sibling entry point. adopt() called watchConnections at adoption time, which starts
  // tracking too late: a raw server that had already accepted an idle socket handed the lock a
  // connection nothing could reach, so release() waits on it forever and __forceDispose() cannot
  // destroy what the tracker never saw. publishAllocation was taught to refuse this in round 13;
  // adopt() went on accepting it (review round 15).
  const raw = track("servers", net.createServer());
  await new Promise((r) => raw.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r));
  const client = connect(raw.address().port, "127.0.0.1");
  await new Promise((r) => client.once("connect", r));
  await new Promise((r) => setTimeout(r, 100));   // the ACCEPT lands, untracked

  const lock = newLock();
  assert.throws(() => lock.adopt(raw), PortLockUnavailable,
    "a server whose accepted connections cannot be reached must be refused, not adopted");
  assert.equal(lock.held, false, "and the refusal leaves the lock unspent, not half-adopted");

  // The control: the same shape through createWatchedServer is adopted and releases promptly.
  const watched = track("servers", createWatchedServer());
  await new Promise((r) => watched.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r));
  const c2 = connect(watched.address().port, "127.0.0.1");
  await new Promise((r) => c2.once("connect", r));
  await new Promise((r) => setTimeout(r, 100));
  const ok = newLock();
  ok.adopt(watched);
  live.servers.delete(watched);
  assert.equal(await deadline(ok.release(), 5_000, "release wedged behind a tracked connection"), true);

  // The refused server is still OURS to clean up — refusing to adopt it transfers no ownership, and
  // the suite's leak gate is right to insist every success path releases what it created. Its
  // untracked connection is exactly why disposal cannot help here, so the test closes both ends.
  client.destroy();
  c2.destroy();
  await new Promise((r) => raw.close(r));
  live.servers.delete(raw);
});

test("identifyHolder validates its deadline, like serveIdentity already did", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // serveIdentity validated its injected challengeTimeoutMs; identifyHolder handed timeoutMs
  // straight to setTimeout. 0/negative/NaN/Infinity fire immediately and report a HEALTHY incumbent
  // as "indeterminate" — a wrong answer to the only question this protocol asks — and a Symbol or
  // BigInt rejects from timer setup with an error naming neither the parameter nor the contract.
  // One of two sites, same file (review round 14).
  const port = await freePort();
  for (const bad of [0, -1, 1.5, NaN, Infinity, MAX_CHALLENGE_TIMEOUT_MS + 1, "500", null, Symbol("t"), 10n]) {
    const label = typeof bad === "symbol" ? "Symbol" : String(bad);
    // `assert.rejects(fn)` accepts a function that throws SYNCHRONOUSLY, so it cannot tell a
    // returned rejected promise from a sync throw — moving the validation back outside the executor
    // would satisfy it and the placement comment would be unpinned prose (review round 15). The
    // returned value is captured first and asserted to be a promise, which is what the documented
    // `.catch(...)` caller shape depends on.
    let returned;
    assert.doesNotThrow(
      () => { returned = identifyHolder(port, randomBytes(32), { purpose: "writer", allocationId: "a1", timeoutMs: bad }); },
      `timeoutMs=${label} must REJECT, not throw synchronously out of a promise-returning function`,
    );
    assert.ok(returned instanceof Promise, `timeoutMs=${label}: a promise must still be returned`);
    await assert.rejects(returned, PortLockUnavailable, `timeoutMs=${label} must be a named contract error`);
  }
  // And the caller shape the placement exists to protect works end to end.
  const viaCatch = await identifyHolder(port, randomBytes(32), { purpose: "writer", allocationId: "a1", timeoutMs: -1 })
    .catch((err) => err);
  assert.ok(viaCatch instanceof PortLockUnavailable, ".catch(...) must see the validation failure");
  // And a valid deadline still reaches the network path: nothing is listening, so this is
  // "indeterminate" rather than a validation error — proving the guard rejects the argument, not
  // the operation.
  assert.equal(await identifyHolder(port, randomBytes(32), { purpose: "writer", allocationId: "a1", timeoutMs: 250 }),
    "indeterminate");
});

test("an unwatched server is REFUSED rather than accepted and silently untrackable", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The enforcement itself. Without it the invariant is a comment, and a comment is exactly what was
  // there when the bug above shipped — the risk was written down beside the call that ignored it.
  const raw = track("servers", net.createServer());
  await new Promise((r) => raw.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r));
  await assert.rejects(
    () => publishAllocation(join(workdir(), "raw.alloc"), { server: raw }),
    PortLockUnavailable,
    "a server publishAllocation did not see created cannot be tracked and must be refused",
  );
  await new Promise((r) => raw.close(r));
  live.servers.delete(raw);
});

test("a client accepted BEFORE serveIdentity cannot pin release() open", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // A real local denial of service, found in review round 12 and reproduced before being fixed.
  //
  // `server.close()` stops accepting but waits for accepted connections to end. Connection tracking
  // used to start inside `serveIdentity()`, so a client accepted in the window between `acquire()`
  // and identity registration was never recorded and never destroyed — `release()` then waited on it
  // forever. Any process that can reach the loopback port could wedge the holder permanently, and
  // it needs no protocol knowledge at all: connect, and do nothing.
  //
  // The delay is the test. Without it the accept has usually not completed when serveIdentity runs,
  // the socket lands in the tracked set, and the bug hides — which is exactly why it survived
  // eleven review rounds.
  const port = await freePort();
  const lock = newLock();
  await lock.acquire(port);

  const early = connect({ host: "127.0.0.1", port });
  await new Promise((r) => early.once("connect", r));
  await new Promise((r) => setTimeout(r, 250));   // let the ACCEPT complete, not just the handshake
  lock.serveIdentity(randomBytes(32), { purpose: "writer", allocationId: "a1" });

  // Bounded: against the bug this never settles, so an unbounded await would hang the suite rather
  // than fail it — the vacuous-hang failure this file's header is about.
  assert.equal(await deadline(lock.release(), 5_000, "release() pinned open by a connection accepted before serveIdentity"), true);

  const successor = newLock();
  assert.equal(await successor.acquire(port), "acquired", "and the port is genuinely free afterwards");
  await successor.release();
});

test("release() stays PENDING until the close callback runs (pins the await)", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // I recorded this mutant — dropping the `await` from `release()`'s close — as deliberately
  // surviving, on the reasoning that the port is freed inside `close()` regardless, so the await
  // changes only when we observe the release and not when it happens. Review round 8 pointed out
  // that this confuses two different things: WHEN THE PORT FREES is indeed unchanged, but the
  // SETTLEMENT OF THE PROMISE is itself part of the contract, and it is directly observable. Callers
  // sequence real work after `await release()`; if it resolves early they are sequenced against
  // nothing. That is a behavioural difference, so it is testable, so "unpinnable" was wrong.
  //
  // Pinning it needs only a close whose callback is under the test's control, which decouples
  // settlement from the kernel-side release that made the two look identical.
  // createWatchedServer, not a raw createServer: adopt() now refuses untrackable listeners for the
  // same reason publishAllocation does. This test previously adopted a raw server and so quietly
  // depended on — and normalized — the unsafe path (review round 15).
  const srv = track("servers", createWatchedServer());
  await new Promise((r) => srv.listen({ host: "127.0.0.1", port: 0, exclusive: true }, r));
  const lock = newLock();
  lock.adopt(srv);

  let openGate;
  const gate = new Promise((r) => { openGate = r; });
  const realClose = srv.close.bind(srv);
  srv.close = (cb) => realClose(() => { gate.then(() => cb?.()); });

  let settled = false;
  const releasing = lock.release().then((v) => { settled = true; return v; });
  // Generous on purpose: the mutant settles within a microtask, so any real delay separates them.
  // The gate is still shut, so a correct release() CANNOT have resolved yet no matter how long
  // we wait — this is a deterministic distinction, not a race the fast path happens to win.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false,
    "release() resolved before the close callback ran — the await is load-bearing and was dropped");

  openGate();
  assert.equal(await deadline(releasing, 5_000, "release() wedged behind the close gate"), true);
  assert.equal(settled, true);
  live.servers.delete(srv);
});

test("a holder that accepts and hangs up is INDETERMINATE promptly, not after the full deadline", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // Sweep survivor: deleting identifyHolder's `close` handler left the suite green, because the
  // 2000ms timeout produces the same ANSWER. The answer was never the point of that handler —
  // promptness is. Startup diagnosis sits in front of a user waiting for a CLI to respond, so
  // "eventually correct after two seconds" is a different product from "correct immediately".
  const port = await freePort();
  const rudeConns = [];
  // accept, then FIN without replying. Its socket is kept so cleanup can destroy it: a half-closed
  // peer keeps server.close() waiting, which is what stalled the whole file the first time.
  const rude = createServer((c) => { rudeConns.push(c); c.end(); });
  await new Promise((r) => rude.listen({ host: "127.0.0.1", port }, r));
  try {
    // The challenge deadline is pushed OUT to 30s for this test, which turns a narrow wall-clock
    // bar into a real separation. Against the default 2000ms the assertion needed a 1500ms
    // threshold — 500ms of margin, close enough to a performance check that a descheduled runner
    // could fail correct code (review round 10). With a 30s deadline, correct behaviour settles in
    // single-digit milliseconds and the mutant that waits the deadline out takes 30 seconds: the
    // two are separated by three orders of magnitude, so no scheduler stall can confuse them.
    const started = process.hrtime.bigint();
    const who = await identifyHolder(port, randomBytes(32), { purpose: "writer", allocationId: "a1", timeoutMs: 30_000 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(who, "indeterminate", "a hang-up is not evidence of a foreign holder");
    // Deadline-relative rather than a wall-clock performance bar: the property is that it did not
    // sit out the challenge timeout, with enormous slack for a loaded machine.
    // A graceful FIN, deliberately, not destroy(): destroy() sends RST and the CLIENT's `error`
    // handler resolves the promise, so the close handler is never what decides and deleting it
    // changes nothing. With a clean half-close there is no error — only `close` distinguishes
    // "answered promptly" from "waited out the 2000ms deadline". My first version of this test used
    // destroy() and the mutant survived it.
    assert.ok(ms < 5_000, `took ${ms.toFixed(0)}ms against a 30s deadline — it waited out the challenge deadline instead of noticing the close`);
  } finally {
    for (const c of rudeConns) c.destroy();
    await new Promise((r) => rude.close(r));
    live.servers.delete(rude);
  }
});

test("only EADDRINUSE is contention; every other bind error is an environment failure", () => {
  // Pure: no uid, no socket, no permissions. Gating it would drop mutation coverage on Windows
  // for no reason, which is the opposite of a requirement-based split.
  // Tested directly rather than through acquire(). The first version of this test drove real
  // ports, and the mutation sweep caught it out: port 1 and out-of-range values are all rejected
  // by the range guard BEFORE listen is reached, so "treat every bind error as contention"
  // survived the entire suite. A test that never reaches the code it names proves nothing.
  assert.equal(classifyBindError("EADDRINUSE"), "contention");
  for (const code of ["EACCES", "EADDRNOTAVAIL", "EMFILE", "ENFILE", "EAFNOSUPPORT", "EPERM", undefined]) {
    assert.equal(classifyBindError(code), "environment", `${code} must never be read as contention`);
  }
});

test("an injected challenge deadline is validated at REGISTRATION, not at the first challenge", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // `challengeTimeoutMs` is injectable state on the identity path, so every bad value has to fail
  // where the mistake is. Round 11 named three distinct failure modes and they fail differently,
  // which is exactly why an unchecked value is dangerous: none of them surfaces at the call site.
  const port = await freePort();
  const lock = newLock();
  await lock.acquire(port);
  const domain = { purpose: "writer", allocationId: "a1" };
  const token = randomBytes(32);

  for (const bad of [
    0,            // clamped by setTimeout to fire immediately: every challenge dropped unanswered,
    -1,           // so a healthy instance becomes indistinguishable from a dead one...
    NaN,          // ...which is the single worst outcome this protocol can produce, since the
    Infinity,     // caller's response to "cannot identify the holder" is to refuse to start.
    1.5,          // not an integer
    "2000",       // a string that would coerce, and coercion is how NaN gets in
    null,
    10n,          // BigInt: throws from inside the connection handler, taking the holder down
    Symbol("x"),  // Symbol: same, and String()-ing it in the error message would throw too
    MAX_CHALLENGE_TIMEOUT_MS + 1,   // unbounded idle-connection window
  ]) {
    assert.throws(
      () => lock.serveIdentity(token, { ...domain, challengeTimeoutMs: bad }),
      PortLockUnavailable,
      `serveIdentity must refuse challengeTimeoutMs=${typeof bad === "symbol" ? "Symbol()" : String(bad)} at registration`,
    );
  }

  // And a valid value still registers and still works end to end — a validator that rejected
  // everything would pass every assertion above.
  lock.serveIdentity(token, { ...domain, challengeTimeoutMs: 30_000 });
  assert.equal(await identifyHolder(port, token, domain), "instance",
    "a legal deadline leaves the holder able to identify itself");
  await lock.release();

  // THE DOCUMENTED CEILING ITSELF is accepted. Testing only `MAX + 1` leaves `> MAX` and `>= MAX`
  // indistinguishable, so a mutant making the published maximum unusable would survive — the
  // boundary a public constant most needs pinned is its own value (review round 12).
  const port2 = await freePort();
  const atMax = newLock();
  await atMax.acquire(port2);
  atMax.serveIdentity(token, { ...domain, challengeTimeoutMs: MAX_CHALLENGE_TIMEOUT_MS });
  assert.equal(await identifyHolder(port2, token, domain), "instance",
    `challengeTimeoutMs === MAX_CHALLENGE_TIMEOUT_MS (${MAX_CHALLENGE_TIMEOUT_MS}) must be accepted, not rejected`);
  await atMax.release();
});

test("the usable-port range is INCLUSIVE at both ends", { skip: POSIX_ONLY, timeout: WAIT_MS }, () => {
  // Pinned on the predicate directly, because binding 1024 needs privileges and binding 65535 is an
  // environment lottery — neither is a sound way to assert a validation rule. The tests elsewhere
  // cover values outside the range and one interior value, which leaves `>=` versus `>` at both
  // ends unpinned: a mutant flipping either would reject allocations the contract accepts, and
  // every existing assertion would stay green (review round 12).
  assert.equal(isUsablePort(USABLE_MIN), true, `${USABLE_MIN} is the first usable port, inclusive`);
  assert.equal(isUsablePort(USABLE_MAX), true, `${USABLE_MAX} is the last usable port, inclusive`);
  assert.equal(isUsablePort(USABLE_MIN - 1), false, "and one below is privileged");
  assert.equal(isUsablePort(USABLE_MAX + 1), false, "and one above is not a port at all");
  // Shape, not just range: a float or a string that would coerce must not pass.
  for (const bad of [1024.5, "1024", NaN, Infinity, null, undefined]) {
    assert.equal(isUsablePort(bad), false, `${String(bad)} is not a port`);
  }
});

test("privileged and invalid ports are refused before any bind is attempted", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The rule is "not privileged", NOT "inside the range macOS happens to use". Review round 10:
  // rejecting anything below 49152 rejected a valid kernel assignment on Linux, whose default
  // ephemeral range starts at 32768 — correct code, refused by us, on a correctly configured host.
  const lock = newLock();
  await assert.rejects(() => lock.acquire(1), PortLockUnavailable);
  await assert.rejects(() => lock.acquire(USABLE_MIN - 1), PortLockUnavailable);
  await assert.rejects(() => lock.acquire(USABLE_MAX + 1), PortLockUnavailable);

  // And the ports Linux would hand out must NOT be refused. This is the assertion that fails
  // against the old rule, and the one whose absence let a portability bug ship as "verified".
  //
  // Scanned, not hardcoded, and a fresh single-use lock per attempt: a fixed port is an environment
  // dependency wearing an assertion's clothes, and it bit immediately — pinning 40000 here made this
  // test fail the moment anything else on the machine held that port.
  let bound = null;
  for (let p = 40000; p <= 40020 && bound === null; p++) {
    const attempt = newLock();
    if (await attempt.acquire(p).catch(() => null) === "acquired") bound = attempt;
  }
  assert.ok(bound !== null,
    "no free port in 40000-40020: a port in Linux's default ephemeral range must be usable, not refused as out of range");
  await bound.release();
});

test("release is prompt and frees the port even with a client connected", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const token = randomBytes(32);
  const lock = newLock();
  await lock.acquire(port);
  // 30s challenge deadline, so "released promptly" and "waited the connection out" differ by
  // three orders of magnitude instead of by 100ms. See the assertion below.
  lock.serveIdentity(token, { purpose: "writer", allocationId: "alloc-1", challengeTimeoutMs: 30_000 });

  // This asserts the OBSERVABLE contract — release is prompt and the port really frees with a
  // client attached — AND, since review round 10, that the tracked-connection teardown is what
  // achieves it. Three mutations removing that teardown previously survived, so it was documented
  // as untested defence in depth. They survived because the assertion sat at 1900ms against a
  // 2000ms challenge deadline: the mutant released at ~2000ms, close enough to the threshold that
  // widening the margin for scheduler noise would have let it through. Injecting the deadline
  // (30s here) separates the two by three orders of magnitude, and the mutant now trips the 5s
  // bound below rather than sneaking under a threshold. The fix for an unpinnable mutant was to
  // stop measuring against a constant I did not control.
  const idle = connect({ host: "127.0.0.1", port });
  await new Promise((r) => idle.once("connect", r));

  const started = process.hrtime.bigint();
  const released = await deadline(
    lock.release(),
    5000,
    "release() blocked on the idle challenge connection",
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Deadline-relative, and the deadline is pushed out to 30s (above) so the separation is three
  // orders of magnitude rather than a few hundred milliseconds. Correct release destroys the idle
  // connection and settles in single-digit ms; a release that waits the connection out settles at
  // the 30s challenge deadline and trips the 5s bound on `deadline()` above long before this line.
  // The previous threshold of 1900ms against a 2000ms deadline was, as review round 10 put it, a
  // wall-clock performance bar wearing a semantic label.
  assert.ok(ms < 5_000, `release took ${ms.toFixed(0)}ms against a 30s challenge deadline — it waited the connection out rather than ending it`);
  assert.equal(released, true);
  idle.destroy();

  const after2 = newLock();
  assert.equal(await after2.acquire(port), "acquired", "the port is genuinely free after release");
  await after2.release();
});

test("identity challenge is domain-separated: right token, wrong purpose is NOT our instance", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const token = randomBytes(32);
  const lock = newLock();
  await lock.acquire(port);
  lock.serveIdentity(token, { purpose: "writer", allocationId: "alloc-1" });

  assert.equal(await identifyHolder(port, token, { purpose: "writer", allocationId: "alloc-1" }), "instance");
  // Both of these hold the SAME per-user token — that is the point. A MAC over the nonce alone
  // would answer "instance" to all three, so a reader lease or an older build would be mistaken
  // for the healthy writer singleton.
  assert.equal(await identifyHolder(port, token, { purpose: "reader-lease", allocationId: "alloc-1" }), "foreign");
  assert.equal(await identifyHolder(port, token, { purpose: "writer", allocationId: "alloc-2" }), "foreign");
  assert.equal(await identifyHolder(port, randomBytes(32), { purpose: "writer", allocationId: "alloc-1" }), "foreign");
  await lock.release();
});

test("REGRESSION: an unset identity domain is refused, not stringified into a shared one", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const token = randomBytes(32);
  const lock = newLock();
  await lock.acquire(port);

  // The reproduced bug: purpose/allocationId were optional, String(undefined) is "undefined", so
  // serveIdentity({}) + identifyHolder({}) answered "instance" — two unrelated endpoints
  // authenticating as each other. The wrong-purpose test above cannot catch this, because it
  // always SUPPLIES both fields; removing the validation leaves it entirely green.
  for (const bad of [{}, { purpose: "writer" }, { allocationId: "a1" }, { purpose: "", allocationId: "a1" }, { purpose: "writer", allocationId: "" }]) {
    assert.throws(() => lock.serveIdentity(token, bad), /must be a non-empty string/,
      `serveIdentity(${JSON.stringify(bad)}) must refuse at REGISTRATION, not answer challenges`);
    await assert.rejects(() => identifyHolder(port, token, { ...bad, timeoutMs: 300 }), /must be a non-empty string/);
  }
  await lock.release();
});

test("a replayed reply is rejected, because the challenger picks the nonce", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const token = randomBytes(32);
  const id = { purpose: "writer", allocationId: "alloc-1" };

  // Capture a reply that is PROVABLY VALID for its own challenge — the first version replayed an
  // HMAC over random bytes, which no honest holder would ever emit, so it proved only that
  // garbage is rejected and would have stayed green with replay protection broken.
  const holder = newLock();
  await holder.acquire(port);
  holder.serveIdentity(token, id);
  assert.equal(await identifyHolder(port, token, id), "instance",
    "the wire protocol is working before we steal from it");
  const nonce1 = randomBytes(NONCE_BYTES);
  const stolen = await new Promise((resolve, reject) => {
    // end(), not write(): the holder replies at the REQUEST BOUNDARY (the challenger's FIN), so a
    // client that never half-closes gets nothing. Without the deepEqual below this test captured
    // an EMPTY buffer and still "passed" — precisely the vacuity the assertion was added to kill.
    const c = connect({ host: "127.0.0.1", port }, () => c.end(nonce1));
    const chunks = [];
    c.on("data", (d) => chunks.push(d));
    c.on("end", () => resolve(Buffer.concat(chunks)));
    c.on("error", reject);
  });
  // PROVE the capture is genuine before replaying it. Asserting only that a different random
  // challenge worked leaves this test green even if `stolen` came back empty or corrupt — it
  // would then demonstrate that garbage is rejected, which is not replay resistance.
  const expected = createHmac("sha256", token)
    .update(`${Buffer.byteLength(PROTOCOL)}:${PROTOCOL}\n`)
    .update(`${Buffer.byteLength(id.purpose)}:${id.purpose}\n`)
    .update(`${Buffer.byteLength(id.allocationId)}:${id.allocationId}\n`)
    .update(nonce1)
    .digest();
  assert.deepEqual(stolen, expected, "the captured reply is the holder's GENUINE answer to nonce1");
  await holder.release();

  // An impostor that answers EVERY challenge with that once-valid reply. identifyHolder mints a
  // fresh nonce, so the stolen reply — genuinely valid for nonce1 — must read as foreign.
  // resume() matters: without a data listener the socket stays paused and "end" never fires, so
  // the impostor would silently never answer and identifyHolder would report "indeterminate" —
  // a test that looks like it proves replay rejection while proving only that nobody replied.
  const impostor = createServer({ allowHalfOpen: true }, (c) => {
    c.resume();
    c.on("end", () => c.end(stolen));
  });
  await new Promise((r) => impostor.listen({ host: "127.0.0.1", port }, r));
  assert.equal(await identifyHolder(port, token, id), "foreign");
  await new Promise((r) => impostor.close(r));
});

test("a fragmented nonce still authenticates: TCP framing is not part of the protocol", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const token = randomBytes(32);
  const id = { purpose: "writer", allocationId: "alloc-1" };
  const lock = newLock();
  await lock.acquire(port);
  lock.serveIdentity(token, id);

  // One byte per write. The first serveIdentity treated the first 'data' event as the whole
  // nonce, so a fragmented — perfectly legal — TCP delivery made a REAL holder MAC a partial
  // nonce and read as foreign. The reply must also be checked valid, not merely present.
  const nonce = randomBytes(NONCE_BYTES);
  const reply = await new Promise((resolve, reject) => {
    const c = connect({ host: "127.0.0.1", port }, async () => {
      for (const byte of nonce) {
        c.write(Buffer.from([byte]));
        await new Promise((r) => setTimeout(r, 1));
      }
      c.end();
    });
    const chunks = [];
    c.on("data", (d) => chunks.push(d));
    c.on("end", () => resolve(Buffer.concat(chunks)));
    c.on("error", reject);
  });
  const expected = createHmac("sha256", token)
    .update(`${Buffer.byteLength(PROTOCOL)}:${PROTOCOL}\n`)
    .update(`${Buffer.byteLength(id.purpose)}:${id.purpose}\n`)
    .update(`${Buffer.byteLength(id.allocationId)}:${id.allocationId}\n`)
    .update(nonce)
    .digest();
  // Byte-compare, not length: an implementation that mis-buffers the fragments and MACs the
  // wrong bytes still returns a 32-byte digest, so a length assertion proves nothing.
  assert.deepEqual(reply, expected, "the holder MACed the reassembled nonce, not a fragment");
  // And an over-long request is a protocol violation, answered with a drop, not a guess.
  assert.equal(
    await new Promise((resolve) => {
      // 32 bytes, THEN the extra byte, then FIN. The old implementation replied the instant 32
      // bytes had arrived, so over-long rejection depended on how TCP happened to segment the
      // request; deciding at the boundary makes it framing-independent.
      const c = connect({ host: "127.0.0.1", port }, async () => {
        c.write(nonce);
        await new Promise((r) => setTimeout(r, 20));
        c.end(Buffer.from("x"));
      });
      c.on("data", () => resolve("replied"));
      c.on("close", () => resolve("dropped"));
    }),
    "dropped",
  );
  // And a SHORT request is equally a protocol violation. Found by my own mutation sweep: deleting
  // the `got !== NONCE_BYTES` check at the request boundary left the whole suite green, because
  // only the over-long case above was covered. Under that mutant a 10-byte request receives an
  // HMAC over a PARTIAL nonce — a reply to something no honest challenger ever sends, computed
  // over input the challenger did not choose, which is the shape replay resistance depends on.
  assert.equal(
    await new Promise((resolve) => {
      const c = connect({ host: "127.0.0.1", port }, () => c.end(nonce.subarray(0, 10)));
      c.on("data", () => resolve("replied"));
      c.on("close", () => resolve("dropped"));
    }),
    "dropped",
    "a short request must be dropped, not answered with a MAC over a partial nonce",
  );
  await lock.release();
});

test("nothing listening is INDETERMINATE, never 'foreign' — we must not act on a guess", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  assert.equal(
    await identifyHolder(port, randomBytes(32), { purpose: "writer", allocationId: "a", timeoutMs: 500 }),
    "indeterminate",
  );
});

test("unexpected close is a POSITIVE lock-loss witness, not merely an absence of commits", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const lost = [];
  const lock = newLock({ onLost: (err) => lost.push(err) });
  await lock.acquire(port);

  // A contender that is already running and retrying BEFORE the close is induced. Starting it
  // afterwards would demonstrate cleanup ordering the test itself chose, not the real window.
  const contender = newLock();
  let contenderGot = null;
  const racing = (async () => {
    for (let i = 0; i < 200 && contenderGot !== "acquired"; i++) {
      contenderGot = await contender.acquire(port).catch(() => null);
      if (contenderGot === "acquired") return;
      await new Promise((r) => setTimeout(r, 5));
    }
  })();

  await lock.__forceUnexpectedClose();

  // THE assertion. "No commit happened" is not enough on its own — it also holds if the holder
  // hung, or never processed the close event at all. A positive, named witness is required.
  assert.equal(lost.length, 1, "lock loss must be announced, not merely implied by silence");
  assert.match(lost[0].message, /can no longer prove/);
  assert.equal(lock.held, false);
  // The protected-commit attempt scheduled AFTER the close handler ran. A mutant that drops the
  // lost-state guard lets this through, and the test fails.
  assert.throws(() => lock.assertHeld(), /closed without release/);

  await racing;
  // Deliberately NOT asserted: that the contender was blocked until the holder aborted. The kernel
  // frees the port before JS is dispatched the close event, so the contender MAY enter first.
  // That is the documented limit of this primitive (plan §3.3) and pretending otherwise here is
  // exactly the overclaim review round 4 removed from the plan.
  if (contenderGot === "acquired") await contender.release();
});

/** Bounded wait with evidence — no storm wait may hang the gate. */
function untilChild(log, what, predicate, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const ev = () => `${what}: exit=${JSON.stringify(log.exited)} messages=${JSON.stringify(log.messages)}`;
    const check = () => { if (predicate(log)) { done(); resolve(log); return true; } return false; };
    const timer = setTimeout(() => { done(); reject(new Error(`timed out ${ev()}`)); }, ms);
    const onMsg = () => check();
    const onExit = () => { if (!check()) { done(); reject(new Error(`child died ${ev()}`)); } };
    const onErr = (e) => { done(); reject(new Error(`child errored (${e.message}) ${ev()}`)); };
    const done = () => { clearTimeout(timer); log.child.off("message", onMsg); log.child.off("exit", onExit); log.child.off("error", onErr); };
    if (check()) return;
    log.child.on("message", onMsg); log.child.on("exit", onExit); log.child.on("error", onErr);
  });
}

test("contender storm: 20 real processes, exactly one holds, and it is STILL HOLDING when the losers report", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const port = await freePort();
  const N = 20;
  const kids = [], results = [];
  let winner = null;

  const logs = Array.from({ length: N }, (_, i) => {
    const c = track("kids", fork(join(HERE, "contender.mjs"), [String(port)], { silent: true }));
    kids.push(c);
    const log = { child: c, messages: [], exited: null, tag: `c${i}` };
    c.on("message", (m) => {
      log.messages.push(m);
      if (m.result) results.push(m);
      if (m.entered) winner = c;
    });
    c.on("exit", (code, sig) => { log.exited = { code, sig }; });
    return log;
  });
  // Bounded, with evidence. Readiness and the leave ack were plain unbounded promises before —
  // a child that died before sending `ready`, or dropped its final IPC message, hung the gate
  // instead of failing it, in a file whose own header claims every storm wait is bounded.
  await Promise.all(logs.map((l) => untilChild(l, `ready from ${l.tag}`, (x) => x.messages.some((m) => m.ready))));

  // Real processes, because mutual exclusion is a property of the KERNEL's binding rule; two
  // objects inside one process share a state space the rule never sees.
  kids.forEach((c) => c.send("go"));
  // Bounded, with evidence — an unbounded poll turns a broken acquire path into a hung gate,
  // and the repo rule about vacuous skips applies to vacuous hangs too.
  //
  // `winner` is part of the wait condition, not just the count. The winner sends `{result}` and
  // `{entered}` as TWO separate messages (contender.mjs:31,34), so `results.length === N` can be
  // satisfied while the winner's `entered` is still in flight — leaving `winner` null and turning
  // the `winner.send("leave")` below into a TypeError on a run where nothing is actually wrong.
  // A timing-dependent failure that accuses the code under test is worse than no test.
  const stallDeadline = Date.now() + 15_000;   // NOT named `deadline`: that shadows the helper above
  while (results.length < N || winner === null) {
    if (Date.now() > stallDeadline) {
      throw new Error(`storm stalled: ${results.length}/${N} results, winner=${winner ? "identified" : "NOT YET identified"} — ${JSON.stringify(results)}; a child likely died or hung`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }

  const acquired = results.filter((r) => r.result === "acquired");
  const occupied = results.filter((r) => r.result === "occupied");
  const errors = results.filter((r) => r.result === "error");

  assert.deepEqual(errors, [], "no contender hit an environment failure");
  assert.equal(acquired.length, 1, `exactly one winner, got ${acquired.length}`);
  assert.equal(occupied.length, N - 1);

  // THE assertion, and the reason the winner is held open on a barrier: all 19 losing results were
  // collected WHILE the winner still held the port. Without this the winner could release early
  // and several children would succeed legitimately, and the storm would report "one winner" only
  // by luck of scheduling. Deliberately NOT comparing IPC timestamps: messages from different
  // senders can be observed out of execution order, so that assertion would be flaky at best.
  const contender = newLock();
  assert.equal(await contender.acquire(port), "occupied", "the winner was still bound when the losers reported");

  const winnerLog = logs.find((l) => l.child === winner);
  winner.send("leave");
  await untilChild(winnerLog, "winner leave ack", (x) => x.messages.some((m) => m.left));
  const after = newLock();   // single-use: the probe above is spent
  assert.equal(await after.acquire(port), "acquired", "and the port frees once the winner releases");
  await after.release();

  // Every contender is shut down through its own path and its EXIT awaited — not `left`, which a
  // child could send while staying alive. Killing them instead left 19 shutdown paths unexercised
  // and the leak invisible.
  for (const l of logs) {
    // `connected` + an error-absorbing callback, the same pair teardown uses and for the same
    // reason. The winner is already on its way out via its own `left` callback, so its channel can
    // close between the `exited === null` check and the send. A bare send() then reports that
    // ASYNCHRONOUSLY as an `error` event on the child — which untilChild is watching, so a healthy
    // shutdown got reported as `child errored (Channel closed)`. Passing a callback routes the
    // failure to the callback instead of the event, which is the whole difference.
    if (l.exited === null && l.child.connected) l.child.send("abandon", () => {});
    await untilChild(l, `clean exit of ${l.tag}`, (x) => x.exited !== null);
    assert.equal(l.exited.sig, null, `${l.tag} exited on its own, not by signal`);
    // "Clean" has to mean successful, not merely unsignalled. Checking the signal alone let a
    // mutant whose `abandon` path calls process.exit(1) survive with all 20 children failing.
    assert.equal(l.exited.code, 0, `${l.tag} exited ${l.exited.code}, not 0`);
  }
});

test("the configured ephemeral range covers the range we require", {
  // Measured on macOS as 49152-65535 (net.inet.ip.portrange.*), which happens to match IANA. It
  // is a sysctl tunable, not an invariant, so this is recorded as an environment precondition:
  // where it does not hold, publishAllocation reports a named configuration error rather than
  // publishing a port later readers reject.
  skip: DARWIN_ONLY,
  // This was the one asynchronous socket test in the file with no harness timeout — so a
  // regression in publishAllocation or in retained-server close would hang the repository-wide
  // gate rather than fail it. Every await here can block on the kernel; none may block forever.
  timeout: WAIT_MS,
}, async () => {
  const { port, server } = await publishAllocation(join(workdir(), "range.alloc"));
  // Registered BEFORE the assertion, so a failing range check still gives the listener back.
  track("servers", server);
  try {
    // What the module actually PROMISES is the only thing asserted. The range check below is an
    // observation about this machine, not a contract, so it is REPORTED rather than gated: macOS
    // exposes net.inet.ip.portrange.first as a sysctl, and on a host that has tuned it this
    // assertion failed `test:all` for a publication that was entirely correct. Round 10 caught the
    // same conflation in the production rule and I fixed it there while leaving the test asserting
    // the old contract — the rule moved, its test did not (review round 14).
    assert.ok(isUsablePort(port), `kernel assigned ${port}, which is not a usable port`);
    if (port < DYNAMIC_MIN || port > DYNAMIC_MAX) {
      process.stderr.write(
        `note: kernel assigned ${port}, outside the ${DYNAMIC_MIN}-${DYNAMIC_MAX} range macOS was ` +
          `measured to use. Not a failure — the module accepts any non-privileged port — but the ` +
          `findings document's environment note no longer describes this host.\n`,
      );
    }
  } finally {
    // The winner RETAINS its listener by design; a test that only wants the number must close it,
    // or the handle stays open for the whole suite and --test-force-exit hides it.
    await new Promise((r) => server.close(r));
    live.servers.delete(server);
  }
});

test("allocation is write-once: the loser adopts the winner's port and is then blocked by the kernel", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const alloc = join(dir, "port.alloc");
  const first = await publishAllocation(alloc, { tag: "a" });
  const second = await publishAllocation(alloc, { tag: "b" });
  // Registered BEFORE the assertions. A failure at any line below used to leave `first`'s retained
  // listener bound with nothing holding a reference to it, and a mutant that wrongly made `second`
  // publish would strand a second one — the failure-path leak that turns red into a hang.
  track("servers", first.server);
  if (second.server) track("servers", second.server);

  assert.equal(first.published, true);
  assert.equal(second.published, false, "link() never clobbers, so only one publication wins");
  // The property that makes the whole scheme work: BOTH processes end up naming the same port.
  // 'bind 0 and persist' fails exactly here — measured, 8 of 8 children got different ports.
  assert.equal(second.port, first.port, "both processes agree on one port");
  assert.equal(readAllocation(alloc), first.port);
  assert.ok(first.port >= USABLE_MIN && first.port <= USABLE_MAX, `kernel assigned ${first.port}`);
  await new Promise((r) => first.server.close(r));   // retained by design; released here
  live.servers.delete(first.server);
});

test("a malformed allocation fails CLOSED — it is coordination state, not a repairable hint", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const bad = (name, write) => {
    const p = join(dir, name);
    write(p);
    return p;
  };
  assert.throws(() => readAllocation(join(dir, "absent")), PortLockUnavailable);
  assert.throws(() => readAllocation(bad("nonjson", (p) => writeFileSync(p, "{", { mode: 0o600 }))), PortLockUnavailable);
  assert.throws(() => readAllocation(bad("range", (p) => writeFileSync(p, JSON.stringify({ port: 80 }), { mode: 0o600 }))), PortLockUnavailable);
  assert.throws(() => readAllocation(bad("nolink", (p) => symlinkSync("/etc/hosts", p))), PortLockUnavailable, "a symlink is not a regular file");
  // Isolated branches. The pre-existing fixtures could not distinguish the new rules from the old
  // ones: the range fixture also lacked a version, and 0644 fails the old group/world check as
  // well as the new exact-mode check, so mutants removing either survived.
  const okBody = JSON.stringify({ port: 50000, version: 1 });
  assert.throws(() => readAllocation(bad("nover", (p) => writeFileSync(p, JSON.stringify({ port: 50000 }), { mode: 0o600 }))), /version undefined/);
  assert.throws(() => readAllocation(bad("v2", (p) => writeFileSync(p, JSON.stringify({ port: 50000, version: 2 }), { mode: 0o600 }))), /version 2/);
  // 0o1600/0o2600/0o4600 are the ones that matter for the MASK: every mode below differs in the
  // low nine bits, so 0o777 and 0o7777 reject them identically and the mask mutant survived. The
  // special bits are the only fixtures that can tell the two masks apart (review round 6 — the
  // suite claimed this coverage without having it).
  for (const mode of [0o400, 0o700, 0o640, 0o1600, 0o2600, 0o4600]) {
    const f = bad(`mode${mode.toString(8)}`, (p) => writeFileSync(p, okBody, { mode: 0o600 }));
    chmodSync(f, mode);
    assert.throws(() => readAllocation(f), /expected exactly 600/, `mode ${mode.toString(8)} must be refused`);
  }
  const loose = bad("loose", (p) => writeFileSync(p, okBody, { mode: 0o600 }));
  chmodSync(loose, 0o644);
  // Group/world-readable means another local account may have seen or influenced it. Repairing the
  // mode in place would be the tempting behaviour and is exactly wrong: the value is already
  // untrustworthy, and silently continuing mints a second singleton.
  assert.throws(() => readAllocation(loose), PortLockUnavailable);
});
