# Session handover — T-026 landed (crash-recovery session)

**Branch:** `v0.1-ts-port` · **Commit:** `9524902` (pushed)
**Outcome:** T-026 complete — T-025 items 2 (`readGeneration`) and 5 (the `ccusageInvokedAt` rename) landed, reviewed, committed. The N-009 park chain's root is cut.

## What happened

The previous session crashed mid-`node --test` while building this subset itself. Recovery found the work **partially lost**: `types.ts` and both test files survived on disk, but `src/snapshot/store.ts` had **none** of it — no rename (4 stale sites) and no `readGeneration`. Reconstructed both from the crash transcript, including the `ARTIFACT_NAME_RE` → `endsWith(".json")` + `ARTIFACT_ID_RE` fix the session had already made before dying.

## Review record (codex session `019fd083`)

Round 1: `request_changes`, two findings. Round 2: **approve, zero findings**.

- **Adopted:** the types.ts doc comment cited "ISS-075 arc" where ISS-077 is the direct record; and my pins-bracket comment overclaimed ("forged AUTHORIZATION… exactly as disqualifying as forged bytes") — an L-006 violation, since the identity bracket cannot witness a swap-and-restore. Comment now states what is witnessable.
- **Disputed, successfully:** the critical ABA swap-and-restore finding. Grounds, both verifiable in-file: (1) it is the module-wide documented `openat` residual (`assertOwnedContainer` doc, store.ts ~240) shared by readSnapshot/resetStore/collectGarbage — a SnapshotFs interface redesign, not a T-026 defect; (2) no privilege gain — pins are unauthenticated hints, so whoever could swap `pins/` could mint a valid pin in the real one directly (that gap is ISS-083). The reviewer accepted both and did not request an issue be filed; the residual stays documented in-module.

## ISS-083 does NOT close — read before believing the runway handover

The N-009 handover said landing items 2+5 "lets ISS-083 be closed properly". The issue's own text refutes that: `readGeneration` authorizes only already-pinned-or-retained generations, so it **cannot validate an unretained generation before its pin exists** (the issue's circularity note). The fix ISS-083 actually wants is a store-owned **atomic validate-then-pin** under one authority bracket — still open, assigned to T-025. T-025's description now carries a "LANDED via T-026" section saying exactly what remains.

## What this unblocks

- **T-011 AC 1** can now publish honestly: `ccusageInvokedAt` is the fact the writer can prove.
- **T-013 AC 4** has its `readGeneration` dependency.
- Neither is unparked by this — unparking means a re-plan against the park records (`docs/t011-park-n009.md`, `docs/t013-park-n009.md`), and T-025's remaining scope is still gated on the owner decisions below.

## Owner decisions still pending (unchanged from the runway handover)

1. **ISS-090** — ratify the `hourly --cached` behavioral change, cut the surface, or accept ~100-min refreshes.
2. **ISS-091** — blocks disappearance policy: accept bounded trailing loss, exclude blocks from coverage, or run the controlled eviction experiment.
3. **ISS-089** — CCUSAGE_CMD/payload-schema conflict (escape route closed in T-025 round 2).
4. **ISS-074** — with its replacement obligation. 5. **ISS-088**, **ISS-086** (recommendation (a) shippable once ratified).

## Next session

With items 2+5 landed, **T-011 and T-013 are candidates for re-planning** — their park reasons are now answered (T-011's single reason was the field only item 5 could make honest; T-013's AC 4 blocker was items 2+5 both). T-025 itself stays parked on ISS-090/091. Suggested order: owner answers ISS-090/091 first if available; otherwise a T-011 re-plan is the highest-value next runway.