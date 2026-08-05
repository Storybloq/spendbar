# Session handover — targeted run `T-025 T-011 T-013 T-012` (N-007/N-008 re-plan)

**Branch:** `v0.1-ts-port` · **Session:** `00000000-0000-4000-8000-000000000000`
**Outcome:** 0 of 4 targets built. T-025, T-011, T-013 **parked**. T-012 unreachable by dependency.
**Review rounds:** 9 (3 per ticket). **Findings:** 78+. **All valid. Zero contested.**
**Issues filed:** 7 new (ISS-083…089), 2 amended (ISS-082, ISS-074), 1 self-corrected (ISS-083).

> Recorded through `storybloq_handover_create` because the autonomous guide deadlocked: `resume`
> routes to HANDOVER, the handover report requires a ticket anchor, the only anchor it accepts is
> T-012, and T-012 is rejected by its own blocked-ticket check. Worth fixing — a targeted session
> whose last remaining target is blocked cannot close itself through the guide.

---

## The one-paragraph version

N-008 amended N-007 and sent three tickets back for re-planning. All three re-plans reached the
same wall from different directions: **the tickets were written against a design that later
decisions superseded, and nobody propagated the supersession into the ticket text.** T-025's item 4
tells you to write down a definition that was never completed. T-011's ticket still specifies the
stale-socket design its own plan's Q5 decision forbids, at four verified sites. T-013 sits between
two recorded decisions that cannot both be satisfied. None of these is hard work that ran out of
time — each is a defect in the filing, which is the park criterion, and each was confirmed by
external review. T-012 was never reachable: `blockedBy: ["T-011","T-010"]` and its whole design is
"jobs on T-011's refresh queue". **Every remaining unblock is an owner decision, not implementation
work.** Nothing downstream is worth planning until they are answered.

---

## Why each target did not ship

Full reasoning is in each ticket's `park` record on disk — this is the shape, not a restatement.

### T-025 — 3 rounds, 30 findings — PARKED
Item 4 instructs migrating contracts, comments and tests to "verified-input-watermark language
(per-source newest event reflected in output)". That sentence cannot be executed:

1. **"Per-source" has no defined key domain.** `sourceVersion` is `Record<string, number>`
   (`types.ts:303`); `compareSourceVersions` treats keys as opaque (`dominance.ts:161-190`); nothing
   binds what a key *means*. Shipped tests use provider-like keys. → **ISS-082 (critical)**.
2. No ccusage surface gives a per-source sub-day activity time, so a per-source watermark cannot
   advance intra-day. → **ISS-081 (critical)**.

Items 3a/3b cannot be sound in isolation from item 4, so the ticket cannot be split around it.

### T-011 — 3 rounds (reject/reject/reject; 11+12+9) — PARKED
Reviewer's round-3 words: *"The correct disposition is park."*

1. **ISS-084 (critical).** The base plan's §1 Q5 (`docs/t011-headless-service-plan.md:211`) decided
   open question 5 as option (a) *literally*: per-process nonce socket path published in
   `endpoint.json`, and **no UDS pathname is ever unlinked** — a decision made because a probe was
   *measured* deleting a rival process's live socket at the same pathname. The ticket still
   specifies the design that replaced, at **four verified sites**: scope item 3's fixed path, the
   probe-and-reclaim startup order, the failure matrix, and AC 4's socket-removal step.
2. **ISS-085 (high).** AC 10 requires `spendbar refresh` to "trigger a refresh", which the v0.2
   indexes-once reduction cannot satisfy after the bootstrap publish.

### T-013 — 3 rounds (reject 15 / revise 12 / reject 12) — PARKED
Review affirmed **twice** that AC 6's cut and AC 4's hold are *authorized* reductions and not park
material — "the NOT-parked distinction is real". That still holds. The park reason emerged in
round 3 and is different:

1. **ISS-089 (high).** ISS-026 is *resolved* and names this ticket: "no validator lands in T-013".
   But every reader needs a payload schema, and `blocks[]` is not uniform — a strict constructor
   **is** runtime `CCUSAGE_CMD` validation. Three options are costed in the issue; recommendation
   is (b).
2. **ISS-087 (critical).** `generation.payload` is deliberately `unknown` (`types.ts:305`;
   `store.ts:937`, `1045-1049`). There is no internal snapshot payload schema, so no reader — the
   five MCP tools, `--cached` — has a proven source shape. Spans 4 tickets and 9 CLI views; needs a
   typed `publishUsageSnapshot` boundary plus T-011/T-012 amendments.

### T-012 — never picked
`blockedBy: ["T-011","T-010"]`; T-011 parked. Its dependency section reads "**T-011 (hard)**: both
tiers are jobs on T-011's refresh queue" — there is nothing to plug into. The guide's own check
refused the pick: *"Ticket T-012 is blocked."* Note `storybloq_ticket_blocked` is **read-only**
(it lists blocked tickets); it cannot record a blocker.

---

## Issues filed this session

| ID | Sev | What it says |
|---|---|---|
| **ISS-087** | **critical** | No internal snapshot payload schema exists; `payload` is `unknown`, so every reader is unsourced. **Read this one first.** |
| **ISS-084** | **critical** | T-011's ticket specifies the stale-socket design Q5 option (a) forbids — 4 sites. |
| ISS-089 | high | Decision conflict: readers need block normalization; ISS-023/026 forbid a T-013 validator. |
| ISS-085 | high | T-011 AC 10 unsatisfiable under the indexes-once reduction. |
| ISS-083 | high | `createPin` accepts any `generationId` — no validate-then-pin exists, so N-008 5a's "the service validates" has no implementation. |
| ISS-086 | medium | T-013 still carries the dead reader-lease design as live text after N-007 #4 cut AC 6; also requests a `serviceStatus` ratification. |
| ISS-088 | medium | T-009's real-client evidence is digests and counts over a probe tool, not replayable transcripts — T-013 AC 2 cannot be discharged as worded. |

**Amended:** ISS-082 now records that it blocks a T-011 scope item (my round-2 claim that ISS-082/081
had no T-011 consequence was false — N-008 1a assigns the retirement attestation to the service).
ISS-074 updated with its real cost.

**Self-corrected:** ISS-083 originally contained a false claim I wrote (that manifest retention
proves readability). Corrected in place rather than deleted.

---

## What the owner must decide (nothing proceeds without these)

Roughly in dependency order:

1. **ISS-081 + ISS-082** — the `sourceVersion` key domain and the per-source time question. These
   gate T-025 *and* T-011, and they sit under ISS-075 from the prior session. Still the root.
2. **ISS-087** — ticket the canonical fact grain. The payload must store **facts**
   (`{provider, projectId, period, model attribution, cost, tokens}`), not rendered answers.
3. **ISS-084** — amend T-011's four Q5 sites to the decided design.
4. **ISS-089** — pick (a), (b) or (c) on the CCUSAGE_CMD conflict.
5. **ISS-085** — rule on AC 10. **ISS-086** — ratify or hold `serviceStatus`. **ISS-088** — amend AC 2.

An issue the planner files is **not** an amendment, and a recorded owner decision is not a
planner's to reverse. That is why all seven are sitting here rather than being fixed in the plans.

---

## Preserved artifacts

`.story/sessions/` is **gitignored**, so these `docs/` copies are the only surviving ones:

- `docs/t011-replan-n007-n008-rev3.md` (31 KB) — T-011 revision-3 delta plan
- `docs/t013-replan-n007-n008-rev3.md` (43 KB) — T-013 revision-3 plan
- `docs/t011-headless-service-plan.md`, `docs/t013-mcp-server-plan.md` — the bases (prior session)

**Uncommitted:** the two new `docs/` files, `ISS-082…089.json`, and the `park` records on
`T-025/T-011/T-013.json`. **Commit these first.**

---

## Rules and lessons

**RULES.md L-006 was adopted this session** (per user instruction, as a review gate rather than a
lesson): *a review round that STRENGTHENS a contract must, in the same round, name the concrete
caller that will supply each premise and how that caller can know the value honestly. If no caller
can, the contract is weakened to what is witnessable and the ideal moves to the ticket that makes
it witnessable.* It would have killed all four dead T-011 designs (ISS-075) in round 3.

**The two defect classes still govern.** Both recurred, in my own work:

1. **A class fixed at one site and not its siblings.** Four instances this session. The worst: I
   fixed an authority violation for T-013's AC 6, then committed the *identical* violation on AC 2
   in the same document — restating it on the authority of an issue I had just filed myself.
2. **A value proven to have one property, then used as though a different property had been
   proven.** The whole ISS-075 family is this, and the T-013 rev-3 payload schema repeated it by
   deriving *answers* where *facts* were required.

**Three of my errors worth not repeating:**

- I re-planned T-011 against the base **document** for three revisions and never re-read the
  **ticket's** scope item 3, startup order, failure matrix, or AC 4 against the Q5 decision. The
  base document is not the specification; the ticket is.
- I planned a `CCUSAGE_CMD` runtime validator in T-013 rev 1, reversing a resolved decision. **The
  prior session made this exact mistake and recorded it as a handover lesson.** I reproduced it by
  incorporating the base plan's *conclusions* without re-checking the decisions under them.
- In T-011 rev 3 I identified AC 10's contradiction in my own §9, wrote "if that reading is wrong
  this parks", and then concluded *not parked anyway*. I found the park criterion and declined to
  apply it. Round 3 caught it.

Also verified and worth not re-deriving: `deriveFreshness` **already ships**
(`src/snapshot/freshness.ts:590`), `scripts/allowlist-coverage.mjs` + `tests-ts/harness/allowlist-witness.mjs`
are **already bidirectional and execution-witnessed**, and the packaging contract **asserts the
lifecycle scripts exist** (`tests-ts/contract/packaging.contract.mjs:349-353`) — it does not scan
for them, which is the opposite of what I asserted in T-013 rev 1. That last one is why ISS-074 is
not the trivial deletion the prior handover called it.

---

## Next session

Do **not** re-plan T-011, T-013 or T-025 — three parks in a row on filing defects is the system
working, and a fourth attempt without owner answers will fail identically. Take the owner decisions
above first. If none are available, `docs/codex-mcp-approval.md` is written and waiting for whenever
T-013 unparks, and ISS-074 is independent of everything here.
