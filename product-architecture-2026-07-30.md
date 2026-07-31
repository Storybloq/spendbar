# spendbar — productization plan (npm-installed CLI + MCP + menubar UI)

> Drafted 2026-07-30 from a 9-agent research workflow (7 lenses → synthesis → adversarial
> critique). Revised 2026-07-31 through **three rounds of external Codex review**
> (session `00000000-0000-4000-8000-000000000000`; round 1: 24 major/3 minor; round 2:
> 16 major/3 minor incl. three overclaim retractions; round 3: 7 major/3 minor — "most round-2
> findings adequately resolved or correctly prototype-gated". All findings accepted.) Empirical claims verified live on the owner's machine (macOS 26.5.1 / Apple
> Silicon / Node v22.18.0) or the live npm registry on 2026-07-30 unless flagged. Research
> transcripts:
> `~/.claude/projects/-Users-testuser/00000000-0000-4000-8000-000000000000/subagents/workflows/wf_00000000-000/journal.jsonl`

## Vision

One `npm install -g spendbar` delivers, for any Claude Code / Codex user:
1. the CLI (current `usage.py` feature set),
2. an MCP server (a user's Claude can answer "what did I spend this week per project"),
3. a real macOS menubar item with live spend text — not a website.

Quality bar (owner-stated): **robust, smooth, performant.**

## Verdict architecture

**One npm package, one bin, TypeScript core, a 112 KB prebuilt Swift menubar helper in the
tarball, a headless refresh service that is the sole snapshot writer, the menubar as a view on
that service, MCP as a subcommand.**

- **Name**: **`spendbar`** (D1, decided). `usage` is TAKEN on npm; `spendbar` verified available
  2026-07-30 — claim name + `@spendbar` scope with a 0.0.1 placeholder before v0.1.
- **One published package** (internal monorepo: core / render / cli / mcp / service / Swift
  helper source). Universal (arm64+x86_64) 112 KB helper in the main tarball;
  `process.platform === 'darwin'` guard with clear capability messages elsewhere; CI-measured
  size with a 1 MB packed threshold triggering the platform-split revisit.
- **Zero lifecycle scripts** (npm 12.0.2 / pnpm 10 block dependency scripts by default; our path
  needs none — and this constraint drives the launcher/self-heal design below).
- `engines: node >=22.12.0`. **ccusage pinned exact-version regular dependency** (20.0.19 at
  research). `CCUSAGE_CMD` override = **executable path + argv array, `shell:false`**; all
  ccusage subprocesses get timeouts, cancellation, stdout/stderr byte limits, exit-code checks,
  schema validation.
- Subcommands: 9 ported views + `mcp`, `menubar`, `service run|install|start|stop|uninstall|repair`,
  `refresh`, `setup`, `doctor`, `uninstall`, `install-swiftbar-plugin`.

## Empirically verified (scope-honest)

- npm-extracted binaries: no quarantine xattr, ad-hoc signing suffices, no Gatekeeper prompt —
  **evidence scoped to the npm path, n=1 machine, npm 10.9.3 extractor**. Distributability
  beyond that is D4's problem (signing/notarization prototype).
- Bundle-less Swift `NSStatusItem` helper proven end-to-end (112 KB universal, ~45 MB RSS,
  stdio JSON-lines IPC). Electron measured 122 MB/304 MB/196 MB with postinstall failures —
  rejected for v1; named runner-up.
- Owner-machine volumes: `~/.claude/projects` 6.5 GiB (16,249 jsonl), `~/.codex/sessions`
  59 GiB. Full pipeline **60–80 s**; `--since` gives **no speedup** (measured) — and therefore
  (round-2 correction) **periodic authoritative full scans remain a fact of life through v0.4**;
  checkpoints cannot reduce ccusage's scan cost. Own-the-parsing (v0.5) is the only true
  incremental path.
- Fast tier: APFS clone shadows + `--offline --since yesterday` ≈ 1 s. Symlinks confirmed
  ignored by ccusage's walker; hardlinks untested.

## Service & data layer

**Process model — service/view split:**
- **`spendbar service run`** — headless daemon, **sole snapshot writer**, ships in v0.2
  **together with a minimal durable `service install|start|stop` + launcher** (round-2 fix: a
  short-lived CLI/MCP invocation must be able to hand off indexing to something that survives
  its exit; v0.2 exit test = run one short command, exit it, verify indexing completes with no
  foreground process). v0.3 adds the full upgrade matrix, not the mechanism itself.
- **`spendbar menubar`** — a view; ensures service, spawns Swift helper, renders. "Quit
  menubar" ≠ "Stop service", both explicit.
- **Control plane**: Unix-domain socket in a 0700 runtime dir; request IDs; bounded message
  sizes; operations = status / refresh / stop / progress; timeouts; protocol version
  negotiation. **Credential check is a v0.2 day-1 prototype gate** (round-3: Node has no stdlib
  peer-UID API; a native dep may violate the no-build rule) — fallback if no no-build
  implementation survives: 0700 dir + high-entropy 0600 auth token + constant-time comparison.
  **Socket path rules (round-3)**: short per-user runtime path (macOS `sun_path` ≈104-byte
  limit — tested with long usernames/home paths); reject symlinked parent dirs; probe a stale
  socket before unlinking (crash can leave a pathname no server owns). **Stop/start sequencing
  (final, round-4)**: `service stop` = persist desired state as stopped → **disable relaunch**
  (KeepAlive would otherwise respawn) → request graceful shutdown **over the socket** → wait to
  deadline → **then** boot out the launchd job → remove only a verified-stale socket. (Ordering
  matters: unloading first would kill the process before it receives the request.) Each
  transition failure-injected; `service start` reverses each step after partial failure. No PID-based control (PID reuse).
- **MCP/CLI are readers.** Staleness with no live service ⇒ **ephemeral computation lease**,
  a separate namespace from the writer lease (round-2): one reader computes a bounded in-memory
  top-up in a **private temporary generation** (never touching promoted writer shadows); others
  wait to a bounded deadline then return existing data with honest freshness. Expiry/takeover
  rules and ownership records defined per namespace; subprocess concurrency capped; multi-client
  herd test.

**Single-writer protocol:**
- **Locking primitive is a v0.2 day-1 prototype decision** (round-2: Node has no stdlib flock;
  O_EXCL takeover races on unlink). Candidate A: audited pure-JS lockfile package (no lifecycle
  build). Candidate B: own lockfile with owner token + inode revalidation — before every publish
  and unlock, verify the lock pathname still refers to the owned inode. Whichever survives the
  prototype: pid + process-start-time + random owner token recorded; lease-losers discard
  results; single-instance guard on the service.
- **Snapshot storage**: immutable generation files + an atomically-replaced manifest; schema +
  checksum validation before activation; at least one known-good generation retained; GC only
  after a later successful activation. **Durability protocol (round-3)**: write generation →
  fsync generation → write + fsync manifest temp → rename manifest → fsync parent directory;
  prior manifest preserved until activation is durable; failure injection at every boundary
  including ENOSPC during each fsync.
- **Schema compatibility policy (round-3 — upgrades AND downgrades)**: declared supported
  reader/writer schema ranges. An older writer meeting a newer schema **refuses to publish**
  without damaging existing generations; supported downgrades get tested reverse migration or
  an explicit rebuild into a version-specific state directory. Forward migrations alone are not
  a downgrade story.

**Refresh state machine:**
- One execution queue; every job (fast tick, full, wake, manual, shutdown flush) carries a
  generation number; coalescing; publish-if-current only. Deterministic tests: wake+timer,
  manual+full, midnight-crossing, shutdown, **crash storms and wake storms** (round-2).
- **Full-tier scheduling (round-2 wording fix — at MOST one per interval)**: persist last
  attempt, last success, failure count, next-eligible time. Start and wake are *triggers subject
  to* the at-most-one-attempt-per-interval cap; only explicit user refresh bypasses. Adaptive
  backoff + AC-power/idle awareness. Honest cost statement: the authoritative pass is a 60–80 s
  scan (owner-scale corpus) every interval through v0.4.
- **Pricing (round-2 downgrade)**: ccusage's price provenance is **authoritative** — spendbar
  records ccusage version + fetch time as provenance but makes **no independent repricing
  claims** until owned parsing (v0.5) proves token-by-model facts sufficient.

**Fast tier:**
- FSEvents = hints. **Eventually-exhaustive reconciliation**: traversal based on stable
  file/directory identities within **immutable scan epochs** (round-3: index-based cursors
  starve/skip under continuous churn — mutations queue for the next epoch); complete metadata
  coverage within a documented maximum interval; tests = plant a missed event beyond each
  per-pass budget AND run continuous-churn coverage verification. Scans on start, stream reset,
  wake, periodic; tick skipped when nothing advanced.
- **Fast-tier merge contract (round-3 — formalized)**: an authoritative-baseline-plus-delta
  algorithm with explicit required-file-coverage per interval, per-source watermarks, defined
  handling of changed/deleted/truncated files, and rules for when a fast aggregate may REPLACE
  vs only AUGMENT the baseline. **Completeness gates publication**: if coverage for an interval
  cannot be established (missed events, daemon downtime), that interval stays marked stale
  rather than publishing a plausible-but-incomplete total. Verified by model-based tests:
  arbitrary generated event sequences compared against a ground-truth full scan.
- Shadows: per-volume clone-support probe; per-generation isolated dirs atomically promoted;
  pre/post inode/size/mtime validation + retry for actively-written files; deletion/truncation
  modeled; cache age/size caps. **Fallback bounds (round-2)**: plain-copy fallback is bounded by
  file size + free space; oversized inputs ⇒ explicitly-stale partials, never unbounded copies;
  the ~1–2 s fast-tick figure is **conditional on the clone-capable path**; ENOSPC tested
  without losing the current snapshot.

**Snapshot schema:**
- **Independently versioned internal schema** with migrations + invariants (round-2 decoupling
  fix — NOT "written from MCP schemas"); MCP outputs derived through adapters; public output
  schemas versioned separately.
- Per-dataset provenance: coverage intervals, source timestamps, refresh tier, pricing
  provenance, generation ids. Response freshness derived per requested range/fields — no global
  stale flag.
- Timezone: IANA id + day-boundary policy per generation; consumed consistently; tz change
  invalidates affected aggregates; DST gap/fold, travel, midnight-during-refresh tests.
- Corruption: readers quarantine + serve bounded partials from the retained known-good
  generation; only the writer rebuilds. Monotonicity = anomaly signal only.
- Privacy: dirs 0700 / files 0600; symlinked state paths rejected; exclusive temp files;
  redacted rotated logs; documented MCP data exposure.
- Codex attribution stays ours (ccusage `codex session` `directory` = date dir, verified): head
  reads of new rollout files with basename+regex gate + realpath containment.

**Launcher + LaunchAgent (round-2 redesign — no "automatic upgrade survival" claim):**
- Stable user-owned launcher at `~/Library/Application Support/spendbar/launcher` executing
  recorded absolute `[node, cli.js]` pairs from an **allowlisted path registry** (0600) written
  only by spendbar itself. **No PATH searching** (attacker-controlled-binary risk).
- **Registry ownership (round-3 — multiple installs)**: the service installation carries a
  **persistent installation ID**; the launcher target changes only through explicit
  `install`/`repair` or a **verified same-installation upgrade handoff**. A foreground command
  from a different prefix/version **reports the mismatch** ("another installation owns the
  service — run `spendbar service repair` to adopt") and never silently retargets.
- Healing model stated honestly: an npm upgrade/removal breaks the recorded path until the
  next foreground invocation **of the owning installation** re-validates + re-records, or the
  user runs `service repair` to adopt; `doctor` detects and explains. No zero-touch survival
  claim.
- Plist targets the launcher; only the menubar view carries `LimitLoadToSessionType: Aqua`.
  **Headless defined honestly (round-3)**: headless = no-menubar operation **within a
  logged-in user session**. LaunchAgents load at user login, so an SSH-only Mac with no GUI
  login gets NO reboot-persistence promise — documented path there is foreground
  `spendbar service run` (e.g. under tmux), unless a per-user non-root launch mechanism is
  proven on the support matrix later.
- **MCP registration goes through the launcher too** (round-2: shebang bins break under
  GUI-launched clients without the package manager's PATH): register the launcher with an
  explicit `mcp` mode, or validated absolute paths. Doctor + the upgrade/prefix/nvm-removal
  matrix extend to REAL Claude Code and Codex MCP launches.

## TypeScript port

- Full port (~1,100–1,250 TS core lines; ~1,800–2,000 with MCP + tests). Pure core, injected
  deps, renderers return strings; CLI, MCP, service are thin consumers.
- **Parity contract**: byte parity **modulo a published allowlist of intentional deltas**.
  Dual-run harness: both implementations over the same fixture matrix comparing stdout bytes,
  stderr bytes, exit codes — incl. malformed args, missing executables, invalid JSON,
  TTY/non-TTY.
- **Rounding**: classify from decoded IEEE-754 bits (exact decimal expansion) implementing
  Python-compatible half-even; not Intl (shortest-repr), not toFixed tie-detection (information
  already discarded). Targeted boundary corpora (below/at/above midpoints across exponents,
  signs, −0, non-finite) + random differential fuzz vs Python; long-decimal fixture sentinels.
- Hazards honored: `-Nd` normalized once; no `--until` to codex session; realpath try/catch;
  summation order = JSON insertion order; hand-rolled argv parsing.

## MCP

- `spendbar mcp` on the same bin, stdio, stdout JSON-RPC only, logs to stderr.
- **v0.2 ships 5 tools** — `usage_summary`, `usage_by_project`, `usage_by_day`, `usage_share`,
  `usage_blocks`. **`usage_hourly` is NOT registered until a bounded snapshot-backed
  implementation exists** (round-2: compute-on-demand could invoke the 60–80 s pipeline inside a
  60 s client timeout); when it ships it is constrained to cached ranges with a typed
  unavailable/stale response and an internal deadline below the client timeout.
- Strict input schemas: normalized start/end, provider filters, sort, limit, cursor. **v0.2
  timezone rule (round-2): the query timezone must match the snapshot timezone — validation
  error otherwise**; timestamp-level re-bucketing is future work, marked as such.
- **Cursor contract (round-2)**: cursors encode dataset generation id + normalized query + sort
  key + position; the referenced immutable generation is retained for a bounded period; expired
  cursors return a typed error requiring pagination restart. Hard range/row caps; truncation +
  `nextCursor` metadata; summary-first defaults.
- `outputSchema` registered once in `tools/list`; results = `structuredContent` + concise text
  fallback; `generatedAt`/freshness/coverage/warnings inside the registered result schema.
- **SDK gate = v0.2 day 1**: `@modelcontextprotocol/server` 2.0.0 vs `sdk@1.30.0` spiked
  against BOTH real clients with protocol transcripts; conformance tests (initialize,
  tools/list, tools/call, malformed input, cancellation, EOF, stdout purity); adapter validated
  by the spike, not assumed. Tool-def token cost measured in CI.

## UI

- Menubar over floating widget. Title overflow contract: `$0.00`–`$999.99` verbatim → `$1.0k+`
  compaction → icon-only fallback; monospaced digits; mode picker exposes only shipped modes
  ($ + burn v0.3; quota v0.5).
- v1 NSMenu dropdown: header (today/week/Δ) → burn strip → Claude-vs-Codex + model split →
  top-5 projects combined $ → refresh / settings / Stop service / Quit menubar.
- v0.4 NSPopover+SwiftUI (unverified bundle-less — de-risk first). Notifications/SMAppService
  need the flat `.app` (v0.5 — or earlier if D4's notarization prototype forces it).
- CI: macos runner + lipo; declared macOS support matrix + `MACOSX_DEPLOYMENT_TARGET`;
  tarball-level release tests (`npm pack` → inspect contents/modes/slices/signature →
  clean-prefix install → CLI + MCP handshake + helper IPC); install matrix npm/pnpm/yarn/bun ×
  Intel/AS clean VMs with quarantine/first-launch checks.
- Freebie: SwiftBar plugin + `install-swiftbar-plugin`.

## Onboarding

Bare `spendbar` = first-run wizard ("install it, run it"): instant today-$ (~1–2 s on the
clone-capable path) → background indexing handed to the durable service → auto-detected consent
prompts (service + login item, `claude mcp add`, `codex mcp add`), `--yes` for scripters,
re-runnable as `setup`. `doctor`: launcher/plist health, node path, snapshot freshness, MCP
registration health against real client launches — printed fixes. `uninstall`: ownership
fingerprints recorded at install; external entries removed only on match; prompt on divergence;
`--purge-data` separate with dry-run. **Permissions phrasing (round-2): no permission prompts
are *expected* for default `~/.claude` / `~/.codex` paths on the tested macOS matrix** — not an
unconditional "zero TCC" guarantee; `doctor` detects and explains permission-denied. Passive
update line; never self-mutating updates.

## Quality bar rulings

- Failure bounded to stale-but-honest via full-tier reconcile + per-dataset provenance
  (monotonicity = anomaly signal only).
- Quiet self-heal + health dot + doctor; crash-loop breaker on the helper.
- Perf: deterministic checks (sizes, query counts, token counts) = hard CI gates; wall-clock
  benchmarks = recorded-baseline comparisons with repetitions/variance on controlled hardware.

## Competitive reality

- **CodeBurn** (9k stars/3.5 months, npm CLI+MCP+menubar): same rollout-log cwd attribution —
  don't compete on provider count. **Quota vs dollars**: top menubar apps are quota-centric;
  D3 = user-selectable modes, $ default. **Positioning**: narrow/deep — per-project combined
  Claude+Codex spend, everywhere you work; accuracy as the trust story.

## Phases

| Phase | Ships | Effort |
|---|---|---|
| v0.1 | TS core + CLI parity: IEEE-754 rounding spike + boundary corpus day 1; dual-run parity harness + delta allowlist; port core/render/cli + fixtures; ccusage pin + real-binary contract test; `npm pack` tarball test; **script-disabled install tests: npm + pnpm + yarn + bun install the packed tarball with lifecycle scripts disabled and run the CLI + pinned ccusage** (round-3 — v0.1 publishes, so v0.1 proves installability); publish. Exit: parity harness green; all four package managers install + run clean | 1.5–2 wk |
| v0.2 | Day-1 prototype gates: MCP SDK spike + **locking primitive** + **socket credential check** → headless `service run` + minimal durable install/start/stop + launcher (installation-ID ownership) + control socket + writer/computation leases + generation-manifest snapshot (fsync protocol, schema-range policy) + formalized fast-tier merge contract + **5** bounded MCP tools + `refresh` + `--cached`. Exit: week-per-project < 2 s warm from BOTH clients; short-lived-command handoff test passes; multi-client herd test passes; merge-contract model tests pass | 2 wk |
| v0.3 | Menubar view: helper productionized, title modes + overflow, attach/quit semantics, full launcher upgrade matrix (upgrade/downgrade/prefix change/nvm removal/interrupted install, incl. real MCP client launches), **D4 signing/notarization go/no-go prototype**, install matrix, doctor, uninstall ownership, SwiftBar plugin. Exit: live $ ≤ 2 s; idle CPU ≈ 0; survives service restarts AND package upgrades (post-heal) | 2 wk |
| v0.4 | Rich popover (de-risk NSPopover bundle-less first), settings, health/stale UI, update line | 1–2 wk |
| v0.5+ | Flat `.app` (notifications, SMAppService — pulled earlier if D4 forces it), brew cask, quota-mode limit scraping, floating-widget toggle, **own-the-parsing** (true incremental full tier — removes the periodic 60–80 s scans and enables independent pricing) | demand-driven |

Total: ~7.5–10 focused weeks to v0.4.

## Top risks

1. CodeBurn near-superset → narrow/deep, ship fast.
2. ccusage drift under the pin → contract tests gating bumps + schemaVersion decoupling +
   hardened escape hatch.
3. Rounding divergence → exact-bits formatter + boundary corpus + dual-run harness.
4. Fast-tier novelty → generation isolation + eventually-exhaustive reconciliation + reconcile
   + provenance; degrade stale-but-honest.
5. MCP SDK v2 immaturity → spike-first + adapter + v1 fallback.
6. (Round-2 addition) **Prototype-gated design points** — locking primitive, notarization
   artifact, launcher registry — are spikes that could each force a design change; all are
   scheduled day-1 of their phase so failure re-plans early, not late.

## Owner decisions

- **D1 Name** — DECIDED: `spendbar`.
- **D2 Positioning** — narrow/deep recommended.
- **D3 Headline** — DECIDED: user-selectable modes; $ default; picker phase-gated.
- **D4 Apple Developer ID ($99/yr)** — **v0.3 go/no-go**, sharpened by round 2: notarization
  tickets don't staple to bare executables, so the prototype must pick the artifact (signed raw
  binary w/ online Gatekeeper check, or early flat `.app`) before committing. Owner confirm
  pending (cost + Apple account).
- **D5 Parity** — byte-frozen modulo published allowlist through v0.2; `--format json`
  pressure valve.

## Carried unverified flags

- ccusage real JSON schema (fixture-only) → v0.1 contract test.
- MCP client negotiation vs SDK v2 → v0.2 day-1 spike.
- Locking primitive on macOS/Node → v0.2 day-1 prototype.
- Unix-socket peer-credential check in Node without native build → v0.2 day-1 prototype
  (token-auth fallback specified).
- Notarization container for the helper → v0.3 D4 prototype.
- NSPopover bundle-less → v0.4 start.
- Launcher registry + LaunchAgent under real upgrade paths → v0.3 matrix.
- Hardlinks untested; symlinks ignored (confirmed); non-APFS fallback unproven + unbenchmarked.
- 18 s-vs-43 s ccusage timing anomaly un-root-caused; timings n=1.
- Quarantine test synthetic, npm extractor only → v0.3 install matrix.
- CodeBurn packaging/signing unverified.
