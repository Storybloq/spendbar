# Parity delta allowlist (D5 contract)

The TS port must be **byte-identical** to the stored goldens (stdout, stderr, exit code)
**except** for the deltas below. Anything not listed here that differs is a port bug.
This list is frozen through v0.2; changes to it are versioned, deliberate, and reviewed.

## Sanctioned deltas

1. **Product-name-bearing strings.** `prog="usage"` in usage/error text and the alltime
   hint `see 'usage codex'` become `spendbar`. Goldens are compared after templating the
   product name (`usage` ⇄ `spendbar` in exactly these positions — not a blind global
   replace).
2. **Argument-error framing (exit-2 cases).** Python argparse's usage/error layout
   (`usage: usage [-h] ...`, `invalid choice:` phrasing) is framework-specific. Frozen
   instead: the **exit code (2)**, that the message goes to **stderr**, and that it names
   the offending option/value. Own-error cases (`bad relative date`, `not found`,
   `costUSD`) ARE byte-frozen — those strings come from usage.py itself.
3. **`blocks` booleans.** Python `True`/`False` render as `true`/`false` in the TS port.
4. **argparse prefix abbreviation.** Python accepts `--metr cost`; the TS parser does
   not. No golden depends on abbreviation; new inputs erroring is sanctioned.
5. **Config default path.** `~/.config/spendbar/config.json` replaces next-to-script
   discovery ("next to the script" is inside global node_modules under npm).
   `USAGE_CONFIG` env override behavior is unchanged and remains frozen.

## Explicitly NOT sanctioned (byte-frozen)

- All table layout: column widths, padding, header text, rule lengths.
- All money/token formatting (see spikes/rounding/ — exact IEEE-754 half-even).
- Reconcile/cross-check lines including `(Δ $+0.00)` phrasing and float tolerances.
- Coverage/note lines (`cwd resolved: 7/10`, `unknown: $4.60 (3 sessions)`,
  scratchpad collapse, `could not be date-windowed`, hidden-gpt note).
- Exit codes everywhere; which stream (stdout vs stderr) every line goes to.
- Empty-window messages and their exit-0 behavior.

## Assertion modes

- **Stored-golden mode**: byte-compare vs `goldens/*.json` on the capture machine
  (goldens are HOME-scoped). Cases in `manifest.dualRunOnly` are excluded here.
- **Dual-run mode**: run Python and TS at the same moment in the same env; compare
  everything including relative-date cases. This is the authoritative check and is
  machine-independent.
- TTY variants: not yet captured (all goldens are pipe/non-TTY). Harness-level TODO
  noted in manifest; add before v0.2 exit if any TTY-conditional output is found.
