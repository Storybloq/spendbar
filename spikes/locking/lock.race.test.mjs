/**
 * The lockfile design (candidate B) admits TWO SIMULTANEOUS HOLDERS. This file proves it.
 *
 * This is a characterization test, not a regression guard for working code. `lock.mjs` is kept in
 * the tree specifically so the failure stays reproducible: "we tried a lockfile and it cannot be
 * made correct with the syscalls Node exposes" is a T-008 gate result, and future work should be
 * able to re-run the evidence rather than re-derive the argument.
 *
 * The design's final defence was to publish via an atomic `rename()` and then decide the winner by
 * READING THE LOCK BACK and checking whose random token survived. That is genuinely better than
 * trusting the syscall's return value — but it is still not mutual exclusion, because read-back
 * tells a process that it LOST; it cannot tell a process that already WON that it has since been
 * superseded. Both contenders below read back their own token, at different times, and both enter.
 *
 * Run: node --test spikes/locking/lock.race.test.mjs
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { POSIX_ONLY } from "../platform.mjs";
import { promisify } from "node:util";

import { Lock, processStartTime } from "./lock.mjs";

const execFileAsync = promisify(execFile);
/**
 * These are deterministic rendezvous tests, so a hang means the sequencing regressed — but an
 * unbounded rendezvous hangs `test:all` instead of reporting that, and --test-force-exit does not
 * rescue a test that never completes. The same bounded-wait discipline the bootstrap suite states.
 */
const WAIT_MS = 15_000;
const dirs = [];
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "spendbar-lockrace-"));
  dirs.push(d);
  return d;
};
after(() => {
  // Every directory attempted, failures aggregated. An unguarded loop stops at the first removal
  // error and silently leaves the rest behind — and in a characterization suite whose whole job is
  // to record HOW the rejected design fails, a teardown that obscures the original failure is
  // especially unhelpful (review round 11).
  const problems = [];
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); }
    catch (err) { problems.push(`remove ${d}: ${err.message}`); }
  }
  if (problems.length) throw new Error(`teardown could not clean up: ${problems.join("; ")}`);
});

/**
 * A pid that is definitely dead: spawn a real process, wait for it to exit, keep its pid.
 *
 * Fabricating a large pid instead would be the tempting shortcut, and it would make this test
 * prove less than it appears to — an unallocated pid and a *recently exited* one are different
 * states, and the liveness check is exactly the code that has to tell them apart. A pid the
 * kernel has actually reaped is the state a crashed owner really leaves behind.
 */
async function deadPid() {
  const child = execFileAsync(process.execPath, ["-e", ""]);
  const pid = child.child.pid;
  await child;
  const probe = await processStartTime(pid);
  // If the OS recycled the pid between exit and probe, the premise of this test is void. Skipping
  // silently would make the whole file pass while proving nothing, so this is an assertion.
  assert.equal(
    probe.state,
    "gone",
    `pid ${pid} was expected to be reaped but reports ${probe.state}; the pid was likely reused, ` +
      "so this run cannot construct the crashed-owner state it needs. Re-run.",
  );
  return pid;
}

/** A lock file left behind by an owner that died without releasing it. */
function plantCrashedOwner(dir, name, pid) {
  const path = join(dir, `${name}.writer.lock`);
  writeFileSync(
    path,
    JSON.stringify({
      pid,
      startTime: "Sat  1 Aug 03:13:05 2026",
      token: "0".repeat(64),
      namespace: "writer",
      generation: 1,
      acquiredAt: "2026-08-01T03:13:05.000Z",
    }),
  );
  return path;
}

test("two contenders both acquire the same lock — candidate B is NOT mutually exclusive", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const path = plantCrashedOwner(dir, "snapshot", await deadPid());

  // A rendezvous inside the takeover window. This does not INVENT the race — it schedules it.
  // Both contenders legitimately reach this point having read the same crashed-owner record and
  // independently judged it dead, which is the ordinary outcome whenever two processes start
  // within the same moment after a crash. Without the barrier the interleaving is real but rare,
  // and a test that reproduces a race one run in a thousand is not evidence of anything.
  let arriveA, arriveB;
  const atA = new Promise((r) => { arriveA = r; });
  const atB = new Promise((r) => { arriveB = r; });

  const pending = {};

  const a = new Lock(dir, "snapshot", {
    hooks: {
      afterLivenessDecision: async () => { arriveA(); await atB; },
    },
  });
  const b = new Lock(dir, "snapshot", {
    hooks: {
      afterLivenessDecision: async () => { arriveB(); await atA; },
      // Let A complete its ENTIRE acquisition — publish and read-back — before B publishes.
      // This is the case the design claims to handle: A is a fully established, self-verified
      // holder at the instant B takes over. Nothing informs A.
      beforePublish: async () => { await pending.a; },
    },
  });

  pending.a = a.tryAcquire();
  const acquiredB = b.tryAcquire();
  const [gotA, gotB] = await Promise.all([pending.a, acquiredB]);

  assert.equal(gotA, true, "A should have acquired: it published and read back its own token");
  assert.equal(
    gotB,
    true,
    "B should ALSO have acquired: it renamed over A and read back its own token. If this now " +
      "fails, lock.mjs has changed and this recorded finding must be re-evaluated rather than " +
      "deleted.",
  );

  // The file names exactly one owner, so from the outside the design looks correct. That is what
  // makes the bug dangerous rather than merely present: no artefact records that A is still
  // running and still believes it holds the lock.
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.token, b.record.token, "the file shows B as the sole owner");
  assert.notEqual(a.record.token, b.record.token);

  // The consequence, stated as an assertion so it cannot rot into a comment: A is a live process
  // that passes its own ownership check right up until it looks again — and every write it makes
  // in between is a write from a second writer.
  assert.equal(a.stillOwnedAdvisory(), false);
  assert.equal(b.stillOwnedAdvisory(), true);
});

test("generation is not a usable fencing token — both holders can mint the same one", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  plantCrashedOwner(dir, "gen", await deadPid());

  // Derived as `previousGeneration + 1` from whatever record the contender happened to read, so
  // two contenders that read the same predecessor mint the SAME number. A fence that two writers
  // can hold simultaneously orders nothing; an allocator has to be authoritative and atomic, which
  // a transient file read cannot be.
  let arriveA, arriveB;
  const atA = new Promise((r) => { arriveA = r; });
  const atB = new Promise((r) => { arriveB = r; });

  const pending = {};
  const a = new Lock(dir, "gen", { hooks: { afterLivenessDecision: async () => { arriveA(); await atB; } } });
  const b = new Lock(dir, "gen", {
    hooks: {
      afterLivenessDecision: async () => { arriveB(); await atA; },
      // Same ordering as the first test: A completes its ENTIRE acquisition before B publishes.
      // Without this the interleaving is scheduler-dependent — B can rename over A before A's
      // read-back, A then reports false with a null record, and the test flakes (review round 1).
      beforePublish: async () => { await pending.a; },
    },
  });

  pending.a = a.tryAcquire();
  const [gotA, gotB] = await Promise.all([pending.a, b.tryAcquire()]);

  assert.equal(gotA, true);
  assert.equal(gotB, true);
  assert.equal(a.generation, 2);
  assert.equal(b.generation, 2, "both contenders minted generation 2 from the same predecessor");
});

test("release() deletes a SUCCESSOR'S live lock — the one rule, violated by release itself", { skip: POSIX_ONLY, timeout: WAIT_MS }, async () => {
  const dir = workdir();
  const path = plantCrashedOwner(dir, "rel", await deadPid());

  // A REAL successor, not a fabricated record. The first version hand-wrote a record at the
  // release window, but that record was stale by the module's own liveness rules and no Lock ever
  // believed it held it — so it proved only that release deletes *a file*.
  //
  // The genuine vulnerable ordering: A reads the lock during release and confirms ITS OWN token
  // (so release believes the unlink is safe), THEN B — which judged the same crashed owner dead
  // long before — publishes over it and reads back its own token, THEN A's unlink lands.
  let arriveA, arriveB, atReleaseRead;
  const atA = new Promise((r) => { arriveA = r; });
  const atB = new Promise((r) => { arriveB = r; });
  const releaseRead = new Promise((r) => { atReleaseRead = r; });
  const pending = {};
  let bOwnedBeforeUnlink = null;

  const a = new Lock(dir, "rel", {
    hooks: {
      afterLivenessDecision: async () => { arriveA(); await atB; },
      afterReleaseRead: async () => {
        atReleaseRead();                       // let B take over, now that A has decided
        assert.equal(await pending.b, true, "B genuinely acquired inside A's release window");
        bOwnedBeforeUnlink = b.stillOwnedAdvisory();
      },
    },
  });
  const b = new Lock(dir, "rel", {
    hooks: {
      afterLivenessDecision: async () => { arriveB(); await atA; },
      beforePublish: async () => { await releaseRead; },
    },
  });

  pending.a = a.tryAcquire();
  pending.b = b.tryAcquire();
  assert.equal(await pending.a, true, "A acquired by taking over the crashed owner");
  assert.equal(await a.release(), true, "A believes its release was clean");

  assert.equal(bOwnedBeforeUnlink, true, "B owned the lock, by B's own check, immediately before A's unlink");
  // And it is gone. A read, decided, then unlinked; the successor arrived in between. No fs
  // primitive available to Node closes that window — the same ceiling as the acquisition race,
  // and a SECOND independent reason candidate B is rejected.
  assert.equal(existsSync(path), false, "the successor's live lock was deleted by a stranger's release()");
  assert.equal(b.stillOwnedAdvisory(), false, "B now owns nothing while still believing it holds the lock");
});
