# Handover — spendbar productization: plan approved, npm name claimed

**Session window:** 2026-07-28 → 2026-07-31 (single long Claude Code session in `~/Developer/claude-usage`)
**State at handover:** Architecture plan externally reviewed and APPROVED; npm name secured; `.story/` initialized this session (no phases/tickets yet). **No product code written — v0.1 kickoff is the next unit of work and awaits an explicit go from the owner.**

## What this project became this session

The repo entered the session as `usage.py` — a 784-line stdlib-only Python CLI wrapping `npx ccusage` for per-project Claude Code + Codex cost tracking. Mid-session the owner pivoted it into a product: **spendbar** — ONE `npm install -g` delivering (1) a TypeScript CLI port, (2) an MCP server (agents can answer "what did I spend this week per project"), (3) a **native macOS menubar item** with live spend text (explicitly NOT a website; a 112 KB prebuilt Swift helper in the tarball, not Electron). Owner's quality bar, stated verbatim: **robust, smooth, performant**.

## The plan (the central artifact)

`product-architecture-2026-07-30.md` in the repo root. Produced by a 9-agent research workflow (7 lenses incl. live empirical tests on the owner's machine — Swift helper compiled+run, Gatekeeper/quarantine tested, ccusage timed at 60–80 s full-scan over 65 GiB with `--since` giving NO speedup), then hardened through **4 rounds of external Codex review** (codex-bridge session `<session id removed — T-024>`, findings 24→16→7→0 majors, verdict **approve**). Continue that session_id into `review_code` when implementation starts.

Architecture headline: one npm package / one bin; headless `spendbar service run` is the SOLE snapshot writer (ships v0.2 with durable install/start/stop); menubar is a *view* on it (v0.3); MCP = `spendbar mcp` subcommand (5 tools in v0.2, `usage_hourly` deferred); readers use ephemeral computation leases; zero npm lifecycle scripts; ccusage pinned exact-version; launcher-shim LaunchAgent (no `env node` — launchd PATH); byte-parity-modulo-published-allowlist port contract with dual-run harness.

**Four prototype gates are RELEASE gates, all day-1 of their phase:** locking primitive, MCP SDK v2-vs-v1 (both v0.2), socket credential check (v0.2), signing/notarization artifact (v0.3 = decision D4).

## Decisions locked

- **D1 name = spendbar** (`usage` is taken on npm by arunoda's usage@0.7.1)
- **D3 menubar headline = user-selectable title modes**, today's-$ default; picker phase-gated ($/burn v0.3, quota v0.5)
- **Quality rulings**: monotonicity is an anomaly *signal* not an invariant; deterministic CI checks hard-gate, wall-clock benchmarks baseline-compare only; stale-but-honest over wrong-and-confident
- **Onboarding**: bare `spendbar` IS the first-run wizard ("install it, run it"); zero postinstall by design
- **Positioning (recommended, not contested)**: narrow/deep — per-project COMBINED Claude+Codex spend; do NOT chase CodeBurn (9k-star near-superset that uses the same rollout-log cwd attribution) on provider count

## npm state (externally visible — handle with care)

- **`spendbar@0.0.2` is LIVE**, published from the owner's `<owner-npm-account>` account. **Owner explicitly wants NO personal-name attribution**: 0.0.1 (which carried an author field) was unpublished; 0.0.2 has no author. **Future publishes must omit `author`.**
- storybloq npm org (owner is org owner) has team read-write on `spendbar` → listed under the org. `@storybloq/spendbar` left unclaimed deliberately.
- Residue: maintainers sidebar still shows `<owner-npm-account>`; fix requires a brand account (e.g. `storybloq-bot`) + `npm owner add`/`rm` — owner must create the account.

## Open items, in order

1. **v0.1 kickoff** (owner has NOT yet said go): IEEE-754 rounding spike + golden capture from the Python CLI first, then the TS port. Work on a branch; `main` holds the Python original with its exact-stdout regression suite (`tests/test_usage.py` + `fake_ccusage.py`) — that suite is the parity oracle, do not break it.
2. **D4** — Developer ID ($99/yr) at the v0.3 go/no-go; owner understands it, cost confirm pending.
3. Optional: `storybloq-bot` npm account (attribution); `@spendbar`/`@storybloq` scope choices; populate this `.story/` roadmap with phases v0.1–v0.5 from the plan doc.

## Gotchas the next session must not rediscover

- **`Intl.NumberFormat roundingMode:'halfEven'` does NOT reproduce Python money formatting** (ICU rounds shortest-repr: 2.675→2.68 vs Python 2.67); `toFixed` breaks on exact midpoints (0.125). Plan mandates exact IEEE-754-bits classification + targeted boundary corpora + differential fuzz vs Python.
- ccusage `codex session` `directory` field is the DATE dir, not the cwd — our rollout-log parsing is irreplaceable.
- Owner context: also runs `codex-claude-bridge` (the review MCP used here), `storybloq` (this tracker), and heavy multi-project usage (~$73k July) — this tool's own dogfooding data.

Related persistent memory: `claude-usage-productization.md` in the Claude memory dir mirrors the durable facts above.