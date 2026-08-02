# Session handover — pre-publish issue sweep (targeted autonomous, 5 of 7)

**Branch:** v0.1-ts-port · **Range:** 8f9d799..58a0051 (5 commits) · **Session:** 15f591bf
**Completed:** ISS-005, ISS-015, ISS-001, ISS-016, ISS-002 · **Remaining targets:** ISS-008, ISS-021

Ended on context rotation at a clean item boundary, not on a problem. Every commit is green.

## What shipped

| Commit | Issue | What changed |
|---|---|---|
| `98900fb` | ISS-005 | Scrubbed the real rollout ID and username/home path from shipping source; taught the packaging contract to scan tarball CONTENTS |
| `2453eca` | ISS-015 | New `src/pystr.ts`; all three `.trim()` sites moved to Python's whitespace set together |
| `fb02d6f` | ISS-001 | `pySlice` added beside `pyLen`; stderr diagnostic truncates by code point |
| `765accd` | ISS-016 | Codex regexes use CPython's Unicode-Nd `\d`; fixed the UTF-16 slice that widening exposed |
| `58a0051` | ISS-002 | Real-binary contract coverage for `blocks --json`; filed ISS-023 for the residual gap |

**Suite at HEAD:** 327 unit tests (was 314), contract 20/20 (was 16), parity `--final` 266 passed / 0 failed / 0 skipped, 45/45 goldens byte-match, `npm run test:all` exit 0.

## The two findings worth carrying forward

**1. Mutation testing caught a half-fix that 318 green tests missed.** On ISS-015 I moved all three strip sites and the suite passed. Reverting `runner.ts` to `.trim()` then passed all 318 tests too — that site's guard had cases for blank and non-blank stdout but none distinguishing the two whitespace sets, so it was guarding a representation the failure would not take. This is the same defect class T-005's handover documented four instances of. Every fix in this session was mutation-verified afterwards; two others (`pySlice` call site vs helper, and ASCII-`\d` vs `\p{Nd}`) turned out to need two separately load-bearing tests each, where one test alone would have looked sufficient.

**2. Fixing ISS-016 created a new defect, caught before commit.** Widening the codex regexes to Unicode Nd made a latent UTF-16 slice REACHABLE: `usage.py:209/:289` carve date fields out of rollout filenames by position, and the old regex had guaranteed those positions were ASCII. With astral digits admitted, `slice(8, 18)` cut a surrogate pair and produced the window key `"𝟎𝟏𝟐𝟑\ud835"` where CPython produces eight digits — a totals-moving corruption. Found by asking "what else now sees inputs it never saw before?" rather than by any test. `pySlice` was widened to the full `s[start:end]` contract and applied at all four codex sites in the same commit. **The general lesson: a parity fix that widens what an input validator accepts should be followed by an audit of every positional operation downstream of it.**

## Decisions taken, with reasons

- **ISS-005 — left three sites alone deliberately.** `usage.py:199` (frozen oracle), `product-architecture-2026-07-30.md` (does not ship), and LICENSE's `Copyright (c) 2026 Amir Shayegh` (ships, but the MIT holder is T-007 openQuestion 1). The new tarball scan exempts ONLY LICENSE Copyright lines, and that exemption is itself mutation-tested — the name appearing anywhere else in LICENSE still fails.
- **ISS-002 — did NOT add a runtime validator.** The repo had recorded that decision twice (`renderers.ts` cmdBlocks, and `fake_ccusage.py:blocks_malformed`, which exists to freeze the behaviour). Eight `blocks_*` parity cases pin Python's permissiveness, and `usage.py` has no validator, so one here is an unsanctioned divergence from the frozen oracle. Overturning a decision recorded that deliberately is an owner call. The contract gate is sufficient under the exact pin.
- **ISS-016 — verified rather than assumed the carry-forward.** The `--since -Nd` note was already satisfied by `rewriteArgv`/`isNegativeNumber`, which already cite ISS-016. No change needed.

## Filed this session

**ISS-023** (low) — `CCUSAGE_CMD` overrides the bundled pinned binary (verified at `src/main-deps.ts:48`), so a user-supplied ccusage runs a payload the contract gate never saw, and `blocks` is the only payload with no runtime validator to notice. Owner decision, both options costed in the issue; the existing fixtures would likely survive a narrow presence check, so the price is an ALLOWLIST entry plus a golden re-run, not a redesign.

## What is next

1. **Finish the sweep:** `/story auto ISS-008 ISS-021` — the two remaining targets, both low severity and both harness/documentation hygiene rather than shipped behaviour. ISS-021 needs a design call on how the schema-validator tests relate to `cases.json`.
2. **Then T-007**, which still needs a supervised turn: six owner questions (LICENSE holder, repository field, ISS-013 Windows decision, publish identity, dist-tag move, usage.py exemption) and an explicit go-ahead before any `npm publish`. Two of its five pre-publish gates are now closed — ISS-005 is scrubbed AND the contract grep is extended, and the tracker/code reconciliation is done.
3. **ISS-013 remains the one high-severity issue open** and is a T-007 blocker requiring an owner decision.

## Standing constraints (unchanged, re-verified)

- `usage.py` is the frozen oracle — untouched this session.
- `package.json` carries no `author`/`contributors`/`maintainers`, and the name is `spendbar`.
- **T-007's `npm publish` is never autonomous.**
- Nothing shipping may carry a real identifier — now enforced at the tarball boundary by content scan, not just by manifest grep.

## Working tree

Five untracked files predate this session and were left alone: `.claude/`, two handovers, `git-activity-review-2026-07-01-to-2026-07-15.md`, `westworld-investigation-2026-07-15.md`. The ~37 modified `.story/` ledger files from the prior enrichment session are still uncommitted; each commit here staged only its own files.
