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

### Input-validity scope (added 2026-07-31, T-003 plan review rounds 1–2)

Byte parity is contracted over **valid ccusage output**, defined below. Inputs outside it are
rejected fail-loud (non-zero exit, message on stderr) where Python would silently mis-aggregate
or crash. This scoping exists because the TS runtime has semantics Python does not:

6. **Canonical-integer object keys are invalid input.** A key matching `/^(0|[1-9]\d*)$/` in
   `projects` or `models` is rejected. `JSON.parse` reorders such keys (JS integer-key
   ordering) while Python preserves textual order, which would change float summation order
   undetectably. Unreachable from real ccusage output — encoded paths always begin `-`
   (absolute paths start with `/`), model names always contain letters.
7. **Integers outside the safe range are invalid input.** Any integral field failing
   `Number.isSafeInteger` is rejected. Python ints are arbitrary precision; `JSON.parse` is
   binary64 and would round silently above 2^53 (~9.0e15). Real token counts are ~1e10.
   Validation happens during parse/normalize and covers **both** providers:
   Claude `totalTokens`, `inputTokens`, `outputTokens`, `cacheCreationTokens`,
   `cacheReadTokens`; Codex `totalTokens` and per-model `totalTokens`. (Claude's token fields
   never pass through `cnum`, so a cnum-only guard would miss them.)
8. **Resource bounds on subprocess and file reads.** ccusage subprocess timeout + stdout/stderr
   byte caps, and a per-line + total byte cap on the Codex rollout head scan (a single JSONL
   line is otherwise unbounded and can exhaust memory before the 5-line limit applies). These
   fire only where Python would hang or OOM; an over-cap rollout file returns unresolved, which
   is the same bucket Python reaches for unparseable files.
9. **`repr()` of an integral JSON float, inside diagnostics only.** Python's `json.loads`
   keeps the int/float distinction from the source token, so `-1.0` reprs as `-1.0`;
   `JSON.parse` yields the number `-1`, and JS cannot recover the token after parsing, so
   it reprs as `-1`. Reachable **only** where a diagnostic embeds `f"{v!r}"` for a value
   that has *already failed* validation (`cnum`'s negative/non-finite branch), so it never
   affects a computed figure or a success-path byte. Everything else about float repr IS
   frozen and implemented: shortest round-trip digits, the scientific-notation threshold
   (`exp < -4 or exp >= 16`, not JS's `-6`/`21`), and two-digit exponents (`1e-07`).
   Non-integral floats, `nan`/`inf`/`-inf`, `True`/`False`/`None`, and string repr are all
   byte-exact and differentially tested against CPython.

### Uncatchable-Python-crash scope (added 2026-07-31, T-003 code review round 2)

Three inputs make usage.py raise an **uncaught** exception (traceback on stderr, exit 1).
The port exits 1 on stderr too, but with a clean one-line message instead of a traceback.
Exit code and stream are frozen; the message text is not.

10. **`CODEX_HOME=~user` for another account.** Python's `expanduser` consults passwd; Node
    exposes no such lookup. Leaving the value unexpanded is *not* a safe fallback — it stays
    a **relative** path, so `./~root/.codex/sessions` under the process cwd would become the
    trusted session root, which is the same hole as the unexpanded bare `~`. Only the current
    user's own name (`$USER`) is expanded; any other `~user` is refused.
11. **Unicode digits in `-Nd` that `int()` rejects.** Python gates on `str.isdigit()`, which
    is a strict superset of what `int()` accepts — `"-²d"` passes the gate and then raises
    ValueError inside `int()`. The port gates on the decimal-digit set (exactly `int()`'s
    domain), so it refuses cleanly. **The digit cases themselves are byte-frozen, not
    sanctioned**:
    `-٣d`, `-１０d`, `-०३d` all resolve identically to Python, verified against CPython's
    `int()` for every Nd code point. A date outside `datetime.date`'s year 1..9999 (e.g.
    `-1000000d`) raises OverflowError in Python and is refused here.

    Note this is **not** a Unicode-version delta. V8 ships a newer Unicode database than
    CPython (measured: 760 Nd code points vs CPython 3.11.6's 660), so JS's native `\p{Nd}`
    and `\p{C}` would diverge on the 100 code points assigned in only one of them. Both the
    digit set and `str.isprintable()` are therefore pinned to the reference interpreter in
    the generated `src/unicode-tables.ts`; a test re-runs the generator and fails if the
    committed table has drifted.
12. **A rollout log that is not valid UTF-8.** Python's text mode raises UnicodeDecodeError,
    a `ValueError` — so `codex_cwd`'s `except OSError` does **not** catch it and the process
    dies. The port decodes strictly (`TextDecoder{fatal}`) and raises. Note this is a
    deliberate refusal to be *more* lenient: `Buffer.toString("utf8")` would substitute
    U+FFFD and hand back a corrupted-but-trusted cwd. A leading BOM is likewise preserved,
    not stripped, so a BOM-prefixed line fails to parse in both languages.

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
