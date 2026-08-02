# Session handover — backlog triage + ticket enrichment

**Branch:** v0.1-ts-port (unchanged — this session touched only the `.story/` ledger, no code) · **Date:** 2026-07-31

## What this session did

After the T-003/T-004/T-005/T-006 autonomous session closed, the ledger held 21 open issues (with heavy review-round duplication) and 16 open tickets still carrying their original one-paragraph sketches. This session ran a 10-agent workflow — 5 triage agents verifying every issue claim against the actual code, 5 enrichment agents drafting full ticket descriptions from `product-architecture-2026-07-30.md` and the handovers — then applied all 37 ledger updates serially via the storybloq CLI. Every triage verdict was reproduced against the working tree before applying; the unicode differential suite was re-run by hand (17/17).

## Issue triage: 21 → 11 open

**Resolved as duplicates (6):** ISS-003→ISS-001, ISS-004→ISS-002, ISS-009→ISS-006, ISS-010→ISS-007, ISS-011→ISS-008, ISS-014→ISS-013. All six auto-filed records were strict subsets of their hand-filed canonicals — nothing needed merging. ISS-014's high-severity call was carried to ISS-013.

**Resolved as already fixed (3):** ISS-006 (encodePath astral split), ISS-012 (code-point string ordering), ISS-007 (padding width). All three were fixed in commit `be56785` during T-004 — `src/config.ts:20` has the `/gu` flag, `src/pysort.ts` routes every sort site, `src/format.ts:130-153` pads on `pyLen()` — and all three are pinned by CPython differential tests in `tests-ts/unicode-parity.test.mjs`. The tracker had never caught up with the code. Caution for future triage: one agent claimed ISS-007's pinning test was missing because it greped `tests/` instead of `tests-ts/` — the test exists at `unicode-parity.test.mjs:98-124`.

**Resolved wontfix (1):** ISS-017 — the `hourly --date` traceback lives only in `usage.py`, the frozen oracle. The shipped port emits a clean one-line diagnostic on that path, published as ALLOWLIST-19 and enforced by the `ts-diag:invalid-date` policy. If `hourly --date` should someday accept `-Nd`, that is a feature ticket, not this issue.

**Kept open (11), each with re-judged severity, verified `file:line` locations, components, and sharpened impact:**
- **ISS-013 raised to high** — Windows `~` expansion uses POSIX semantics while README.md:58 advertises Windows; both tools exit 0 with different numbers. Needs an owner decision (fix / caveat / drop the claim) before publish.
- **ISS-002 raised to medium** — its own "no TS consumer reads blocks yet" mitigation went stale when `cmd_blocks` shipped; a ccusage rename of `costUSD`/`totalCost` would pass the contract gate and render $0.00 tables at exit 0.
- **ISS-001 lowered to low** — diagnostic-path only, implausible trigger.
- ISS-005 (medium, publish blocker), ISS-015/ISS-016 (medium, mechanical parity fixes with in-repo fix precedents), ISS-008/ISS-020/ISS-021 (low hygiene), ISS-018/ISS-019 (medium, Python-free CI pair, design preserved in the T-005 session plan.md §5.1/5.2).

## New finding (folded into ISS-005)

`src/context.ts:141-142` carries `USER=amirshayegh` and `/Users/testuser/.codex` in a comment that compiles into `dist/context.js:80-81` — which ships in the npm tarball. Sixteen green contract tests missed it because the attribution grep in `tests-ts/contract/packaging.contract.mjs:111-119` reads only `package.json`, never tarball file contents. ISS-005's scope is now BOTH sites (rollout ID at `src/codex.ts:30` + this one), and the fix must extend the contract grep to unpacked tarball contents so the class cannot recur.

## Ticket enrichment: T-007 through T-022

Every open ticket now carries: why it exists (plan-doc + review-round provenance), in/out scope, approach notes, failure modes, numbered acceptance criteria checkable without asking anyone, risks, and open questions explicitly marked as owner decisions rather than guessed. Original ticket content was folded in, not replaced.

Dependency corrections applied: **T-012** gains explicit blocker T-010 (merge contract expressed in T-010's provenance vocabulary), **T-013** gains T-008 (the reader computation lease is a namespace of T-008's locking primitive), **T-022** gains T-020 (both UI sub-items land on T-020's settings surface). Blocked count is now 11.

**T-007 got the heaviest treatment.** Its description now opens with the hard rule — publish never runs without an explicit in-session user go-ahead — and carries five pre-publish gates (ISS-005 scrub + contract-grep extension; tracker/code reconciliation, now done; the ISS-013 Windows decision; README rewrite for npm — it is still the Python tool's README and would become the npm page) and a full publish checklist (script-disabled install matrix across npm/pnpm/yarn/bun, `npm pack` audit, no provenance without CI, post-publish verification, v0.1.0 tag).

## Owner decisions pending (T-007 open questions)

1. LICENSE says "Copyright (c) 2026 Amir Shayegh" and npm always ships LICENSE — does the no-personal-attribution rule extend to the copyright holder?
2. `repository`/`homepage` fields: a personal GitHub URL would embed "shayegh" and fail the contract grep — storybloq-org repo, or omit for 0.1.0?
3. ISS-013: fix Windows `~` expansion, caveat the README, or drop the Windows row?
4. Publish identity: `ashayegh` account (2FA) vs creating the brand account first; provenance deferred (no CI)?
5. Publishing 0.1.0 moves the `latest` dist-tag off 0.0.2 — confirm; and merge v0.1-ts-port to main first, or tag on the branch?
6. usage.py:199 carries the same rollout ID but is the frozen oracle — scrub with explicit exemption, or accept repo-side residue since it never ships?

## What's next

1. **Recommended next auto session:** `/story auto ISS-005 ISS-015 ISS-001 ISS-016 ISS-002 ISS-008 ISS-021` — clears every autonomous-safe pre-publish item. ISS-005 first (privacy). Each parity fix gets a CPython differential test in the unicode-parity style; the 266-case parity harness is the safety net.
2. **Then a short supervised turn for T-007:** owner answers the six questions above, then explicitly authorizes publish.
3. **Then v0.2 openers:** `/story auto T-008 T-009` — both unblocked day-1 release gates (locking primitive + socket credentials; MCP SDK v2-vs-v1 against real clients).

## Standing constraints (unchanged, re-verified this session)

- **T-007's `npm publish` is never autonomous** — irreversible, outward-facing, explicit user go-ahead required.
- `usage.py` is the frozen oracle — never modified (untouched this session; no code changed at all).
- `package.json`: name `spendbar`, no `author`/`contributors`/`maintainers` field, ever (0.0.1 was unpublished over exactly this).
- No real transcript data, session identifiers, or personal paths in fixtures or anything that ships.

## Artifacts

Workflow run `<workflow id removed — T-024>` (10 agents, ~499k tokens, 0 errors); triage verdicts and per-ticket enrichment drafts preserved in the session scratchpad (`triage.json`, `enrich-T-0*.json`, `apply.mjs`). Ledger after apply: 22 tickets (6 complete), 11 open issues, 11 blocked tickets, phases unchanged.