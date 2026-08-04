# Session handover — targeted run `T-010 T-011 T-012 T-013 ISS-055`

**Branch:** `v0.1-ts-port` · **Session:** `00000000-0000-4000-8000-000000000000`
**Outcome:** 2 of 5 targets completed. T-011 and T-013 **parked**. T-012 unreachable.
**Issues filed:** 9 (3 critical, 2 high, 3 medium, 1 withdrawn-as-my-error).

---

## The one-paragraph version

T-010 shipped. ISS-055 shipped. **T-011 and T-013 did not, and the reason is the same for both: a contract T-010 already froze cannot be satisfied by the data source v0.2 actually has.** T-010 gates every publish after the first on strict dominance over per-source *consumed* offsets. `ccusage` is a black box that never reports what it consumed. Seven review rounds and four separate designs went into trying to close that gap; all four failed on the identical substitution — bytes *available* used where bytes *consumed* was required. That is ISS-075, and it is the root of most of what follows. T-012 is blocked behind T-011 by declared dependency and would inherit the same problem anyway.

---

## What landed

### T-010 — Snapshot store (COMPLETE, committed earlier in the session)

Shipped and reviewed. Nothing outstanding.

### ISS-055 — Codex MCP tool-approval requirement (RESOLVED, commit `62a4ae3`)

Codex cancels an MCP tool call **before sending it** unless the server carries `default_tools_approval_mode = "approve"`. The client answers `initialize` and `tools/list`, then prints `(failed)` next to the server's name and never sends `tools/call` — a blameless server reads as broken.

I verified before acting, and the **harness-side half was already fixed** by T-009: `spikes/mcp/real-client/capture.mjs:518` passes the `-c` override, `spikes/mcp/real-client/capture.test.mjs:344` asserts it is present, and both evidence manifests record it in the verbatim command line.

What was actually missing is what the issue asked for: the knowledge lived only in a comment inside `spikes/`, which that directory's own framing calls *evidence, not shipping code*. T-013 owns the Codex setup instructions and is parked, and `src/mcp` does not exist — so there was no user-facing document to edit. **`docs/codex-mcp-approval.md`** is that document. It records the measured exchange, the setting and its four accepted values, and the three alternatives that were *measured rather than assumed* (`projects.trust_level` — no effect; dropping `--ephemeral` — no effect; `--dangerously-bypass-approvals-and-sandbox` — works, rejected because it disables the sandbox for everything in order to approve one server's tools).

Three things in it change what T-013 builds:

1. Put the setting **inside the registration snippet** users paste, not in prose beside it. The failure is silent and its error text blames spendbar; a user who skips the prose reaches a wrong conclusion about our software. The snippet is the artefact that gets copied.
2. T-013's AC 9 non-interactive test must set it **and assert `tools/call` was received** — else a cancelled run scores as a spendbar conformance failure and the test is measuring the harness.
3. Prefer absolute paths in `command`; shebang bins break under GUI-launched clients that do not inherit the package manager's `PATH`.

It also preserves the **ISS-047 evidence-hygiene lesson**, now demonstrated rather than suspected: earlier Codex captures passed only because the operator's own `~/.codex/config.toml` approved the call. *A real-client test that inherits the operator's configuration is measuring the operator.*

---

## Why T-011 parked — after 7 review rounds and 80 findings

**All 80 findings were valid. Zero were contested.** Rounds: 13 + 13 + 14 + 15 + 11 + 8 + 6. The plan grew 525 → 1234 lines; its own length became a defect source, with three separate rounds finding cross-section contradictions.

**The unsolvable core.** T-010 requires strict dominance over per-source *consumed* offsets before any publish after the first. `ccusage` does not report what it consumed. Four designs were built and each disproven on the same substitution:

| Design | How it failed |
|---|---|
| Pre-scan file sizes | Size available ≠ bytes consumed |
| Before/after `(path, size)` sampling | Same, with a wider race |
| Sampling + `mtimeNs` + `ino` | Same, **and** `ino` violates the no-inode-revalidation constraint |
| Immutable input capture | Same; capture proves availability, not consumption |

Final position in the plan: publish **one** bootstrap generation with an empty `sourceVersion`, marked `provenance.refreshTier = "bootstrap"`.

**The two contradictions that forced the park** (both are defects in the *filing*, which is the park criterion — not merely hard work):

1. **AC 1 vs. `ccusageFetchedAt`.** The field is a required scalar in `Provenance` with no honest value available, and the record-absence escape that works for `sourceVersion` (an empty map) is not available for a scalar. → **ISS-077** (high).
2. **AC 5 vs. the native-error boundary.** Singleton startup must distinguish `EADDRINUSE` from `EACCES`, but the standing constraint is that *only the fs adapter may inspect a native error*. → **ISS-078** (high).

**Preserved:** `docs/t011-headless-service-plan.md` (1234 lines). `.story/sessions/` is gitignored, so this copy is the only one that survives.

### Design conclusions worth not re-deriving

- **Node's `net.Server.close()` unlinks by pathname**, and will delete a *rival's* live socket. Proved empirically on Node v22.18.0 / macOS — the probe deleted a different inode at the same path. Resolution: `close()` is never called on the UDS server; the raw `net.Server` is confined behind a nominal interface with no `close`, no `Symbol.asyncDispose`, no signal option.
- **Process exit does not unlink a UDS.** Measured for plain exit, SIGTERM and SIGKILL: socket survived in all three.
- **T-008's adopted primitive** — kernel-held loopback port bind with write-once `link()` allocation — stands. Both lockfile candidates reproduced failing; macOS silently truncates `sun_path` past 104 bytes; the kernel frees a TCP port *before* JavaScript sees `close`.

---

## Why T-013 parked — at round 1

15 findings, 2 critical. I applied the T-011 lesson (stop when the filing is the problem) rather than spending six more rounds restating it. Three ACs are undischargeable as written:

- **AC 4** — no `readGeneration(id)` API exists, and `createPin` needs a `LatchingWriteAuthority`.
- **AC 6** — lease liveness is incoherent *and* requires a live service, i.e. T-011's entire unbuilt coordination stack.
- **The compute path** inherits ISS-075 wholesale.

**ISS-079 / ISS-080 (critical):** the reader computation lease's 4000 ms deadline, the measured 60–80 s pipeline cost, and the never-promoted-private-result rule **cannot coexist**. The specified herd test *hides* this — it passes while the feature does nothing. A test that cannot fail for the reason its name gives is the suite's central standard, and this one violates it.

**Preserved:** `docs/t013-mcp-server-plan.md`.

---

## Why T-012 was never picked

Declared `blockedBy: ["T-011", "T-010"]`. T-011 is parked, so T-012 is unreachable by dependency. Independently, T-012's own ticket says it uses `ccusage` and defers owned parsing to v0.5 — so it inherits ISS-075 and would park for the same reason. The guide ended the session here.

---

## Issues filed (all currently untracked in git — see Loose ends)

| ID | Sev | What it says |
|---|---|---|
| **ISS-075** | **critical** | No v0.2 ticket can produce a truthful `sourceVersion`; T-010's dominance contract needs consumed offsets ccusage does not report. **Read this one first.** |
| **ISS-076** | critical | The T-011 plan did not solve `sourceVersion` — it relocated the problem to T-012. |
| **ISS-079** | critical | T-013's lease deadline, pipeline cost and never-promoted rule cannot coexist; the herd test hides it. |
| **ISS-080** | critical | Same defect, recorded from the review side. |
| ISS-077 | high | `ccusageFetchedAt` cannot be honestly populated "from the invocation". |
| ISS-078 | high | The plan let the low-level *network* adapter inspect native errors — constraint violation. |
| ISS-073 | medium | T-011's `acceptanceAdditions` names a GC field that does not exist: shipped field is `noUsableManifest`, and it routes to reset-and-rebuild. |
| ISS-074 | medium | `package.json` has `prepack` and `prepare` — contradicts the no-lifecycle-scripts constraint. |
| ISS-072 | low | **Withdrawn — my error.** Kept resolved-with-reasoning rather than deleted. |

### ISS-072, recorded deliberately

I filed it against a **correct** document, arguing that treating `reset.failed` as a hard stop wedges the service. That was wrong twice: `failed` is a `string[]` that does not say what it names, and `store.ts:458` refuses an unknown root entry *regardless of manifest*, so rebuilding does not converge either. Withdrawn with the reasoning error preserved, because the pattern is worth more than the issue was.

---

## The two defect classes that governed this session

Every serious error, mine and the reviewer's, reduced to one of these. They are worth carrying forward as a checklist:

1. **A class fixed at one site and not its siblings.** I once fixed launcher mode `0700 → 0600` in §5 and left §9 stale — inside the fix for a class-not-siblings finding.
2. **A value proven to have one property, then used as though a different property had been proven.** "Our code never unlinks" used as "no unlink happens". "Still bound to our inode" used as "this pathname names our inode". Attempt *counts* routed through the *duration* validator (`2.5` and `2**60` both pass a duration check; neither is a count). And the whole ISS-075 family: *available* used as *consumed*.

Also, from a mistake I made on T-013 Q5: **a recorded owner decision is not mine to reverse.** ISS-023 accepted the `CCUSAGE_CMD` validator gap and ISS-026 extends it to T-013. Reasoning may justify reopening a decision; it does not authorize silently overriding one.

---

## Loose ends for the next session

1. **Uncommitted work in the tree.** Only the ISS-055 fix was committed. Still untracked/modified: `.story/tickets/T-011.json`, `.story/tickets/T-013.json` (both carry `park` records), `docs/t011-headless-service-plan.md`, `docs/t013-mcp-server-plan.md`, and `.story/issues/ISS-072.json` … `ISS-080.json`. The plan docs matter most — `.story/sessions/` is gitignored and those are the only surviving copies. **Commit these first.**
2. **ISS-075 is the gate.** It is an owner decision, not an implementation task. Until it is answered — accept bootstrap-only publishes for v0.2, or bring parsing in-house earlier than v0.5, or relax T-010's dominance contract — T-011, T-012 and T-013 all stay parked. Nothing downstream is worth planning before it is settled.
3. **ISS-074 is cheap and independent.** `prepack`/`prepare` can be removed without touching any of the above.
4. **When T-013 unparks,** `docs/codex-mcp-approval.md` is written for you; fold it into the setup instructions rather than rediscovering it.