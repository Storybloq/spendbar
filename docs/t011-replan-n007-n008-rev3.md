# T-011 — Headless service — re-plan against N-007 / N-008 (revision 3)

> **AMENDED 2026-08-05 — three statements in this revision are now FALSE ABOUT THE TREE. Read this
> before §2's amendment table or §4, because both would send an implementer to do work that is
> already done.** Nothing below is rewritten; this revision predates N-009, and `docs/t011-replan-n009.md`
> is the later re-plan. What changed is the tree, not the reasoning.
>
> Commit `9524902` (ticket **T-026**, complete) extracted T-025 items 2 and 5 and landed them:
>
> 1. **§2's N-007 #2 row and all of §4 — "T-025 is parked, so its item 5 does not land / will not
>    land. T-011 owns the rename outright."** The rename **landed in T-025's own module**, not here.
>    `ccusageInvokedAt` is declared at `src/snapshot/types.ts:301` and enforced at
>    `src/snapshot/store.ts:960`, `:1077`, `:1083`. §4's "15 sites" rename list is **complete and
>    performed** — `grep -rn ccusageFetchedAt src/ tests-ts/` returns one hit, the rationale comment
>    at `types.ts:298` that records what the field was renamed *from*. **T-011 must not re-perform
>    this rename.** What survives from §4 is only the *witness* half — the contributing-set
>    definition and the clock read immediately before the ccusage spawn — which is still T-011's and
>    still unbuilt (`src/ccusage.ts` captures no instant).
> 2. **§2's N-007 #5 row — "T-025 (parked). T-011 does not call it."** Both halves are dead.
>    `readGeneration` exists at `src/snapshot/store.ts:2806`, and the live plan
>    (`docs/t011-replan-n009.md` §2) has T-011's pin-request path calling it as step 1. Do not carry
>    this row forward.
> 3. **"T-025's park record is annotated to say item 5 moved here"** (§4) was never true and is now
>    moot: `docs/t025-park-n009.md` carries no such annotation, and item 5 did not move.
>
> **What did NOT change:** T-025's ingestion-surface registry, its coverage policies and
> `SnapshotPayloadV1` remain parked on ISS-090/ISS-091. Only items 2 and 5 landed.

**Base:** `docs/t011-headless-service-plan.md`, 1234 lines, 12 sections, produced over 7 review rounds and 80 findings.

**Revision history of this re-plan.** Revision 1: REJECTED, 11 findings, 2 critical — I incorporated the base document by reference without reading it. Revision 2: REJECTED, 12 findings, all major — I read the base document but claimed its supersession map was complete over 1234 lines, and it was not. **Both rejects are the same defect at different scales: asserting a property of a body of text I had not checked exhaustively.** Revision 3 stops asserting completeness and instead enumerates, per amendment, what changes and who owns it.

**Risk: HIGH.**

**Park assessment: NOT parked. Reasons in §9 — the criterion is a defect in the filing, and every finding of round 2 resolves to a scope reduction with a named holder, not to a contradiction in T-011's own acceptance criteria.**

---

## 0. Corrections — revisions 1 and 2, stated before anything else

### From revision 1 (carried; the base document is the authority on all four)

| Revision 1 said | The base document actually says | Effect |
|---|---|---|
| "Open question 5 (ISS-041) still open"; carried forward *probe → reclaim confirmed-stale* and *socket removal in stop* | **Q5 is DECIDED** (§1 Q5, line 211): **option (a) literally — no unix-socket pathname is EVER unlinked**, by us or by Node. Per-process nonce path `/tmp/spendbar-<uid>/svc-<32 hex>.sock`, live path published in `endpoint.json` | **Critical.** My sequence executed the read-then-unlink race empirically proven to delete a rival's live socket. Reversed. All five open questions are decided. |
| Witness = injected clock immediately before `runner` at `src/ccusage.ts:31` | §4 (line 491): `src/runner.ts:176` is **`spawnSync`**; a dedicated async `service/ccusage.ts` adapter is required, **plus a test proving the synchronous runner is unreachable from any service module** | **Critical.** My named witness sat in a module the service is forbidden to call. Reversed. |
| AC 7's race tests need two successful store commits | §4 (line 549): "AC 7's publish-if-current is the **queue's internal discipline** … **tested with injected jobs, independent of ccusage**" | My "new blocker" was false. Withdrawn. |
| AC 6 "partially dischargeable" | Loss discipline is observable on a single paused pre-commit publish | Understated. AC 6 is **fully** dischargeable. |

### From revision 2 — three reversals and one contradiction I found myself

| Revision 2 said | The truth | Effect |
|---|---|---|
| §5: "ISS-082/081 have no consequence for this ticket, **and that is the point**" | **FALSE.** N-008 1a assigns the retirement attestation to *the service* — "the service attests retirement only after verifying the INPUT side". That caller is T-011's and ISS-082 blocks it. The block also reaches the base's generic bootstrap-replacement operation (base:1148), which bypasses dominance and therefore rests on the candidate being *semantically* truthful, not merely structurally valid. | **Reversed.** §5 rewritten; ISS-082 amended to record that it blocks a T-011 scope item directly. T-011 stays implementable — but as a **consequence** of ISS-082, stated as one, not as an unrelated coincidence. |
| §1: the base's "three refusal verdicts" incorporated **unchanged** | N-008 1b **supersedes one of the three.** Equality must return `{status:"unchanged"}`, distinct from refusal. Verified against source: `{}` vs `{}` → `compareSourceVersions` sees an empty key set, so neither the one-sided-key branch nor `anyGreater`/`anyLess` fires → **`"equal"`** (`dominance.ts:185-190`) → `verdict !== "dominates"` → `SnapshotNotDominatingError` (`store.ts:2180-2192`). Preserving that is preserving superseded behaviour. | **Reversed.** §6. T-011 does not implement N-008 1b; it makes the equality case **unreachable** and routes the situation to a typed `bootstrap-limit` outcome that is explicitly **not** `unchanged`. |
| §1 / §5: the base's `sourceVersion` reasoning incorporated "**unchanged in effect**" | The *outcome* survives; the *reason* is now false. Base §10.1 (line 1038) says "no design available to this ticket can produce a `sourceVersion` that honestly supports a dominance claim, **because ccusage does not report what it consumed**". N-007 #1 rejects that premise outright — watermarks are output-derived. Keeping the outcome while incorporating the disproven justification leaves two incompatible contracts in one operative plan. | **Superseded in reasoning, outcome retained.** §5. The two reasons have different exit conditions, which is why this is not cosmetic: the old one waits for owned parsing (v0.5); the real one waits for two owner decisions (ISS-082 → ISS-081). |
| — | **Found by my own audit, not by review:** findings 4 and 10 compose into a contradiction. If the bootstrap-replacement operation is reachable from `spendbar refresh`, then `bootstrap-limit` ("this build cannot re-index") is a lie, because resetting and republishing *is* a re-index. | Resolved in §6/§7 by gating replacement on a **non-bootstrap** candidate, which v0.2 cannot construct — so it has no production caller. This is the T-025 items 3a/3b class (two fixes composed without checking the pair); this time it was caught before submission. |

Two prerequisites revision 1 missed and revision 2 kept: **ISS-074** (`prepack`/`prepare` in `package.json`) is a *prerequisite of this ticket*, not a loose end — the no-lifecycle-scripts rule is a hard constraint and the launcher design exists *because* of it. And the exact-mode launcher contract rests on an unproven premise: that **launchd accepts a 0600 plist**.

---

## 1. Supersession map — per amendment, with an owner for each consequence

Revision 2's map was organised by base section and closed with "everything not listed is incorporated unchanged". That claim is what round 2 broke twice. This map is organised the other way: **every clause of N-007 and N-008 is listed, and every consequence names the ticket that discharges it.** A base section is now only cited as the *site* of a change, never as evidence that unlisted text is fine.

| Amendment | What it requires | Who discharges it | Base sites affected |
|---|---|---|---|
| N-007 #1 — watermark semantics | Redefine `sourceVersion` as an output-derived watermark | **Blocked** on ISS-082 then ISS-081. Not T-011. | §4, §10.1 — reasoning superseded (§5 below), outcome retained |
| N-007 #2 — `ccusageFetchedAt` → `ccusageInvokedAt` | Exact-key rename + an honest witness | **T-011** (§4 below). T-025 is parked, so its item 5 does not land — see §4. | `store.ts:960,1077,1083,1084`; `types.ts:294`; 10 test sites |
| N-007 #3 — network adapter | `EADDRINUSE`/`EACCES` classified at an adapter | **T-011** (§3 below). Resolves ISS-078, AC 5. | §4's "native-error classification is unresolved" |
| N-007 #4 — cut the reader lease | Reader lease removed | T-013. No T-011 surface. | none |
| N-007 #5 — `readGeneration(id)` approved | New store read API | T-025 (parked). T-011 does not call it. | none |
| **N-008 1a — attested retirement** | `publishSnapshot.retireSources`; dominance permits a missing key only when named there; the service attests only after verifying the input side; retirement logged as its own outcome | **Store side: T-025 (parked, held on ISS-082). Service caller: NOT SHIPPED by T-011 — see §5.** | §4, §10.1 |
| **N-008 1b — `{status:"unchanged"}`** | A third `publishSnapshot` status, produced on equality, distinct from published and refused | **Store side: T-025 (parked). T-011 does not implement it and does not simulate it — see §6.** | §4's "three refusal verdicts" |
| N-008 2a — rename is an exact-key schema change | Pre-rename snapshots fail `assertExactKeys` and classify to reset; acceptable pre-release, written down | **T-011** carries this now that T-025 is parked (§4). | §3's reset routing |
| **N-008 5a — pin-request path** | Readers request a pin over the socket; the service validates and executes `createPin` | **T-011 at a reduction** (§8). The general form is held on **ISS-083** and assigned to the store ticket. | new surface; base §6 protocol registry |

**Two internal contradictions inside the base document itself**, found by round 2 and independently confirmed against the file. Neither comes from N-007/N-008; both are pre-existing and both are corrected here rather than inherited:

| Base site | Contradiction | Resolution |
|---|---|---|
| §7 numeric schema, lines 697 and 717 | The exhaustive numeric-unit set includes `version-bound` — "the **verified Node range** endpoints" — while §1 Q5 (lines 254-262) *rejects* range inference as "two versions used as proof for an interval" and requires an exact-version allowlist plus a live probe. Implementing §7 recreates what Q5 rejects. | **`version-bound` is removed** from the schema and every range-endpoint mutation test with it. The exhaustive set becomes `duration-ms \| duration-seconds-integer \| count \| bytes`. The allowlist is a list of exact version *strings* — not a numeric field at all — so it leaves the numeric registry entirely and the bidirectional generation check still passes. |
| §1 Q5, line 262 vs §5 inventory, lines 583-597 | Q5 says probe results are "cached per interpreter identity so it is not re-run on every start", but §5's inventory — which exists precisely to be exhaustive — contains no cache record, and install and run are separate processes so a non-persistent cache cannot satisfy the sentence. A persistent one needs exact mode, fsync, schema validation, hostile-umask coverage and invalidation, keyed by something proving the *binary* unchanged — and inode identity is prohibited by T-008, so the key would have to be a content hash of the interpreter, which costs more per start than the probe it saves. | **The cache is removed.** The probe runs at `service install` and at every `service run` start. Cost: a handful of child spawns once per service *lifetime* (the service is long-lived, started at login). Benefit: no new coordination record, and §5's inventory stays correct as written. |

---

## 2. What "T-011 alone indexes once" now means, precisely

Every generation T-011 publishes carries `sourceVersion = {}` and `provenance.refreshTier = "bootstrap"`. Three consequences follow, and §§5-7 are each one of them:

1. An **empty key set cannot shrink**, so retirement is unreachable — §5.
2. A **`{}` candidate can never dominate a `{}` live**, so a second refresh cannot publish through the normal path — §6.
3. A candidate that **makes no per-source claim cannot make a false one**, which is what keeps the reset-and-publish path honest — but only for candidates the service builds itself — §7.

---

## 3. N-007 #3 — the network adapter (resolves ISS-078, AC 5)

The constraint was always "native errors are inspected only at an **adapter**"; fs was merely the only adapter that existed. `src/service/net-adapter.ts` owns `EADDRINUSE` / `EACCES` classification exactly as the fs adapter owns fs errnos: it is the sole module that reads `err.code` off a native network error, and it returns branded, tagged outcomes. Core logic never sees a native error.

The three outcomes AC 5 needs stay distinct and none collapses into another: **held-by-us** (challenge–response succeeds), **held-by-foreign-or-unidentifiable** (named refuse-to-start; allocation file byte-identical afterwards), **environment failure** (`EACCES`, e.g. a sandbox forbidding loopback binds) — which T-008 explicitly requires must not read as "lock held".

Mutants: an adapter mapping `EACCES` to the in-use branch; a core module reading `err.code` directly; a caller continuing past "foreign"; a caller recovering by allocating a second port (caught by the byte-identity assertion).

---

## 4. N-007 #2 — `ccusageFetchedAt` → `ccusageInvokedAt` (resolves ISS-077, AC 1)

15 sites: `store.ts:960, 1077, 1083, 1084`; `types.ts:294`; `snapshot-realfs.test.mjs:73, 137`; `snapshot-store.test.mjs:74, 1441, 4936, 5027, 5148, 5964, 6038, 6102`.

**Ownership is now settled by circumstance, not preference.** Revision 2 said "T-025 must be amended in the same change, or T-011 depends on its commit — either is fine". **T-025 is parked, so its item 5 will not land.** T-011 owns the rename outright, and T-025's park record is annotated to say item 5 moved here. Leaving it double-claimed was acceptable when both tickets were live; it is not acceptable now that one of them is not.

**Witness (L-006).** The clock is read immediately before the **async spawn in `src/service/ccusage.ts`** — not `src/ccusage.ts:31`, which service modules are forbidden to reach.

**Which invocation the scalar denotes** — revision 2 said "the earliest payload-contributing invocation", and round 2 was right that this is ambiguous one level down. Defined properly:

> The **contributing set** is every ccusage invocation whose result — *including an observed empty result* — influences any field of the persisted generation: payload, `sourceVersion`, coverage, `sourceTimestamps`, `ccusageVersion`, or any other provenance field. `ccusageInvokedAt` is the **minimum attested instant over the contributing set**.

Membership rules, each stated because each is a case revision 2's phrase silently decided wrong:

- **An empty result contributes.** Learning that a source produced nothing is information the generation records.
- **A provenance-only command contributes.** "Payload-contributing" excluded commands that determine `ccusageVersion` or coverage; they are inputs to the persisted document and belong in the set.
- **A discarded command does not contribute.** If its output is used for nothing, it is not in the set.
- **Retries: the invocation whose result was USED is in the set; failed attempts are not.** A failed attempt contributed nothing, so stamping its earlier instant would claim data was requested earlier than the data actually reflected.
- **Fallbacks: only the command whose output was used.** If A is tried and discarded in favour of B, only B is in the set.
- **Zero contributing invocations is a refusal, not a default.** A publish path that reaches the store having invoked ccusage zero times has no honest value for the field and must refuse rather than stamp anything.

Each command result carries its own attested instant back to `rebuild.ts`, which selects the minimum and forwards it — never reconstructs it. Tests: an empty contributing result is included; a provenance-only command is included; a discarded command is excluded; a failed-then-retried command stamps the successful attempt; two contributing commands with genuinely distinct instants select the minimum; **the mutant stamping the last invocation must fail** — and it is built on two contributing calls with distinct instants, so it cannot pass vacuously; zero contributing invocations refuses.

Accepted per N-008 2a: exact-key schema change; a pre-rename generation fails `assertExactKeys` (`store.ts:1058`) and classifies to reset. Derived cache, reset is the migration, pre-release.

---

## 5. N-008 1a — retirement is unreachable, not unimplemented

N-008 1a assigns the attestation to the service, and ISS-082 means the service cannot know what it would be attesting about: the key domain is undefined, so there is no entity to name, no declaration site to read, and no honest value to pass. That is an L-006 witness failure and it is the block round 2 caught me denying.

**What T-011 ships: no retirement caller at all.** The justification is not "we ran out of time" — it is that the path cannot be reached:

- `publishSnapshot.retireSources` is a **store** change. It is held on ISS-082 with the rest of the store follow-on work, along with its telemetry and its tests.
- T-011 supplies no `retireSources` argument, and **a test asserts no module under `src/service/` references the symbol.**
- Retirement is only meaningful when a key set shrinks. Every generation T-011 publishes carries `sourceVersion = {}`. **An empty key set cannot shrink**, so no retirement event is constructible from anything this ticket writes.

That last point is the whole difference between this and a park. T-025 parked because it was asked to *write down a definition that does not exist*. T-011 is asked to *call an operation that is unreachable in the configuration it ships* — and "unreachable, with a test proving no path reaches it" is a statement that can be made honestly and checked.

The unblocking order is recorded on the ticket: ISS-082 (key domain) → ISS-081 (witness) → the store's `retireSources` → a service attestation caller.

---

## 6. N-008 1b — the equality case is made unreachable, and `bootstrap-limit` is not `unchanged`

Verified against source: a second refresh under T-011 produces `{}` against a live `{}`, `compareSourceVersions` returns `"equal"`, and the shipped store throws `SnapshotNotDominatingError`. N-008 1b says that should be `{status:"unchanged"}`. That is a store change on a parked ticket. **T-011 neither implements it nor simulates it.**

Instead the situation is intercepted **before it reaches the store**, and given its own name.

**Admission check.** A refresh is admitted only if it could possibly publish. It cannot when the store holds a usable active generation marked `refreshTier = "bootstrap"` and the watermark contract is unimplemented — which, in every build this ticket produces, is always. So the queue returns the terminal outcome **`bootstrap-limit`** at admission, **before any ccusage process is spawned.** Round 2 asked for exactly this test and it is the one that makes the outcome worth having: *no ccusage process starts.*

**`bootstrap-limit` is not `unchanged`, and the plan says so in the type.** `unchanged` means *we looked and nothing had moved*. `bootstrap-limit` means *we cannot look*. Reporting the second as the first is a freshness lie — the exact class N-008 1b exists to prevent — so no code, message or telemetry field in this ticket uses the word `unchanged`.

**The refresh outcome type is closed and disjoint:** `published` | `bootstrap-limit` | `refused-incomparable` | `failed`. `refused-incomparable` remains reachable in both directions (a `{}` candidate against a non-empty live written by a newer writer, and the reverse) and keeps its own routing and tests. The `equal` case is unreachable, and the test that proves it is failable: a second refresh yields `bootstrap-limit` and `SnapshotNotDominatingError` is never constructed — **the mutant that removes the admission check reaches the store and produces it, and fails.**

**Runtime surfacing** (round 2 was right that revision 2 named the requirement and specified no mechanism):

- `status` gains **`refreshMode: "bootstrap-only" | "incremental"`**, always `"bootstrap-only"` in v0.2, plus `bootstrapPublished: boolean`. A reader can tell a service that indexes once from one that is broken without inferring it from a failure.
- **Progress** reports a terminal `bootstrap-limit` frame — never a fabricated completion.
- **`spendbar refresh`** exits with a distinct non-zero code (not the generic failure code) and a message that states the limitation and that lifting it is T-012's work. A user is told what is true, not handed an error that looks like a bug.
- **One log line at the admission decision**, so the reduction is visible in support output.
- **Before the bootstrap publish**, refresh is admitted and runs normally. The two halves are tested separately.

---

## 7. The bootstrap-replacement operation — mechanism ships, production caller does not

Base §10.1 (line 1148) has T-011 ship a **generic** replacement operation — detect the bootstrap marker → reset under the latching authority → publish with `live: null`, where dominance is skipped (`store.ts:2180`) — and argues, correctly, that deferring it to T-012 leaves a green test that warns nobody.

Round 2's objection stands against the *generic* form: `live: null` bypasses the only gate that checks the candidate, so safety rests on the candidate being **semantically** truthful, and a "synthetic truthful candidate" demonstrates structure, not semantics. While ISS-082/081 are open no caller can supply that premise.

Both are satisfied by separating the mechanism from its parameter:

- **The mechanism ships and is exercised end-to-end** through an injection seam that is not exported from the package: marker detection → reset under the held authority → all three reset hard stops → publish with `live: null`, as one serialized queue job (marker-observation and reset must not be separable, per the base). Break any step and the test goes red, which is what the base's objection actually demanded.
- **There is no production caller,** because the operation is gated on the candidate being **non-bootstrap** — that is its entire purpose, transitioning *out* of bootstrap — and v0.2 can construct only `{}`/`bootstrap` candidates. A test asserts no production path reaches the seam.

**This is also the resolution of the contradiction my own audit found** (§0, row 4). Had replacement been reachable from `spendbar refresh`, `bootstrap-limit` would have been false: the service *could* re-index by resetting. Gating on a non-bootstrap candidate makes the two sections consistent — `refresh` terminates at `bootstrap-limit`, replacement has no caller — rather than merely adjacent.

Unblocking is the same chain as §5, ending at a real candidate from T-012.

---

## 8. N-008 5a — the pin-request path, at a stated reduction

Readers (T-013 cursors) request a pin over the control socket; the **service**, sole holder of write authority, executes `createPin` (`store.ts:3068`). Readers never construct an authority.

**What "the service validates" cannot mean.** Verified by reading it: `createPin` validates only the `PinDoc` — `assertGuardedAuthority` → `detachDocument` → `assertArtifactId` → `assertPinInvariants` → `commitArtifact`. Nothing in that chain reads `doc.generationId` against the store. Revision 2 said the service verifies the generation is "retained-**or-existing**", and round 2 was right that existence proves nothing: a pathname can be a symlink, a wrong-mode file, a malformed envelope, a checksum failure, or an artifact pending GC. Nor can the gap be closed by `readGeneration(id)` — it does not exist yet (T-025, parked) and authorizes only *already* pinned or manifest-retained generations, so it cannot validate an unretained generation *before* the pin that would authorize it. That is circular. **Filed as ISS-083 (high), assigned to the store ticket.**

**What ships instead — a reduction, stated as one.** Pins are granted **only for generations named in the validated manifest's retention set** (`activeGenerationId` ∪ `retainedGenerationIds`). That set is sound to trust: those generations were written by the store's own publish protocol and GC is required to protect them (`store.ts:2671-2674`, `store.ts:2901-2902`). One queue job, in order: validated manifest read → require membership → `assertHeld()` → `createPin`, with no await between the guard and the commit, serialized against GC and publish so a sweep cannot intervene.

**What is NOT available, and T-013 must be told:** pinning a valid-but-*unreferenced* generation to rescue it from GC — the case a long-lived cursor most needs. A request for a generation no longer retained is a typed refusal telling the cursor to re-read, not a success. Held on ISS-083.

**Operational surface** (round 2's finding 8 — none of this was specified):

- **Client idempotency key**, bounded and validated, distinct from the protocol request id. A retry after a lost response returns the **same** pin id deterministically rather than being rejected as a duplicate or creating a second pin.
- **Live pins are capped globally and per client**; the idempotency map holds exactly one entry per live pin and so is bounded by the same cap, with no count-based eviction (evicting an entry would let a retry mint a second pin).
- **Pin mutations do not wait behind ccusage.** The execution queue's long phase (spawn + parse) does not hold the store mutation bracket; only the short publish phase does. A pin request therefore waits at most one short publish, not 60–120 s.
- **Cancellation:** if the connection closes or the deadline expires before admission, the request is cancelled and never mutates. If it has already entered its mutation bracket it completes — mutations are not abortable — and the response is dropped; the idempotency key makes the client's retry return the same pin.
- Registered in the exhaustive protocol registry, the shutdown-latch checks, the authority-loss matrix, request caps and the hostile-input matrix. An operation added outside all five is the class-not-siblings defect.
- Tests: lost response then retry (same key → same pin id); retry with a different key (second pin, counted against the cap); timeout before admission (no mutation); timeout during wait (cancelled, no mutation); pin storm (cap enforced, typed refusal, no unbounded files); generation dropped from retention between read and request (typed refusal, not success).

---

## 9. Park assessment — why this is not a park

The criterion is a defect in the filing: an acceptance criterion contradicting a stated constraint, a cited `file:line` that does not hold, or a scope item that cannot be sound in isolation from the others.

- **No AC contradicts a constraint.** ACs 1-12 are about the socket, the singleton, the launcher, the lifecycle and the queue. None of them mentions watermarks, retirement or dominance.
- **No cited `file:line` fails.** Every location checked this round held: `store.ts:3068`, `store.ts:2180-2192`, `dominance.ts:161-190`, `store.ts:2671-2674`, base `697`/`717`/`262`/`1038`/`1148`.
- **Every scope item is sound in isolation, at a stated reduction with a named holder.** Retirement (§5) is unreachable, not undischargeable. The equality status (§6) is a store change T-011 routes around rather than fakes. Replacement (§7) ships as a mechanism with no production caller. The pin path (§8) ships a real, useful subset with the rest on ISS-083.

The one thing that would flip this: if the owner reads N-008 5a's "the service validates and executes `createPin`" as requiring the *general* form, then T-011 has a scope item with no possible implementation and it parks. The reduced form is what I read the clause to license; **if that reading is wrong, say so and this parks on ISS-083.**

### One AC that needs an owner ruling either way

**AC 10** reads: "`spendbar refresh` reaches the running service over the socket and **triggers a refresh**." Revision 2 claimed this passed because "the refresh runs and correctly declines to publish". Under §6's admission check that is no longer true — after the bootstrap publish, no refresh runs at all; the command reaches the service and receives `bootstrap-limit`. So AC 10 is discharged in two halves: **before** the bootstrap publish it triggers a real refresh; **after**, it returns a typed terminal outcome. If AC 10 is meant to require that a refresh actually execute on every invocation, that is not satisfiable in v0.2 and the AC needs amending rather than quietly reinterpreting. I am flagging it rather than choosing, because revision 2 chose and was wrong.

---

## 10. Prerequisites — gates, not tasks

1. **ISS-074 — remove `prepack` and `prepare` from `package.json`.** A hard constraint (no lifecycle scripts), and the launcher design exists *because* of it. Removal, explicit release/CI build steps, the dist-versus-source packaging assertion, and a passing lifecycle-script scan all land before the launcher work is called done.
2. **The 0600-plist probe.** ACs 8 and 12 assume launchd accepts a 0600 plist; the base says an owner mode exception is required if it does not. Probe on a supported macOS runner and record the result. If it fails, ACs 8/12 park for the exception rather than being claimed.
3. **The Node-runtime probe is now per-start** (§1). It must exist before `service run` is called complete, and its exact-version allowlist replaces the deleted `version-bound` schema entry.

---

## 11. Build order — construction, and separately, acceptance

Round 2 was right that revision 2's list claimed ACs before their dependencies existed — AC 2 before the four operations, AC 1 before install/start, AC 6 before the queue. These are two different lists and conflating them is what produced that.

### Construction

1. Gates: ISS-074 removal; 0600-plist probe.
2. Seam: `types.ts`, `errors.ts`, `durations.ts`, `coordination.ts` — including the numeric schema **without** `version-bound`.
3. `net-adapter.ts` → port allocation → singleton startup → the Node-runtime probe.
4. Control socket: length-prefixed framing, path rules, token challenge, protocol registry, handlers still inert.
5. Execution queue with injected recording jobs; publish-if-current; the short-mutation-bracket split that §8 depends on.
6. `service/ccusage.ts` + the rename (§4) + `rebuild.ts` + publisher → the bootstrap publish; the `bootstrap-limit` admission check (§6); the replacement mechanism behind its seam (§7).
7. Control operations wired to real behaviour: status (with `refreshMode`), refresh, stop, progress, **pin** (§8).
8. Lifecycle: launcher, install/start/stop, plist, `spendbar refresh`.

### Acceptance — each AC claimed only after the step that makes it honest

| After | ACs |
|---|---|
| 3 | **5** (singleton startup), **11** (allocation lifecycle) |
| 4 | **3** (socket path) |
| 5 | **7** (races, injected jobs, independent of ccusage) |
| 6 | **6** (lock-loss: needs a real publish path *and* queue integration to prove the in-flight job is discarded) |
| 8 | **2** (round-trips — `stop` reaches launchd, so it is not claimable at step 7), **4** (stop sequencing), **8** (launcher), **9** (no PID control — a codebase-wide search), **10** (`spendbar refresh`, in the two halves of §9), **12** (hostile umask — covers *every* row of the §5 inventory, including launcher and plist) |
| everything | **1** (clean-prefix install + handoff) — last, and only once install, start and refresh compose end to end |

---

## 12. Non-goals

Unchanged from base §11 — fast/full tier internals (T-012); menubar (v0.3); the upgrade matrix, `doctor`, `setup`, uninstall ownership (v0.3); zero-touch upgrade survival explicitly not claimed; no reboot-persistence promise on SSH-only Macs; defending the loopback port against a hostile other local user is out of scope by design.

Added by this revision, each with its holder: the `retireSources` caller (ISS-082); `{status:"unchanged"}` (T-025); a production caller for bootstrap replacement (ISS-082/081 → T-012); pinning unreferenced generations (ISS-083).
