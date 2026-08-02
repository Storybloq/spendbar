/**
 * One real child in the allocation bootstrap storm and crash matrix (T-008 §3.6 test 9, §3.7).
 *
 * Runs the full first-run sequence: bind an ephemeral port, publish the allocation write-once,
 * and either ADOPT the retained listener (publication winner — it has held the port continuously
 * since before the allocation named it) or bind the winner's port (loser). The parent barriers
 * the publish step so every child provably holds a DIFFERENT ephemeral candidate before any
 * publishes — the racy state the write-once protocol has to converge, not a state the test
 * hopes for.
 *
 * Crash matrix: `SPENDBAR_CRASH_AT` names a point at which the child SIGKILLs ITSELF —
 * deterministic, not timing-dependent, and a self-raised SIGKILL is the same uncleanable death
 * as an external one. The publication-window points ride publishAllocation's own hooks, so they
 * land at the REAL filesystem boundaries (candidate durable / linked, cleanup not yet run) —
 * review round 1 caught that the first matrix crashed only outside the call, where the finally
 * had already tidied up, so the named boundaries were never actually exercised.
 *
 * `SPENDBAR_MUTANT_EARLY_ENTER` makes this child claim protected entry right after its
 * provisional bind — the violation the storm's message-log sweep exists to catch. It is here so
 * the sweep can be shown to fail on a child that lies, not only pass on children that don't.
 */
import net from "node:net";
import { PortLock, createWatchedServer, publishAllocation } from "./portlock.mjs";

const [, , allocPath, tag] = process.argv;
const crashAt = process.env.SPENDBAR_CRASH_AT;
const die = (point) => { if (crashAt === point) process.kill(process.pid, "SIGKILL"); };

// Provisional listener: allocation-only. Under the redesign the winner's provisional listener IS
// the lock (adopted below, never closed), so "provisional" means "not yet agreed", not "will be
// re-bound". Losers close theirs inside publishAllocation and bind the winner's port.
// Watched from creation: publishAllocation refuses a server it did not see created, because
// sockets accepted before tracking starts can never be closed (review round 13).
const probe = createWatchedServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
});
process.send({ candidate: probe.address().port });
// The lie is shaped like the LEGITIMATE final message on purpose: `result: "acquired"` alongside
// the premature `entered`. A weaker mutant (a bare `{entered: true}`) passes against a sweep that
// excuses anything whose result field reads "acquired", which is what the sweep used to do — so the
// weaker mutant would have certified a blind check as working. Review round 8.
if (process.env.SPENDBAR_MUTANT_EARLY_ENTER) process.send({ entered: true, result: "acquired", mutant: true });
await new Promise((r) => process.once("message", r));      // parent: all children now hold distinct ports

die("before-publish");
const lock = new PortLock({ onLost: (err) => process.send({ lost: err.message }) });
let outcome;
try {
  outcome = await publishAllocation(allocPath, {
    tag,
    server: probe,           // the SAME socket that reserved the candidate — continuous hold
    hooks: {
      afterCandidateWrite: () => die("mid-publish"),        // candidate durable, link not attempted
      afterLink: () => die("after-link"),                   // allocation live, candidate not cleaned
    },
  });
} catch (err) {
  // send() then exit() races the IPC flush and loses the message — the harness then reports a
  // bare exit-1 with no cause, which is exactly the evidence-free failure the bounded waits were
  // built to prevent. Exit only from the send callback.
  process.send({ result: "error", message: err.message }, () => process.exit(1));
  await new Promise(() => {});   // hold until the callback exits us
}
die(outcome.published ? "after-win" : "after-lose");

let result;
if (outcome.published) {
  // Winner-only barrier BETWEEN publication and adoption. The adversary test needs to bind the
  // allocated port at exactly this moment: a mutant that closed its provisional listener after
  // publishing and rebound before reporting would look identical from outside once the result
  // arrived, so probing after the result proves nothing about continuous reservation.
  process.send({ publishedPort: outcome.port });
  await new Promise((r) => process.once("message", r));
  lock.adopt(outcome.server);
  result = "acquired";
} else {
  // Review round 8: I had recorded "loser skips closing its probe" as an UNPINNABLE mutant,
  // detectable only as a hang. That was wrong, and the refutation is one line: this child holds a
  // reference to the very socket publishAllocation was supposed to close, so the release is
  // directly observable here rather than only through its downstream consequences. A loser that
  // still has its provisional listener bound would otherwise leak it until exit AND, on the
  // one-in-N run where its own candidate is the winning port, deadlock against itself below.
  process.send({ probeClosed: probe.listening === false });
  result = await lock.acquire(outcome.port);
}
process.send({ result, port: outcome.port, published: outcome.published, entered: result === "acquired" });
die("after-adopt");

process.on("message", async (msg) => {
  if (msg === "leave") {
    // Losers never held the lock, so release() returns false — that is fine and deliberate: the
    // parent releases EVERY child so shutdown is exercised, not just the winner's.
    await lock.release();
    // Exit from the send callback — process.exit() can terminate before the IPC flush, and the
    // parent then waits out its full timeout on a message that was never delivered. Same race the
    // error path above already avoids.
    process.send({ left: true }, () => process.exit(0));
  }
  if (msg === "abandon") process.exit(0);
});
