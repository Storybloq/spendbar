# usage — per-project Claude Code / Codex cost tracking

A small CLI that wraps [`ccusage`](https://github.com/ryoppippi/ccusage) and reports your Claude
Code (and Codex) token spend **grouped by project**, broken down by model family, with day-over-day
and burst views. It reads your local `~/.claude/projects` usage logs via ccusage — your usage data
and logs are processed locally and never uploaded. (The tool itself opens no network connections;
note that `npx` fetches the ccusage package from the npm registry on each run, and ccusage may fetch
public model-pricing data to compute costs. Set `CCUSAGE_CMD='ccusage'` with a global install to
avoid the per-run npm fetch.)

```
usage projects [--since D] [--until D] [--metric tokens|cost|both]
                                         Per-project × model. tokens (default) shows per-model
                                         token counts + Fable$; cost shows per-model $; both stacks them.
usage daily    [--since D] [--until D] [--metric cost|tokens|both]
                                         Per-day by model family (INCLUDES Codex/GPT). cost (default)
                                         shows per-model $; tokens shows per-model token counts; both stacks them.
usage share    [--since D] [--vs D]      % of spend per project; --vs = compare two windows
usage compare  --day1 D --day2 D         Two calendar days, per project, side by side
usage blocks   [--since D]               ccusage billing blocks + $/hour burn rate
usage hourly   [--date D]                Half-hour cost histogram (burst finder; est ±10-15%)
usage alltime                            Every project's cost to date + first/last active
usage codex    [--since D] [--until D]   Per-project Codex spend. Joins ccusage's per-session
                                         costs to each session's start cwd (read from the Codex
                                         rollout logs), so Codex gets the same project names.
                                         Windows by each session's START date + prints a Δ
                                         cross-check against `ccusage codex daily`.
usage combined [--since D] [--until D]   Claude + Codex per project in ONE table
                                         (Project | Claude$ | Codex$ | Total$ | Share).
```

Dates accept `YYYYMMDD`, `YYYY-MM-DD`, or relative `-3d` / `-30d` (trailing window from today).

## Requirements

- **`python3`** (3.8+, standard library only — no pip installs).
- **`node` + `npx`** — the CLI shells out to `npx --yes ccusage@latest`. (Override the command with
  the `CCUSAGE_CMD` env var if you have ccusage installed globally, e.g. `CCUSAGE_CMD="ccusage"`.)

## Install

```sh
# 1. clone the repo
git clone https://github.com/<your-username>/claude-usage.git
cd claude-usage
# 2. put it on your PATH (pick a dir already on $PATH):
chmod +x usage.py
ln -s "$(pwd)/usage.py" ~/.local/bin/usage
# 3. sanity check
usage alltime
```

## Configure your project names (optional)

Out of the box, projects display as their folder name (`myapp`) for repos under a workspace root,
or `~/some/path` otherwise. To rename or group projects:

```sh
cp usage-config.example.json usage-config.json   # then edit
```

- **`workspace_roots`** — directory names directly under your home where you keep repos. With
  `"Developer"` listed, `~/Developer/myapp` shows as `myapp`. Add yours (`code`, `src`, `projects`…).
- **`renames`** — map a bare project name to a nicer label; point several at the same label to group
  them (e.g. `frontend` + `backend` → `My Product`).

The config lives next to `usage.py` by default; override the location with `USAGE_CONFIG=/path/to.json`.

## Good to know (accuracy)

- **`projects` / `share` / `alltime` are Claude-Code-only.** ccusage can't tag Codex/GPT sessions by
  project, so they're excluded from these views and *undercount* total spend. Use **`usage daily`**
  or **`usage blocks`** for Codex-inclusive totals — that's why `daily`'s grand total is larger —
  **`usage codex`** for the per-project Codex breakdown, and **`usage combined`** for Claude + Codex
  merged per project in one table.
- **`codex` attributes by session-origin cwd and windows by session START date.** Each Codex session
  is attributed to the directory it *started* in (`$CODEX_HOME`, default `~/.codex`; archived sessions
  included), and `--since`/`--until` filter on the session's **start** date (from the rollout
  filename). This avoids ccusage's last-activity bleed, where a long-lived session resumed inside the
  window would otherwise drag its entire lifetime cost in. Because that start-date basis differs from
  `ccusage codex daily` (which buckets by calendar day), each windowed run prints a
  `[session-start $X vs codex daily $Y (Δ $Z)]` cross-check — a small Δ means they broadly agree; the
  residual comes from multi-day sessions (lumped on their start day) and sessions that cross the
  window edge. Sessions whose filename can't be parsed for a start date are excluded from a window
  (and the excluded amount is noted). There's also a `cwd resolved: N/M` coverage line; unresolvable
  sessions land in an `unknown` bucket (cost is conserved, never dropped), and Claude Code agent
  scratchpads (`/tmp/claude-<uid>/…`) collapse into `(agent scratchpads)`. Still don't compare `codex`
  totals 1:1 with `daily`'s Gpt$ column — the two bucket dates differently.
- **`[totals reconcile: OK]`** means the per-project sum equals ccusage's own grand total (cost is
  conserved). It does *not* independently prove each per-project number — it's a conservation check.
- **`hourly`** estimates from raw logs with a flat blended $/token rate, so it's labeled ±10–15%;
  it's for finding *when* spikes happened, not exact per-hour dollars.
- Data only goes back as far as your local `~/.claude/projects` logs exist.

## Tests

```sh
python3 tests/test_usage.py
```

Runs the real CLI against a fixture ccusage and asserts actual output. Machine-independent — the
fixture builds project keys from the running machine's home dir.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Built on top of [`ccusage`](https://github.com/ryoppippi/ccusage) by ryoppippi (open-source, MIT at
time of writing), which this tool invokes at runtime via `npx` — ccusage's source is not bundled or
modified here. This project is an independent wrapper, not affiliated with or endorsed by ccusage,
Anthropic, or OpenAI. "Claude", "Claude Code", "Codex", and related product names are trademarks of
their respective owners.
