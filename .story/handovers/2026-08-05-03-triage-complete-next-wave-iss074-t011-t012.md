# Session handover — backlog triaged; next wave is `ISS-074 T-011 T-012`

**Branch:** `v0.1-ts-port` · **Commits this session:** `9524902` (T-026), `dc68954`, `df2c846`, `f44ff46`, `eb3cad6` — all pushed.
**This is the third handover of the session.** The first two carry the detail and are not repeated here: `2026-08-05-01-t026-landed-recovery-session.md` (crash recovery, T-026 build+review) and `2026-08-05-02-t011-unparked-after-adversarial-audit.md` (the 13-agent unpark audit, the governing-plan repair, the defects verification caught in my own work).

## What this handover adds: the triage (commit `eb3cad6`)

Seven issues closed, **each verified against the tree before writing** — the verifier fan-out re-ran greps, re-read decision docs, and reproduced test runs rather than trusting handover claims:

| Closed | Why (short form — full record with evidence index is in each issue's resolution) |
|---|---|
| ISS-075/076 | The owner choice ISS-075 posed WAS made: N-009 adopted the watermark redefinition, hardened into the recency/coverage split. All debt is inside T-025's recorded scope. |
| ISS-079/080 | The reader lease was CUT (N-007 decision 4); T-013's repaired scope text literally says "This closes ISS-079/ISS-080". No binding doc carries the 4000 ms deadline. |
| ISS-081/082 | N-009's section headings answer them by name; mechanism verified — intra-day refresh publishes via the `refreshed` outcome with no watermark advance needed. |
| ISS-059 | Already fixed 2026-08-02 in `60cf3d1`, the same commit that filed it; reproduced green (30/30 mutations, `test:all` exit 0). Record was never marked resolved. |

Also: 13 orphan issues tagged (store cluster → T-010+T-025; evidence cluster → T-009; ISS-068 → T-010+T-011), and **T-012 gained a KNOWN TEXT DRIFT section** naming its two pre-decision sites (per-source-offset watermark vocabulary; "pricing fetch time") so its re-plan's first act has its list waiting.

**Ledger state after triage:** open criticals 10 → **4, all real**: ISS-090, ISS-091 (owner gates on T-025), ISS-087 (payload schema, T-025's), ISS-060 (store reset race, T-010/T-025). Validate warnings 19 → 6, all historical-provenance notes. `storybloq recommend` now leads with the genuine gates.

## The backlog, one screen

- **v0.2 (current):** T-011 **unparked, ready** → unblocks T-012. T-025 parked on ISS-090/091 → gates T-013's unpark. 
- **v0.3:** T-014 and T-016 are **unblocked and independent** (no deps); T-015 needs T-011+T-014; T-017 needs T-015; T-018 needs T-012.
- **v0.4/v0.5:** T-019 (needs T-014), T-020 (needs T-015), T-021 (needs T-016), T-022 (needs T-020).
- Enrichment is NOT needed — sampled tickets are deep; the need was drift repair, now recorded in place.

## NEXT AUTO WAVE (recommended): `/story auto ISS-074 T-011 T-012`

Ordering rationale:
1. **ISS-074 first** — small, independent, and a named T-011 prerequisite with a **replacement obligation**: `prepack`/`prepare` must be replaced (explicit build in release/CI + a packaging assertion that shipped `dist/` matches sources), not merely deleted. Removing them turns `tests-ts/contract/packaging.contract.mjs:349-353` red until that test is updated in the same change — it asserts the scripts EXIST.
2. **T-011** — the root of the dependency spine (unblocks six tickets transitively). The plan phase must read the AMENDED governing plan (`docs/t011-headless-service-plan.md`, header first) and honor the three write-downs already in the ticket: `ccusageVersion` from the RESOLVED binary's `--version` self-report with the `"unknown"` fallback (never `PINNED_CCUSAGE_VERSION`); the bootstrap publish carries `refreshTier: "bootstrap"` (with `{}` live, every later publish refuses — `equal` or `incomparable` — so without the marker the store can never advance); the pin path is `readGeneration(id)==="ok" → assertHeld() → createPin` in ONE serialized queue turn, refusals distinguishing `not-retained` from `gone`.
3. **T-012** — reachable only if T-011 completes; its first act is the KNOWN TEXT DRIFT repair in its own description.

**Known hazard, twice reproduced (file upstream if it bites again):** the autonomous guide deadlocks when a targeted session's last remaining item is blocked — `resume` refuses outside COMPACT and the handover report demands a ticket anchor it then rejects. If T-011 parks, T-012 is unreachable and the session must close via `storybloq_handover_create` directly, as the last two runways did.

**Optional parallel wave** (separate session, zero dependency overlap): `/story auto T-016 T-014` — the D4 signing go/no-go prototype and the Swift-helper productionization are the only unblocked tickets outside v0.2. T-014's big caveat is recorded in its own text: the prototype Swift source is NOT in the repo and must be re-derived from the research-workflow transcripts.

**Owner decisions still open (unchanged, now the only criticals besides ISS-060/087):** ISS-090 (hourly `--cached` behavioral change vs cut the surface vs ~100-min refreshes) and ISS-091 (blocks disappearance: accept bounded trailing loss vs exclude from coverage vs controlled eviction experiment — passive observation is NOT authorization). Answering them unparks T-025 → T-013, which would make the wave after this one `T-025 T-013`.
