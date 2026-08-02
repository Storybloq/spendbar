# spendbar 0.1.0 published; repo public at Storybloq/spendbar — v0.1 phase COMPLETE

Supervised release turn, owner-authorized ("yes to publish", public repo greenlit, no-Claude-co-author constraint). Executed after the T-009 auto session went quiet — and partially INTERLEAVED with it (see "session collision" below).

## What shipped

- **npm: `spendbar@0.1.0` is live** on the `latest` tag from the `ashayegh` account (no OTP challenge). Tarball: 27 files, 79.4 kB, shasum `53a34bfd336558642affc10fb40a5c5b8e24a916` — byte-identical to the pre-publish audit. Manifest carries no author/contributors/maintainers; deps exactly `ccusage@20.0.19`. Registry-install smoke test passed (`spendbar --help` from a clean prefix).
- **GitHub: `https://github.com/Storybloq/spendbar` is PUBLIC** — `main` (default) + `v0.1-ts-port` + annotated tag `v0.1.0` at the release commit. T-024's privacy CI workflow rides along and now audits every pushed commit.
- **T-007 complete → the v0.1 phase is COMPLETE** (all 8 leaves).

## Release-gate decisions made this turn

- **ISS-024** (frozen diagnostic recommends npx): shipped 0.1.0 under the issue's own option 2, recorded on the issue — the T-023 README note already resolves the page/binary contradiction; the clean fix (reword + ALLOWLIST entry + policy, through review) is rescoped to 0.1.1. No longer gates T-007.
- **repository/homepage/bugs** now point at Storybloq/spendbar (commit `c8f7f51`, ships with 0.1.1 — 0.1.0's manifest predates it).

## Two incidents, both handled

**1. The old personal repo was PUBLIC.** `AmirShayegh/claude-usage` (one commit, pushed 2026-07-07) publicly carried a `Co-Authored-By trailer naming the assistant model (email-class value removed)` trailer AND the real rollout ID in usage.py — both standing-constraint violations, exposed for ~4 weeks. **Made private immediately** (reversible protective action). Whether to delete it outright is the owner's call. Local remote renamed `origin` → `legacy`.

**2. Claude trailers existed after all.** 14 commits carried `Claude-Session:` and the 2 root commits carried `Co-Authored-By trailer naming the assistant model (email-class value removed)` — an earlier audit had greped the wrong patterns and missed them. **History rewritten** (`filter-branch --msg-filter`, all 44 commits, message-only — trees verified byte-identical), `refs/original` backups deleted, push set verified zero Claude/anthropic trailers. Prevention: repo `.claude/settings.json` sets `includeCoAuthoredBy: false` — verified working on every subsequent commit, including the auto session's own post-resume commit.

## Session collision, resolved

The T-009 auto session self-resumed from its usage-limit stop MID-RELEASE: it re-did the chunk-7 work I had stashed, committed it as `5d17c17`, completed T-024, and ended again. Consequences handled: the first v0.1.0 tag landed on its commit and was **moved to the true release commit `4957fbf`**; the published tarball was unaffected (audited post-pack, and the session touched only spikes/ + .story/). The old stash (`stash@{1}`, "chunk 7 mid-flight") is now superseded by commit 5d17c17 and can be dropped. `.story/servers/` (machine-local runtime state) is now gitignored. Ledger writes the session left uncommitted were committed via `scripts/guarded-commit.mjs` — T-009.json deliberately excluded (live claim block, tool-owned).

## THE ONE OPEN OWNER DECISION — decide soon, it gets more expensive daily

Per T-024's closing note, the scrubbed personal values (claim email — same address as the public commit-author email — home paths, session UUIDs) **remain in historical blobs** of commits like `1cc1ff9`/`8f9d799`/`304da06`, and that history is now public. Rewriting it out is ~free TODAY (repo is minutes old, zero cloners: filter-repo + force-push) and progressively breaks clones later. T-024 explicitly reserved this as an owner decision, so it was NOT done unilaterally. Recommend: decide within days, not weeks.

## What's next

1. **T-009 finish** — still `inprogress` with a live claim; chunk 7 is committed; the session ended at its usage limit again. Resume with `/story auto T-009` (or wait for the limit-stop auto-resume if still armed).
2. **v0.2 re-spec + issue triage session** — 17 open issues, chiefly: T-010–T-015 descriptions still specify the lockfile design T-008 rejected (ISS-030/033, dup pair), the impossible T-010 recovery criterion (ISS-040), the stale-socket TOCTOU (ISS-041), plus ISS-024 rescoped to 0.1.1.
3. Then T-010 → T-013 build the service tier; v0.3 puts the number in the menubar.

## Standing constraints (all held this turn)

usage.py untouched (frozen oracle). No author field in the published manifest (verified in the live tarball). No Claude co-authorship in the public history (verified on the push set). Publish executed ONLY on explicit owner authorization, in a supervised turn. Privacy scan green (audit mode, 349 files) at push time.