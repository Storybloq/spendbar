# tests/oracle — deterministic fixture artifacts

A committed, byte-exact recording of everything the Python oracle asks its ccusage fixture for,
plus the filesystem tree that fixture runs against. The point is to let a Python-free CI (and
the published package's CI) replay the oracle's world without Python or a real ccusage — see
ISS-018, and ISS-019 for the TypeScript replayer that consumes this.

## The direction of trust

The important thing about this directory is which file is allowed to be right.

```
usage.py  ──hand-read──▶  inventory.json   (DECLARED: what should happen)
    │                          │
    │                          ▼
    │                     build.py --check ──▶ disagreement is the finding
    │                          ▲
    ▼                          │
record.py + trace.py ─────▶ traces.json    (OBSERVED: what did happen)
```

`traces.json` is instrumentation, and instrumentation cannot audit itself: it only ever records
the calls the run it watched happened to make. If `usage.py` silently stopped calling ccusage
for `daily`, the trace would faithfully record zero calls, and every artifact test downstream
would keep passing against a smaller, wrong world.

So `inventory.json` is **authored by hand from the oracle source**, with a line citation per
entry, and `build.py --check` compares the two. When they disagree, the inventory is the side to
trust — unless reading `usage.py` shows the inventory itself is wrong, which is exactly what
happened to the `hourly` entry (it was declared as making no ccusage calls; usage.py:604 says
otherwise, and the comment there records why the wrong reading was tempting).

## Files

| File | Role |
|---|---|
| `inventory.json` | **Authored.** The five argv shapes, which commands issue which, and why. Hand-read from `usage.py` with line citations. |
| `trace.py` | Recording stand-in for `fake_ccusage.py`: logs one JSON line per child call, then `execv`s the real fixture so it stays invisible. |
| `record.py` | Runs all 118 registry cases with `trace.py` in place. Emits `traces.json`. |
| `build.py` | Checks observed against declared, then generates `responses/`. Also `--regen-check`. |
| `verify.py` | **Independent.** Imports nothing from the above; re-derives every claim from `fake_ccusage.py` and `fixtures.py` directly. |
| `mutation_check.py` | Damages the artifacts 27 ways and requires each check to report that specific damage. |
| `responses/` | Generated. 54 responses + `index.json` + `tree.json`. Committed. |

## Generated artifacts

`responses/index.json` holds one record per distinct `(mode, argv)` key, with **separate**
`stdoutSha256` and `stderrSha256` — a single digest over the concatenation would collide,
since `("ab", "c")` and `("a", "bc")` hash identically — and a `{kind, status}` termination
object so a signal death cannot be recorded as a clean exit.

`responses/tree.json` describes the fixture filesystem. Three things in it are load-bearing:

- **mtimes.** `usage.py:620` skips an hourly transcript whose mtime predates the target day
  *without opening it*, and `fixtures.py` backdates one file on purpose to exercise that.
- **the symlink.** One codex session points outside `CODEX_HOME`, to exercise the realpath
  containment check. Serializing it as an ordinary file would silently delete that case.
- **`substituteHome`.** Files flagged with it contain the literal `/fixture/home`; a replayer
  must rewrite that to wherever it actually materialized the tree, or every codex project lands
  in the `unknown` bucket.

Everything is generated under `HOME=/fixture/home`. That is a **privacy gate** as much as a
determinism one: these files are committed and this repo is going public, and `fake_ccusage.py`
derives its project keys from the ambient home, so a generator that forgot to force it would
commit the maintainer's real home path. `verify.py` re-checks the bytes on disk rather than
trusting the generator's own assertion.

## Running it

```sh
npm run test:oracle              # verify.py, --regen-check, mutation_check.py
python3 tests/oracle/record.py   # re-record traces (needed if cases.json changes)
python3 tests/oracle/build.py    # regenerate responses/
```

`--regen-check` exists separately from `verify.py` because correctness and determinism come
apart: a generator that stamped the clock or iterated a set would still emit artifacts
`verify.py` accepts, while producing a different diff every run.

## Known gaps

Three window-arg branches are declared in `inventory.json` but exercised by no registry case,
listed by name under `unexercised` and tracked as **ISS-029**: `blocks --since`, `daily --until`,
`codex --until`. `build.py --check` fails if an entry there becomes stale, so adding the missing
cases forces the entry's removal rather than leaving it to rot.

The artifact set is **anchor-relative**: `--since -3d` resolves against the wall clock, so cases
are recorded at their own `captureAnchor` where they have one and at `defaultAnchor` otherwise.
A replayer driven at a live anchor will miss. See `$anchorComment` in `inventory.json`.
