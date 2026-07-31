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

### Producer-contract scope (added 2026-07-31, T-006)

13. **Default ccusage command.** Python shells out to `npx --yes ccusage@latest`. The port
    depends on an exactly-pinned `ccusage` and runs the bundled shim via `process.execPath`,
    with **no npx fallback and no run-time fetch**: acquiring and executing registry code at
    the moment the trusted install is broken is a supply-chain hazard, and pinning a version
    does not fix it. `CCUSAGE_CMD` behaviour is unchanged for every **non-empty** value and
    remains byte-frozen — every stored golden sets it explicitly, so none depends on the
    default. One narrow exception: an **explicitly empty** `CCUSAGE_CMD=""`. In Python that
    is a set-but-degenerate command — `"".split() == []`, so `cmd = [] + args == args` and
    `cmd[0]` becomes the bare **subcommand** (`claude`, `codex`, `daily`, `blocks`). Python
    then execs *that*: usually `FileNotFoundError`, caught by `usage.py:115` and reported as
    the ordinary `'claude' not found. Install Node.js…` message — but if a real program of
    that name happens to be on `PATH` (`claude` very plausibly is, for this tool's audience)
    Python would silently run it with ccusage's arguments. The port refuses `""` up front
    with the no-command error instead. It is treated as *set*, not unset: treating it as
    unset would silently substitute the bundled binary, a different program again.
14. **Schema violations fail loud.** Two different Python behaviours are being matched here,
    and they are not the same delta — measured, not assumed:

    - Most consumed fields are **indexed directly** in Python (`day["totalTokens"]`,
      `day["date"]`, `mb["modelName"]` — `usage.py:184-191`, `479-484`, `560-565`,
      `608-612`; and `r["period"]` at `486`/`489`, inside the f-strings rather than the loop
      body above it), so a **rename raises `KeyError`**: an **uncaught traceback**,
      exit 1, stderr. The port emits a clean one-line message instead. Exit code and stream
      are frozen; the text is not — the same shape as entries 10-12.

      Wrong *types* are **not** uniformly fatal in Python, and an earlier revision of this
      entry claimed they were (code review R5). It is value-dependent: `model_family` is
      `(name or "").lower()` (`usage.py:91`), so a `modelName` of `None`, `False`, `0` or
      `""` is classified as `other` with no error, while `42` raises `AttributeError`.
      Likewise `day["date"]` is fatal on the `--instances` path (`min`/`max` against a str at
      `usage.py:186-187`) but merely becomes an odd dict key elsewhere. The port rejects
      every non-string here, which is a superset of what Python refuses; that is sanctioned
      under this entry, and is why the guard is **type-only** — see the empty-string note
      below.
    - On the **Claude** paths, only `projects`, `daily` and `totals.totalCost` genuinely
      default in Python (`.get(…, {})` / `.get(…, [])` / `.get("totalCost", 0)`), so only
      those silently aggregate as zero there.

      The **Codex** paths default in four more places, and an earlier revision of this entry
      stated the sentence above globally — which contradicted its own later prose about
      presence guards (code review R7). Measured: per-model `totalTokens` is
      `m.get("totalTokens", 0)` (`usage.py:253`), the codex-daily totals are
      `totals.get("costUSD", 0.0)` / `totals.get("totalTokens", 0)` (`usage.py:270-271`), and
      the codex-daily collection is `d.get("daily", [])` (`usage.py:272`). Those four are
      precisely the ones the port must guard for PRESENCE — they are the whole reason
      `pyGet` exists and the reason `validateCodexDaily` keeps a root guard where
      `validateCodexSessions` does not.

    The **silent-zero this entry exists to prevent is the PORT's**: `num()`
    (`aggregate.ts:61`) coerces anything non-numeric to 0, which would turn a producer
    rename into a clean-looking table with wrong totals where Python at least crashed. The
    port therefore requires every consumed field and exits non-zero.

    **Required, but may be empty.** `daily` and `sessions` (always emitted), plus
    `modelBreakdowns` on every Claude row and `models` on every Codex SESSION (daily rows are
    unconsumed -- see below). An empty `[]`/`{}`
    is valid — that is the unclassified-token bucket — but an **absent** one is not:
    `aggregate.ts:116` falls back to `[]` and `codex.ts:162` falls back to "unclassified", so
    absence would zero the per-model columns without any error, which is the exact bug this
    entry exists to prevent. Measured against both producers before requiring: the pinned
    binary emits `modelBreakdowns` even without `--breakdown`, and `models` on every codex
    session and daily row; `tests/fake_ccusage.py` does the same in every mode. There is
    still deliberately **no** "non-zero tokens implies a model breakdown" rule.

    **Scope limit — this entry covers only what the port would otherwise accept SILENTLY.**
    Fields consumed through `cnum` (all Codex costs and token counts) already fail loud on
    absence *and* on wrong types, and that message is byte-frozen under entry 2. Validation
    deliberately does **not** re-check them: it runs before `codex.ts` does, so a duplicate
    check would replace the frozen wording and break golden `codex_bad_cost`. The only part
    `cnum` cannot express is the safe-integer bound of entry 7, which is applied everywhere.

    **Required outright** (all Claude-side): the numeric fields `totalCost`, `totalTokens`,
    breakdown `cost` and the four counters (`inputTokens`, `outputTokens`,
    `cacheCreationTokens`, `cacheReadTokens`), plus `totals.totalCost` — all reached via
    `num()`, which silently yields 0. Also the *string* fields `date`/`period` and
    `modelName`, which are not `num()` at all but a `typeof === "string" ? … : ""` fallback:
    a rename there silently collapses every row into one blank date key or one blank model
    family, which is the same class of quietly-wrong table.

    Those three are checked for **type only — an EMPTY string is valid** (code review R5).
    Refusing `""` would exit 1 where Python exits 0: `model_family("")` returns `other`
    without raising, and an empty `date`/`period` is simply a blank key. It is a value the
    producer can legitimately emit (an unnamed or unresolved model), and it is neither
    missing nor mistyped, so it was never evidence of the drift the guard looks for — a
    renamed key still reads back `undefined` and still fails.

    Plus, on the Codex side only, the two things reached via a default or skipped outright:
    `codex daily` `totals.costUSD`/`totals.totalTokens` and per-model `totalTokens` —
    **presence only**, since their type is `cnum`'s and its wording is frozen. Note presence
    means *the key exists*: a present-but-`null` value is NOT absence, and is deliberately
    forwarded to `cnum` (`pyGet` in `codex.ts`) so it produces Python's frozen message rather
    than being defaulted to 0.

    **Deliberately NOT required**, because unconsumed — requiring a field nothing reads turns
    a still-working payload into a hard failure, which is worse than the bug being fixed:
    `totals.totalTokens` on the **Claude** paths (`aggregate.ts:128` returns only
    `num(totals.totalCost)`; `usage.py:184`/`484` sum tokens from rows — note the **Codex**
    totals *are* consumed at `codex.ts:145`/`200` and are guarded); the four token counters at
    **row** level (absent from the golden fixture, never read per row);
    `modelBreakdowns[].totalTokens` (the producer never emits it); every field of a
    **`codex daily` row** (`codex.ts:457` discards `rows` entirely) — including the
    **per-model `totalTokens` nested inside a daily row's `models` map**, which the shared
    validator required unconditionally until code review R5 and which is just as unconsumed
    as the row around it; and `directory` on a Codex session, which is optional **and
    nullable** by design.

    **Two omission tolerances are sanctioned**, both gated on the payload being *genuinely*
    empty — **both** `totalCost`/`costUSD` **and** `totalTokens` equal to zero. Gating on cost
    alone would be wrong: cost is zero for an unpriced or offline-resolved model while tokens
    are positive, so a rename could still be waved through as "nothing to report".
    (a) `projects` is omitted entirely by the pinned binary on an empty result (and is a
    **map**, not a list). (b) `daily` may be absent: the golden fixture omits it on empty,
    a shape the current producer no longer generates but that `usage.py` tolerates via
    `.get("daily", [])`. Anything else missing is an error.
15. **New process-boundary diagnostics.** All to **stderr**, all **exit 1**, message text not
    frozen: unsupported platform; missing platform binary (`--omit=optional`); ccusage
    timeout (120 s); output past the capture cap; termination by signal; a **synchronous**
    spawn throw (`spawnSync` raises before returning a result for an invalid argument); an
    empty configured executable (a whitespace-only or empty `CCUSAGE_CMD`; see entry 13 for
    what Python does instead); and a non-ENOENT spawn failure such
    as `EACCES` — which must NOT reuse the frozen "not found" text, since that would
    misreport a permissions problem as a missing install. Only `ENOENT` maps to the frozen
    not-found message.

    The missing-binary preflight resolves `<platform-pkg>/bin/ccusage`
    (`bin/ccusage.exe` on Windows) — the same specifier ccusage's own shim resolves, **and
    from the same resolution base**: `createRequire(<resolved shim path>)`, mirroring
    `node_modules/ccusage/src/cli.js:9`. Both halves are required for the guarantee. An
    earlier revision matched only the specifier and resolved it from *this* module (code
    review R5); because the platform packages are optionalDependencies of `ccusage` rather
    than of spendbar, the two graphs coincide only under npm's flat hoisting. Under pnpm's
    strict layout or Yarn PnP the binary sits beside the shim and is invisible from here, so
    the preflight would have refused a working install. Checking the package manifest instead
    would verify a different file again, letting a manifest-present/binary-missing install
    through.

    Also new here: **a spawn result with no exit status** — no `error`, no `signal`, and
    `status === null`. `ccusage.ts:40` only treats a run as failed when `status !== 0` *and*
    stdout is blank, so such a result carrying parseable JSON would otherwise be accepted as
    a successful run with no process exit ever observed (code review R5).

    Amends entry 8: the **64 MiB cap is a per-stream process limit** (`spawnSync` exposes a
    single `maxBuffer` applied to each stream — there is no per-stream setting), whereas the
    **1 MiB stderr limit is diagnostic-only**, bounding the error *message* rather than the
    process. Truncation is byte-based and UTF-8-safe with a visible marker.
16. **Malformed UTF-8 from the ccusage subprocess.** Extends entry 12 from rollout *files* to
    the *process* boundary, for the same reason and with the same resolution. `usage.py:114`
    is `subprocess.run(cmd, capture_output=True, text=True)`; text mode decodes with
    `errors='strict'`, so malformed stdout or stderr raises `UnicodeDecodeError` — a
    `ValueError`, therefore **not** caught by `run_ccusage`'s `except OSError` — and Python
    dies with an uncaught traceback, exit 1. The port refuses it cleanly (stderr, exit 1,
    text not frozen), which puts it under the entry 10-12 shape.

    The port previously passed `encoding: "utf8"` to `spawnSync`, which **substitutes U+FFFD**
    per invalid byte (code review R7). That is the leniency entry 12 already rejects, and it
    is sharper here: replacement can turn malformed stdout into *parseable* JSON — measured,
    `{"cost":"\xff"}` decodes to `{"cost":"�"}` and `JSON.parse` accepts it — so the port
    would have printed a clean table from altered data exactly where Python exits non-zero.
    Capture is now `encoding: "buffer"` with an explicit `TextDecoder{fatal}`, matching
    `STRICT_UTF8` in `codex.ts:214`. `ignoreBOM: true` there means the BOM is **preserved,
    not stripped**, so a BOM-prefixed payload fails to parse in both languages.

    Note the port always decodes as **UTF-8**, whereas Python's text mode uses the locale
    encoding (`locale.getencoding()`). On any UTF-8 locale — the only configuration the
    goldens are captured under — these agree.
17. **`~` expansion is POSIX semantics on every platform.** `expandUser` implements CPython's
    `posixpath.expanduser`, including the two tails that are easy to miss and were both wrong
    until code review R7: `userhome.rstrip('/')` (so `HOME=/tmp/foo/` yields `/tmp/foo` and
    `/tmp/foo/.codex`, not `/tmp/foo/` and `/tmp/foo//.codex`) and the final `or '/'` (so an
    empty `HOME` yields `/` and `/.codex`). An explicitly empty `HOME` is a **set** home, as
    in Python — it is not treated as unset, which would have silently redirected a
    deliberately hermetic caller back into the real user's `~/.claude` and `~/.codex`.

    **Windows is a KNOWN GAP, not a sanctioned delta — see ISS-013.** The distinction
    matters and an earlier revision of this entry blurred it (code review R7): everything
    else in this file is a divergence that was measured and then deliberately accepted,
    whereas this one is simply not implemented on a platform the README advertises as
    supported (`README.md:58`, Windows x64/arm64 ✅). Sanctioning it here would be
    overclaiming, so it is recorded as outstanding work instead.

    Concretely, Python on Windows uses `ntpath.expanduser`, which does **not** consult `HOME`
    at all (`USERPROFILE`, else `HOMEDRIVE`+`HOMEPATH`, else the path is returned unexpanded),
    treats `\` as a separator alongside `/`, and resolves `~user` by swapping the home's
    basename rather than through a passwd lookup — so it can succeed where entry 10 refuses.
    The port reads `HOME` and falls back to `os.userInfo().homedir` on every platform (**not**
    `os.homedir()`, which consults `$HOME` first and so cannot express "HOME is absent" —
    code review R8). On Windows it can therefore resolve a different `CODEX_HOME`, read a
    different session tree, and encode a different `homeEnc` than usage.py would.

    It is filed rather than fixed because `expandUser` predates T-006 (T-003 wrote it; T-006
    corrected only the POSIX `rstrip`/`or '/'` tails above), and because no measurement could
    back an implementation today — the reference interpreter is never run on Windows here.
18. **The ccusage child gets no stdin, and no console window on Windows.** `usage.py:114` is
    `subprocess.run(cmd, capture_output=True, text=True)`, which redirects only the two output
    streams — **stdin is inherited**. Measured: a child spawned that way reads the parent's
    stdin (`'HELLO'` written into the parent's fd 0 arrives in the child). The port passes
    `stdio: ["ignore", "pipe", "pipe"]`, so the child gets `/dev/null` and sees EOF instead.

    Accepted deliberately, and in the safe direction: ccusage never reads stdin, so nothing
    observable changes today, and if it ever did, Python would **block forever** on an
    interactive terminal while the port returns. A hang has no byte-parity to preserve. The
    reverse choice — inheriting — would import that hazard for no measured gain, so this is
    not a gap to close later.

    Same options object, same footing: `windowsHide: true`. Python's `subprocess` does not
    set `STARTF_USESHOWWINDOW` by default, so on Windows a GUI-subsystem child could flash a
    console there and not here. That only bites on the platform entry 17 already records as a
    known gap, and it is noted here so the stdio options are documented as a whole rather than
    one line of them.

### Uncatchable-Python-crash scope, continued (added 2026-07-31, T-004 Step 3)

19. **`hourly --date <value datetime.date.fromisoformat rejects>`.** A fourth member of the
    entry 10–12 class, found by measuring the argv surface rather than by reading the source.
    `cmd_hourly` is the one date-taking command that never calls `norm_date`: usage.py:600
    takes `a.date` verbatim and usage.py:618 hands it straight to
    `datetime.date.fromisoformat`, so anything that is not ISO-parseable raises an **uncaught**
    `ValueError` — traceback on stderr, exit 1.

    Reachable and easy to hit, not a corner: `rewrite_argv` lists `--date` among its date
    options, so `hourly --date -1d` is rewritten to `--date=-1d`, sails through argparse, and
    then crashes. Every *other* date option accepts `-1d`, so typing it here is the natural
    thing to do. `--date bogus` crashes identically. Measured under the pinned environment,
    exit 1 both ways, against the ordinary entrypoint and not merely under the test wrapper.

    The port raises the same crash on the same inputs (exit 1, empty stdout) but writes a
    one-line message instead of a traceback, which is why these cases carry
    `compareStderr: false`. The accepted grammar was transcribed from measurements of the
    reference interpreter, not from the docs, and the argv matrix pins each edge:
    `YYYY-MM-DD` and `YYYYMMDD` are accepted, ISO **week** dates `YYYY-Www-D` are accepted
    (`2026-W01-1` resolves to 2025-12-29), and ordinal dates, unpadded fields, a time
    component, surrounding whitespace and non-ASCII digits are all rejected. Two subtleties
    are easy to get wrong in a port and are therefore tested directly:

    * usage.py:601 rewrites any **8-character** value to `XXXX-XX-XX` *before* parsing, so
      the compact week form `2026W011` is first mangled into `2026-W0-11` and then dies —
      it does NOT take the week-date path.
    * the mtime filter compares against the **resolved** date while the records are matched
      against the **raw** string, and the two differ for a week date. Reusing one value for
      both filters on the wrong day.

    An empty `--date` is falsy, so usage.py:600 falls back to today rather than failing the
    parse — the one value that reaches this line without being parsed at all.

    Sanctioned on the same terms as 10–12: **exit code and stream are frozen, the message
    text is not.** The port cannot reproduce those bytes under any implementation — the
    traceback embeds CPython frame objects, absolute paths to `usage.py` and its line
    numbers — so it emits a clean one-line message instead.

    Two consequences for the harness, recorded here because they are easy to get wrong:

    - **Crash paths are not byte-comparable through the test wrappers at all.** The traceback
      renders the *call stack*, so `tests/harness/usage-wrapper.py` adds two frames of its own
      and rewrites the paths. Any "contract" derived from wrapper-captured traceback bytes
      would be a property of the wrapper, not of the program. The differential case therefore
      asserts the frozen part — exit 1, stderr non-empty, stdout empty — and nothing about the
      text. The §4.1 wrapper self-test did not catch this because it uses a success path.
    - This is a **defect in usage.py**, filed separately rather than fixed here: the oracle
      stays unchanged (§15 item 3), so the port matching its exit code is the whole obligation.

20. **Broken stdout pipe (`| head`, and any reader that closes early).** Measured
    2026-07-31, ~24 MB of output against three readers:

    | reader | CPython | Node (default) |
    |---|---|---|
    | `head -1` | **exit 120**, `BrokenPipeError` traceback (371 B) | exit 1, unhandled `'error'` event (1082 B) |
    | early-closing script | **exit 120**, same traceback | exit 1, same class (497 B) |
    | `sed -n 1p` | exit 0, empty stderr | exit 0, empty stderr |

    The third row is a measurement about the *reader*, kept because it is the trap: `sed -n 1p`
    consumes its whole input and only prints the first line, so the writer never sees EPIPE and
    nothing is proven by piping to it. Small output proves nothing either — it fits the pipe
    buffer and the writer finishes before the reader closes. Only output exceeding the buffer,
    into a genuinely early-closing reader, reaches this path.

    **Exit status 120 is reproduced exactly** — exit codes are byte-frozen below, and Node's
    default of 1 is a real divergence on an ordinary invocation (`spendbar daily --since -365d
    | head`), not a corner case. The port installs a stdout error guard, stops writing, and
    exits 120.

    **The stderr text is not reproducible**, on the same terms as entries 10–12 and 19: the
    CPython bytes are a traceback naming `usage.py` and its line numbers, plus a second
    `Exception ignored in: <_io.TextIOWrapper name='<stdout>' ...>` block emitted by the
    interpreter's own shutdown. The port writes a short diagnostic instead. Stream and exit
    code frozen, text not — no new category, just the first member of that class with an exit
    code other than 1.

### Ordering-and-presentation scope (added 2026-07-31, T-004 Steps 5–6)

21. **Tied costs in `share` and `combined` order by project name.** usage.py:526 and :684 sort
    over a Python **set**, and `sorted` is stable, so tied keys fall back to set iteration
    order — which is hash-based. Python is therefore *itself nondeterministic* here; byte
    parity is undefined rather than violated, and matching it is not possible even in
    principle.

    Measured: the full golden check under `PYTHONHASHSEED` 0, 1 and 12345 leaves all cases
    matching, because the fixtures contain no ties. The exposure is real but unexercised.

    The port defines one total order: the Python primary key first (negated cost, or negated
    Claude+Codex total), then the project name compared by `pyCompareStr` — code points, per
    ISS-012. Tied rows therefore appear in ascending name order, always, on every machine.
    Chosen over "whatever JS insertion order gives" because an arbitrary-but-stable order is
    still arbitrary, and a user comparing two runs deserves the same table.

22. **`--help` text: product name and the config-path sentence.** Three spans of the help
    output name the product (plan section 9): argparse's `prog`, the `alltime` hint
    `(… see 'usage codex')`, and the module docstring, which `description=__doc__` renders
    verbatim and which contains 13 `usage <subcommand>` references plus 15 bare `usage`
    tokens. The shipped binary calls itself `spendbar`, so its help necessarily differs from
    every stored golden — and because argparse aligns usage-line continuations under `prog`,
    the *wrapping* moves too, not just the word.

    ALLOWLIST 5 does **not** cover this. It sanctions the config default *path*; it says
    nothing about rewriting help *text*, and assuming it carried over would be an overreach.
    Hence this separate entry. The specific text change it authorises, beyond the product
    name, is the docstring's config sentence, which is factually **wrong** for the port:

        Python : "(from usage-config.json next to this script, or $USAGE_CONFIG)"
        Port   : "(from ~/.config/spendbar/config.json, or $USAGE_CONFIG)"

    Reproducing the Python sentence byte-for-byte would mean shipping documentation that
    points users at a file the port never reads — inside `node_modules` under a global npm
    install. Correcting it is the whole reason this entry exists rather than a `prog` swap.

    **Assertion, in two independent modes** (they must not share a generator, or a bad
    template would produce the implementation and its own expected output and the test would
    pass while the help was wrong):

    - *Oracle mode* (`prog: "usage"`): asserted against the eleven `help_*` stored goldens,
      raw CPython output. Nothing derived from the port's template touches it.
    - *Shipped mode* (`prog: "spendbar"`): asserted against a reviewed snapshot committed as
      data, not regenerated at test time.

    Everything else in the help output — option lists, choice lists and their declaration
    order, wrap width, indentation rules — stays byte-frozen.

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

23. **A mid-render failure produces no partial stdout.** usage.py prints as it goes, so a
    crash part way through a table leaves the header already on stdout. The port renders each
    command to a string and writes it once, so it emits *nothing* on a failure path.

    Reachable today through `blocks`, which still has no schema validator (ISS-002, which
    T-004 does not close). Measured with a `costUSD` of `"100.0"` — a string where a number
    belongs, which no validator rejects: usage.py writes the 57-byte header, then dies in
    `rate = cost / hrs` with `TypeError: unsupported operand type(s) for /: 'str' and 'float'`,
    exit 1. The port exits 1 with a one-line message and an empty stdout.

    What is NOT sanctioned, and is asserted instead: the port must still **fail**. An earlier
    revision returned 0 for any non-numeric value, so it rendered `$0.00` and exited 0 where
    the oracle exited 1 — turning a loud failure into a plausible wrong number, which is
    strictly worse than either behaviour. Booleans stay accepted, because Python's `bool` is
    an `int` and `True / 2.0` is 0.5 rather than an error. Case: `argv_blocks_malformed`,
    which pins that python still emits partial output, that the port emits none, that both
    diagnose on stderr, and that both exit 1.

24. **Tied costs order by project name; Python has no defined order at all.** usage.py:526
    (`share`) and usage.py:684 (`combined`) sort a Python **set**, and `sorted` is stable, so
    tied keys fall back to hash-based set iteration order.

    Measured, not assumed: with three projects tied at $5.00, `usage.py share` produces three
    DIFFERENT orders across `PYTHONHASHSEED` 0, 1, 2, 12345 and 99. Byte-parity is therefore
    **undefined** here rather than violated, and a differential case would pin an accident of
    seed 0 — so these are deliberately not parity cases.

    The port defines the order instead: sort by the Python primary key, then by project name
    via `pyCompareStr` (code points, so `Beta Product` precedes `mike`). Asserted in
    `tests-ts/tiebreak.test.mjs` as an invariant over the rendered table, together with a
    guard that the fixture really does contain a tie and a re-measurement that CPython is
    still nondeterministic — if it ever stops being so, this entry needs revisiting.

- TTY variants: not yet captured (all goldens are pipe/non-TTY). Harness-level TODO
  noted in manifest; add before v0.2 exit if any TTY-conditional output is found.
