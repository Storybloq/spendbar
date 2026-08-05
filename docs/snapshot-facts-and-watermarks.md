# Snapshot facts and watermarks — decisions under ISS-081, ISS-082, ISS-087 (v2)

Status: PRINCIPLES DECIDED 2026-08-04 (N-009). v1 of this document was REJECTED in codex
review (session 019fcfc4, 10 findings, 1 critical) and this revision exists because of it;
§8 dispositions every finding. The SnapshotPayloadV1 field-by-field spec is deliberately
delegated to T-025's plan phase — WITH this document and review session 019fcfc4 as
mandatory inputs (resume that session so the reviewer keeps context).

Core correction from the review: **a maximum instant attests RECENCY, never COMPLETENESS.**
v1 collapsed the two and its digest-based "refreshed" outcome could silently publish data
loss. v2 separates them: watermarks answer "is this newer?", coverage answers "is anything
missing?", and both gates run on every publish.

## §1 A source is an INGESTION SURFACE (answers ISS-082)

`sourceVersion`'s keys are the surfaces the service consumes — SIX, not five (finding 5:
`hourly` reads transcripts, not ccusage; the service is the writer, so it may read them):

    claude-instances    ccusage claude daily --instances --breakdown --json  (ccusage.ts:73)
    all-daily           ccusage daily --breakdown --json — ALL agents incl. GPT (ccusage.ts:87; renamed from v1's misleading "claude-daily", finding 10)
    claude-blocks       ccusage blocks --json                                (ccusage.ts:97)
    codex-sessions      ccusage codex session --json                         (ccusage.ts:104)
    codex-daily         ccusage codex daily --json                           (ccusage.ts:118)
    claude-transcript-hours   writer-owned scan of transcript JSONL into half-hour token buckets (the facts transcripts.ts derives today), with timezone + model family recorded

**The key set is fixed per SCHEMA_VERSION**, enforced by an executable **ingestion-surface
registry** (finding 8): one versioned structure holding, per surface — key, invocation,
strict normalizer, watermark function, row-identity function, disappearance policy (§3),
retention horizon, and empty sentinel (0). Both `sourceVersion` and payload keys validate
against the registry by exact set equality, and a contract test requires SCHEMA_VERSION to
change whenever the registry changes. `retireSources` (N-008 1a) stays deleted: quiet
sources keep their key at a non-advancing watermark; surface-set changes are schema bumps.

## §2 Watermarks attest RECENCY only (answers ISS-081's witness half)

Epoch-ms per surface, computed by the registry's watermark function over NORMALIZED rows
(finding 3: the parity validators are permissive by design and are NOT normalizers — the
writer gets strict parsers for ISO dates and rollout timestamps, an explicit unparseable-row
policy, and transition tests for empty↔non-empty, newest-row deletion, and clock skew):

- claude-blocks: max(actualEndTime | endTime | startTime) over NON-GAP rows, with one
  defined fallback rule (finding 2: gap rows have no timestamps; the renderer's
  Python-truthiness fallback is the semantic to match, not `??`).
- codex-sessions: max validated rollout-filename start instant (codex.ts:51). Undated
  sessions excluded from the watermark, included in rows (they exist in the CLI today).
- claude-instances / all-daily / codex-daily: max strict-parsed row date (day floor).
- claude-transcript-hours: max bucket instant.

Watermark comparison keeps dominance's shape (fixed keys, ≥1 strictly greater, none
lesser) but **a watermark alone never authorizes replacement** — §3 must also pass. A
regressed watermark on a WINDOWED surface whose regression is age-consistent (§3) is
treated as equal, not as a violation — the window slid; that is not the store's regression
(finding 2's blocks-age-out case).

## §3 COVERAGE is attested separately, per surface, on every publish (the critical fix)

Every surface's rows carry a **stable row identity** (registry-defined: e.g. instances
(project, date); all-daily (date); codex-sessions (rollout id); blocks (startTime);
transcript-hours (bucket start, tz)). On every publish the candidate's identity set is
compared with the live payload's, per surface:

- **Additions**: always allowed.
- **Content updates at an existing identity**: allowed. This is where growing active
  blocks, growing live codex sessions, and pricing recomputes land — honestly, without
  the v1 digest trick (findings 1, and §2's residual cases from v1).
- **Disappearance**: allowed ONLY when the registry's policy for that surface explains it:
  - *Trailing-edge rule* (all windowed surfaces — and nearly every surface is windowed,
    because ccusage recomputes from transcripts that prune at a retention horizon):
    identities may vanish only from the OLDEST edge, i.e. every vanished identity is older
    than every surviving one and older than the registry's retention horizon.
  - *Age-consistent emptiness*: non-empty → empty is allowed only when the previously
    newest identity has aged past the retention horizon (a 31-day-quiet provider must not
    wedge an active user's publishes; a suddenly-empty recent source must refuse).
  - Anything else — interior gaps, leading-edge loss, recent rows gone — is a typed
    refusal (`coverage-regression`, naming surface and count, values never printed), and
    the live generation is retained (finding 1's suggestion, adopted).

Publish outcomes (supersedes v1 §3 and completes N-008 1b):
- coverage passes + watermark dominates → `{status:"published"}`
- coverage passes + watermark equal + any content update → `{status:"refreshed"}`
- coverage passes + watermark equal + no changes → `{status:"unchanged"}`, nothing written
- coverage fails → typed refusal; watermark never overrides it.

Derived-cache purity SURVIVES this design: nothing is merged into history that ccusage
cannot regive (v1's flirtation with accumulating blocks history is dropped — the CLI's
blocks view never showed more than ccusage's current window, so neither does the store;
a reset still costs exactly one recomputation).

## §4 The payload stores FACTS, not answers (answers ISS-087, with finding-4/6/7 repairs)

`generation.payload` is **SnapshotPayloadV1**: per-surface normalized row tables PLUS
per-surface producer totals (finding 7: reconciliation cross-checks consume totals —
projects/daily/codex all compare rows against producer totals; readers must be able to
reproduce those diagnostics), under exact-key, canonically ordered encoding (arrays sorted
by row identity, so producer reordering cannot masquerade as change — finding 4).

- One branded constructor/validator produces and checks the normalized value; writers
  build through it, readers consume through it, the invariant check (ISS-064/T-025 item 1)
  calls it. The permissive parity validators in json.ts stay what they are — parity
  guards — and are NOT reused as this schema (finding 4).
- **Codex project attribution is resolved at the writer** (finding 6): the service resolves
  rollout cwd at ingestion (as aggCodex does live today) and stores per-session attribution
  plus the config identity used for cleanName mapping, or an explicit unknown reason.
  Readers never open rollout files; old snapshots never change meaning.
- **Size is bounded by design, measured before build** (finding 9): T-025's plan phase
  measures encoded payload size on the owner's real data (worst realistic case) against
  MAX_ARTIFACT_BYTES (64 MiB), records the measurement in the plan, and sets a supported
  bound with a defined user-visible behavior at the bound. No unbounded all-time growth
  ships on an assumption.

## §5 What this decides vs. what T-025's plan phase owns

Decided here: the six §1 surfaces and registry obligation; recency/coverage separation;
§3's outcome contract and disappearance policies; payload = facts + totals with writer-side
normalization and attribution; size measurement as a plan-phase gate.
T-025's plan phase owns: SnapshotPayloadV1 field-by-field, the exact normalizer and
identity functions, retention-horizon constants, the transition-test matrix, and the size
measurement — reviewed by resuming codex session 019fcfc4.

## §6 Supersession ledger

- v1 of this document: §3 digest-refresh rule REJECTED in review before being built —
  superseded by §3 coverage attestation. v1's five-surface list superseded by six.
- N-007 decision 1, N-008 1a/1b: as v1 stated, with §3 above as the final outcome contract.
- T-025 items 3–4: re-specified against §2/§3/§4.
- T-013: payload question → §4; hourly stays available under --cached via
  claude-transcript-hours rather than being cut.

## §7 Finding-by-finding disposition (codex session 019fcfc4)

1 (critical, refreshed can publish data loss) → ADOPTED: §3 coverage attestation; digest
rule deleted. 2 (blocks not monotone, window slides) → ADOPTED: §2 age-consistent
regression + §3 trailing-edge; no history accumulation. 3 (validators aren't normalizers)
→ ADOPTED: registry normalizers, §2. 4 (no concrete schema; array order breaks digest) →
ADOPTED: §4 branded SnapshotPayloadV1, canonical ordering; field spec in T-025 plan.
5 (hourly needs transcripts) → ADOPTED: sixth surface. 6 (codex attribution) → ADOPTED:
writer-side resolution + config identity. 7 (totals consumed) → ADOPTED: totals stored.
8 (registry + version tie) → ADOPTED: §1. 9 (unbounded size) → ADOPTED as plan-phase
measurement gate, §4. 10 (claude-daily misnamed) → ADOPTED: all-daily.
