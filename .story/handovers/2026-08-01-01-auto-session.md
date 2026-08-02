# Session handover — harness hygiene sweep complete (ISS-008, ISS-021)

**Branch:** v0.1-ts-port · **Range:** 58a0051..92c0463 (2 commits) · **Session:** 277d0be7
**Completed:** ISS-008, ISS-021 — both targets, session ended normally.

This finishes the seven-item pre-publish sweep begun in session 15f591bf. **Open issues are down from 11 to 4.**

## What shipped

| Commit | Issue | What changed |
|---|---|---|
| `132dcd9` | ISS-008 | Corrected ALLOWLIST entries 7 and 9; refuted the issue's second counterexample; two differential tests |
| `92c0463` | ISS-021 | `fake_ccusage.py --dump-vocabulary`; fixture-schema matrix now derived, not restated |

**Suite at HEAD:** 335 unit tests (was 314 at the start of the sweep), contract 20/20 (was 16), parity `--final` 266 passed / 0 failed / 0 skipped, 45/45 goldens byte-match, both Python suites pass.

## ISS-008: one counterexample held, one did not

The issue's own theme is that entry 9's prose was stated more absolutely than the code supports, so both claims were reproduced before anything was written.

**Negative zero CONFIRMED.** Driven end-to-end through the CLI with `codex daily` totals of `-0`: oracle prints `codex daily $0.00`, port prints `$-0.00`, both exit 0. Python parses the bare token to `int` 0, which has no sign.

**And mutation testing upgraded the justification.** The divergence is *unfixable* in JS, not merely rare: `JSON.parse` maps both `-0` and `-0.0` to one value where CPython maps them to two that format differently, so no function of the parsed number can satisfy both — only the raw token could, and it is gone. Normalising `-0` inside `money()` makes `-0` agree and immediately breaks `-0.0`. That is now the entry's stated reason.

**The cost counterexample was REFUTED.** It claimed the port prints `...992` where Python prints `...993`. Python prints `...992` too — `f"{v:,.2f}"` converts to binary64 on its side as well — and the exact-int summation route is closed because every cost accumulator in usage.py is seeded `0.0` (:176, :338, :341, :476). Measured end-to-end with costs of `9007199254740993` and `1`: byte-identical output. **Dutifully "softening" entry 9 to name it would have put a fresh false claim into the very entry the issue was filed about.** The true part — cost fields really are exempt from the safe-integer bound — is now recorded in entry 7 with its measurement and a generalised rule: extend the bound to a field when that field can reach output as an integer.

## ISS-021: the fourth description is gone, not corrected

`cases.json` was the wrong source — it describes CLI invocations, while these tests drive ccusage branches directly. The right source is `fake_ccusage.py`'s own per-branch dispatch tables, which decide what payloads exist; it now publishes them via `--dump-vocabulary`, built from the same objects `dispatch` indexes.

Deriving made the gap measurable rather than suspected: **11 hand-written entries → 24 derived pairs (15 validator-applicable)**, recovering all nine blocks modes, `instances/tied`, and every `tolerated` cross-provider pair — including `instances/codex_empty`, the pair `combined_empty` actually drives.

Coverage can no longer narrow silently: a validator-less branch must be declared with its reason (`blocks` → ISS-002/ISS-023), and a new branch fails with an actionable message. The dump is prevented from becoming a fifth description by running all 24 pairs for real.

**Mutation A is the proof the fix works:** adding a mode to fake_ccusage's INST table that emits an invalid payload produced a new failing test case *with no second file edited*. Before this change that mode was invisible.

## What is next

1. **T-007 needs a supervised turn** — six owner questions (LICENSE copyright holder, `repository` field, the ISS-013 Windows decision, publish identity, the `latest` dist-tag move, the usage.py:199 exemption) and an explicit in-session go-ahead before any `npm publish`. Two of its five pre-publish gates are now closed: ISS-005 is scrubbed with the contract grep extended, and the tracker/code reconciliation is done. The README rewrite for npm remains.
2. **ISS-013 is the only high-severity issue open** and is a T-007 blocker awaiting an owner call (fix Windows `~` expansion, caveat the README, or drop the Windows row).
3. **v0.2 openers when ready:** `/story auto T-008 T-009` — both unblocked day-1 release gates.

## Open issues after this session (4)

- **ISS-013** (high) — Windows `~` expansion; owner decision, T-007 blocker.
- **ISS-018 / ISS-019** (medium) — the Python-free CI pair, design preserved in the T-005 session plan §5.1/5.2.
- **ISS-020** (low) — ALLOWLIST IDs asserted by non-case tests have no execution evidence. Worth noting this sweep touched adjacent ground: entries 7 and 9 now carry differential tests, which is the shape ISS-020 is asking for generally.
- **ISS-023** (low, filed last session) — `CCUSAGE_CMD` bypasses the pinned binary; owner decision.

## Standing constraints (unchanged, re-verified)

- `usage.py` is the frozen oracle — untouched this session; `tests/fake_ccusage.py` is a fixture, not the oracle, and `--dump-vocabulary` is an exact-argv match so no existing invocation changed.
- `package.json` carries no `author`/`contributors`/`maintainers`; name is `spendbar`.
- **T-007's `npm publish` is never autonomous.**
- Nothing shipping may carry a real identifier — enforced at the tarball boundary by content scan.

## Working tree

Untracked files predating the sweep were left alone: `.claude/`, the handovers, `git-activity-review-2026-07-01-to-2026-07-15.md`, `westworld-investigation-2026-07-15.md`. The ~37 modified `.story/` ledger files from the earlier enrichment session remain uncommitted; every commit in this sweep staged only its own files.
