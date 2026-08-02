/**
 * T-008 §3.6 test 9 + §3.7 crash matrix — the allocation bootstrap under real concurrency and
 * real death.
 *
 * The property under test is the one "bind port 0 and persist" measurably lacked (8 of 8
 * children got different ports and all believed they held the singleton): N racing first-runs
 * must CONVERGE on one port with at most one holder, and a crash at any publication boundary
 * must leave the next process able to converge too — with leftover candidate files named and
 * counted, never silently absorbed.
 *
 * Harness contract: every wait is BOUNDED and rejects with the child's exit code, signal, and
 * message log. A broken implementation must fail this suite loudly, never hang it — the repo
 * rule about vacuous skips applies to vacuous hangs too.
 *
 * Run: node --test spikes/locking/bootstrap.test.mjs
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { POSIX_ONLY } from "../platform.mjs";

import { PortLock, readAllocation } from "./portlock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT_MS = 15_000;
const dirs = [];
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "spendbar-bootstrap-"));
  dirs.push(d);
  return d;
};
const live = new Set();
/**
 * Locks are registered at construction, not released only on the happy path. A probe that
 * unexpectedly ACQUIRES (which is the exact failure its assertion exists to catch) leaves a bound
 * listener behind, and with --test-force-exit gone that turns a red test into a suite that cannot
 * terminate — the 876-second hang this round actually produced in portlock.test.mjs.
 */
const liveLocks = new Set();
const newLock = (opts) => { const l = new PortLock(opts); liveLocks.add(l); return l; };
/** Bound a promise without leaking the losing timer. */
function deadline(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what)), ms); })])
    .finally(() => clearTimeout(timer));
}
const exited = (c) => new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", r)));

after(async () => {
  // Concurrent and individually BOUNDED, and the SIGKILL is followed by an actual WAIT for the
  // exit. Review round 6: the previous version awaited each release serially with no deadline, so
  // one wedged release — the exact leaked-handle mutant this cleanup exists to contain — blocked
  // every remaining lock and the temp-directory removal forever; and signalling a child without
  // awaiting its exit let cleanup return while IPC handles were still open, holding the process up.
  // Cleanup FAILURES ARE REPORTED, not discarded. allSettled plus a swallowed catch meant a wedged
  // release or a child that never emits `exit` left a referenced listener or IPC handle behind
  // while the hook reported success — the runner could still hang, and the teardown would have said
  // nothing (review round 7). Racing a timer does not cancel the underlying operation, so on a
  // child-exit timeout the channel and stdio are forcibly detached before the failure is raised.
  // Resources still live when teardown BEGINS are a failure, exactly as in portlock.test.mjs.
  // Round 10 caught that the gate was added there and not here, so this file kept the self-healing
  // blind spot it was meant to close: a passing test that skipped `untilLeftAndExited()` or left a
  // held lock was silently repaired by SIGKILL and the file stayed green. Counted before cleanup,
  // thrown after it — so the leak is reported without leaving the suite unable to terminate.
  const problems = [];
  const stillLive = {
    locks: [...liveLocks].filter((l) => l.held).length,
    kids: [...live].filter((c) => c.exitCode === null && c.signalCode === null).length,
  };
  const leaked = Object.entries(stillLive).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
  if (leaked.length) problems.push(`a passing run leaked resources: ${leaked.join(" ")} — every success path must release explicitly`);
  for (const r of await Promise.allSettled([
    ...[...liveLocks].map(async (l) => {
      try {
        await deadline(l.release(), 5_000, "lock release wedged");
      } catch (err) {
        // Symmetric with the child branch below, and added because it was NOT (review round 13):
        // the timer bounds how long we WAIT, it does not cancel the close, so a wedged release left
        // a referenced listener holding the event loop open. The hook would then throw the right
        // diagnostic into a runner that never exited to print it.
        l.__forceDispose();
        throw err;
      }
    }),
    ...[...live].map(async (c) => {
      try { c.kill("SIGKILL"); } catch { /* already dead */ }
      try {
        await deadline(exited(c), 5_000, `child ${c.pid} survived SIGKILL`);
      } catch (err) {
        try { c.disconnect(); } catch { /* channel already gone */ }
        for (const pipe of [c.stdin, c.stdout, c.stderr]) pipe?.destroy();
        c.unref();
        throw err;
      }
    }),
  ])) if (r.status === "rejected") problems.push(String(r.reason?.message ?? r.reason));

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

/** Bounded wait on a predicate over a child's log; rejects with full evidence on exit/timeout. */
function until(log, what, predicate) {
  return new Promise((resolve, reject) => {
    const evidence = () =>
      `waiting for ${what}: exit=${JSON.stringify(log.exited)} messages=${JSON.stringify(log.messages)}`;
    const check = () => { if (predicate(log)) { cleanup(); resolve(log); return true; } return false; };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out ${evidence()}`)); }, WAIT_MS);
    const onMessage = () => check();
    const onExit = () => { if (!check()) { cleanup(); reject(new Error(`child died ${evidence()}`)); } };
    const cleanup = () => { clearTimeout(timer); log.child.off("message", onMessage); log.child.off("exit", onExit); };
    if (check()) return;
    log.child.on("message", onMessage);
    log.child.on("exit", onExit);
  });
}

function runChild(allocPath, tag, { crashAt, holdBarrier, mutantEarlyEnter } = {}) {
  const child = fork(join(HERE, "alloc-contender.mjs"), [allocPath, tag], {
    silent: true,
    env: {
      ...process.env,
      ...(crashAt ? { SPENDBAR_CRASH_AT: crashAt } : {}),
      ...(mutantEarlyEnter ? { SPENDBAR_MUTANT_EARLY_ENTER: "1" } : {}),
    },
  });
  live.add(child);
  const log = { child, messages: [], candidate: null, result: null, exited: null, barrierOpen: false, premature: [] };
  child.on("message", (m) => {
    log.messages.push(m);
    // Classified AT RECEIPT, against a flag only the parent writes. See prematureEntries below for
    // why nothing about the message's own contents can be trusted to do this job.
    if (m.entered && !log.barrierOpen) log.premature.push(m);
    if (m.candidate) {
      log.candidate = m.candidate;
      if (!holdBarrier) openBarrier(log);
    }
    // A result is only believed once the barrier is open. Before that there is nothing to have a
    // result ABOUT, so an early one is a lie by construction and must not be allowed to install
    // itself as the child's official result.
    if (m.result && log.barrierOpen) log.result = m;
  });
  child.on("exit", (code, sig) => { log.exited = { code, sig }; live.delete(child); });
  return log;
}

/** One bounded waiter across many children — resolves with whichever satisfies the predicate. */
function untilAny(logs, what, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out ${what}: ${JSON.stringify(logs.map((l) => l.messages))}`)); }, WAIT_MS);
    const check = () => {
      const hit = logs.find(predicate);
      if (hit) { cleanup(); resolve(hit); return true; }
      return false;
    };
    const onAny = () => check();
    const cleanup = () => { clearTimeout(timer); for (const l of logs) { l.child.off("message", onAny); l.child.off("exit", onAny); } };
    if (check()) return;
    for (const l of logs) { l.child.on("message", onAny); l.child.on("exit", onAny); }
  });
}

/**
 * Ask a child to leave, then require BOTH stages independently: the `left` acknowledgement, and a
 * clean exit.
 *
 * The predicate used to be `exited !== null || messages.some(m => m.left)`, and review round 5 was
 * right that the `||` made the acknowledgement stage self-confirming: a mutant child whose `leave`
 * handler just calls `process.exit(0)` — never running `lock.release()`, never sending `left` —
 * satisfies it via the exit alternative, so the test could not tell graceful release from silent
 * death. That is the whole property the two stages exist to separate, so `left` is now required on
 * its own merits and the exit is a second, separate demand.
 *
 * `until` rejects on an exit that does not satisfy the predicate, so a child that dies without
 * acknowledging fails here loudly rather than being absorbed.
 */
async function untilLeftAndExited(log, who) {
  assert.equal(log.exited, null, `${who} was already dead before being asked to leave`);
  log.child.send("leave");
  await until(log, `leave ack from ${who}`, (l) => l.messages.some((m) => m.left));
  await until(log, `clean exit of ${who}`, (l) => l.exited !== null);
  assert.equal(log.exited.sig, null, `${who} exited on its own, not by signal`);
  assert.equal(log.exited.code, 0, `${who} exited 0, not ${log.exited.code}`);
}

/** Bounded wait for a clean SIGKILL death — used by the crash matrix. */
const untilKilled = (log, what) => until(log, what, (l) => l.exited !== null);
/** Bounded wait for the final result message. */
const untilResult = (log, what) => until(log, what, (l) => l.result !== null);

/**
 * Release the winner barrier if the child is parked at it, then wait for death. Crash rows past
 * publication (after-win, after-adopt) pause there by design, so a bare death-wait times out.
 */
async function untilKilledReleasingWinner(log, what) {
  const r = await until(log, what, (l) => l.exited !== null || l.messages.some((m) => m.publishedPort));
  if (r.exited === null) { r.child.send("adopt"); return untilKilled(r, what); }
  return r;
}

/** Drive a child that may pause at the winner barrier, then wait for its final result. */
async function untilResultReleasingWinner(log, what) {
  const r = await until(log, what, (l) => l.result !== null || l.messages.some((m) => m.publishedPort));
  if (r.result === null) { r.child.send("adopt"); return untilResult(r, what); }
  return r;
}

/**
 * The parent opens the barrier: set the flag, then send.
 *
 * Honest note on the ordering, because the obvious justification is wrong. I first wrote that the
 * flag must be set first "because the child can reply faster than the next statement runs" — it
 * cannot. Node dispatches IPC messages from the event loop, so no reply can be processed between
 * two synchronous statements in the parent, and swapping these two lines is an EQUIVALENT MUTANT
 * (verified: the swap passes three runs). The order is kept as defensive style against a future
 * edit that puts anything awaitable between them, and it is recorded here rather than credited
 * with a guarantee it does not provide.
 */
function openBarrier(log) {
  log.barrierOpen = true;
  log.child.send("publish");
}

/**
 * The premature-entry sweep, over what the PARENT observed rather than over what the children said.
 *
 * This has now been wrong twice in the same direction, and the second time is the instructive one.
 * Round 1: it read only result objects, so a child claiming entry early was never looked at.
 * Round 8: it read complete logs but exempted any message whose `result` field said "acquired" —
 * so a mutant sending `{entered: true, result: "acquired"}` before the barrier was waved through
 * for resembling the legitimate final message. Tightening that to object identity (`m !== l.result`)
 * looked like the fix and was not: the early lie ARRIVES FIRST, so it becomes `l.result`, and the
 * identity check then exempts the very message it was added to catch.
 *
 * The actual lesson is that no rule over message CONTENT can work here, because the content is
 * authored by the process under suspicion — every such rule is a spec for how to lie convincingly.
 * The parent does hold one fact the child cannot forge: when the parent itself opened the barrier.
 * Entries are therefore classified at receipt against that flag, and this function only reports
 * what was already decided by an authority the child has no access to.
 */
function prematureEntries(logs) {
  return logs.flatMap((l) => l.premature.map((m) => ({ tag: l.tag, message: m })));
}

test("bootstrap storm: 8 real first-runs, all holding DIFFERENT candidates, converge on one port and one holder", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const alloc = join(dir, "port.alloc");
  const N = 8;
  const kids = Array.from({ length: N }, (_, i) =>
    Object.assign(runChild(alloc, `k${i}`, { holdBarrier: true }), { tag: `k${i}` }));

  // The barrier is the point of the test: every child must be holding its own DISTINCT ephemeral
  // port BEFORE any publishes. Without it the first child can win the link before the others
  // even bind, and the storm degenerates into a queue that would pass under the broken
  // bind-0-and-persist scheme too.
  await Promise.all(kids.map((k) => until(k, `candidate from ${k.tag}`, (l) => l.candidate !== null)));
  assert.equal(new Set(kids.map((k) => k.candidate)).size, N, "the racy state is real: every child reserved a different port");
  assert.deepEqual(prematureEntries(kids), [], "no child claims protected entry before the barrier opens");

  kids.forEach(openBarrier);

  // THE POISONING-WINDOW ADVERSARY, at the only moment that tests anything: the winner has
  // published the allocation and has NOT yet adopted. If its provisional listener were closed
  // here — as the first implementation did before rebinding — an outsider could take the port
  // and the write-once allocation would permanently name a port its publisher never owned.
  // ONE waiter over all children, not a race of N timers: Promise.race settles on the first, but
  // the seven losing `until` timers stayed armed for their full 15s, delaying natural exit.
  const publisher = await untilAny(kids, "publishedPort from any child",
    (l) => l.messages.some((m) => m.publishedPort));
  const publishedPort = publisher.messages.find((m) => m.publishedPort).publishedPort;
  const adversary = newLock();
  assert.equal(await adversary.acquire(publishedPort), "occupied",
    "the publisher held the allocated port continuously across publication — no close-and-rebind gap exists");
  publisher.child.send("adopt");

  await Promise.all(kids.map((k) => untilResult(k, `result from ${k.tag}`)));

  const results = kids.map((k) => k.result);
  const ports = new Set(results.map((r) => r.port));
  const winnerLog = kids.find((k) => k.result.result === "acquired");

  assert.equal(ports.size, 1, `all ${N} children agreed on ONE port; got ${[...ports].join(", ")}`);
  assert.equal(results.filter((r) => r.published).length, 1, "link() let exactly one publication through");
  assert.equal(results.filter((r) => r.result === "acquired").length, 1, "exactly one holder");
  assert.equal(results.filter((r) => r.result === "occupied").length, N - 1);
  assert.deepEqual(prematureEntries(kids), [], "every entered claim is the winner's own final acquire");
  assert.equal(readAllocation(alloc), [...ports][0], "the file and the kernel agree");

  // Every loser's provisional listener is verifiably CLOSED before it re-bids. I had written this
  // mutant off as detectable only through a hang, because the leaked listener is internal to
  // publishAllocation and invisible to the harness's resource registry. Round 8's correction: the
  // registry is not the only observer — the child passed that socket IN, so it can just look at it.
  // The reachability I was missing was in the test's own design, not in the module.
  const losers = kids.filter((k) => !k.result.published);
  assert.equal(losers.length, N - 1, "the storm produced N-1 losers to check");
  for (const l of losers) {
    const reported = l.messages.find((m) => "probeClosed" in m);
    assert.ok(reported, `${l.tag} lost but never reported the state of its provisional listener`);
    assert.equal(reported.probeClosed, true,
      `${l.tag} still had its provisional listener BOUND after losing publication — a leaked ` +
      `reservation on a port no allocation names`);
  }

  // Every child is told to leave and its exit awaited — not just the winner. Leaving seven
  // children for the suite-level SIGKILL makes the test depend on forced cleanup and would hide
  // a shutdown or handle-leak regression, which --test-force-exit hides again at the suite level.
  // Two stages: the `left` acknowledgement AND the actual exit. A mutant that sends `left` and
  // stays alive would pass a one-stage check and leak its IPC channel.
  for (const k of kids) await untilLeftAndExited(k, k.tag);
});

test("the premature-entry sweep is itself falsifiable: a mutant child that lies is flagged", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const alloc = join(dir, "port.alloc");
  const mutant = Object.assign(runChild(alloc, "liar", { holdBarrier: true, mutantEarlyEnter: true }), { tag: "liar" });
  // Wait for THE LIE ITSELF to arrive, not merely for the candidate that precedes it.
  //
  // The child sends `{candidate}` and `{entered, result, mutant}` as two separate messages, so
  // waiting on `candidate !== null` could return before the second had been received — and the
  // sweep then correctly reported zero premature entries because none had arrived yet. It passed
  // standalone and failed roughly one run in ten under `test:all`'s load, which is the worst
  // possible signature: a test that accuses the code under test of going blind whenever the machine
  // is busy.
  //
  // This is the SAME race I fixed in the contender storm in round 8 (waiting for N results without
  // waiting for the winner's separate `entered`), reintroduced here two rounds later. Multi-message
  // IPC needs the wait condition to name every message the assertion depends on.
  //
  // Not self-confirming: the wait is on raw `messages` — did the child send the lie? — while the
  // assertion is on `premature`, which is the classification under test. A sweep that flags nothing
  // still fails.
  await until(mutant, "the mutant's early-enter claim", (l) => l.messages.some((m) => m.mutant));
  // The mutant claimed entry right after its provisional bind — before any allocation exists.
  // If this assertion ever starts passing on zero, the sweep has gone blind and every storm
  // green above it is meaningless.
  const flagged = prematureEntries([mutant]);
  assert.equal(flagged.length, 1, "the sweep flags the lie");
  assert.equal(flagged[0].message.mutant, true);
  // The lie must also have been REFUSED, not merely noticed. Its `result: "acquired"` arrives
  // before any barrier opens, and an unguarded handler would let it install itself as the child's
  // official result — which is precisely how the previous identity-based sweep was defeated, since
  // the exemption for "the child's own final result" then pointed at the lie. Pins the
  // `log.barrierOpen` guard on the result assignment, which nothing else exercises.
  assert.equal(mutant.result, null, "a result claimed before the barrier opened must not be believed");
  mutant.child.kill("SIGKILL");
  await untilKilled(mutant, "mutant cleanup");
});

test("crash matrix: SIGKILL at each REAL publication boundary, and a fresh process still converges", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  // The boundary points ride publishAllocation's own hooks, so mid-publish really is "candidate
  // durable, link not attempted" and after-link really is "allocation live, candidate not yet
  // cleaned" — the first matrix crashed only outside the call, where the finally had already
  // tidied, and so never exercised the boundaries its rows were named after.
  const matrix = [
    { crashAt: "before-publish", residue: 0, alloc: "absent" },
    { crashAt: "mid-publish", residue: 1, alloc: "absent" },     // stranded candidate, no allocation
    { crashAt: "after-link", residue: 1, alloc: "victim" },      // allocation live + stranded candidate
    { crashAt: "after-lose", residue: 0, alloc: "winner", needsWinner: true },
    { crashAt: "after-adopt", residue: 0, alloc: "victim" },     // the holder dies BOUND
  ];

  for (const row of matrix) {
    const dir = workdir();
    const alloc = join(dir, "port.alloc");

    let winnerPort = null;
    if (row.needsWinner) {
      const winner = Object.assign(runChild(alloc, "w"), { tag: "w" });
      await untilResultReleasingWinner(winner, "pre-existing winner");
      winnerPort = winner.result.port;
      await untilLeftAndExited(winner, "pre-existing winner");
    }

    const victim = Object.assign(runChild(alloc, `v-${row.crashAt}`, { crashAt: row.crashAt }), { tag: row.crashAt });
    await untilKilledReleasingWinner(victim, `${row.crashAt} victim death`);
    assert.equal(victim.exited.sig, "SIGKILL", `${row.crashAt}: the child really died uncleanably`);

    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.equal(leftovers.length, row.residue,
      `${row.crashAt}: expected ${row.residue} candidate file(s) of residue, found ${leftovers.length} (${leftovers.join(", ")})`);
    if (row.alloc === "absent") {
      assert.throws(() => readAllocation(alloc), /no allocation/, `${row.crashAt}: no allocation was published`);
    } else {
      const port = readAllocation(alloc);
      if (row.alloc === "winner") assert.equal(port, winnerPort, `${row.crashAt}: the incumbent allocation is untouched`);
      // `victim` rows previously asserted only that SOME readable allocation existed, so a publisher
      // that linked a valid-but-wrong port satisfied both rows while the table's own column claimed
      // the allocation is the victim's (review round 14). The candidate the victim reserved is known
      // — it reports it before dying — so the claim can simply be checked.
      if (row.alloc === "victim") {
        assert.equal(port, victim.candidate,
          `${row.crashAt}: the published allocation must be the port the victim actually reserved`);
      }
    }

    // THE recovery assertion: a fresh, uninstrumented process converges regardless of the wreckage.
    const successor = Object.assign(runChild(alloc, "successor"), { tag: "successor" });
    await untilResultReleasingWinner(successor, `${row.crashAt} successor`);
    assert.equal(successor.result.result, "acquired", `${row.crashAt}: successor holds the lock`);
    assert.equal(successor.result.port, readAllocation(alloc), `${row.crashAt}: on the persisted port`);

    // And exclusion still holds around the successor.
    const probe = newLock();
    assert.equal(await probe.acquire(successor.result.port), "occupied");
    // Exit awaited too: a mutant that acknowledges `left` and stays alive would otherwise be
    // silently SIGKILLed by the suite-level after hook, so the leak it represents never surfaces.
    await untilLeftAndExited(successor, `${row.crashAt} successor`);
  }
});

test("a candidate stranded mid-publish is counted, left alone, and does not block convergence", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const alloc = join(dir, "port.alloc");
  // The same state the mid-publish crash row produces, planted so this test stands even if that
  // row's hook plumbing ever changes.
  const stranded = join(dir, "port.alloc.deadbeef.tmp");
  writeFileSync(stranded, JSON.stringify({ port: 55555, version: 1 }), { mode: 0o600 });

  const successor = Object.assign(runChild(alloc, "successor"), { tag: "successor" });
  await untilResultReleasingWinner(successor, "successor past stranded candidate");
  assert.equal(successor.result.result, "acquired", "the stranded candidate did not block a fresh first-run");
  assert.notEqual(successor.result.port, 55555, "the stranded candidate's port was never adopted — only the LINKED allocation is authoritative");

  // The bounded-cleanup contract from plan §3.7: nothing here may touch a candidate it did not
  // create. The residue is named and counted; removing it is an operator action.
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), ["port.alloc.deadbeef.tmp"]);
  await untilLeftAndExited(successor, "successor");
});
