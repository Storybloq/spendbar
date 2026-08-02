# Session handover — T-005 (targeted autonomous session)

**Branch:** v0.1-ts-port · **Range:** be56785..8f9d799 (11 commits) · **Targets completed:** T-003, T-006, T-004, T-005

## What T-005 did

The parity harness had three parallel descriptions of the same 118-case matrix — capture.py's `CASES` table, cases.mjs's `EXTRA_CASES`, and cases.mjs's `GOLDEN_CAPABILITY` — and a case added to one was invisible to the others. `tests/golden/cases.json` is now the single definition, read by both the Python capture script and the TS harness.

Four changes:

1. **One registry.** cases.json holds every case, stored-golden and differential-only alike.
2. **Named comparison policies** replaced the per-case booleans (`rewrite`, `partialStdout`, `compareStderr`) and a `tsStderr` RegExp. Each policy declares the one ALLOWLIST ID it consumes, and the registry requires the case's `waiver` to equal it exactly — so a comparison cannot grant itself a licence nothing authorised.
3. **The anchors are split.** Each stored case replays at its own `captureAnchor`; the differential runs at a distinct `LIVE_ANCHOR`; both go through `tests/harness/usage-wrapper.py` with a mandatory `--anchor`.
4. **`dual_run_only` is gone.** Two relative-date goldens were stored but excluded from comparison because their output embedded "today" — two goldens nothing ever checked. Pinning the clock makes them ordinary comparable goldens.

## The measurement that justified the design

With the differential silently running at the capture anchor, byte comparison across all 118 cases produces **zero failures** — both implementations receive the same wrong anchor and agree with each other perfectly. Only `assertAnchorRouting` catches it. Every anchor-related guard in the harness exists because of that result.

## Review

Five rounds — codex, agent, codex, agent, codex — ending in a clean approve with zero findings. 32 findings total. Every one was reproduced before being fixed, and every fix mutation-verified. One finding I refuted by measurement rather than fixing, and re-submitted for adjudication in the next round.

**The recurring defect, four instances, is the thing to carry forward: a guard checking a representation the failure would not take.**

| Guard | What it watched | Where the failure actually lives |
|---|---|---|
| anchor comparison | two values built from one variable, 11 lines apart | only diverges if that construction changes |
| retired-field check | prose in ALLOWLIST.md | `"compareStderr": false` in cases.json |
| routing spy | six probes, all `case: null` | conditioned on a real case |
| retired-field list | omitted `rewrite` for a prose-scan reason | JSON keys, where the reason does not apply |

Each fix moved the witness rather than adding more of them. The trace is now recorded at the spawn boundary from the argv it forwards (truthful by construction for all 265 invocations, not for six probes), and the retired-field denylist was replaced by rejecting anything the schema does not declare.

**Twice, measuring changed the fix where reasoning would have got it wrong.** A reviewer-suggested termination fixture `{kind:"signal", status:1}` is unreachable — `classify()` always sets `status: null` — which made the real fix sharper. And the cross-provider fixture tolerance: the reviewer proposed narrowing to the one pair it had observed across four suites, but `tiebreak.test.mjs` drives `combined` under `FAKE_MODE=tied` and reaches both codex branches. Instrumenting the fixture across every suite found three real pairs. Both the reviewer's proposal and my original were wrong, in opposite directions.

**A data-loss path was closed.** `assert_registry_matches_disk()` ran after the goldens install but outside the rollback block, so a directory that installed and then failed validation stayed installed with the good backup beside it — and the next run's recovery saw JSON files, called it intact, and deleted the backup. That recovery code had shipped with no test at all; `tests/golden/test_capture_recovery.py` now drives the real functions across 26 scenarios.

## State

`npm run test:all` — 314 unit tests, both Python suites, contract 16/16, parity `--final` **266 passed / 0 failed / 0 skipped**, 45/45 goldens match a live Python re-run at their captureAnchor. A regeneration round-trip rewrites all 45 byte-identically.

New scripts: `test:python`, `test:goldens`, `test:all`. The Python suites were manual-only and this repo has no CI — given the ticket's own framing about untested recovery code, a test no runner invokes is one release away from being a test that does not exist.

## Constraints held

- **`usage.py` is the oracle and was never modified.** Verified at every commit.
- **`package.json` has no `author` field; the name is `spendbar`.** This is the standing instruction that the published package must not carry the user's name. A contract test enforces it.
- **No fixture contains a real home path or name**, so no transcript-derived data can reach a public repo or npm tarball.

## What is next — needs a decision, not autonomy

**T-007 (`npm publish`) must not be started autonomously.** Publishing is irreversible and outward-facing; it needs explicit confirmation. It was deliberately excluded from this session for that reason, and ISS-005 was to be fixed before it.

Open follow-ups: **ISS-021** — `tests-ts/fixture-schema.test.mjs`'s `CASES` table is a fourth unverified description of part of the matrix, derived from nothing and already incomplete. It predates T-005 and fixing it means deciding how the schema-validator tests relate to the case registry, which is a design question. **ISS-022** was an auto-filed duplicate and is resolved.

Also still open from earlier work: **ISS-020** (nothing reports which ALLOWLIST IDs actually executed, so `ALLOWLIST-22a` is asserted by a snapshot test whose execution is not proven) and **ISS-002** (the blocks paths have no strict validator).

Three untracked files in the working tree predate this session and were left alone: `.claude/`, `git-activity-review-2026-07-01-to-2026-07-15.md`, `westworld-investigation-2026-07-15.md`.