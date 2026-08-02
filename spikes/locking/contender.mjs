/**
 * One real child process in the contender storm (T-008 §3.6 test 3).
 *
 * Real processes, not in-process Lock instances: mutual exclusion is a property of the KERNEL's
 * address/port binding rule, and two objects inside one process share a state space the rule
 * never sees. An in-process storm would test our own bookkeeping and call it exclusion.
 *
 * Protocol with the parent, which controls every transition so the test never depends on timing:
 *
 *   parent -> "go"      make exactly one bind attempt
 *   child  -> {result}  "acquired" | "occupied" | {error}
 *   child  -> {entered} only the winner; sent the instant it is inside the critical section
 *   parent -> "leave"   the winner may now release  <-- WITHOUT this the winner can close before
 *                       the other 19 have attempted, and several of them then succeed legitimately.
 *                       The storm would report one winner only by luck of scheduling.
 *   child  -> {left}    released, about to exit
 */
import { PortLock, PortLockUnavailable } from "./portlock.mjs";

const port = Number(process.argv[2]);
const lock = new PortLock({
  // Losing the lock here must be reported, not thrown into an unhandled rejection where the
  // parent would see only a nonzero exit and could not tell it apart from a crash.
  onLost: (err) => process.send({ lost: err.message }),
});

process.on("message", async (msg) => {
  if (msg === "go") {
    try {
      const result = await lock.acquire(port);
      process.send({ result });
      // Reported only after acquire() resolved, so "entered" cannot be observed before the bind
      // completed — the parent's overlap check depends on these timestamps meaning what they say.
      if (result === "acquired") process.send({ entered: true, at: process.hrtime.bigint().toString() });
    } catch (err) {
      process.send({
        result: "error",
        // The distinction the parent asserts on: an environment that cannot bind loopback at all
        // must never be counted as contention.
        unavailable: err instanceof PortLockUnavailable,
        message: err.message,
      });
    }
    return;
  }
  if (msg === "leave") {
    await lock.release();
    // Exit only once the IPC message has flushed; process.exit() can beat it and hang the parent.
    process.send({ left: true, at: process.hrtime.bigint().toString() }, () => process.exit(0));
  }
  if (msg === "abandon") process.exit(0);
});

process.send({ ready: true });
