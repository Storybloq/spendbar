# T-013 — MCP server: 5 bounded tools + reader computation lease + `--cached`

*Revision 1. Written after T-011 was parked following seven adversarial review rounds and 80
findings. The two defect classes those rounds kept surfacing govern this document too, and §0 says
what was done differently up front rather than discovering it in round 4.*

## 0. What was verified before this plan was written

T-011's plan asserted capabilities that turned out not to exist, four times, and each cost a review
round. So the load-bearing facts here were checked in the repo **first**, and the checks are
recorded so a reviewer can falsify them rather than re-derive them:

| Claim | Checked | Result |
|---|---|---|
| T-009 shipped an adapter this ticket can import | `ls src/mcp` | **Does not exist.** T-009's work is in `spikes/mcp/`, which its own framing calls evidence, not a shipping library — the same rule `spikes/locking/` carries. **This ticket writes the production adapter.** |
| The MCP SDK is available | `package.json` | **Not installed.** `dependencies` is `{ccusage: 20.0.19}`. `@modelcontextprotocol/server` and `zod` are **added by this ticket**, exact-pinned. |
| T-010 exposes a reader API | `store.ts:2555-2590` | `readSnapshot(fs, paths, attempts=3) → {status:"no-snapshot"} \| {status:"ok",view} \| {status:"partial",view,reason}`, `SnapshotView = {generation, quarantined[]}`. |
| Bounded partials are representable | `store.ts:2557` | `quarantined: string[]` — *"Non-empty means a bounded partial"*. AC 5 maps onto it directly. |
| Per-generation tz / policy exist for the AC 3 rule | `types.ts` `Provenance` | `timezone`, `dayBoundaryPolicy`, plus `coverage`, `fieldCoverage`, `sourceTimestamps`. |

**The working rule, carried over.** The recurring defects are (a) *a class fixed at one site and not
its siblings* and (b) *a value proven to have one property, then used as though a different property
had been proven*. T-011's plan named them in its first paragraph and then committed them nineteen
times across seven revisions — usually **inside the fix for the previous instance**. The lesson was
not "try harder": it was that obligations must live in generated artefacts and runtime brands rather
than in prose a human maintains. §8 is where that applies here.

---

## 1. Does T-013 inherit T-011's blockers? — **No, and the reason is not "it's a different ticket"**

T-011 was parked on two contradictions. Both must be re-examined here rather than assumed away,
because this ticket uses **the same T-008 primitive**.

**ISS-075 (`sourceVersion` / `ccusageFetchedAt`) does NOT block T-013.** That contradiction is on
the **publish** path: a generation cannot be written honestly because a required scalar has no
truthful value. T-013 is a **reader**. It never calls `publishSnapshot`, never constructs a
`GenerationDoc`, and never asserts dominance. It *reads* `Provenance` and reports it. If
`ccusageFetchedAt` is later re-specified, T-013's obligation is to render whatever the field becomes
— which is a display concern, not a correctness one. **Caveat stated rather than glossed:** with
T-011 parked there is no writer, so a snapshot only exists if something else wrote one; §7 covers
how the suite obtains generations without depending on the parked ticket.

**The native-error boundary does NOT block T-013, and this is the one that needed real thought.**
T-011's AC 5 required distinguishing `EADDRINUSE` (a holder exists) from `EACCES`/sandbox (an
environment failure), because the two lead to *opposite* outcomes — refuse-to-start versus diagnose
the environment — and T-008 names collapsing them as the indeterminate-becomes-an-answer defect.
**The reader lease has no such fork.** The ticket is explicit that the lease is *"an OPTIMIZATION,
not a correctness boundary"*: correctness comes from T-010's atomic-rename publish, so a reader is
correct with the lease, without it, and when it cannot tell why it failed to get it. Every bind
failure — held, forbidden, sandboxed — collapses to one honest state: **"I am not the computing
holder"**, whose behaviour is *wait to the deadline, then serve what the snapshot has, with honest
freshness*. Collapsing them is safe **here** precisely because it is not a fork, and that is the
distinction T-008's rule turns on.

This is deliberately the shape of argument that failed in T-011 — *"property X holds for a different
reason here"* — so it carries a test rather than a paragraph: **a lease-bind failure injected as
`EACCES` must produce byte-identical observable behaviour to one injected as `EADDRINUSE`**. If
those ever diverge, the collapse has become a fork and this argument is void.

---

## 2. The five open questions, decided

### Q1 — cursor-referenced generation retention → **30 minutes, floor of one known-good generation**

A cursor pins a generation; retention must outlive realistic pagination and nothing more. 30 minutes
covers an interactive session with slack; beyond it a client is resuming a stale conversation and a
typed restart is the right answer. It rides T-010's GC as an *input* (a pin), never as a second
retention mechanism, and it does not lower T-010's existing floor of one known-good generation.
Validated through §8's registry as a `duration-ms` value.

### Q2 — lease wait deadline → **4000 ms**; subprocess concurrency cap → **1**

The deadline is bounded by the client, not by the work: the measured pipeline is 60–80 s, so a
reader **never** waits for a full computation — it waits only long enough that a *nearly finished*
holder can publish. 4000 ms sits well inside the exit target of <2 s warm plus margin, and the
stall it can cause is capped and honest. **Cap 1** because the entire purpose is to prevent a herd
from launching N copies of a 60–80 s pipeline; any cap above 1 concedes the thing the lease exists
to prevent. Both are `duration-ms` / `count` registry entries (§8) — a count is not a duration, the
error T-011 made.

### Q3 — `--cached` scope → **all 9 ported views; no snapshot ⇒ typed error, never empty output**

Restricting the flag to a "snapshot-expressible subset" would make `--cached` mean different things
per view, which is worse than a clear refusal. Views the snapshot cannot answer fail with a typed
error naming the view and the reason. **A missing snapshot is an error, not empty output** — empty
output is indistinguishable from "you spent nothing", which is a fabricated answer, the exact class
this project treats as the worst failure mode.

### Q4 — real-client exit-test registration → **validated absolute paths**

The launcher is T-011's deliverable and T-011 is parked. Registering through it would make this
ticket's exit test depend on parked work. Absolute paths are what the launcher would resolve to
anyway, so the test measures the same thing. **Recorded honestly:** this does *not* discharge the
plan's launcher-registration requirement — shebang bins do break under GUI-launched clients — it
defers it to the v0.3 doctor/upgrade matrix that already owns that surface, and §10 says so.

### Q5 — `usage_blocks` under `CCUSAGE_CMD` → **runtime validator required in this ticket**

ISS-023 accepted "no runtime validator for custom `CCUSAGE_CMD` payloads" for the **CLI**, where the
blast radius is one user's terminal output. That acceptance does **not** extend to MCP, and
extending it would be defect class (b) — a property proven in one context used as though proven in
another. MCP structured output is a **versioned public schema** consumed by an LLM that will
compute over it and present results as fact. So `usage_blocks` validates its payload at runtime
before serving, and a payload that fails yields a typed error rather than a pass-through. This is a
divergence from the CLI's accepted tradeoff and is stated as one.

---

## 3. What gets built

`src/mcp/`, mirroring `src/snapshot/`'s shape: a seam, a real adapter, pure logic taking the seam.

| module | responsibility |
|---|---|
| `adapter.ts` | The ~50-line SDK adapter — **written here**, informed by `spikes/mcp/` but not importing it. The only module that touches `@modelcontextprotocol/server`. |
| `server.ts` | Registration of exactly 5 tools, `outputSchema` once each, stdio wiring, stdout purity. |
| `schemas.ts` | Input and output schemas; the versioned public surface. |
| `tools/*.ts` | One module per tool; pure over a `SnapshotView`. |
| `cursor.ts` | Encode/decode, generation pinning, query+sort binding, typed expiry and mismatch. |
| `freshness.ts` | Per-range/per-field derivation from `Provenance`; never a global flag. |
| `lease.ts` | The reader computation lease — a **namespace** of the T-008 primitive (§4). |
| `cached.ts` | `--cached` for the CLI, and the ALLOWLIST divergence entries. |

**Dependencies are a supply-chain act, not a convenience.** `@modelcontextprotocol/server@2.0.0`
and `zod` enter the **root** manifest, **exact-pinned, no `^`/`~`**, only as `src/mcp` lands. `zod`
is a **direct** dependency (T-009's phantom-dependency finding). Two checks ride with them, because
the no-lifecycle-scripts constraint is a property of the *tree*, not of our file: the packaging
contract's **dependency lifecycle-script scan** must cover both new packages and their transitive
tree, and a version bump re-runs T-009's conformance suite plus supply-chain inspection — the ccusage
pattern. *(ISS-074 notes the root package itself still carries `prepack`/`prepare`; that is filed
and is not this ticket's to fix, but the scan added here is the one that would catch a dependency
doing it.)*

---

## 4. The reader lease — reuse, not re-derivation

The lease is a namespace of the same primitive T-011 designed over seven rounds. That design is
preserved at `docs/t011-headless-service-plan.md` and is **reused rather than re-invented**:
write-once `link()` allocation, continuous reservation via adopt with no close-and-rebind gap,
domain-separated challenge–response, exact modes via `fchmod`-after-open + `fstat` verify, and the
socket-path rules including the measured 104-byte `sun_path` truncation.

What is **different**, and each difference is a deliberate consequence of the lease being advisory:

- **Its own allocation and its own `purpose`.** Domain separation is what stops a reader lease
  answering the writer's challenge or vice versa (AC 6), and it is tested in **both** directions —
  writer-`purpose` against the lease port and lease-`purpose` against the writer port. One direction
  is half a test; that is the class-(a) failure applied to a security property.
- **No refuse-to-start.** Failure to acquire is an ordinary outcome (§1).
- **No takeover, no expiry, no reclamation** — inherited from T-008 and unchanged. A live-but-hung
  holder is *never* taken over; waiting readers hit the deadline and serve honest-stale. This is the
  one place where the lease's advisory nature costs something real, and it is stated rather than
  engineered around.
- **The holder computes into a private temporary generation that is never promoted** and never
  enters the writer namespace. AC 6 asserts the promoted namespace is **bit-identical** before and
  after — the same byte-identity oracle T-011 used for its allocation file, which catches a
  "recovery" that quietly writes somewhere it should not.

**T-011 is parked, so nothing else holds the writer port.** That does not make the lease
unnecessary: it is what makes MCP work with no service, which is its stated purpose. It does mean
the interplay tests (AC 6, "live-service and no-service worlds") can only exercise the no-service
world honestly today. §7 says how the live-service side is covered without pretending a parked
ticket shipped.

---

## 5. Cursors, freshness, and the timezone rule

**Cursor** (AC 4) encodes: generation id, normalized query, sort key, position. All four are
**bound**, and a presented cursor whose normalized query or sort key mismatches the request is
refused with a typed error rather than silently re-sorted — a cursor that "still works" after the
query changed is a wrong answer wearing a correct-looking shape. Pinning is a **pin on the
generation**, so all pages of one cursor are consistent even when a writer publishes mid-pagination.
After retention expires, typed expiry requiring restart.

**Freshness** (AC 5) is derived **per requested range and per field** from `Provenance.coverage` and
`Provenance.fieldCoverage`, honouring that field's documented rule: *a field absent from
`fieldCoverage` has made no claim and is therefore not covered.* Absence is reported as *not
covered*, never defaulted to covered — the same "absence is not zero" rule `dominance.ts` applies to
sources. **No global stale flag exists**; a global flag is precisely how a covered range and an
uncovered one get one answer.

**Quarantine** (AC 5): `readSnapshot` returning `partial` with non-empty `quarantined` yields
**bounded partials from the known-good generation plus warnings** — never a fabricated total, and
never a silent drop to a smaller number that reads as "you spent less".

**Timezone** (AC 3): the query timezone must equal `Provenance.timezone`; otherwise a validation
error **naming both zones**. Re-bucketing is out of scope, and the error says so, so a user is not
left guessing whether they hit a bug.

---

## 6. The 5 tools, and the one that must not exist

`usage_summary`, `usage_by_project`, `usage_by_day`, `usage_share`, `usage_blocks`. Each registers
`outputSchema` **once** in `tools/list`; every result is `structuredContent` plus a concise text
fallback, with `generatedAt`/freshness/coverage/warnings **inside** the registered result schema.

**`usage_hourly` is not registered, and the test for that must be able to fail.** AC 1 requires
asserting its absence — an assertion that passes trivially today and would keep passing if someone
registered it under a different name. So the test asserts the tool list **equals** the exact set of
five, rather than asserting one name is missing.

Strict input schemas: normalized dates, provider filters, sort, limit, cursor. Malformed input
yields typed validation errors and **never** a crash — ISS-017 is the cautionary precedent (the
Python CLI tracebacks on a non-ISO date), and the MCP surface is consumed by a model that will
happily send malformed input.

---

## 7. Verification, grouped by acceptance criterion

Grouped this way because T-011 proved that a prose test list goes stale and a missing group becomes
invisible.

- **AC 1** — `tools/list` **equals** the exact 5-tool set; `outputSchema` present exactly once each.
- **AC 2** — T-009's conformance suite re-run over the final tool layer against **recorded
  real-client transcripts**: initialize, tools/list, tools/call, malformed input, cancellation, EOF.
  **Stdout purity** asserted as *zero non-JSON-RPC bytes in any test*, with a mutant that writes one
  stray `console.log` and must fail.
- **AC 3** — unequal-timezone query errors naming both zones; equal-timezone succeeds.
- **AC 4** — truncation + `nextCursor` past the row cap; all pages consistent across a mid-pagination
  publish; typed expiry after retention; typed rejection of query-mismatch **and** sort-mismatch
  (two mismatches, two tests — siblings).
- **AC 5** — stale snapshot + no service → freshness reflecting *actual per-range* coverage;
  quarantined generation → bounded partials with warnings, never fabricated totals; a field absent
  from `fieldCoverage` reported as not covered.
- **AC 6** — herd: **N ≥ 10** concurrent clients + `--cached` against a stale snapshot → **exactly
  one** computation while the holder's listener stays bound, subprocess count ≤ 1, every caller
  answered within the deadline. Kill-the-holder mid-computation → successor computes **or** all
  readers get honest-stale at the deadline; never deadlock. Promoted writer namespace
  **bit-identical** before/after. Domain separation refused in **both** directions.
- **AC 7** — `--cached` spawns **no** ccusage subprocess, asserted via the **injected runner** (an
  observable, not an absence of evidence), and returns snapshot-derived output with freshness.
- **AC 8** — every `--cached` divergence has a numbered ALLOWLIST entry plus replacement
  shipped-mode tests; byte parity green for all non-`--cached` invocations.
- **AC 9** — week-per-project **< 2 s warm from both real clients**, recorded wall-clock with
  repetitions; deterministic proxies (sizes, query counts) hard-gate CI.
- **AC 10** — `tools/list` serialized size and proxy token count recorded, committed as baseline at
  completion, CI fails hard past **baseline +10%**.

**How the suite obtains snapshots with T-011 parked** — stated because it is the one dependency
this ticket cannot satisfy by itself. Generations are produced by a **test-only publisher** that
writes through T-010's real `publishSnapshot` behind a real authority. That is enough for every AC
above, all of which are reader-side. It is **not** enough for the live-service half of AC 6's
"live-service and no-service worlds", which needs a real writer holding a real port. That half is
**explicitly deferred to T-011's unparking** and recorded in §10 rather than simulated — a fake
writer would make the test pass without testing the thing it is named for.

---

## 8. Where the obligations live

The T-011 lesson, applied from revision 1 instead of revision 7:

- **One typed configuration schema.** Every numeric value declares its unit — `duration-ms`,
  `count`, `bytes` — and validation plus mutation cases are **generated** from it. An undeclared
  numeric field fails the build. Registered here: cursor retention (`duration-ms`), lease wait
  deadline (`duration-ms`), subprocess cap (`count`), row cap (`count`), range cap (`count`),
  response size caps (`bytes`), `readSnapshot` attempts (`count`, bounded 1..16 by the store itself).
  Counts are validated as **positive bounded safe integers**, not as durations — `2.5` and `2**60`
  pass a duration check and neither is a count.
- **Schemas are the single source of truth for tool surface.** `tools/list`, the token-budget
  measurement (AC 10) and the input validators all derive from `schemas.ts`; a tool added without a
  schema fails the build rather than shipping unmeasured.
- **The `--cached` divergence ALLOWLIST is checked bidirectionally**: a divergence with no entry
  fails, and an entry with no divergence fails. One direction lets the list rot.

---

## 9. Not built here

`usage_hourly`; timezone re-bucketing; MCP resources and prompts; any non-stdio transport;
registration UX (`claude mcp add` / `codex mcp add` consent prompts) and `doctor`'s MCP health
checks and real-client launch matrix, all v0.3.

---

## 10. Open questions and honest gaps

1. **AC 6's live-service half is blocked on T-011** (parked). The no-service world — the lease's
   actual purpose — is fully covered. The live-service world is deferred, not simulated.
2. **Q4's launcher-registration requirement is deferred to v0.3**, not discharged. Shebang bins do
   break under GUI-launched clients; the exit test uses validated absolute paths, which measures the
   same latency but does not prove the registration path.
3. **Q5 diverges from ISS-023's accepted CLI tradeoff** by requiring a runtime validator for
   `usage_blocks` under `CCUSAGE_CMD`. If the owner would rather extend the CLI's acceptance to MCP,
   that is a decision — but it means an LLM may compute over unvalidated payloads and present the
   result as fact, and the plan's default is the safer one.
4. **ISS-055** (codex-cli approval behaviour under `--ignore-user-config`) is the next queue item and
   is a property of the client, not of this code. It will reach users of this server, so it is worth
   resolving alongside rather than after.
