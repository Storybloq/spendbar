# T-008 committed; T-009 in plan review round 3

Autonomous session `909304b8`, targeted queue `/story auto T-023 ISS-018 ISS-019 ISS-020 T-008 T-009`.
**5 of 6 done.** T-009 is the last item and is still in PLAN_REVIEW — no T-009 code written yet.

## What landed

**T-008 — commit `1cc1ff9`**, 33 files, 7614 insertions. Fifteen code-review rounds.
Both go/no-go questions answered **negative in the form they were asked**, which is why the
deliverable is `docs/v0.2-prototype-findings.md` rather than a library.

- **Locking:** candidates A and B (both lockfile designs) disproven — a lock file must be *reclaimed*
  when its owner dies, and Node has no atomic compare-and-delete, no inode-conditional replace, no
  flock. `spikes/locking/lock.race.test.mjs` reproduces candidate B destroying a live lock on its
  happy path and is **kept deliberately as evidence** (so `lock.mjs` is frozen — its umask-unsafe
  creation and hook double-read are documented exceptions, not oversights).
- **Adopted (candidate C):** `spikes/locking/portlock.mjs` — write-once port allocation plus a
  listener held continuously from before the allocation names it. Death releases the port; no stale
  state, no reclaim. HMAC challenge so an impostor on the same port is refused.
- **Peer UID:** no API in Node 22's public surface on macOS without a native build. The "no" rests on
  a name inventory *and* semantic verification, and the probe answers YES for injected real
  capabilities, so it is a detector rather than a constant. Fallback: 0700 dir + 0600 write-once token.
- Verified at commit: `TESTALL_EXIT=0`, 463 tests / 0 fail, 106 spike tests, zero Darwin skips.

**The two defect patterns that dominated T-008** (both recorded in §4.1 of the findings doc, and
worth carrying forward as review lenses):
1. *Fixing a class in one place and not its siblings* — **seven** instances. The umask trap alone
   appeared separately in the token, the port allocation, the snapshot file, and the snapshot
   directory, each fix carrying a comment claiming the class had been swept.
2. *Claiming a property no test pins* — "reads the uid once" while both branches read it twice;
   "every hook resolved up front" while two of four were read late and twice; "an unrequested close
   is FATAL" when the primitive cannot stop its caller.

## T-009 — where it actually stands

Plan at `.story/sessions/<session id removed — T-024>/plan.md`, now **revision 3**.
Rounds 1 (14 findings) and 2 (13 findings) both returned **revise**. Round 3 review was in flight
when this handover was written.

**Facts already established by live check (do not re-derive from memory — ticket hard rule):**
- `@modelcontextprotocol/sdk` **1.30.0** and `@modelcontextprotocol/server` **2.0.0** are both still
  `latest`, identical to the plan doc's 2026-07-30 record → **open question 1 is resolved by evidence.**
- `zod` 4.4.3. v1 accepts `^3.25 || ^4.0`, v2 needs `^4.2.0` → one zod 4 serves both.
- `sdk@1.30.0` = **17 direct deps** (express, hono, cors, jose, express-rate-limit…) for a stdio-only
  need; `server@2.0.0` = **2**. Decision-relevant but deliberately **not** a decision input.
- Clients installed: **Claude Code 2.1.220**, **Codex CLI 0.144.0**.

**Two ticket amendments already written into `.story/tickets/T-009.json`** (with `Was:`/`Why amended:`):
- **Criterion 4 + go/no-go** — `blocked` (both candidates fail) is now a valid *completed* outcome
  with no pinned SDK. Without this the gate could only be completed by a positive result. On
  `blocked`, T-009 creates a resolution ticket and adds it as a blocker to **T-013** (completing
  T-009 otherwise satisfies `T-013.blockedBy` and would let it proceed with no SDK). **T-011 is
  deliberately untouched** — it records that T-009 is not its dependency.
- **Criterion 6** — the recorded threshold is an **equality snapshot** (canonical bytes + proxy
  tokens must *equal* recorded values), because an upper bound derived from this ticket's own first
  measurement passes by construction and deletion sails under it. The enforced *budget* is deferred
  to T-013.

**Biggest structural decisions in revision 3, so they are not relitigated:**
- Candidates live in an isolated `spikes/mcp/candidates/` workspace with its own lockfile and
  `npm ci --ignore-scripts` — **not** root devDependencies (which would push non-shippable code into
  every contributor install and audit).
- **Adapter first**, with *injected* v1/v2 backends and no module statically importing both; the
  production module goes to `src/mcp` after the decision, so T-013 has something to consume and the
  loser is never production-reachable.
- Supply-chain check **never runs an install script at any point**: resolve a lock graph, fetch and
  unpack every tarball, inspect the whole closure (including `binding.gyp`, which is a tarball file
  and invisible to `npm view`), *then* `npm ci --ignore-scripts`, then rescan by installed path.
- Real-client work splits into **`capture:real-clients`** (auth-required, never claimed CI-runnable)
  and **`verify:real-client-evidence`** (offline, in `test:all`), with typed outcomes
  `pass | conformance-fail | infrastructure-unavailable` — only `conformance-fail` counts against an
  SDK, so a missing binary can never be mistaken for evidence against a candidate.
- Cancellation needs a **blocking mode with a handler-started witness**; an immediate echo tool
  cannot test it deterministically.
- `zod` must be an **exact direct** dependency — relying on the SDK's transitive copy is a phantom
  dependency that npm hoisting merely hides.

## Blocking / carried

- **ISS-046 (high, filed this session, blocks T-009's privacy gate).** Reproduced by scanning
  `git ls-files`: `.story/tickets/T-009.json` carries a **real email**; `.story/issues/ISS-005.json`
  and `.story/tickets/T-007.json` carry the **real home path**. The repo's own hard rule forbids
  this, and it means the repo-wide privacy scan T-009 wants **cannot pass today**. `.story/` does not
  ship (the tarball whitelist is `dist` + `README.md`), so this is repository-contents exposure, not
  a shipped artifact. T-009 enforces *zero new leaks in files it touches* and blocks on ISS-046 for
  the pre-existing ones rather than scrubbing unrelated history inline.
- **ISS-042** — T-009's description claims the packaging contract already enforces script-disabled
  install. Reproduced false at `packaging.contract.mjs:286`. Criterion 7 is new work.
- **ISS-033 / ISS-040 / ISS-041** — T-010 through T-015 still specify the lockfile design T-008
  rejected; T-010 has an impossible post-rename recovery guarantee; the stale-socket protocol has a
  TOCTOU that holding the singleton lock **narrows but does not close** (ISS-041 was revised to say
  so after I first proposed the lock as the fix — it only serializes cooperating instances).
- Filed this session: **ISS-037, ISS-039–ISS-046**. **L-005** written after ISS-038 duplicated
  ISS-037: never both hand-file an issue *and* report the finding as `deferred` — `deferred`
  auto-files.

## Standing constraints

`usage.py` is a frozen oracle. `package.json` must never carry `author`/`contributors`/`maintainers`
(0.0.1 was unpublished over exactly that). **T-007's `npm publish` is never autonomous** — it needs
explicit in-session user go-ahead for that specific version. No native compilation, no consumer
lifecycle scripts (`prepare`/`prepack` are required and allowed). Out-of-scope findings are filed,
not fixed inline. Never skip vacuously.

## Next step

Read the round-3 review verdict, revise if needed, then implement §2→§10 of the plan **in that
order** — the sequencing is deliberate: cheap falsifiable checks before the four quota-consuming
real-client runs, so a "no" is found early rather than after paid sessions.
