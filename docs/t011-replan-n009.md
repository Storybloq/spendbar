# T-011 re-plan — delta against `docs/t011-headless-service-plan.md`

**The base document is the base, not a restart** (ticket's own instruction). This plan states only
what N-007/N-008/N-009 change, what the ticket repair changed, and the decisions the base left open.
Everything not named here is unchanged and already reviewed there.

**First act, completed before planning: the ticket text was repaired at EIGHT sites** (ISS-084
recorded four; re-audit found four more, including the sibling of the one it named — the
class-and-siblings pattern again). **ISS-084 and ISS-085 are both now resolved**; they were T-011's
two park reasons and neither survives.

---

## §1 What the two park reasons were, and why they are gone

**ISS-084 — the ticket specified the design its own plan forbids.** Q5 (`base:211`) decided option
(a) *literally*: a per-process nonce path `/tmp/spendbar-<uid>/svc-<32 hex>.sock` published in
`endpoint.json`, and **no unix-socket pathname is ever unlinked — not by us, not by Node**. The
ticket still carried the fixed path, the probe-and-reclaim startup order, a socket-removal step in
both AC 4 *and* scope item 5, path-length math computed for the wrong path, a stale-socket test row
for reclamation that no longer happens, and Q5 still listed as **open**. All eight repaired; AC 13
added to assert never-unlink end to end.

**ISS-085 — AC 10 was unsatisfiable.** It rested entirely on the v0.2 indexes-once reduction, which
existed *only* because no truthful `sourceVersion` was definable (ISS-075 → ISS-081/082). **N-009
defines it**, so the reduction is superseded. AC 10 now asserts the refresh **mechanism** — reach,
enqueue, run — which this ticket can witness in full, with the publish verdict explicitly assigned to
the store. That split is L-006 applied: this ticket does not compute `sourceVersion` at all, so
requiring it to guarantee a publish outcome would be demanding a premise its caller cannot supply.

---

## §2 N-008 5a — the pin-request path, and the gap in it

**New surface:** readers (MCP, CLI cursors) request a pin over the control socket; the **service** —
sole holder of write authority — validates and executes `createPin`, returning a pin id or a typed
refusal. Readers never construct an authority and never write. Scoped here because T-013's AC 4
consumes it and nothing else can provide it.

**The gap (ISS-083), and the witness that closes it.** "The service validates" had no
implementation: `createPin` (`store.ts:3068`) runs `assertGuardedAuthority` → `detachDocument` →
`assertArtifactId` → `assertPinInvariants` → `commitArtifact` and **never reads `doc.generationId`
against the store**. A pin naming a nonexistent generation is not refused — it is created, and then
silently collected by GC, which drops a pin whose `generationId` is absent from `existingGenerations`
(`store.ts:2993-2996`). A silent no-op where a refusal was promised.

That absence is deliberate on the store's side, not an oversight: `createPin`'s own docstring is
*"Pins are hints: losing one costs a cursor a typed error, never wrong data"* (`store.ts:3067`), and
the GC comment reinforces it — the sweep re-checks what is protected **before every deletion**, "not
once at the top", precisely because a publish can land mid-sweep. The store models pins as
best-effort hints. N-008 5a promises the *reader* something stronger — a typed refusal — so the
strengthening belongs at the service boundary that makes the promise, not inside a primitive whose
contract is deliberately weaker.

**DECISION — the service validates against the manifest, and that is witnessable without T-025.**
The retention set is exactly `activeGenerationId` ∪ `retainedGenerationIds`
(`store.ts:2671-2674`, `:2901-2902`), and the manifest is readable on its own. So the pin path is:

1. Read the manifest.
2. Refuse, typed (`unknown-generation`), if the requested id is in neither the active nor the
   retained set. This is precisely the set a pin can meaningfully name.
3. `assertHeld()` immediately before `createPin`, no intervening await.
4. Return the pin id.

**Why the premise is honest:** the service is the sole writer *and* runs GC, so nothing can remove a
generation between step 1 and step 3 except the service itself, and it serializes both on the single
queue. The single-writer topology is the witness — not an assumption about timing. A reader-side
check would have no such witness, which is why this belongs on the service and only on the service.

**What this does NOT do:** it does not prove the generation's *body* is readable — only that the
store still retains it. That stronger check needs `readGeneration` (T-025 item 2, parked). The
refusal is therefore named `unknown-generation`, not `unreadable-generation`, and the plan claims
only what it proves. ISS-083 stays open against T-025 for the store-level fix.

---

## §3 What N-009 changes for this ticket — and what it does not

N-009 assigns the surface registry, watermarks and coverage to **T-025, which is parked** on
ISS-090/ISS-091. Consequences, stated so nothing is discovered later:

- **Unaffected and buildable now:** `service run` + port allocation, the control socket and its path
  rules, the launcher and registry, `install|start|stop` + plist, `spendbar refresh`, the refresh
  **queue skeleton**, and the pin-request path above. That is scope items 1, 3, 4, 5, 6 and most of 2
  — the great majority of the ticket.
- **Contingent:** any claim that a *second* publish produces a new generation. The queue submits a
  candidate and takes the store's verdict; the verdict's richness (`published` / `refreshed` /
  `unchanged` / typed refusal) arrives with T-025. AC 1 needs one publish (the bootstrap) and is
  fine; AC 10 asserts the mechanism and is fine.
- **T-025 is recorded as a SOFT dependency** on the ticket, not a hard one, because nothing above
  blocks on it.

---

## §4 Open questions — settled here

**Q1, wire framing: length-prefixed frames, not JSON-lines.** The base fixes the properties (request
ids, bounded sizes, version negotiation) but not the encoding. Length-prefixed wins on one concrete
ground rather than taste: **the bounded-message-size rule is enforceable before allocation.** A
4-byte length header is read first, checked against the cap, and the body is refused without ever
buffering it; with JSON-lines the only way to find the end is to scan for a newline, so an oversized
or newline-free message must be accumulated to discover it is too big — the cap becomes an
after-the-fact check on memory already spent, which is a trivial local DoS from any same-uid peer
that got past the token. It also removes the embedded-newline escaping question entirely. The
identity-challenge protocol already uses length framing (length-framed 32-byte nonce), so this makes
one framing discipline across both, rather than two.

**Q2, disable relaunch: `launchctl` override, not a plist rewrite.** A plist rewrite mutates the
artifact that `install` owns, so a failure mid-stop leaves a file that no longer matches what
`install` wrote and that `start` must then detect and repair — a second reconciliation problem inside
the stop sequence, which is where round 4 already found the ordering hazards. The override is
external state that `start` clears unconditionally, so partial-stop recovery is idempotent rather
than corrective. Plist keys: `RunAtLoad` true, `KeepAlive` as a dictionary with `SuccessfulExit`
false (restart on crash, not on clean exit — a cleanly stopped service must stay stopped), and
`ThrottleInterval` left at its default with the value asserted in the test rather than assumed.

**Q3, `service repair` in v0.2: NO — and that decision is what makes ISS-026 dischargeable.** The
mismatch message may name only remedies that exist in the shipped version. Shipping `repair` means
shipping its own adopt/validate/re-record semantics and its own failure matrix, which is the v0.3
matrix arriving early. Not shipping it costs one sentence: the message directs the user to re-run
`service install` from the owning installation, which exists and works. A test asserts the message
names **only commands the shipped CLI registers** — a mutant adding `service repair` to the message
MUST fail, so the two can never drift apart.

**Q4** was already miscast in the ticket ("no number in the plan") and is repaired: the base fixes
**two** bounds — a 5000 ms injectable graceful-wait and a separate launchd-termination bound whose
value is the configured launchd exit timeout, *verified rather than assumed* — and the end-to-end
guarantee is their **sum**. The test asserts total elapsed, not the first term.

**Q5** is decided (option (a), literally) and is no longer an open question.

---

## §5 Build order

1. Injectable clock/scheduler and the fs/net seams — first, or the race tests are flaky by
   construction (the base is emphatic and it is right).
2. Runtime-dir + token validation (write-once `link()`, `fchmod`-after-open + `fstat`, exact modes).
3. Write-once port allocation + the challenge/response holder classification.
4. **The interpreter probe** — process-exit / SIGTERM / SIGKILL + rival-survival oracle against the
   live interpreter, cached per interpreter identity. This gates everything socket-related and must
   land before the socket, not after.
5. Nonce socket bind + `endpoint.json` publication + reader-side validation.
6. Control protocol (length-prefixed), then operations: status / refresh / stop / progress /
   pin-request.
7. Refresh queue skeleton with generation numbers, coalescing, publish-if-current.
8. Launcher + registry + installation id.
9. `install | start | stop` + plist + the stop sequence.
10. `spendbar refresh`.

---

## §6 Where the recurring defect classes will bite here

Named concretely rather than as a warning, because the base records seven instances of the first one
in T-008 alone:

- **Class fixed at one site, not its siblings.** The ticket repair itself hit this: ISS-084 named
  AC 4's socket-removal step and missed the identical step in scope item 5. The rule for this ticket
  is therefore stated as a *rule*, not a symptom: **every file this ticket creates** gets
  fchmod-after-open + fstat verification; **every deadline this ticket accepts** is validated at
  registration (0/negative/NaN/Infinity/Symbol); **every publish path** calls `assertHeld()`
  immediately before its commit. After any correction, grep the rule across all sites before
  reporting.
- **One property proven, a different one used.** The base kills three separate designs on exactly
  this ("our code never unlinks" ≠ "no unlink happens"; "still bound to our inode" ≠ "this pathname
  names our inode"). The live one in this plan is §2's: *retained* is not *readable*, and the
  refusal is named accordingly.

---

## §7 Risks specific to this delta

The pin-request path's validation rests on the single-writer topology; if anything ever publishes or
GCs outside this service, the premise fails silently — so the mutant is a second writer path, and it
must fail. `service repair` not shipping means the mismatch message is the only recovery instruction
a stranded user gets, which makes its wording load-bearing and is why it is asserted against the
registered command list. The interpreter probe adds a startup cost and a refusal mode that will look
like a bug on an unprobed Node; its message must say plainly that the runtime was measured and what
was measured. T-025 being parked means the store's publish verdict stays coarse for now, so any test
here asserting a rich outcome would be asserting something not yet built — none do, deliberately.
