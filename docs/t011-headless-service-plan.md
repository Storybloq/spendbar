# T-011 — Headless service: run/install/start/stop, launcher, control socket, refresh state machine

*Revision 7. Six plan-review rounds — **reject ×6** — 13 + 13 + 14 + 15 + 11 + 8 findings, and
**all 74 were valid**. Nothing contested in any round. The falling count (15 → 11 → 8) is the only
trend claim made here, and it is made because rounds 5 and 6 also found me arriving at the round's
critical finding independently before the review returned. Every correction is made in place with the
superseded argument left visible, because a plan that quietly swaps a bad proof for a good one
teaches its next reader nothing.*

*Claims that overturned my own reasoning were verified against the machine and the source before I
accepted them: `net.Server.close()` really does unlink a rival's live socket while process death
never does (§1 Q5 reproduces both probes); `store.ts:455-461` really does refuse an unknown root
entry regardless of any manifest; `sourceVersion` really is `Record<string, number>`
(`types.ts:303`); `runner.ts` really is `spawnSync`; `package.json` really does carry `prepack` and
`prepare`. Checking is what made it safe to act on them — and twice it was what told me my own
filed issue was wrong.*

**The honest summary of five rounds: each revision fixed the previous round's instances of the two
defect classes and introduced fresh ones.** Round 3's findings included a class-not-siblings failure
*inside* the fix for a class-not-siblings finding (§9 kept a 0700 launcher after §5 fixed it to
0600), a proved-one-property-used-as-another *inside* the fix for that same class (retry **counts**
routed through the **duration** validator), and a hard-constraint violation introduced by my own
self-audit (adding `ino` to `sourceVersion`, where inodes are prohibited and the field is
`Record<string, number>` anyway). That is not a case for trying harder. It is why §4, §7, §9 and
§2 now push the guarantees into mechanisms that fail the build — annotations on the seam that
*derive* the mutation manifest, a nominal interface with no reachable `close`, an immutable input
registries generated from source rather than written by me — and why anything that cannot be
mechanised is stated as an expectation with its residual named.

*Revision 5's largest change is not a fix but a **withdrawal**. Four designs in a row tried to
manufacture a truthful per-source `sourceVersion` out of an aggregator that does not report what it
consumed, and each failed on the same substitution — bytes **available** used as bytes **consumed**.
The fourth answer is that the scope was wrong: T-011 now publishes one generation with an empty
`sourceVersion`, an explicit no-claim that T-010's own dominance rules make incapable of falsely
dominating anything, and **no ticket is currently claimed to complete repeated authoritative
refresh** — see ISS-075. That
is a real reduction in what v0.2 does with this ticket alone, and it is stated in §4 as a reduction
rather than dressed up.*

## 0. Provenance, and the working rule

`docs/v0.2-prototype-findings.md` (T-008) is the governing document: it *reproduced* the failure
of both lockfile candidates, *measured* macOS silently truncating `sun_path` past 104 bytes, and
*recorded* the adopted primitive. Where this plan and that document differ, that document wins.
`.story/tickets/T-011.json`'s `acceptanceAdditions` is the T-010 review's message to this ticket
and is **binding** — revision 1 called it binding and then failed to honour it, which is
finding 3 below.

T-010 shipped as `d0b6efc`. Its plan file — 199 obligations across twelve review rounds — was
deleted from disk by the session's COMPLETE transition and is unrecoverable (`sessions/` is
gitignored). What survives: the ticket JSONs, ISS-069/070/071, and the commit message.

**The working rule, which two revisions have now stated and then broken.** The dominant defect in
T-008 and in every T-010 round was never a missing check. It was **a class fixed at one site and
not its siblings**, and **a value proven to have one property then used as though a different
property had been proven**.

Revision 1 contained both: it validated one deadline while accepting seven, specified fsync for two
coordination files while creating six, wrote one `assertHeld` mutant for a rule that binds every
publish path — and, worst, treated *"we chose this pathname"* as proof of *"the inode at this
pathname is ours"*.

Revision 2 fixed those and produced four more of the same two shapes, which is the part worth
sitting with. It proved *"our code never unlinks"* and used it as *"no unlink happens"* — Node's
`close()` does it (§1 Q5). It proved *"we are still bound to our inode"* and used it as *"this
pathname still names our inode"* — the identical substitution, one revision after being corrected
for it. It proved *"one subclass of `reset.failed` is benign residue"* and used it as *"every
`reset.failed` is"*, then filed **ISS-072** against a correct binding document on the strength of
it (§3). And it listed a 0700 launcher and a 0644 plist inside the very inventory written to prove
every file obeys the 0600/0700 rule (§5).

The lesson revision 3 takes from that is not "try harder". It is that **the mechanism has to be
outside my judgement**, because my judgement produced the same error four times in a document whose
opening paragraph names the error. So: an AST manifest that fails the build when a mutation has no
mutant (§7), a lint rule for the `close()` call (§1 Q5), a bidirectional inventory rather than a
list I maintain (§7), and §10 grouped by acceptance criterion so an unaddressed one is visible
rather than remembered. Where a claim cannot be mechanised, it is stated as an expectation rather
than a guarantee — `/tmp` cleanup on reboot, and what ccusage consumed.

---

## 1. The five open questions, decided

### Q1 — control-protocol framing → **length-prefixed** (argument corrected)

4-byte big-endian unsigned length, then a canonical-JSON body; 64 KiB maximum request body,
1 MiB maximum response body, and a **total** cap on a progress stream (§6) because a per-frame
limit bounds no stream.

Revision 1 argued that newline framing *cannot* reject oversized input. **That was wrong**, and
the reviewer is right: a JSON-lines parser can retain at most the limit and reject the moment the
next byte arrives without a delimiter. Bounded buffering is achievable in both designs, so it
does not distinguish them.

The real reasons, which do:

- **The size is declared before it is spent.** A length prefix lets the server refuse from four
  bytes, with an actionable typed error, instead of discovering at byte 65537 that the peer was
  never going to send a delimiter. The difference is diagnosis quality, not whether memory is
  bounded.
- **One framing discipline, deterministic boundaries** — the frame's extent is known from the
  header rather than discovered by scanning. *(Revision 3 also claimed newline framing is ambiguous
  about "a newline inside a string". That is false and is removed rather than left standing: a raw
  newline is invalid inside a JSON string, and an escaped `\n` contains no delimiter byte. This is
  the third Q1 argument I have had to withdraw; the decision has survived all three, which is worth
  noting only because it means the decision was never resting on them.)*
- **One framing discipline in the process.** The identity challenge is already length-framed at
  exactly 32 bytes; two framings is two parsers to get right.

Both designs need the same behaviour for a peer that declares a legal length and then stalls: an
idle deadline, specified in §6 and validated in §7.

### Q2 — "disable relaunch" → **`launchctl disable`, verified, inside idempotent reconciliation**

Plist: `RunAtLoad: true`, `KeepAlive: { SuccessfulExit: false }`, `ThrottleInterval: 10`,
**`ExitTimeOut` (seconds, the value Q4's launchd-termination bound is read from — revision 4
relied on "the configured launchd exit timeout" while this key list omitted it, so there was no
configured value to read)**, and no
`LimitLoadToSessionType`. `KeepAlive: { SuccessfulExit: false }` means a graceful (exit 0) stop
is not respawned while a crash is; `launchctl disable gui/<uid>/<label>` is what makes
desired-state=stopped durable across a reboot.

Revision 1 claimed the override database has "no such window". **Too strong.** A crash between
persisting desired=stopped and issuing `disable` leaves launchd enabled while durable state says
stopped. And `launchctl enable|disable` returns 0 in cases that do not prove the label reached
the intended state, so exit status is not evidence.

Corrections:

- **`start` and `stop` are idempotent reconciliation operations, not sequences.** Each reads
  validated desired state, computes the delta against observed state, and applies only the steps
  that are missing. Running either twice is a no-op; running either after any partial failure
  completes it.
- **`service run` reads validated desired state before doing any work** and refuses to start when
  it says stopped, which closes the crash-between-steps divergence from the other side.
- **Verification is by `launchctl print-disabled` / `print` for the exact label**, never by exit
  code.
- `stop` continues through recoverable step failures, aggregating errors, rather than abandoning
  cleanup at the first one.
- Tests inject **crashes between steps**, not only returned errors from steps.

### Q3 — minimal `service repair` in v0.2 → **No**

Per ISS-026 the mismatch message therefore names **only** re-running `spendbar service install`
from the owning installation, and must not mention `repair`. The argument is scope: `repair` is a
convenience remedy whose semantics (which installation may take over a registry it does not own?)
would have to be designed inside a ticket that has not yet proven the registry. It goes to v0.3
with the upgrade matrix.

### Q4 — shutdown → **semantics first, then TWO bounds, both enforced from OUTSIDE**

Revision 1 estimated one publish path and used it as a bound for the whole shutdown. That proves
nothing about the siblings — an in-flight `ccusage` child, a stalled control client, a blocked
socket write, a store bootstrap, or a synchronous canonicalize that prevents an in-process timer
from firing at all.

What ships:

1. **Stop serving at ONE linearization point.** Revision 3 said "latch a refusing flag and destroy
   any connection accepted afterwards", and that covers only connections whose *acceptance* callback
   observes the latch. It misses an already-established connection, and one accepted before the
   latch whose authentication or dispatch continuation resumes after it — both can still dispatch
   requests during shutdown, so the plan did not establish that serving had stopped. The latch is
   irreversible and is checked **at acceptance AND immediately before every frame dispatch and every
   job admission**; every connection except the one carrying the in-flight `stop` response is
   destroyed immediately. Deterministic tests pause at each of the four points — accept-before-latch,
   auth-before-latch, dispatch-before-latch, and a persistent authenticated connection that sends
   after the latch — because a single "we set a flag" test passes while three of those four still
   serve. **The latch check sites are derived, not listed** — but §7's `ServiceOs` effect
   annotations are the wrong source of truth for them, which revision 4 claimed and could not have
   delivered: a control handler and a queue job kind are not `ServiceOs` methods, so nothing in that
   registry describes them. Two **separate exhaustive registries** therefore exist — one of every
   protocol operation, one of every queue job kind — with dispatch and admission code generated from
   them, an unregistered handler or job kind failing the build, and a mutant introducing one of each
   without a shutdown check. A hand-maintained list of check sites is the thing that failed at every
   other site enumeration in this plan; a registry that does not cover the sites in question is the
   same failure wearing the word "derived".
2. **Cancel or discard**: queued jobs are discarded; a running job is *cancelled* (child killed,
   loop cancellation token observed) and its result discarded — never published.
3. **Publish only an already-materialized flush**, and shutdown never *starts* work that could
   block. The flush publishes **the candidate its job produced, carrying that job's own
   `sourceVersion`** — the empty no-claim value belongs to §4's minimal rebuild candidate
   specifically, not to the publish path in general, and a future T-012 flush must keep the
   truthful version its tier computed. *Revision 5 both applied `{}` to every flush and contained
   a flat contradiction: it said the flush skips the call when a live manifest exists AND that the
   ordinary live case asserts a typed `equal` refusal. Skipping the call produces no refusal to
   assert.* Resolved by choosing — but the skip is **conditioned on the candidate, not on the
   store**: only a candidate carrying the **empty no-claim `sourceVersion`** is skipped, and the
   test asserts **zero `publishSnapshot` calls** for it. "A live manifest exists" is not proof that
   a materialized candidate should be discarded, and gating on it would throw away every future
   truthful, strictly-dominating flush candidate in the ordinary case — contradicting the promise
   one sentence earlier to publish the candidate its job produced. Any non-empty candidate is passed
   to `publishSnapshot` and its typed published/refused outcome routed, with a shutdown test using a
   strictly dominating candidate that **must publish**.
4. **Tracked connections closed, then destroyed** at the deadline.
5. **The deadline is enforced by the stopping process, not by the daemon** — a monotonic wait,
   then `bootout`. An in-process timer cannot fire if the event loop is blocked, which is exactly
   the case the deadline exists for.

**Two bounds, not one — revision 3 stated a single 5000 ms and claimed "stopped within the
deadline", which is false.** Waiting 5000 ms and *then* invoking `bootout` cannot stop anything
within 5000 ms; `bootout` and launchd's own SIGTERM-to-forced-exit interval both add time after it,
and they add the most in precisely the event-loop-blocked case cited as the reason for external
enforcement. So: a **graceful-wait bound** (5000 ms, injectable, validated per §7), and a separate
**launchd-termination bound** whose value is the configured launchd exit timeout, verified rather
than assumed. What the plan claims is "`bootout` is requested after the graceful bound"; the
end-to-end guarantee is the **sum**, and the test asserts the total elapsed bound rather than the
first term of it. Tests: a blocked child, a blocked socket write, a blocked close, and an
event-loop-blocking publish.

### Q5 — the stale-socket residual (ISS-041) → **option (a), LITERALLY: no pathname is ever unlinked**

Revision 1 chose a per-process nonce path and then added a sweep of "paths we recorded
ourselves". **That is unsound, and it is this ticket's own named defect class.** A recorded path
is a *name*. The history proves we once chose it; it does not prove the inode there is ours:

- After a crash, a same-UID process can unlink the orphan and bind its own socket at that
  pathname. The sweep then deletes a **live replacement**.
- The cooperating case races too. T-008 measured that the kernel frees the port *before*
  JavaScript is dispatched the `close` event — so holding the port does **not** prove the
  predecessor's unix socket is dead.

That is stale-record-then-unlink with the probe removed, which changes the evidence but not the
race. And revision 1's adversarial test was **vacuous**: it exercised a path the holder never
considers, so it could not detect replacement at a historical path.

Revision 2 then kept ONE unlink — "our own path, at graceful shutdown, while still bound to that
inode" — and review round 2 killed that too, correctly and on two independent grounds. **Being
bound proves the server handle refers to its original inode; it does not prove the pathname still
names that inode.** The same adversary unlinks our live name, binds a replacement, and our
"graceful" cleanup deletes *their* socket. There is still a pathname lookup, so there is still the
race. Worse, and this is the part I had not looked at: **`net.Server.close()` unlinks the path
itself**, so "our code never calls unlink" was never the same claim as "no unlink happens."

I verified both empirically rather than take them on authority (Node v22.18.0, macOS):

    original inode: 509838642   rival inode: 509838643
    rival present before our close: true
    rival socket survived our server.close(): false
    *** Node's close() DELETED the rival's live socket ***

and then the complementary probe, which is what makes the fix implementable:

    plain process.exit(0) : socket SURVIVED (not unlinked)
    SIGTERM -> exit(0)    : socket SURVIVED (not unlinked)
    SIGKILL               : socket SURVIVED (not unlinked)

**Only `close()` unlinks. Process death never does** — *on the runtime I measured*. That
qualification is load-bearing and revision 4 dropped it: the probes ran on Node 22.18.0 while
`package.json` declares `engines.node: ">=22.12.0"` with **no upper bound**, so the absolute claim
covered runtimes I had not tested and cannot constrain. A nominal interface stops *our* code from
calling close; it says nothing about a future Node's shutdown behaviour.

Revision 7 answered this with the range `>=22.12.0 <23.0.0` probed at two endpoints — and that is
**two versions used as proof for an interval**, the defect class again, on the claim Q5 rests
entirely on. An interval also **admits future 22.x releases that were never probed**, so the
"verified range" would silently un-verify itself on the next Node patch.

So the qualification is **empirical at the runtime that will actually run**, not inferred from an
interval: `service install` and `service run` execute the process-exit / SIGTERM / SIGKILL probes
plus the rival-survival oracle **against the live interpreter** and refuse to proceed if the
socket is unlinked, with the result cached per interpreter identity so it is not re-run on every
start. CI additionally publishes an **explicit allowlist of the exact versions probed**, so the
claim is "these versions were measured" rather than "this interval was verified". That is a
narrower claim and it is the only one the evidence supports. So what ships:

- Socket path: `/tmp/spendbar-<uid>/svc-<32 hex>.sock`, nonce fresh per process start from
  `randomBytes(16)` — a CSPRNG, named explicitly, with no collision handling because at 128 bits
  there is nothing to handle; a bind that nonetheless returns `EADDRINUSE` retries a bounded number
  of times with a fresh nonce and **never unlinks**, then fails with a typed error. Canonical
  length 67 bytes at uid 501, 74 at a 10-digit uid — bounded by construction.
- The live path is published in `endpoint.json` (mutable, port-guarded, atomic rename + fsync;
  the write-once allocation is untouched), and validated by readers per §6.1 before anyone connects.
- **No unix-socket pathname is ever unlinked. Not by us, not by Node, not at any point.**
  `close()` is never called on the unix-domain server — that is a rule about the runtime, not just
  about our code, and it is the only form of the rule that is true. The process exits and the
  kernel drops the listener. **How shutdown actually stops serving is Q4**, because
  "accept-then-destroy" was not enough and compressing it back into one line here would repeat the
  error.
- **The raw `net.Server` never escapes one adapter.** A lint rule against `.close()` was revision
  3's mechanism and it is not sufficient — I called it mechanised when it was syntactic. `close()`
  is reachable without ever writing `.close()`: `server[Symbol.asyncDispose]()` delegates to it (so
  a `using` declaration closes on scope exit), aborting the `AbortSignal` passed to
  `listen({signal})` closes it, and any alias, helper, or escaped raw server evades a `.close()`
  scan entirely. So the UDS server lives inside one adapter and is exposed only through a **nominal
  interface with no `close`, no `Symbol.asyncDispose`, no signal option and no raw-server getter** —
  a shape where the unlink paths cannot be named rather than a rule asking that they not be typed.
- Type-aware bans plus a mutant for **each** close-equivalent route — direct `close()`, `using` /
  `Symbol.asyncDispose`, aborting the `listen` signal, an aliased close, and cleanup on a *failed
  startup after `listen` succeeded*, which is the site a tidy-up would most naturally be written and
  would unlink a pathname that by then may be someone else's. A failed startup exits; it does not
  tidy. Every one of those mutants is run against the rival-replacement survival oracle, because a
  ban that is never shown to catch the thing it bans is a comment. (`close()` on the **TCP** lock
  listener is fine and unaffected: no pathname, no unlink.)

**The residual, stated correctly this time — and it is now larger, not smaller.** Orphan socket
inodes accumulate **without bound, one per process exit** — every shutdown, graceful or not, not
just every crash. Revision 1 claimed a bound of 8 (false: its sweep was unsound, and a crash
between `bind` and the endpoint publish leaves an inode no history could contain). Revision 2
claimed graceful shutdowns were clean (false: see above). The honest statement is that this design
trades unbounded orphans for never deleting a name it cannot prove it owns, and takes that trade
knowingly. `/tmp` cleanup on reboot is an **environmental expectation, not a guarantee** — no
version-scoped evidence is offered for it and none is claimed. A launchd crash loop produces
roughly one orphan per `ThrottleInterval` indefinitely, so the service emits a diagnostic when its
own runtime dir exceeds a threshold count, which surfaces the growth instead of letting it be
discovered.

The adversarial test is now decisive rather than merely non-vacuous: a competitor replaces the
pathname **while our original server is still bound**, we perform a full graceful shutdown, and the
assertion is that the competitor's inode **survives**. That test fails under revision 1, fails
under revision 2, and is exactly the probe reproduced above.

---

## 2. What gets built

`src/service/`, mirroring `src/snapshot/`: seam interface, real adapter, pure logic taking the
seam. The spikes are **evidence, not a library**.

| module | responsibility |
|---|---|
| `types.ts` | The `ServiceOs` seam (net / fs / process / launchctl / clock), with every contract stated **on the interface**, not only in the adapter. |
| `errors.ts` | Branded, tagged errors: identity by module-private `WeakMap`, `name`/`code` as **own data properties** via `snapshot/intrinsics.js`, causes carried opaquely. |
| `durations.ts` | **Two** validators and the registry of their sites (§7): finite-positive-bounded for elapsed-time values, positive-bounded-**safe-integer** for attempt counts. A count is not a duration. |
| `coordination.ts` | The single write-path for every coordination file (§5): exact mode via `fchmod`-after-open + `fstat` verify, short-write-safe loop, file fsync, atomic publication, parent-directory fsync. |
| `portlock.ts` | Write-once allocation via `link()`, continuous reservation via adopt, `assertHeld()`, loss latch, `identifyHolder` challenge–response. Carries T-008's pinned invariants as named regression tests (§7.1). |
| `runtime-dir.ts` | Runtime dir + 32-byte token; digest-then-`timingSafeEqual` comparison. |
| `socket-path.ts` | Pre-`listen` canonical-length refusal, component rules, no-symlinks-below-root, the per-start nonce path. |
| `control.ts` | Length-prefixed protocol, auth-before-dispatch, request IDs, version negotiation, idle/request deadlines, caps, backpressure. |
| `queue.ts` | Refresh state machine: one queue, generations, coalescing, publish-if-current, cancellation. |
| `ccusage.ts` | Async `spawn` adapter — cancellation, timeout, byte limits, strict decoding, exit/signal classification, unconditional child cleanup. `runner.ts` is `spawnSync` and cannot serve a daemon (§4). |
| `rebuild.ts` | **The minimal rebuild job (§4)** — the thing that makes AC 1 a production test. Publishes with an empty `sourceVersion` (an explicit no-claim); what completes repeated authoritative refresh is undecided (ISS-075). |
| `store-bootstrap.ts` | **The T-010 integration contract (§3)**, every branch. |
| `launcher.ts` | Installation identity, allowlist registry, `[node, cli.js]` absolute pairs, no PATH search. |
| `lifecycle.ts` | `install`/`start`/`stop` as idempotent reconciliation; plist emission; verified `launchctl`. |
| `run.ts` | Composition and the fixed startup order (§8). |

**Only the adapter may inspect a native error — and revision 2 never said so.** That is one of this
ticket's hard constraints and it was simply absent from the plan, which is how it would have been
absent from the code: a branded error module with opaque causes is not enough on its own, because
nothing stops core logic from reaching for `err.code` when a branch needs `ENOENT` or `EEXIST`. So
**every** filesystem method on `ServiceOs` returns a *classified* result — one of a closed set of
outcomes carried by private identity brands — and the real adapter is the single place that maps a
native failure into it, once. Core modules never read `code`, `message` or `name` off anything they
did not construct. The enumeration is every fs operation this ticket performs, not the memorable
ones: coordination reads and writes, candidate creation, `realpath`, `lstat`, `open`, `link`,
`rename`, `fsync`, directory fsync, and the endpoint read.

**And every NET operation whose failure core logic branches on, which revision 3 left out.** The
classified-result rule was applied to the filesystem and stopped there — the same
one-site-not-its-siblings shape, in the section that states the rule. It does not survive contact
with this ticket: port acquisition **must** tell `EADDRINUSE` (a holder exists — diagnose it) from
`EACCES` or a sandbox refusal (an environment failure), and T-008 is explicit that collapsing those
two is the indeterminate-becomes-an-answer defect; control connections must tell refusal from
malformed coordination. Without classified net outcomes, core modules inspect native error shapes
to make exactly the decisions the boundary exists to protect. So `listen`, `connect`, per-socket
errors and the identity challenge each return closed, branded outcomes, with native inspection
confined to the low-level adapter.

Tests throw hostile values and Proxies at **every classification a core module consumes**, network
and filesystem alike — the T-010 discipline, applied to the whole seam rather than half of it.

**This needs an explicit owner amendment before it is implemented, and it is not implemented
without one.** The hard constraint says *only the **fs** adapter may inspect a native error*.
Branding a net outcome stops core logic from inspecting it, but it does not satisfy a restriction on
**where the original native error is inspected** — I was proving one property and using it as the
other, which is why it is flagged rather than shipped. Two coherent resolutions, both the owner's:
widen the constraint to "only a designated low-level adapter", naming the net adapter alongside the
fs one; or route net failures through the single authorized adapter. Until one is chosen, the port
lock cannot distinguish `EADDRINUSE` from `EACCES` — and T-008 is explicit that collapsing those is
the indeterminate-becomes-an-answer defect — so this genuinely blocks that distinction rather than
being a wording quibble. Recorded in §12.

**Revision 3 added new bounds and routed them all through the DURATION validator, which was wrong
for the counts.** The ccusage adapter's timeout is a duration; the `EADDRINUSE` rebind limit is an
**attempt count**. Finite-and-positive does not prove *safe integer*: `2.5` and `2**60` both pass a
duration check and neither is a count. Sending a count through a validator that proves the wrong
property is this plan's own defect class (b), committed inside the fix for defect class (a) — which
is exactly why it is written down here instead of silently re-routed.

So there are **two validators**: `durations.ts` for elapsed-time values, and one
**positive-bounded-safe-integer** validator for attempt counts, with every count registered through
it and tested against fractional, unsafe-integer, negative-zero, non-number and above-maximum
inputs in addition to the hostile values the duration sites already get.

CLI: `service run|install|start|stop`, and `refresh`.

`createWriteAuthority` from `src/snapshot/authority.ts` is the **only** thing passed to
`startWriter`/`publishSnapshot`; the `PortLock` becomes its inner authority. `LatchingWriteAuthority`
is nominal, so a raw `PortLock` neither typechecks at the seam nor passes `assertGuardedAuthority`.

---

## 3. Store bootstrap — the binding T-010 contract (finding 3)

Revision 1 reduced this to "pass a branded authority". The `acceptanceAdditions` require all of
the following, and each gets a named test:

- **Version scoping.** Only `<stateDir>/store-v<SCHEMA_VERSION>/` is ever addressed. A test
  asserts **no seam call names another version's directory** — the same containment oracle shape
  T-010 used, so it can fail for the reason its name gives.
- **Authority first.** The port lock is acquired *before* `startWriter`, which asserts authority
  before it sweeps staging.
- **Routing on `startWriter`'s status, in the order it must actually be evaluated.** `usable` →
  resume, treating `unreferencedGenerations` as ordinary GC input. `first-run` → record
  `needs-initial-build`. `not-usable` → the reset has *already been attempted*, so **inspect the
  completed reset FIRST**: hard-stop on any of the three fields below; log `resetError.reason` for
  observability and **never branch on it** (a mutant that switches on `reason` must fail the
  suite); and only a reset with all three fields clear records `needs-initial-build`.

  *Revision 3 wrote this bullet as "`not-usable` → log the reason, then rebuild" and put the hard
  stops in the next bullet. Since this plan is implemented directly, that earlier unconditional
  instruction is the one that would have been coded — reproducing the exact `acceptanceAdditions`
  violation the section exists to prevent. The word "rebuild" now appears only at the final branch.*
- **The reset outcome is not assumed to be success. THREE hard stops, exactly as the
  `acceptanceAdditions` states.** `reset.failed` non-empty → the store is in an unknown state; do
  **not** rebuild, surface it, and retry only from a fresh `startWriter`.
  `reset.stoppedAtManifest` → **the manifest visibility boundary could not be cleared, so reset
  cannot safely continue.** (Revision 3 said this means the store is "intact and still readable".
  That overstates it: `resetStore` also returns this flag when the manifest pathname holds a
  directory or other unusable state, where nothing readable is established. The hard-stop
  disposition is right; the evidence claimed for it was not. Readability is asserted only in the
  specific case of a regular, previously validated manifest.) `reset.stoppedOnAuthorityLoss` → the
  lock is gone; stop, do not retry. Only a reset with none of the three set may be followed by a
  rebuild.

  **Revision 2 said two, and that was my error — recorded here rather than quietly corrected**
  (I filed **ISS-072** against the ticket on the strength of it; it is now **withdrawn**). My
  argument was that a non-empty `failed` is benign residue which a published manifest converts
  into unreferenced generations for GC, and that treating it as a hard stop wedges the service.
  That holds for exactly one subclass. `failed` is a `string[]` and it does **not** say what kind
  of entry each path is: it can name an unknown root entry, a substituted directory, or wrong-type
  staging state. `store.ts:455-461` is decisive —

      manifest present + unreferenced generation  -> USABLE; the orphan is GC input
      unknown entry in the root                   -> not-usable (reset)

  — so for anything but that one benign subclass, classification refuses the store **regardless of
  any manifest**. Rebuilding does not converge; it burns a full ccusage rebuild every start and
  publishes a snapshot the next start destroys, which is strictly worse than stopping and
  surfacing. I proved a property of one subclass and used it as though it had been proved of all
  of them — **the same defect class as this round's critical Q5 finding, in the same revision**,
  which is why it is written out here instead of being edited away.
- **GC outcomes — and the field is `noUsableManifest`, not `noManifest`** (filed as **ISS-073**;
  the ticket text names a field that does not exist, and reading `undefined` is falsy, so a branch
  written against the ticket's wording would silently never fire). `SweepResult.noUsableManifest`
  is documented as *"absent, or present under a name that is a symlink, a non-regular file, or the
  wrong mode… Both cases route to reset-and-rebuild under the one rule"* (`store.ts:2804`). So the
  response is **not** a direct rebuild, which the ticket also gets wrong: a direct rebuild on a
  present-but-unusable manifest would publish over a symlink or a wrong-mode file without passing
  through classification or reset — acting inside a tree the store has just said it cannot account
  for. Correct routing: surface that nothing was collected, run a **fresh `startWriter`**, honour
  all three reset hard stops, and rebuild only after `first-run` or a completed reset. Separate
  tests for the absent manifest and for **each** present-but-unusable form (symlink, non-regular
  file, wrong mode) — one test for "unusable" would pass with three of the four branches missing.
  `abortedOnManifestChange` → a concurrent publish moved the manifest; leave the residue for the
  next sweep, do not re-run immediately.
- **Dominance is advisory.** T-011 supplies the live manifest and accepts that a writer held past
  its check regresses to stale-but-complete, self-corrected by the next dominating publish.
- **Three hard-stop tests, and `failed` gets four of them.** `stoppedAtManifest` and
  `stoppedOnAuthorityLoss` each halt the bootstrap with **zero rebuild**. Because `failed` does
  not say what it names, it is tested once per kind of thing it can name — a failed valid
  generation, an unknown root entry, a substituted directory, and a wrong-type staging entry —
  each asserting **zero publish**. A single `failed`-is-non-empty test would pass while three of
  the four kinds went unhandled, which is precisely the generalisation that produced the withdrawn
  ISS-072.
- **Convergence, asserted in two phases and not one.** After a `not-usable` store resets and
  rebuilds, the next `startWriter` must never report `not-usable` again. The trap the ticket's own
  correction records: the status immediately after the reset is `first-run` (the store is empty),
  and only *after* the rebuild PUBLISHES does it become `usable`. Asserting `first-run` twice would
  pass even if the rebuild silently wrote nothing, so both phases are asserted separately — which
  is the same "a test must be able to fail for the reason its name gives" standard applied to a
  test whose name is about convergence.
- The adapter supplied to the store implements `openRead`/`readAll`, refuses a final-component
  symlink with an `ELOOP`-coded error, and routes every failure through `classifyFsError`.
- The authority passed in is one `createWriteAuthority(inner, onLost)` built — **not**
  `createLatchingWriteAuthority`, which does not exist and which the ticket's own text names
  wrongly. The runtime brand is a module-private `WeakSet`, not `instanceof`, because
  `Object.create(LatchingWriteAuthority.prototype)` with an own no-op `assertHeld` satisfies
  `instanceof` while holding no latch at all; a forged authority is refused at every entry point
  with `AuthorityHandlerContractError`.

---

## 4. The minimal rebuild job (finding 4)

AC 1 requires a **real** published generation from a production path; revision 1 excluded tier
internals and named no rebuild, so only a synthetic queue test could have passed. `rebuild.ts`
owns the interim path until T-012 replaces or schedules it:

**A new async ccusage adapter, because `runner.ts` cannot do this job.** Revision 2 said "invokes
`src/runner.ts` through the seam, as a cancellable child". `src/runner.ts:176` is **`spawnSync`**,
and calling it through a seam does not make it asynchronous: it cannot be cancelled by the event
loop and it blocks `status`, `progress`, `stop` and the lock-loss witness for up to its 120-second
timeout — in a process whose entire contract is to respond to those. So `service/ccusage.ts` is a
dedicated adapter over `spawn` with `shell: false`, real cancellation, a timeout, output-byte
limits, strict decoding, exit/signal classification and unconditional child cleanup. It **shares**
`runner.ts`'s validation and diagnostic helpers rather than duplicating the judgements, and a test
proves the synchronous runner is unreachable from any service module — otherwise this is a second
implementation of the same decisions, which is how the two diverge.

**Source-version provenance, which revision 2 asserted without checking.** I claimed a
"per-source-offset source-version manifest" as though the existing aggregation could supply one.
It cannot: `aggregate.ts` operates on ccusage's *output*, and ccusage does not report which bytes
of which transcripts it consumed. Pre-scan sizes can omit bytes ccusage later reads; post-scan
sizes can claim bytes appended after ccusage passed the file. A generation counter or timestamp
would prove a job ran, not that any source advanced — and used as `sourceVersion` it can **falsely
dominate** and publish stale or incomplete data over good data. That is the dominance rule turned
into a corruption mechanism.

**Three designs failed here, all of them the same substitution, and the fourth answer is that there
is no design — the scope is wrong.** Revision 2 asserted the aggregation could supply offsets.
Revision 3 sampled `(path, size)` before and after the run — proving *size* stability and using it
as *content* stability. My own audit "fixed" that with `mtimeNs` and `ino`, adding two defects
rather than removing one: sampling still cannot prove the state held *throughout* the run, and
`ino` is an inode used to revalidate a source, which T-008 prohibits — a hard-constraint violation
introduced by the fix for a defect-class violation, and note that "it is never persisted" answers
only the *inode field* prohibition, not the *inode revalidation* one, which is that same
substitution a fourth time. Revision 4 copied the sources into an immutable capture, which fixes
*destination* stability and still proves only that bytes were **supplied** — while a truncate
during the copy can produce hybrid bytes of length N that were never that source's first N bytes,
and ccusage ignoring a trailing record still publishes a stale payload under a strictly greater
offset.

The invariant behind all four: **ccusage is a black box that does not report what it consumed.**
No amount of care on the input side converts "these bytes were available" into "these bytes are
in the payload". So T-011 stops trying:

- **T-011's rebuild publishes with an EMPTY `sourceVersion` — an explicit "no claim".** No capture,
  no copying, no scratch tree, no offsets, no inode inspection. The aggregation runs against the
  live tree exactly as `spendbar` does today.
- **T-010 makes this safe by its own rules, not by my argument.** `publishSnapshot` skips the
  dominance comparison entirely when there is no live manifest (`store.ts:2180`, `if (live !== null)`),
  so the first publish succeeds. Every later publish compares, and `{}` against a live `{}` is
  `equal`, which refuses (`store.ts:2183` — only strict dominance publishes). A generation that
  makes no claim **cannot falsely dominate anything**, because it cannot dominate anything.
- **So T-011 publishes exactly one generation, and that is the honest boundary.** A second refresh
  with no T-012 fails closed with `SnapshotNotDominatingError("equal")` — a real, typed, tested
  outcome rather than a silent no-op or a fabricated advance. **No ticket is currently claimed to
  complete repeated authoritative refresh** (ISS-075): consumed-offset provenance requires knowing
  what ccusage read, and T-012 cannot supply it either — it also uses ccusage and defers owned
  parsing to v0.5. Naming T-012 here was moving the problem, not solving it.

What that costs, stated plainly: v0.2 with T-011 alone indexes once. That is a real reduction
against a reading of AC 7 and AC 10 in which every refresh publishes — and it is the only reading
available that does not publish a number the code cannot justify. AC 1 is unaffected (one real
generation from the production path, which is exactly what it asks for). AC 10 is unaffected in
what it actually says: `refresh` reaches the running service and triggers a refresh; the refresh
runs, and correctly declines to publish. AC 7's publish-if-current is the **queue's internal
discipline** — generation numbers, coalescing, no superseded generation becoming current — and is
tested with injected jobs, independent of ccusage.

**The three refusal verdicts, because "every later publish is `equal`" was wrong too.** `equal`
holds only when both sides are `{}`. The production cases are three and they are routed and
reported separately: `{}` vs `{}` → **`equal`**; a `{}` candidate against a non-empty live (a
pre-existing or T-012-produced manifest) → **`incomparable`**; a non-empty candidate against the
bootstrap `{}` → **`incomparable`**, which is the handoff case above. A test suite expecting only
`equal` could not exercise two of the three states that actually occur.

**One real-store production sequence**, since the whole design rests on `{}` being accepted
everywhere and AC 1 only proves the initial publish: publish `{}` with no live manifest → read back
and validate both the generation and manifest documents → restart and obtain `usable` from
`startWriter` → attempt a second `{}` and assert `equal` **with the store unmutated** → then a
non-empty candidate, asserting the designed handoff rather than today's wedge.

Also:

- Publishes through `publishSnapshot` behind the latching authority, with `assertHeld()`
  immediately before the commit and no await in between.
- Reports cancellation and authority loss distinctly — a cancelled rebuild publishes nothing, and
  a lost authority is terminal.

The clean-prefix handoff test drives **this** path, not a stub.

---

## 5. Coordination-state inventory (finding 7)

Revision 1 specified durability for two files and created six. Every file and directory this
ticket creates is listed here, and every one goes through `coordination.ts`'s single write path —
exact mode via `fchmod`-after-open + `fstat` verify, short-write-safe loop, file fsync where the
bytes must survive, atomic publication, and **parent-directory fsync**:

| record | mode | publication | durability |
|---|---|---|---|
| runtime dir `/tmp/spendbar-<uid>` | 0700 | mkdir + verify | n/a (tmp) |
| `token` | 0600 | write-once `link()` | file fsync + dir fsync |
| `alloc.json` | 0600 | write-once `link()` | file fsync + dir fsync |
| `endpoint.json` | 0600 | atomic rename | file fsync + dir fsync |
| desired-state record | 0600 | atomic rename | file fsync + dir fsync |
| installation record **+ allowlist, ONE file** | 0600 | atomic rename | file fsync + dir fsync |
| launcher **script** | 0600 (**not** 0700 — see below) | atomic rename | file fsync + dir fsync |
| LaunchAgent plist | 0600 (**not** 0644 — see below) | atomic rename | file fsync + dir fsync |
| `~/Library/Application Support/spendbar/` | 0700 | mkdir + verify | dir fsync |
| every rename **candidate** (one per atomic publication above) | 0600 at creation | — | fsync before rename |
| every `link()` **candidate** (token, allocation) | 0600 at creation | — | fsync before link |

**Revision 2 violated the mode constraint it was written under, in its own inventory.** It listed
a 0700 launcher executable and a 0644 plist against a hard rule of *directories exactly 0700, files
exactly 0600*. Both are fixed rather than excused:

- **The launcher is a 0600 script, never executed directly.** The plist's `ProgramArguments` is the
  absolute `[node, launcher.js]` pair, so the file is read by an interpreter rather than `exec`'d.
  No execute bit is needed, and this is better than a waiver: it removes the shebang and the
  exec-bit from the trust path entirely, in a file whose whole purpose is deciding what gets run.
- **The plist is written 0600.** launchd loads it as the owning user, so user-only read should
  suffice; that "should" is the one claim here I cannot settle from this machine, so it is
  **verified on a macOS runner before the launcher code lands** and, if launchd refuses a 0600
  plist, it becomes an explicit constraint exception for the owner (§12) rather than a mode
  quietly widened in an implementation commit.
- The inventory now also covers the **candidates and parent directories** revision 2 omitted — the
  rename and link temporaries are real files with real modes, created under the caller's umask, and
  a candidate created 0644 and then renamed into place is a 0644 final file no matter what the
  table says about the target. AC 12's hostile-umask tests are correspondingly extended from three
  objects to **every row above**, which is the same class-and-its-siblings check applied to the
  inventory that was supposed to be the check.

**Validation is fail-closed and NEVER repairs in place** — and this is the opposite of the policy
T-010 shipped, so it is stated rather than inherited. T-010's store is a derived cache, which is
what licenses it to delete a wrong-type entry and rebuild; coordination state is not recomputable,
so a record that fails validation is refused and surfaced, never rewritten into shape. The
allocation file is validated on **every** dimension: owner uid, type, mode exactly 0600 masked at
`0o7777` (so setuid/setgid/sticky are caught), encoding, and an any-non-privileged-port range
check. The runtime dir is the **primary isolation boundary** — lstat type, owner uid,
non-symlink, mode exactly 0700 masked at `0o7777` — with **every rejection branch reachable via
injected stats**, which is what makes each one able to fail for the reason its name gives.

`assertHeld()` immediately precedes every singleton-owned mutation (`endpoint.json` and anything
else the holder writes), with no intervening await — the same rule T-010 enforces, enumerated in
§7 rather than asserted here.

Note the boundary this preserves: **snapshot data is not fsynced** (derived cache, T-008's
recorded decision); **coordination state is**, because a lost allocation is not recomputable — it
is a second singleton.

---

## 6. Control protocol (finding 10)

Auth **before dispatch**; length-prefixed frames; request IDs correlated and duplicates refused;
version negotiation with a typed mismatch error; per-connection and per-process connection caps;
an idle deadline on both header and body; a request deadline; **a total cap on progress output**,
because per-frame limits bound no stream and many small frames otherwise exhaust the daemon;
backpressure honoured so queued writes do not grow without bound.

Test matrix (each a named test): authenticated round trips for status/refresh/stop/progress;
unauthenticated peer refused before any handler runs; fragmented and coalesced frames; zero,
truncated, oversized-declared and oversized-streamed bodies; a peer that declares a legal length
and stalls; duplicate and unknown request IDs; unsupported version; connection and request caps;
backpressure; bounded total progress; and `spendbar refresh` with **no service running** failing
with a typed, clear message.

---

### 6.1 The endpoint record is untrusted input until it is validated

Revision 2 specified how `endpoint.json` is *written* — durably, atomically, guarded — and said
nothing about how it is *read*. That gap is a credential-disclosure path, not a tidiness problem:
a client reads the record, connects to whatever path it names, and **sends the token**. A record
that is corrupt, symlink-followed, or replaced therefore redirects authentication material to a
socket of somebody else's choosing, turning a coordination failure into token disclosure or a hang.
Exact file mode proves none of the things that matter here — not that the value is a string, not
that the path is canonical, not that it is inside the trusted root, not that it is under 104 bytes.

The validator lives in **one module that every reader must go through**, rather than a checklist
each reader implements: `refresh`, `stop`, `status`, the service's own already-running check, and
whatever T-013 and the v0.3 menubar add later. A checklist is how the fifth reader ends up
connecting without the third check, which is this plan's recurring failure in its client-side form.
Before connecting and before sending anything, it establishes:

- `openRead` with `O_NOFOLLOW`, then owner and mode checked **on the descriptor**, not the path.
- Exact-key schema: unknown keys rejected, every value type-checked, no coercion.
- The socket path canonicalized and proven **contained in the trusted runtime root** — the same
  containment check the writer uses, not a prefix comparison.
- Filename matched against the **nonce grammar**, and `Buffer.byteLength` of the canonical form
  bounded at 104.

Any failure routes to a typed `no-service` or `invalid-coordination` error, and **no
authentication material is sent on any of those paths**. That last clause is the one that has to be
tested directly — a test that asserts the token never reaches a socket the validator rejected.

## 7. Two validators, derived sites, and a mutation manifest (findings 9 and 12)

Revision 1 validated one deadline and wrote one mutant — the class-not-siblings error, twice.

- **Two GENERATED registries, because a prose list is what keeps going stale.** Revision 4 titled
  this section "two validators" and then enumerated only the duration sites, called it "the single
  validator" two subsections later, omitted the ccusage timeout from a list it called exhaustive,
  and never enumerated the count sites at all. A hand-written enumeration of the sites of a rule is
  the same artefact that has failed at every other enumeration here, so both registries are
  **generated from the source and checked bidirectionally**, and any numeric configuration value
  not registered in one of them fails the AST check.

  **One typed configuration schema is the source of truth**, because "unregistered values fail the
  AST check" is circular without one — the checker cannot know a new field is numeric-with-units
  unless every field must declare its unit. So every numeric configuration field declares exactly
  one of `duration-ms`, `duration-seconds-integer`, `count`, `bytes`, or `version-bound`, and
  validation plus mutation cases are **generated from that schema**. A field with no declaration
  fails generation.

  - `duration-ms`: identity challenge, control header idle, control body idle, request timeout,
    progress timeout, queue timers, the **ccusage adapter timeout**, and the **graceful-shutdown
    wait**.
  - `duration-seconds-integer`: **`ExitTimeOut`** and **`ThrottleInterval`** — the plist keys.
  - `duration-ms`, added because Q4's claimed total omitted them: **`launchctlCommandTimeoutMs`**
    and **`terminationVerificationTimeoutMs`**. Invoking `bootout` and polling `print` are
    *subprocess* operations that can block on their own, so a stop bound of "graceful wait +
    `ExitTimeOut`" is not the end-to-end bound it was presented as. The total is the sum of **four**
    terms — graceful wait, bounded `bootout` invocation, launchd `ExitTimeOut`, bounded
    verification — each with its own timeout test and mutant. Q4 named a sum that left out two live
    siblings, which is the enumeration failure this registry exists to make impossible; it is
    recorded here rather than quietly patched.
  - `count`: the `EADDRINUSE` nonce-rebind limit, connection caps, and the **orphan-diagnostic
    threshold**.
  - `bytes`: request-body and response-body caps, the total progress cap, and the **ccusage
    output-byte limit**.
  - `version-bound`: the **verified Node range** endpoints.

  *The four fields in bold were live siblings revision 5's prose list had already missed — which is
  the argument for generating the list rather than writing it, made one more time by the list.*

  Mutation-tested per declared unit: durations with `0`, negative, `NaN`, `Infinity`, a non-number,
  a `Symbol` and above-maximum; counts and byte caps additionally with fractional, unsafe-integer
  and negative-zero, because finite-and-positive does not prove safe-integer.

  **`ExitTimeOut` is a unit conversion, not just a bound, and that is its own defect class.** It is
  serialized to launchd in **integer seconds** while the stopping process waits in milliseconds; a
  valid millisecond duration does not prove the emitted plist value is a whole number of seconds, so
  a fractional or overflowing conversion yields a plist launchd reads differently from the bound
  being enforced — a value proven to have one property used as though it had another. It is
  registered as a bounded positive safe integer in seconds, the external wait is derived from it by
  **checked** multiplication, and a test asserts the emitted plist value and the derived wait denote
  the same bound.
- **The mutation manifest inventories MUTATING SEAM CALLS, not guard calls.** Revision 2 said "one
  mutant per guarded call site" plus a source inventory, and that mechanism cannot do the job it
  was written for: an inventory of `assertHeld` calls detects a guard with no mutant, but it is
  blind to the case that actually matters — **a newly added mutation that has neither a guard nor a
  mutant**, which is invisible to a scan keyed on guards. It also listed *logical* jobs (manual
  refresh, shutdown flush) rather than mutations, and those are not where the mutations are:
  the snapshot mutations and their adjacent guards live inside T-010's `store.ts`, so deleting a
  caller-side preflight may correctly change nothing and yield an **unkillable mutant** — a green
  test that proves the harness works, not the code.

  **Obligations are generated PER EFFECT, not one shape for all.** Revision 5 required every
  mutating call to map to an immediately preceding guard and then said lifecycle mutations
  deliberately have no port guard — no generated schema can satisfy both, so either `install`'s
  writes fail the manifest or the guard requirement quietly becomes optional for holder mutations
  too. Each effect therefore generates its own obligation shape, and a mismatched shape fails
  generation: **`holder-mutation`** requires an adjacent guard plus a guard-deletion mutant;
  **`lifecycle-mutation`** requires durability and error mutants and **no** port guard;
  **`read`** forbids native mutation entirely.

  So: an **AST-based manifest** enumerating every call to a mutating `ServiceOs` method, each
  mapped to the obligation its effect requires, its mutant transformation, and the test that must fail
  when that mutant is applied. The check runs **both directions** — source→manifest catches a new
  mutation with no entry, manifest→source catches an entry whose site is gone — and either
  mismatch fails the harness.

  **What makes that more than a wish is where "mutating" is defined — and revision 4's version was
  still circular.** It said "adding a mutating method without its annotation is itself the lint
  failure", which only holds if annotations are *required on every method*; if they are required
  only on methods already known to mutate, an unannotated new method is indistinguishable from a
  reader and the lint cannot infer anything — the exact gap the mechanism claims to close. So:
  **every `ServiceOs` method must carry exactly one effect annotation** — `read`,
  `lifecycle-mutation`, or `holder-mutation` — and a missing or unknown effect is a build failure.
  The allowed adapter operations, the guard rule, the manifest and the mutants are all *derived*
  from that exhaustive set; there is no second list to keep in sync, and no method can abstain.

  Two further corrections, both from the same finding. **Guard adjacency must be to the native
  mutation, not to the seam call** — an async adapter that awaits between the two reintroduces the
  gap AC 6 forbids while the manifest reports a guarded site, so holder-guarded commits are required
  to be synchronous final-commit primitives with the assertion inside or immediately adjacent to the
  native mutation, and direct native mutations outside the adapter are banned. And **holder-guarded
  mutations are distinguished from lifecycle writes**: revision 3 swept in all coordination writes,
  but only the writes the *holder* owns need the port guard — `install` writes its record while
  holding no port and never should. T-010's mutations keep T-010's own internal mutants; T-011 adds
  mutants only for mutations **T-011 itself performs**.

### 7.1 T-008's pinned invariants, carried into production as named tests

`spikes/locking/` is **evidence, not a library** — production modules are written against these
properties, never imported from the spike. Each of the following was *reproduced* in T-008 and each
gets its own named test here, because a property proven in a spike and not asserted in production
is a property that was proven and then lost:

- **Nothing after `link()` may throw.** Every injectable hook is read into a local *before* the
  link. A throw after it strands a permanent allocation naming an unbound port. Related and
  distinct: **a post-link durability failure is REPORTED on the result, never thrown, and the
  listener is RETAINED** — an adversary binding the allocated port afterwards must still get
  `EADDRINUSE`. Two assertions, because "did not throw" does not imply "still holds the port".
- **Connection tracking starts at server CREATION**, not at identity registration. T-008
  reproduced a local DoS where a connection accepted in that gap wedged `release()` forever.
- **Injectable deadlines are validated at REGISTRATION**, not at use — through §7's elapsed-time
  registry (and counts through its integer registry; they are different properties).
- **Locks are single-use.** A released or lost lock refuses both re-acquire and adopt. There is no
  "revalidate then continue" state; nothing exists to revalidate.
- **`adopt()` validates before mutating state.**
- **Identity registration is part of BECOMING the holder**, not a step after it — AC 5's third
  mutant (a caller that skips identity registration) is what proves the ordering.

---

## 8. Startup order, corrected for readiness (finding 5)

Revision 1 had bind → publish → serve and claimed a published endpoint names a *serving* socket.
Binding proves only that the kernel accepted the pathname; a reader can connect between `listen`
succeeding and the handlers existing.

    read + validate desired state (refuse if stopped)
      → validate write-once token
        → validate write-once allocation
          → acquire port (or adopt the publication listener)
            → bootstrap the store (§3) — CLASSIFY ONLY; returns an action, never
              awaits a rebuild; the three hard stops abort startup here
              → register auth, protocol handlers, error listeners, connection
                tracking and shutdown behaviour   ← BEFORE listen
                → listen on the fresh nonce path, await the 'listening' event
                  → publish endpoint.json (atomic + fsync)
                    → serve, reporting status=starting until a generation exists

**Two steps from the ticket's stated order are GONE, deliberately.** T-011's scope item 3 fixes the
order as `… → acquire port → probe unix socket → reclaim only confirmed-stale → bind socket`.
Choosing option (a) at §1 Q5 deletes both the probe and the reclaim, because option (a) *is* "no
pathname is ever reused and nothing is reclaimed" — the ticket offers it in those words. This is a
deviation from a written sequence and is called out rather than quietly absorbed. It also makes
one named test in scope item 3 **unwritable as stated**: "an adversarial binder occupying the
pathname in the probe/unlink window" cannot exist when there is no probe and no unlink window. The
§10 stale-path adversary is its replacement and is strictly stronger — it asserts the property the
original test was reaching for (a competitor's live socket is never deleted) at the only place a
violation could still occur, rather than at a window this design no longer has.

**Bootstrap classifies; it does not build — and that resolves a three-way contradiction revision 2
carried.** It said startup completes the store bootstrap *including* `first-run → rebuild` before
`listen`, AND that the endpoint may publish while a rebuild runs with `status=starting`, AND that
AC 1's short-lived CLI command *triggers* indexing. Those cannot all describe one machine: if
`start` indexes, the CLI command triggers nothing and AC 1's test passes even when the command does
nothing at all — a test that cannot fail for the reason its name gives. So:

- `startWriter` classification, the three reset hard stops and the GC routing all run before
  `listen` (they are fast and they gate whether serving is safe at all). A hard stop **aborts
  startup**; it does not serve a degraded daemon.
- A `first-run`-or-post-reset store records **needs-initial-build** and enqueues **nothing**.
- `status` reports `starting` while no generation exists, and the endpoint is published anyway so
  clients can see that state rather than a refused connection.
- The **first refresh request enqueues the initial build** — from `spendbar refresh` in v0.2, and
  from T-012's scheduler once it lands. AC 1 therefore asserts three things in order: no generation
  exists before the command; the command is what causes one; and it is published after the
  foreground process has exited.

Properties, each testable: no filesystem act touches the socket before the port is held; a reader
that finds an endpoint record finds a socket that is bound **and whose handlers are installed**;
and a client connecting the instant `listen` resolves is authenticated, not dropped.

---

## 9. Launcher ownership model (finding 11)

Revision 1 named an installation ID and an allowlist without saying where either lives, so the
foreign-prefix and same-installation tests had no oracle.

- **Ownership is exact canonical `[node, cli.js]` pair equality, and nothing else.** Revision 2
  kept a random installation id and claimed it let an explicit `install` recognise a *moved but
  same* installation. It cannot, and the claim was self-contradictory besides — the same section
  said a foreign prefix changes nothing. The id lives **only in the central record**; a moved
  invocation holds no prefix-local copy and no secret, so its pair differs and the record has no
  way to tell it from any foreign prefix. Recognising a move would need an unforgeable credential
  held *by the prefix*, which is not designed here. **So for v0.2 a move IS foreign**, stated
  plainly; same-prefix upgrades keep the same pair and are unaffected, which is the case that
  actually occurs.
- **Installation identity and the allowlist are ONE atomically published record** (0600) — one
  physical file, one schema, one rename — not two files that a concurrent `install` can leave naming
  different winners. Revision 2 tested concurrent `install` while specifying no serialization and no
  multi-record transaction, so the test had nothing to hold; revision 3 said "one record" here while
  §5's inventory still listed a registry and an installation record as **two separately published
  rows**, which recreates the inconsistent-winner window this bullet claims to close. §5 now has one
  row. The concurrent test pauses **before and after that single rename** while readers continuously
  validate what they observe, so a torn intermediate would be caught rather than assumed impossible.
- **The launcher is materialized by `service install`**, not by a package lifecycle script — and
  the parenthetical revision 3 attached to that ("there are none") was **false about this repo**:
  `package.json` carries `prepack` and `prepare`, both running the build (**ISS-074**).

  Revision 4 filed it and declined to fix it, which does not work: a root-package lifecycle scan
  that fails on the first run is not a test, and leaving the scan out leaves a hard constraint
  unenforced. **So removing both keys is a prerequisite step of T-011**, with the guarantees they
  provided replaced rather than dropped — `prepack` kept `npm publish` from shipping a stale
  `dist/`, and `prepare` built on a git-dependency install. The replacements are an explicit
  `npm run build` in the release and CI commands, and a packaging-contract assertion that the
  shipped `dist/` matches the current sources, which is a stronger check than a hook that only fires
  on some install paths. The **root-package lifecycle scan** then ships as a passing regression test.
  Concretely, the launcher is a
  **0600 non-executable `launcher.js`**, invoked by the recorded absolute Node interpreter via the
  plist's `ProgramArguments`, written through §5's single durable path. That the package cannot set
  itself up at install time is the whole reason the launcher design exists.

  *Revision 3 left this bullet saying "a small executable script written at 0700" while §5 fixed the
  launcher as a non-executable 0600 file two sections earlier. Implemented as written, the later
  instruction would have violated the exact-mode constraint and contradicted the plist design — the
  class-fixed-at-one-site-not-its-siblings failure occurring **inside the fix for a
  class-fixed-at-one-site-not-its-siblings finding**. The mode mutant targets this site.*
- **No PATH search anywhere** — the poisoned-PATH test proves it.
- Tests: copied prefixes; replaced package contents; a missing old target; symlinked targets;
  concurrent `install` invocations; and a foreign-prefix invocation that prints the mismatch
  naming only `service install` (Q3) and **changes nothing**.

---

## 10. Failure modes — named deterministic tests

Injectable clock and scheduler from the first commit; no sleeps as synchronization. Grouped by the
acceptance criterion each discharges, so a missing group is visible rather than inferred.

**AC 1 — handoff.** Clean-prefix `service install` + `service start`, then one short-lived CLI
command triggers indexing and **exits**; a new generation is published by §4's real rebuild path
and the assertion includes **no foreground spendbar process remaining** — the exit, not just the
publish, is what the v0.2 handoff test is about.

**AC 2 / AC 10 — control protocol.** The full matrix in §6.

**AC 3 — socket path.** Over-104 canonical refused **before `listen`**, proven by injecting a
realpath that pushes a *fitting requested* path over the limit and asserting `listen` is never
reached; `.` / `..` / empty components refused before any path is built; a symlink inside the
runtime dir refused while a symlinked root (`/tmp`) is accepted; no post-`listen` check serves as
a primary guard.

**AC 4 — stop sequencing, SEVEN steps.** Failure injected at each of — persist desired state,
disable relaunch, graceful shutdown request over the socket, graceful-wait deadline, `bootout`,
**verified termination** (the step Q4's second bound created; revision 4 added the bound and left
this list at six, so the transition it introduced had no failure row), and the seventh, which the
ticket calls "remove the socket **under the stale-socket rule above**". The termination-wait
boundary gets its own timeout, `launchctl`-failure and crash injections. Under §1
Q5 that rule is *nothing is ever reclaimed*, so the step is a **deliberate no-op** and is tested as
one: a stop must leave the socket inode in place. Naming it and asserting the no-op is the point —
revision 2 listed it as "removal of our own socket", which contradicted its own Q5 two sections
earlier. Per finding 6, **crashes** are injected between steps as well as errors returned from them. After any partial failure `service start` restores a working service (§1 Q2's
reconciliation is what makes that true for every partial state rather than for the ones anyone
thought to enumerate). A stopped service **does not respawn via KeepAlive**.

**AC 5 — composed startup, all four cases.** First run allocates, holds, and registers identity
**as part of becoming holder**; a second start against our own live instance authenticates it,
reports already-running, exits cleanly and **never publishes**; a foreign holder throws the named
refuse-to-start error; an unidentifiable holder throws too — indeterminate collapses into neither
answer. Allocation file **byte-identical** after every refusal. Mutants: a caller that continues
past "foreign"; one that recovers by allocating a second port (caught by byte-identity); one that
skips identity registration.

**AC 6 — lock-loss discipline.** Witness fires on unrequested close, `onLost` terminates or
irreversibly disables publishing, the in-flight job is discarded, and no publish lands after an
observed loss.

Revision 2 claimed a quiet-return handler is "rejected at registration". **That is false against
the shipped code**: `createWriteAuthority` (`authority.ts:183`) constructs and validates nothing
beyond the type; the return value is checked when loss is **observed**. A test named for
registration-time rejection could not fail for the reason its name gives. Corrected two ways, both
needed: the assertion becomes *registration succeeds, and the first observed loss raises
`AuthorityHandlerContractError` and sets the irreversible latch*; and the service obtains its
handler only from a **module-private factory that takes no callback at all**.

That second half needed strengthening too. Revision 3 said "branded terminal factory", and a brand
proves only *provenance* — that the handler came from the factory — not that the factory does
anything terminal. T-010 accepts the `TERMINATED` sentinel as a *statement*; it does not verify the
process exited. A factory mutant that simply returns `TERMINATED` would satisfy the brand while
doing nothing, and the plan would have called that a guarantee. So the factory takes no arbitrary
callback: it constructs a **fixed closure** that first trips an independently observable
irreversible publishing latch (or invokes the fixed process-exit primitive) and only then returns
`TERMINATED`. The killing test is a mutant that returns `TERMINATED` without that action, checked
in a subprocess or against the observable publishing-disabled assertion — a mutant the brand alone
cannot kill, which is the point. Per-site mutants per §7.

**AC 7 — refresh races.** wake+timer, manual+full, midnight-crossing, shutdown flush, crash storm,
wake storm — publish-if-current holds in every schedule; no superseded generation becomes current.

*Revision 5 said these run against the real store and assert its refusal, which would have made
every one of them vacuous:* after the first generation the store refuses every T-011 candidate
anyway, so the refusal **masks the queue defect** and deleting publish-if-current entirely would
not fail a single race test. The oracle has to be the queue's, not the store's. So the races run
against a **recording publisher seam** that accepts current candidates and records what it was
handed, with a **mutant that deletes the generation-current check**: each named schedule must fail
because that mutant records a *superseded* publish. Empty-`sourceVersion` refusal tests are a
separate suite (§4) and never stand in for this one.

*The seam is test-only, and enforcing that needs a BRAND rather than a name.* Revision 6 asserted
only that no production path constructs the recording publisher — but the seam is **structural**, so
any sibling fake or wrapper that accepts every candidate reaches production without ever
constructing that class, and converts the store's refusal into acceptance. The assertion did not
enforce the property it claimed. So the **production publisher is nominally runtime-branded and
production composition rejects an unbranded publisher**, queue scheduling stays separately testable
with an injected recorder, and a mutant substituting a *different* unbranded accepting publisher at
the composition boundary must fail.

**AC 8 — launcher.** §9's matrix.

**AC 9 — no PID-based control.** No PID, process start time, or inode field exists in any
coordination state, **and a codebase search for kill-by-pid control paths comes up empty** — an
executable test over the source, not a claim, because this is the one criterion whose subject is
the absence of code.

**AC 11 — allocation lifecycle.** Write-once via `link()`; an adversary binding the allocated port
between publication and adoption gets `EADDRINUSE` (continuous reservation, no close-and-rebind
gap); the crash matrix at `before-publish` / `mid-publish` / `after-link` / `after-lose` /
`after-adopt` converges to exactly one holder in every row, with stranded candidates counted, left
alone and never adopted; **a post-link durability failure is reported, not thrown, and the listener
is retained** — asserted as two separate facts, with an adversary bind afterwards still refused.
Plus the socket-lifecycle rows finding 2 demanded: after nonce selection, after bind, after
endpoint candidate write, after rename, after directory fsync — each row naming exactly what is
stranded and asserting convergence still holds. Bootstrap storm of 8 real children → one agreed
port, one holder, seven blocked.

**AC 12 — hostile umasks.** 022 / 0200 / 077 as child processes, across **every row of §5's
table** — not just the runtime dir, token and allocation the ticket names, but the endpoint record,
the desired-state record, the installation-plus-allowlist record, the launcher script, the plist,
the Application Support directory, and **every rename and link candidate**. A candidate created
0644 under a hostile umask and then renamed into place is a 0644 final file whatever the target row
claims, so testing only the three named objects tests the sibling that was never the problem. Each
is created exactly via `fchmod`-after-open + `fstat` verify and validated exactly at `0o7777`; a
wrong mode is **refused fail-closed, never repaired in place** (§5).

**Cross-cutting.** Token comparison: wrong-length and wrong-byte share one code path, asserted
structurally — no length oracle, no timing branch. The **stale-path adversary** (§1 Q5): a
competitor replaces the pathname while our server is still bound, and after our full graceful
shutdown their inode survives — the probe reproduced in §1. The Q5 mechanism is tested in **full**
here, not summarised: an AST/type test proving the raw UDS `net.Server` never escapes its adapter,
plus the **five-route mutant matrix** — direct `close()`, `using` / `Symbol.asyncDispose`, aborting
the `listen` signal, an aliased close, and cleanup on a failed startup after `listen` succeeded —
each run against the rival-survival oracle. *Revision 4 compressed this paragraph back to "a lint
rule and a test", which an implementer working from the acceptance-test section could have satisfied
while four of the five routes stayed live. A summary that drops the part the design turns on is not
a summary.*

**Fixtures.** Synthetic corpora with placeholder paths (`/Users/testuser`) only — no real
transcript data, personal paths, or session/rollout identifiers, including in anything §4's
rebuild job reads or records. The packaging content scan already enforces this for shipped files
and is the backstop, not the primary discipline.

---

## 10.1 The reduction this plan accepts, stated once, plainly

**T-011 alone indexes once.** §4 explains why: no design available to this ticket can produce a
`sourceVersion` that honestly supports a dominance claim, because ccusage does not report what it
consumed. So the rebuild publishes an explicit no-claim, T-010's rules make that generation
incapable of dominating anything, and a second refresh fails closed with a typed
`SnapshotNotDominatingError("equal")`.

**The dependency direction stays T-011 → T-012. Revision 5 said T-012 becomes "a hard dependency"
of T-011, and that was a cycle**: T-012 already hard-depends on T-011 because its jobs run on this
queue. Two tickets cannot each be the other's prerequisite, and a plan that says so cannot describe
an implementation order. T-011 depends on nothing from T-012 and is implementable today.

**And the claim that T-012 completes this is WITHDRAWN — filed as ISS-075.** Revision 6 said
repeated authoritative refresh arrives with T-012. The reviewer checked T-012's own filing: it
**also uses ccusage and explicitly defers owned parsing to v0.5**, so its shadows and watermarks
prove what was *supplied*, exactly as mine did. T-012 is structurally no more able to produce a
consumed-offset `sourceVersion` than T-011 is. I had not solved the problem; I had moved it to a
ticket that cannot solve it either — which is the same substitution one ticket over, and the
fourth time this section has produced it.

So this plan **claims nothing about what completes repeated refresh.** The real question is a
contract-level one that spans T-010, T-012 and v0.5 and belongs to the owner, because answering it
changes a shipped contract: either `sourceVersion` is **redefined as a verified input watermark**
(with T-010's contracts, comments and tests updated to match, after which v0.2 can satisfy it
honestly), or it keeps **consumed-offset** semantics and repeated authoritative refresh does not
exist until owned parsing lands. ISS-075 states both, with the four disproven designs as evidence.
T-011 proceeds on the part that is sound regardless of the answer.

**The handoff, and why my first version of it was also wrong.** I verified `{}` is accepted
everywhere T-010 reads it — `canonicalSourceVersion({})` returns a frozen empty record,
`compareSourceVersions({}, {})` is `equal`. Then I checked the other direction and found that a
missing key on *either* side returns `incomparable` (`dominance.ts:180`), so T-012's first
claim-bearing generation is incomparable with the bootstrap generation and would refuse too. My fix
for that said "T-012's first publish must run against a store that has been reset" — and that is
not a mechanism. A store carrying a **valid** `{}` manifest classifies as **`usable`**, so nothing
resets it, ever. I had written a requirement and called it a handoff.

What ships instead is an explicit, one-time transition with a named owner on each side:

- **T-011 marks the generation as a bootstrap — concretely `provenance.refreshTier = "bootstrap"`.**
  I checked that this is possible rather than assuming a field: `GenerationDoc` carries
  `provenance: Provenance` (`types.ts`), and `assertExactKeys(g, "generation body", GENERATION_KEYS)`
  (`store.ts:1027`) would **refuse** any new top-level key, so `refreshTier` is not merely convenient
  — it is the only route the schema permits. The marker makes the generation distinguishable by
  inspection instead of by inferring intent from an empty map.

  **But the schema does not police the VALUE, and noticing that is the difference between a
  mechanism and a convention.** `refreshTier` is validated by `requireString` alone
  (`store.ts:1075`), so `"bootstrap"` carries no more weight than any other string — I had proven
  *the field can hold the marker* and was about to use it as *the marker is reliable*, which is this
  plan's own defect class, in this round's fix, for the third round running. Since the store will
  not enforce it, T-011 does: a shared `BOOTSTRAP_REFRESH_TIER` literal, **validated at candidate
  construction AND at transition detection** — both ends, because validating only the writer leaves
  the reader accepting anything, and validating only the reader lets a malformed generation be
  written in the first place.

  **And the marker needs its own mutants, because the obvious test cannot see it.** A test that
  publishes a bootstrap generation and asserts a non-empty candidate is `incomparable` would pass
  with the marker **omitted or misspelled**, since that verdict follows from `sourceVersion` alone
  and never reads `refreshTier` — a test that cannot fail for the reason its name gives. So there
  are read-back tests plus mutants that omit the marker and that misspell it (`bootstarp`), and both
  must fail **specifically because no valid handoff marker is present**. Without that, a typo
  produces a valid store that can never transition, forever.

- **T-012 can actually perform the reset — checked, not assumed.** `resetStore` is exported
  (`store.ts:1219`) and takes the gate, so T-012 calls it under its own held authority. Had it been
  module-private, this entire handoff would have been another requirement with no mechanism behind
  it, which is exactly what the previous revision shipped.

- **And the rest of `Provenance` is an obligation the no-claim decision does not excuse.** It
  requires `coverage`, `fieldCoverage`, `sourceTimestamps`, `ccusageVersion`, `ccusageFetchedAt`,
  `timezone` and `dayBoundaryPolicy`. Every one is filled from something actually observed — the
  ccusage version and fetch time from the invocation, timezone and day-boundary policy from the
  resolved configuration. Where the bootstrap genuinely cannot substantiate a claim it records
  **absence rather than a placeholder**, which is exactly the rule the field's own documentation
  states: *"A field ABSENT from this map has made no claim and is therefore not covered."* A
  fabricated `coverage` interval would be the same defect as a fabricated `sourceVersion`, one
  field over, and it is the sibling that would have been missed by fixing only the version.

  **One of those fields cannot be filled honestly at all, and the absence escape is unavailable
  for it.** `ccusageFetchedAt` reads as *when pricing was fetched*, but ccusage embeds its pricing
  data at build time and its output reports no such timestamp; the daemon's invocation time proves
  only when ccusage **ran**. Revision 6 said "from the invocation", which is that substitution one
  more time. And unlike `fieldCoverage`, this is a **required scalar** that T-010 validates as a
  non-empty explicit instant (`store.ts:1075`), so recording absence is not an option the schema
  offers. There is no honest value available to T-011, which makes this a **schema question, not an
  implementation choice**: the field wants a discriminated value such as
  `{kind:"embedded", ccusageVersion, pricingRevision}` or `{kind:"unknown"}`. Folded into **ISS-075**
  because it has the same root cause, and listed in §12. Until it is answered the bootstrap
  generation is provisional in one documented field — which is precisely why the whole generation
  carries `refreshTier = "bootstrap"` rather than passing as an ordinary publish.
- **PREPARE BEFORE RESET. The replacement must not destroy the store and then discover the
  candidate is invalid.** Revision 7's sequence reset the usable bootstrap store *first* and only
  then called `publishSnapshot`, which is where validation, canonicalization and size checks happen
  — so a malformed id, provenance, payload or timestamp, an oversized artifact, or a throwing
  canonicalize would erase the live snapshot and *then* fail, leaving nothing. "The candidate is
  synthetic" and "the candidate is intended to be truthful" do not prove it satisfies T-010's
  publish contract; that is the same substitution one more time, and here it costs the user their
  data. So a **T-010-owned pure preparation step** fully validates, canonicalizes and size-checks
  the candidate and returns a **nominal prepared candidate**; the replacement accepts only that
  prepared form, additionally rejects an empty or bootstrap-marked replacement, and only then resets
  and commits with no remaining candidate-dependent failure mode.
- **ONE reset owner, and it is serialized.** Revision 7 said T-012 calls `resetStore` directly in
  one bullet and that T-011 exclusively ships the replacement in the next — two transition sites,
  and the direct path bypasses the very contract the other bullet promised was unchanged. The
  T-011 replacement operation is the **sole** reset owner; **T-012 never calls `resetStore`
  directly**. It runs as **one serialized queue job**, because marker-observation and reset must not
  be separated: an exported caller that read the marker, then reset, could destroy a *newer
  non-bootstrap* generation on the strength of a stale read. Order inside the job: prepare the
  candidate → read and require an `ok` **active** bootstrap generation → reset synchronously under
  the same held authority → handle all three hard stops → publish.
- **T-011 SHIPS the replacement operation itself, green, rather than leaving a note for T-012.**
  Revision 6 promised a "failing-by-default test" that would be edited later, and that is not a
  contract test: a test asserting today's `incomparable` refusal is **green**, not red, so it warns
  nobody; editing it inside T-012 proves only that T-012 changed a test, not that T-011 ever
  supplied a working mechanism; and nothing prevents the handoff regressing between the two. So
  T-011 implements a **generic bootstrap-replacement operation** now, exercised end-to-end with a
  synthetic truthful candidate: detect an active bootstrap marker → reset under the latching
  authority → publish with `live: null` into the resulting empty store, where dominance is skipped
  (`store.ts:2180`). Whoever later has a real candidate — T-012 or otherwise — supplies it and
  reruns the **unchanged** contract.
- **The transition honours all three reset hard stops, because it is a sibling reset site.** §3
  already treats `failed`, `stoppedAtManifest` and `stoppedOnAuthorityLoss` as hard stops, and
  revision 6 wrote this one as "reset and publish" — the rule applied at one site and not its
  sibling, in the section added to fix a different instance of that rule. Each of the three halts
  the transition with **zero publish** and gets its own test; publication happens only after a
  fully successful reset; and any retry begins from a **fresh `startWriter`**, never in place.

---

## 11. Not built here

`doctor`, `setup`, uninstall ownership, the upgrade/downgrade/prefix-change/nvm-removal matrix,
`service repair` (Q3), the menubar view, and the fast/full tier internals (T-012 plugs into §4's
job and this queue). Zero-touch upgrade survival is **not claimed**. Reboot persistence on
SSH-only Macs is **not claimed** — LaunchAgents load at GUI login; the documented path is
foreground `service run`. Defending the loopback port against a hostile *other local user* is out
of scope by design: refuse-to-start with a clear diagnosis, never two writers — and a sandbox
that forbids loopback binds must read as an **environment failure**, not "lock held", which is a
test, because collapsing that distinction is the indeterminate-becomes-an-answer failure T-008
warns about.

---

## 12. Open questions carried to the owner

1. **ISS-070 lands here.** A hardened realm is a *process* decision and this ticket owns the
   process, but this plan does **not** implement lockdown: freezing the intrinsic graph changes
   the behaviour of every dependency in the daemon and is not a side effect to take in a service
   ticket. `service run` is the natural place if the answer is yes.
2. **The inode-revalidation reading of T-008's gate** (T-010's `ownerDecisionRequired`) remains
   open. Nothing in T-011 depends on it — this ticket holds no inode field in any coordination
   state — but the answer may require T-010 to change.
3. **ISS-073 — the `acceptanceAdditions` name a GC field that does not exist** (`noManifest`; the
   shipped field is `noUsableManifest`) and understate it as "rebuild" when the field's own doc
   says both its cases route to reset-and-rebuild. §3 uses the real field and the real routing.
   Nothing is blocked; what needs the owner is whether the ticket text gets corrected, since
   reading `undefined` is falsy and an implementer following that text would write a branch that
   silently never fires. **ISS-072, which I filed in the previous round against the same clause,
   is WITHDRAWN — my argument was wrong** and the ticket's `reset.failed` rule is correct; the
   withdrawal is recorded on the issue rather than deleted, because the reasoning error is the
   useful part.
4. **A constraint exception may be needed for the LaunchAgent plist mode.** §5 writes it 0600 to
   satisfy the exactly-0600 rule and the launcher becomes a non-executable 0600 script invoked via
   an absolute interpreter. Whether launchd loads a 0600 plist is verified on a macOS runner before
   that code lands; if it refuses, widening that one file is the owner's call, not an
   implementation detail to slip into a commit.
5. **ISS-075 — `sourceVersion` semantics. The one genuinely BLOCKING question, and it is not
   T-011's to answer.** T-010's dominance contract requires per-source **consumed** offsets;
   ccusage does not report them; and T-012 cannot supply them either, since it also uses ccusage
   and defers owned parsing to v0.5. Four designs were built and disproven (§4). Either
   `sourceVersion` is redefined as a verified **input watermark** — which v0.2 can satisfy honestly,
   and which means updating T-010's contracts, comments and tests — or it keeps consumed-offset
   semantics and **repeated authoritative refresh does not exist until owned parsing lands**.
   **This is an IMPLEMENTATION PREREQUISITE, and revision 7's claim that "T-011 is implementable
   under either answer" was false.** I asserted it without checking it against every part — the
   defect this plan is about, committed in the sentence declaring the plan safe. It is false because
   of `ccusageFetchedAt`: T-010 requires a non-empty explicit instant (`store.ts:1075`), no honest
   value exists, and because it is a required **scalar** the record-absence escape that
   `fieldCoverage` offers does not apply. So the **bootstrap publish itself cannot be written
   honestly** until the schema question is answered — which means AC 1 is blocked, not merely
   narrowed.
6. **The native-error boundary needs an amendment or a routing decision** (§2). The constraint says
   only the **fs** adapter may inspect a native error; the port lock must distinguish `EADDRINUSE`
   from `EACCES`, and T-008 is explicit that collapsing them is the indeterminate-becomes-an-answer
   defect. Either widen the constraint to a designated low-level adapter naming the net adapter, or
   route net failures through the authorized one. **Not implemented under the unchanged
   constraint — and this too is an IMPLEMENTATION PREREQUISITE rather than an open question**, because
   AC 5's four-case startup turns on exactly that distinction: our own live instance, a foreign
   holder, an unidentifiable holder, and an environment failure. Without it the singleton startup
   path cannot be written, and collapsing the cases is the one outcome T-008 names as forbidden.
7. **ISS-074 becomes a prerequisite**, not just a filing: `prepack` and `prepare` are removed and
   their guarantees replaced (explicit build in release/CI, plus a packaging assertion that the
   shipped `dist/` matches sources), because a lifecycle scan that fails on its first run is not a
   test and omitting the scan leaves a hard constraint unenforced.
8. **Launchd coverage.** Some sequences need a macOS runner; reboot persistence and GUI-login
   load may need the owner's machine. The plan commits to **recording which is which** rather
   than presenting owner-machine verification as CI coverage.
