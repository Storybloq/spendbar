# Session handover — T-011 UNPARKED after a 13-agent adversarial audit

**Branch:** `v0.1-ts-port` · **Commits:** `9524902` (T-026), `dc68954`, `df2c846` — all pushed
**Outcome:** T-026 complete. **T-011 unparked** with zero surviving blockers. Governing plan and ticket repaired. ISS-077 and ISS-073 closed; ISS-092 filed and resolved; L-006 lesson recorded.

## The one-paragraph version

The previous session crashed mid-build; recovery found `src/snapshot/store.ts` had lost **all** of its work (no rename, no `readGeneration`) while the other three files survived. Reconstructed, reviewed (codex `019fd083`: round-1 `request_changes` → round-2 **approve**, zero findings), committed as T-026. That discharged T-011's sole recorded park reason — so the real question became whether T-011 could actually unpark, given ISS-075/081/082/087 were *still open criticals tagged to it*. A 13-agent adversarial audit answered **unpark, zero blockers**, and found the thing that would have caused a fourth park: **the governing plan still said "AC 1 is blocked, not merely narrowed"**, and the ticket states that document outranks the ticket. Repaired. Then a 4-agent verification of the repair caught **three defects in my own work**, including a false claim.

## Why the four open criticals do not reach T-011 (each checked against code)

- **ISS-075/081/082** bite the **second** publish, not the first: `publishSnapshot` gates the whole dominance comparison behind `if (live !== null)` (`store.ts:2180`). An empty `sourceVersion` is honest on a bootstrap under the store's own absence-is-no-claim rule (`dominance.ts`). AC 10 as repaired already assigns the publish verdict to T-025.
- **ISS-087** — `grep -rn SnapshotPayloadV1 src/ tests-ts/` returns **zero**. Neither the type nor its constructor exists, so there is nothing to conform to; the store's whole payload contract is presence (`store.ts:1049`) plus canonicalizability. RULES.md's own remedy for an unwitnessable contract is to weaken it and move the ideal to the ticket that makes it witnessable — which N-009 already did.
- **ISS-090/091** block T-025's ingestion-surface registry. T-011's bootstrap builds no registry.

## What was repaired, and why it mattered

**The governing plan** (`docs/t011-headless-service-plan.md`) — §2, §10.1, §12 items 5-6, plus a header. Every superseded passage kept in a blockquote, per the plan's own convention that a superseded argument stays visible. Satellite docs repaired in parallel: the two re-plans, both T-013 docs, both T-025 docs, the park record.

**Two binding ticket-text traps — sibling clauses failing in opposite directions.** Clause (6) named a GC field `noManifest` that does not exist (ISS-073) → branch never fires. Clause (4) called `reset.failed` a boolean when it is `string[]` (ISS-092, **previously unfiled**) → `if (reset.failed)` is truthy for the empty array, so it halts the bootstrap on **every clean reset**; the store is never rebuilt and AC 1 fails with no test naming the cause. Neither produces a type error, a runtime error, or a failing test.

**`t013-mcp-server-plan.md` got an annotation, not a rewrite.** Its six "T-011 is parked" sites still reach true conclusions — they rest on *no writer is BUILT*, which unparking does not change. The premise expired while the conclusion survived; that is defect class (b) running backwards, and it is worth recognizing next time.

## Three defects the verification found in my own repair

Worth recording because all three are this project's named classes, committed inside corrections:

1. **A false claim.** I wrote that a direct rebuild "would publish over a symlink". It would not — `publishSnapshot` reads the live manifest through `readStoreFile` specifically so it does *not* collapse unusable into absent, and **throws** (`store.ts:2144-2151`). The routing conclusion was right; the reason was invented. Class (b), inside a fix for class (b).
2. **`failed === []`** in a required-test row — always false in JavaScript. The identical trap, inside the fix for it.
3. **Every plan citation the amendments displaced.** My header added 36 lines, so `:84`/`:113`/`:142`/`:805` all moved. Corrected to `:120`/`:149`/`:178`/`:849-851`. The dangerous ones landed on *plausible* prose rather than whitespace.

Also: I broke a hash-pinned `sourceRef` on ISS-073 by re-pointing its line numbers while leaving its revision — `storybloq validate` caught it. `sourceRefs` is provenance at the reviewed revision; `location` is where to look now. The tool derives the moved range itself.

## Ledger state

| Record | State |
|---|---|
| T-026 | complete |
| T-011 | **open, unparked** (`park` → `parkHistory` with discharge evidence) |
| ISS-077, ISS-073 | resolved, with verification attached |
| ISS-092 | filed and resolved (the `reset.failed` trap) |
| ISS-083, ISS-065 | **stay open**, evidence corrected |
| T-025 | still parked on ISS-090/ISS-091 |

**L-006 name collision, deliberate:** the lessons ledger allocated L-006 to the new lesson while `RULES.md` already used "L-006" for the witness gate, cited across the park records. Renaming the gate would have swept many governing files, so both sides now carry a collision warning instead.

## Next session

T-011 is ready to **plan**. Three things to write down rather than rediscover:

1. **`ccusageVersion` is the sibling defect one field over.** `PINNED_CCUSAGE_VERSION` (`src/resolve-ccusage.ts:21`) is the version that *ships*, not the one that *ran* — `CCUSAGE_CMD` overrides the executable (`src/context.ts:192`). Record the resolved binary's `--version` self-report; when it is unobtainable, record `"unknown"` (representable: `requireString` refuses only the empty string) and **never** substitute the pin.
2. **The bootstrap needs `refreshTier: "bootstrap"`.** With `{}` live, every later publish refuses (`equal` or `incomparable`), so the store never advances without the marker. Plan §10.1 spends a page on this; the ticket does not carry it yet.
3. **ISS-074 first** (`prepack`/`prepare`) — a prerequisite with a **replacement** obligation, and removing it turns `tests-ts/contract/packaging.contract.mjs:349` red until that test is updated too.

Owner decisions still open, unchanged: **ISS-090**, **ISS-091**, ISS-089, ISS-088, ISS-086.
