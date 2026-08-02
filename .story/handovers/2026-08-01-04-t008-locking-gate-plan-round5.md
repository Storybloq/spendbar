# T-008 — the locking gate killed the lockfile and found a working primitive

Autonomous session `909304b8`, targeted queue `T-023 ISS-018 ISS-019 ISS-020 T-008 T-009`.
**Completed and committed: T-023, ISS-018 (079a5ef), ISS-019 (f2d3660), ISS-020 (584c3c9).**
**T-008 is in PLAN_REVIEW after round 5. T-009 not started.**

## The headline: the planned architecture was wrong, and the gate caught it on day 1

T-008 exists to test two assumptions before T-010/T-011/T-013 commit to them. Both failed, which
is the gate working, not the gate failing.

**1. The lockfile cannot work, and this is reproduced rather than argued.**
Candidate B published a complete owner record via `link()`/`rename()` and decided the winner by
*reading the lock back* and checking whose token survived. Driving two contenders through the
takeover window — both read the same crashed-owner record, both judge it dead:

```
A acquired: true   B acquired: true    *** BOTH ENTERED ***
```

`rename` is atomic, so it **orders** the two takeovers; ordering is not exclusion. Read-back tells
a process it *lost*; it cannot tell a process that already *won* that it has been superseded.

Not patchable, and this is the durable lesson: **every race came from having to reclaim stale
filesystem state.** A lock file outlives its owner, so somebody must judge it abandoned and take
it. `link`/`O_EXCL` never clobbers (so a stale lock is never reclaimable); `rename` always clobbers
(so it cannot revoke); Node exposes no `flock` and no atomic compare-and-delete. That is the
design's ceiling, not a bug in it. Candidate A (a third-party package) is rejected on the same
measured ceiling — same syscalls available.

This is preserved as **executable evidence**: `spikes/locking/lock.mjs` stays in the tree with
`spikes/locking/lock.race.test.mjs`, a **passing** test (verified green: 2/2) asserting both
contenders enter and that both mint the same fencing generation. Passing, not failing — a red test
would sit permanently broken or get quietly excluded, and neither preserves the finding.

**2. The replacement: a resource whose lifetime the kernel owns.** Bind `127.0.0.1:<port>`.

| | measured |
|---|---|
| second bind while holder alive | `EADDRINUSE` |
| second bind while holder has an **established, accepted connection** | `EADDRINUSE` |
| rebind immediately after SIGKILL of an idle holder | OK |
| rebind immediately after SIGKILL of a holder **with an established connection** | OK |

The last row was measured specifically because review round 3 objected that crash recovery had
only been tested idle, and T-011 will hold real connections. `TIME_WAIT` applies to the connection
4-tuple, not the listening socket. Had it failed the primitive would be unusable.

## Three things I got wrong, caught by review, each corrected by measurement

1. **`exclusive: true` does not provide the exclusion.** I credited it with the guarantee. Measured:
   `exclusive:false first=OK second=EADDRINUSE` — identical. Exclusion comes from the kernel's
   address/port bind rule, so the 20-child storm would pass either way and could never be evidence.
   Claim withdrawn; option retained as untested defence in depth.
2. **"Bind port 0 and persist" is not a lock** (review critical). Kernel exclusion applies only once
   every contender bids for the *same* address:port. Reproduced with 8 real first-run children:
   `distinct candidate ports before publish : 8 of 8` — eight listeners, eight singleton beliefs.
   Candidate B's failure in new clothing, introduced by me. **Fixed and re-measured** with
   write-once `link()` publication: `agreed ports: 1, holders: 1, blocked: 7`.
   **Why `link()` is right here and wrong for the lock**: an allocation is *never reclaimed* — it is
   write-once config meant to outlive every process. "Never clobbers" is fatal for a lock and
   exactly right for an allocation. There is deliberately **no automatic re-allocation** (it has the
   same race); a foreign listener refuses startup, rotation is offline.
3. **Fatal-close is not fencing** (review critical). The kernel frees the port *before* JS is
   dispatched the `close` event, so a contender can enter while the old holder still runs.
   Withdrawn to the honest contract: *exclusion holds exactly while the listener remains bound;
   after an unexpected close the old holder performs no further protected commit; no ordering
   between abort and entry is claimed.*

## Output that changes downstream tickets

- **T-011**: the port bind *is* the single-instance guard. No PID file, no staleness logic, no
  takeover. Startup order is fixed: validate write-once token → validate write-once allocation →
  acquire port → probe Unix socket → reclaim only confirmed-stale → bind socket → serve.
- **T-010**: needs **no lock**. Atomic `rename()` of a complete temp file is torn-read-free.
  Caveats now written down: one self-contained file (never split across data+index+checksum);
  `sourceVersion` is a *manifest of per-source offsets* with explicit dominance rules, not a scalar
  max; the monotonicity check is read-then-rename and therefore **advisory** — worst case is a
  stale snapshot, self-corrected, never corrupt. Process-crash atomic, **not** power-loss durable
  (it is a derived cache). Allocation and token *are* fsynced — different boundary.
- **T-013**: leases are an optimisation, not a correctness boundary, once publish is atomic.
- **Security boundary accepted, not solved**: a TCP port is machine-wide, not uid-scoped. Another
  local user can hold it and prevent startup. Failure is refuse-to-start, never two writers.
- **Socket path**: macOS **silently truncates** over-long `sun_path` — `listen` succeeds,
  `address()` returns the untruncated path (it lies), and a *different* path sharing the first 104
  bytes connects to the same server. So reject **before** `listen` on
  `Buffer.byteLength(canonicalPath) > 104`. Measure the **canonical** form: `/tmp` is a symlink to
  `/private/tmp`, so the real string is 34 bytes, not the 26 I first quoted.
- **No stdlib peer-UID API** in Node 22 → the 0700-dir + 0600-token + `timingSafeEqual` fallback is
  what T-011 implements.

## State and next step

Plan: `.story/sessions/<session id removed — T-024>/plan.md` (445 lines). Round 5 returned
**revise with NO criticals** (trajectory: reject → revise 13 major → revise 3 critical → revise 0
critical); the reviewer accepts the write-once protocol and calls the narrowed contracts honest.
All 11 round-5 findings are folded into a new **§3.7 "Boundaries the primitive does NOT cover"**.

**Next action: submit round 6 to `review_plan`, session_id `<session id removed — T-024>`.**
The reviewer holds prior rounds in session, so sending changed sections is sufficient and cheaper.

Uncommitted: `spikes/locking/{lock.mjs, lock.race.test.mjs, portlock.mjs, contender.mjs}`,
`docs/v0.2-prototype-findings.md` (§0–3 written; §4–5 placeholders). `portlock.mjs` has been
brought in line with write-once allocation but **still needs** the domain-separated challenge
transcript (protocol id, purpose, allocation id, version, both nonces), tracked challenge
connections destroyed on release, and the named lock-loss notification. Nothing here ships —
`files` is `dist` + `README.md`, enforced by the packaging contract test.

**Do not treat the remaining findings as a reason to park.** Park is for a defect in the filing;
this plan converged on substance every round.

## Standing constraints (unchanged)

`usage.py` is the frozen oracle. `package.json` must never carry `author`/`contributors`/
`maintainers` (0.0.1 was unpublished over exactly that). **T-007's `npm publish` is never
autonomous** — it needs explicit in-session user go-ahead for that specific version. No real
transcript data or personal paths in anything that ships. No native compilation, no lifecycle
scripts. Reproduce an issue's own evidence before acting on it (L-004). Never skip vacuously.
