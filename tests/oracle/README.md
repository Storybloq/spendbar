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

## The consumer side (Python-free)

`tests-ts/oracle/` replays all of this with no Python at all, which is what `npm run test:pure`
exists to prove.

| File | Role |
|---|---|
| `artifacts.mjs` | Loads the index and tree, materializes the tree, answers `(mode, argv) -> bytes`. |
| `replay.mjs` | The `CCUSAGE_CMD` stand-in. An unrecorded key exits **97**; there is no fallback. |
| `golden.test.mjs` | Replays all 45 stored goldens against the TS CLI with no Python. |
| `materialize.test.mjs` | Damages the materialized tree 9 ways; each must be rejected. |

Two rewrites make the canonical artifacts usable on a real machine, and both are needed:

- **Tree files** flagged `substituteHome` have `/fixture/home` replaced with the materialized
  home.
- **Response payloads** have the *encoded* form rewritten too — the recorded project keys read
  `-fixture-home-Developer-alpha`, and a subject running under a real home derives a different
  `HOME_ENC`, so without this the CLI renders the raw key instead of `alpha`. This was found by
  the golden replay failing on 12 cases, not by inspection.

`test:pure` runs under a PATH stripped to a node-only directory and probes **from inside the
child** that `python3` is `ENOENT` — asking from the parent would answer a question about the
parent. Every test file must be classified exactly once across `PURE`, `NEEDS_PYTHON` and
`NEEDS_TOOLCHAIN`; there is deliberately no default, and any skip or todo is a hard failure,
because a skipped test reports as a pass at the top level.

**Permission bits are deliberately not modelled.** Nothing reads them: `usage.py` opens fixture
files for reading and has no permission-denied branch, and no case exercises one. Recording a
mode would describe the generating machine's umask rather than the fixture. The decision is
self-enforcing — `materialize.test.mjs` fails if any fixture file stops being readable or grows
a setuid/setgid/sticky bit, so a future fixture that *does* rely on a mode reopens the question
instead of silently losing it.

## Running it

```sh
npm run test:oracle              # verify.py, --regen-check, mutation_check.py  (needs Python)
npm run test:pure                # the whole Python-free suite, python3 made unreachable
python3 tests/oracle/record.py   # re-record traces (needed if cases.json changes)
python3 tests/oracle/build.py    # regenerate responses/
```

After changing `cases.json` or `fake_ccusage.py`, run `record.py` then `build.py`, then both
suites: `test:oracle` checks the artifacts against Python, `test:pure` checks that the replay
still reproduces the goldens without it.

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
