# spendbar — per-project Claude Code / Codex cost tracking

A small CLI over [`ccusage`](https://github.com/ryoppippi/ccusage) that reports your Claude Code
(and Codex) token spend **grouped by project**, broken down by model family, with day-over-day
and burst views.

Most numbers come from ccusage, which spendbar runs as a subprocess. Two commands also read
your logs directly: `hourly` scans `~/.claude/projects/*/*.jsonl` itself, and `codex` reads
your `~/.codex` rollout logs to find which directory each session started in. Everything is
processed locally and never uploaded, and spendbar itself opens no network connections.
(ccusage may fetch public model-pricing data to compute costs.)

```sh
npm install -g spendbar
spendbar alltime
```

Requires **Node 22.12+**. Nothing else — no Python, no other runtime.

## Commands

```
spendbar projects [--since D] [--until D]   Per-project × model table (+ Fable cost)
spendbar daily    [--since D] [--until D]   Per-day cost, split by model family
spendbar share    [--since D] [--vs D]      % of spend per project; --vs adds a 2nd window
spendbar compare  --day1 D --day2 D         Two calendar days, per project, side by side
spendbar blocks   [--since D]               Billing blocks + $/hour burn rate
spendbar hourly   [--date D]                Half-hour cost histogram from raw logs (burst finder)
spendbar alltime                            Every project's cost to date + first/last active
spendbar codex    [--since D] [--until D]   Per-project Codex spend (from Codex session logs)
spendbar combined [--since D] [--until D]   Claude + Codex per project in one table (Total$)
```

`projects` and `daily` accept `--metric` (`tokens`/`cost`/`both`; `projects` defaults to
`tokens`, `daily` to `cost`).

Window options — `--since`, `--until`, `--vs`, `--day1`, `--day2` — accept `YYYYMMDD`,
`YYYY-MM-DD`, or a relative `-3d` / `-30d` (a trailing window from today). `hourly --date`
names a single calendar day and takes `YYYYMMDD` or `YYYY-MM-DD` only.

## Platform support in 0.1.0

This table is about what has actually been **run**, which is not the same question as which
platforms ccusage publishes a binary for (that's the separate table further down).

| Platform | 0.1.0 status |
|---|---|
| macOS arm64 | **Verified** — where spendbar is developed, and where its parity suite and package-manager install matrix are executed |
| macOS x64 | **Unverified** — expected to work; not executed |
| Linux (x64, arm64) | **Unverified** — expected to work, same POSIX path semantics; not executed |
| Windows (x64, arm64) | **Experimental** — not executed, *and* one known divergence (below) |

**Windows caveat.** spendbar expands `~` with POSIX semantics on every platform, which is not
what Python's `ntpath.expanduser` does. On Windows that means `HOME` is consulted first, so if
`HOME` is set to anything other than `USERPROFILE`, spendbar resolves a *different*
`CODEX_HOME` **and** a different project-key prefix than you would expect. Backslash forms
(`CODEX_HOME=~\.codex`) are not expanded at all, and `~user` is expanded only when *user* is
the account you are running as — Python resolves any user's home there.

To avoid it, make sure `HOME` either equals `USERPROFILE` or is unset, and give `CODEX_HOME` an
absolute path. Setting `CODEX_HOME` alone is *not* enough — project-key normalization is
derived from `HOME` separately, so a mismatched `HOME` still misattributes projects.

Proper Windows path semantics are deferred to the Windows milestone, where they can be built
and verified against a real Windows reference rather than guessed at.

## ccusage

spendbar depends on [`ccusage`](https://www.npmjs.com/package/ccusage), pinned to an **exact**
version and installed as a regular dependency. It is never fetched at run time: there is no
`npx` fallback, because downloading and executing registry code at the moment your local
install is broken is exactly when you least want it. If the dependency cannot be resolved,
spendbar says so and stops.

ccusage ships a small JS shim plus a per-platform native binary delivered through **optional**
dependencies, so `npm install --omit=optional` produces a working shim with no binary. spendbar
detects that up front and reports it as an install problem, rather than letting it surface as
an opaque subprocess error later.

Platform availability is therefore also bounded by ccusage's own binaries:

| | x64 | arm64 |
|---|---|---|
| macOS | ✅ | ✅ |
| Linux | ✅ | ✅ |
| Windows | ✅ | ✅ |

Anything else (linux-armv7, FreeBSD, …) is refused with a message naming what *is* supported.
On those platforms, install ccusage yourself and point `CCUSAGE_CMD` at it. A binary existing
for a platform is not a claim that spendbar has been run there — see the table above.

Install weight: ~450 KB shim + ~3.1 MB platform binary.

`CCUSAGE_CMD` overrides the command entirely (e.g. `CCUSAGE_CMD="ccusage"` for a global
install); when set, the bundled dependency is not required at all.

> **Known wording bug.** If `CCUSAGE_CMD` points at something that cannot be spawned, the error
> says `Install Node.js (node + npx), or set CCUSAGE_CMD…`. That wording is inherited verbatim
> from the Python tool this port must match byte-for-byte. **Installing npx is not the remedy** —
> spendbar has no npx fallback. Fix `CCUSAGE_CMD`, or unset it to use the bundled copy.

## Configure your project names (optional)

Out of the box, projects display as their folder name (`myapp`) for repos under a workspace
root, or `~/some/path` otherwise. To rename or group projects, create
`~/.config/spendbar/config.json`:

```json
{
  "workspace_roots": ["Developer", "code", "projects"],
  "renames": {
    "frontend": "My Product",
    "backend": "My Product",
    "~": "misc"
  }
}
```

- **`workspace_roots`** — directory names directly under your home where you keep repos. With
  `"Developer"` listed, `~/Developer/myapp` shows as `myapp`. Defaults to `["Developer"]`.
- **`renames`** — map a bare project name to a nicer label; point several at the same label to
  group them.

Both keys are optional; with no config file at all, spendbar still works and shows bare project
names. `USAGE_CONFIG=/path/to.json` overrides the location.

## Good to know (accuracy)

- **`projects` / `share` / `alltime` are Claude-Code-only.** ccusage can't tag Codex/GPT
  sessions by project, so they're excluded from these views and *undercount* total spend. Use
  **`spendbar daily`** or **`spendbar blocks`** for Codex-inclusive totals — that's why
  `daily`'s grand total is larger — **`spendbar codex`** for the per-project Codex breakdown,
  and **`spendbar combined`** for Claude + Codex merged per project in one table.
- **`codex` attributes by session-origin cwd and windows by session START date.** Each Codex
  session is attributed to the directory it *started* in (`$CODEX_HOME`, default `~/.codex`;
  archived sessions included), and `--since`/`--until` filter on the session's **start** date
  (from the rollout filename). This avoids ccusage's last-activity bleed, where a long-lived
  session resumed inside the window would otherwise drag its entire lifetime cost in. Because
  that start-date basis differs from `ccusage codex daily` (which buckets by calendar day),
  each windowed run prints a `[session-start $X vs codex daily $Y (Δ $Z)]` cross-check — a
  small Δ means they broadly agree; the residual comes from multi-day sessions (lumped on their
  start day) and sessions that cross the window edge. Sessions whose filename can't be parsed
  for a start date are excluded from a window (and the excluded amount is noted). There's also
  a `cwd resolved: N/M` coverage line; unresolvable sessions land in an `unknown` bucket (cost
  is conserved, never dropped), and Claude Code agent scratchpads (`/tmp/claude-<uid>/…`)
  collapse into `(agent scratchpads)`. Still don't compare `codex` totals 1:1 with `daily`'s
  Gpt$ column — the two bucket dates differently.
- **`[totals reconcile: OK]`** means the per-project sum equals ccusage's own grand total (cost
  is conserved). It does *not* independently prove each per-project number — it's a
  conservation check.
- **`hourly`** estimates from raw logs with a flat blended $/token rate, so it's labeled
  ±10–15%; it's for finding *when* spikes happened, not exact per-hour dollars.
- Data only goes back as far as your local `~/.claude/projects` logs exist.

## About this repository

spendbar began as a single Python script, `usage.py`, which still lives here. It is not shipped
in the npm package and is not something you need to run — it is kept **frozen** as the oracle
the TypeScript port is compared against, byte for byte, by a parity suite and a set of stored
golden outputs. Deliberate divergences from it are numbered and justified in
`tests/golden/ALLOWLIST.md`.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Built on top of [`ccusage`](https://github.com/ryoppippi/ccusage) by ryoppippi (open-source, MIT
at time of writing), which spendbar runs as a subprocess from its own pinned, locally installed
copy — ccusage's source is not bundled or modified here. This project is an independent wrapper,
not affiliated with or endorsed by ccusage, Anthropic, or OpenAI. "Claude", "Claude Code",
"Codex", and related product names are trademarks of their respective owners.
