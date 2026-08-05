# T-025 — T-010 follow-on: generation invariants, readGeneration, dominance amendments, ccusageInvokedAt

**Risk: MEDIUM** for the landing subset, **HIGH** for anything touching dominance or `sourceVersion` until ISS-081 resolves — reclassified per round-2 finding 11, which was right that "low" understated a pins-directory authorization traversal, a container-replacement retry protocol, a six-member public result type, a public API deletion and a schema-reset change.

**Governing decisions:** N-007 (1, 2, 5), N-008 (1a, 1b, 2a, 5a). **Gate:** RULES.md L-006 — every premise names its witness.

Every change this ticket makes is in `src/snapshot`. That is true only because item 5 is now scoped to the store contract alone (§5); the process-boundary capture its production witness needs belongs to T-011. Nothing here adds authority semantics, lease machinery, or migration code.

**Revision 3** — addresses all 11 round-2 findings, on top of round 1's 9. All 20 were valid; none were contested. **Round 2 refuted revision 2's headline factual claim**, and that correction is recorded below rather than quietly patched.

---

## STATUS — what is blocked on ISS-081 (critical), and a correction

**Revision 2 claimed "no row in any ccusage surface this repo uses carries a sub-day event timestamp". That was false**, and round 2 caught it. Sub-day instants do exist:

- **`ccusage blocks --json`** (`src/ccusage.ts:96`) rows carry `startTime`, `endTime` and `actualEndTime` as ISO instants with millisecond precision (`tests/fake_ccusage.py:67-70`), consumed at `renderers.ts:397-399`, reached by the live `blocks` subcommand (`main.ts:70, 122, 146`). `actualEndTime` is a genuine newest-activity time and **does** advance intra-day.
- **Codex `sessionFile`** matches `ROLLOUT_RE` (`codex.ts:59-62`), which admits a time component after the `T`.

I audited the daily surfaces, found what I expected, and stopped. **That is the second time in this arc I filed against an incomplete audit** — ISS-072 was withdrawn for the identical pattern. L-006 asks for the witness; it does not ask whether the search for one was exhaustive, and that second question is what both failures needed.

**The corrected finding is narrower and still blocking.** No ccusage surface gives a **per-source** sub-day activity time:

| Surface | Per-source? | Sub-day? |
|---|---|---|
| `claude daily --instances` | **yes** (per project) | no — `date` only |
| `blocks` | **no** — global 5h windows, no source key, Claude-only | **yes** — `actualEndTime` |
| codex `session` | per session | start time only; a growing session never advances it |

So N-007's watermark is caught between two properties it needs at once:

- A **per-source day** watermark does not advance within a day → no intra-day refresh can ever publish (defeating T-012's fast tier and the product), and N-008 1b would report "found nothing new" for a run that found real new spend — the exact freshness lie 1b exists to prevent.
- A **global sub-day** watermark from `blocks.actualEndTime` advances honestly but collapses the key set to one, which N-008 1a explicitly rejected: it "surrenders exactly the per-source regression protection the gate exists for". It is also Claude-only.

ISS-081 now carries **four** candidate resolutions, including one only the corrected audit made visible: **(d)** per-source day watermarks for regression protection *plus* the global `blocks.actualEndTime` as a separate tiebreak permitting an intra-day publish when no per-source key regressed. Recommendation moved to **(a) or (d)** — both preserve the per-source protection that (b) partly surrenders.

**Effect on this ticket** (revised per round-2 finding 4). Held on ISS-081: item 3b (`unchanged`), item 4 (semantics rewrite), **and the candidate-side dominance rule** — round 2 was right that candidate-only-as-progress is justified *only by* the watermark redefinition, so landing it while item 4 is held would make runtime behaviour contradict `dominance.ts`'s shipped documented contract.

Landing now: item 1 (audit only), item 2 (`readGeneration`), item 5 (store-side rename), the dead-union deletion, and **live-side `retireSources` only** — which stays compatible with the documented semantics because attested retirement is a topology statement, not a claim about what the numbers mean.

---

## 0. Scope correction — item 1 is already shipped

**The ticket asks me to build `assertGenerationInvariants`. It exists, is exported, and is called at every generation decode site.** Verified, not recalled:

| Claim | Evidence |
|---|---|
| The validator exists | `store.ts:1014`, exported |
| It checks body shape | `store.ts:1022-1049`: object, inert, exact keys, **id binding to filename**, `publishedAt` instant, `sourceVersion` canonicalizable, provenance shape, payload present |
| Provenance is field-by-field | `store.ts:1053-1098` — exact keys, coverage array, interval shapes, sourceTimestamps instants, five required strings, IANA timezone |
| Called on the classify path | `store.ts:664` |
| Called on the read path | `store.ts:2699`, with the comment naming this exact failure at 2695-2698 |
| Called on the **write** path | `store.ts:2206` — candidates are validated on the way out too |
| Tested | `snapshot-store.test.mjs:2402, 2433, 2446, 4949, 5009, 5124, 5157, 5532, 5545, 5559` |

**ISS-064's cited lines (`store.ts:841`, `store.ts:267`) no longer hold** — they are from a pre-completion revision of T-010, and T-010's own review rounds closed the gap. There are exactly two generation decode-and-serve sites today (`664`, `2694`); `collectGarbage` touches `generations/` only to delete (`store.ts:3034-3061`) and decodes nothing.

**Consequence for this plan:** item 1 contributes *no new validator*. Its only surviving obligation is that the new `readGeneration` calls the existing one — which is item 2's work. **ISS-064 is resolved-on-verification and will be closed with that evidence, not re-implemented.** Building a second validator would be duplicate surface presented as a fix.

---

## 1. Verified baseline

Facts this plan depends on, each read this session:

- `PublishResult = {status:"published"…} | {status:"refused"…}` — `store.ts:1987-1989`
- Dominance gate: `store.ts:2180-2192`. Runs only `if (live !== null)`; `verdict !== "dominates"` **throws** `SnapshotNotDominatingError`
- `compareSourceVersions` — `dominance.ts:161-190`. One-sided key on **either** side returns `"incomparable"` immediately; `anyGreater && anyLess` → `"incomparable"`; else `dominates` / `regressed` / `equal`
- `readSnapshot(fs, paths, attempts = 3)` — `store.ts:2581`; `attempts` validated to integer 1..16 at `2595`
- Reader bracket: container identity at `2615-2620`, manifest-identity re-check at `2685` and `2714`, container re-check at `2717`
- Retention set: `manifest.activeGenerationId` + `manifest.retainedGenerationIds` — `store.ts:2671-2674`
- Pin liveness, as GC computes it: `pin === null || Date.parse(pin.until) <= now || !existingGenerations.has(pin.generationId)` → collectable — `store.ts:2993-2996`
- `PinDoc` keys `["pinId","generationId","until"]` — `store.ts:965`; validated by `assertPinInvariants` (`store.ts:1167`)
- `createPin(fs, authority: LatchingWriteAuthority, paths, pin)` — `store.ts:3068-3070`
- `PROVENANCE_KEYS` includes `"ccusageFetchedAt"` — `store.ts:954-963`
- `ccusageFetchedAt` occurs at exactly **15 sites**: `store.ts:960, 1077, 1083, 1084`; `types.ts:294`; `snapshot-realfs.test.mjs:73, 137`; `snapshot-store.test.mjs:74, 1441, 4936, 5027, 5148, 5964, 6038, 6102`

---

## 2. Item 2 — `readGeneration(id)`

The reader half of the pin mechanism. **Not manifest-following:** `readSnapshot` remains the only function that serves "whatever the manifest currently activates".

### Authorization set

A generation may be read iff its id is in:

```
manifest.activeGenerationId ∪ manifest.retainedGenerationIds ∪ { p.generationId : p ∈ pins, Date.parse(p.until) > now }
```

Pin liveness is computed **exactly as GC computes it** (`store.ts:2993-2996`), minus the `existingGenerations` clause — that clause answers "is this pin collectable", and here the file's absence is a separate, reportable outcome rather than a reason to call the pin dead. Using a different liveness rule than GC would let a reader serve a generation GC has already decided to delete; keeping them identical is what makes the two agree.

An **expired** pin does not authorize. A generation may still be on disk (GC has not swept), and serving it would silently redefine the contract as "whatever is on disk", which is precisely the limit N-007 decision 5 places on this function.

**Precedence when the manifest is unusable** (round-2 finding 6). Revision 2 was genuinely ambiguous: it returned `no-store` for any unusable manifest *and* claimed pin-authorized reads do not depend on the manifest. Both cannot hold. Resolved **in favour of N-007's union**, which says *pinned **or** manifest-retained* — a disjunction, so either disjunct suffices:

1. Try the manifest. Usable → its retained set contributes.
2. **Scan pins regardless**, including when the manifest is absent or unusable. A pin is a standalone retention record; it does not become void because the manifest did.
3. `no-store` only when **neither** a manifest nor a live pin can authorize the id. An unusable manifest alone is not `no-store` if a live pin authorizes.

This is the reading that makes pins worth having: a cursor mid-pagination through a pinned generation should survive a manifest problem, which is the whole reason its generation was pinned.

### Result type

```ts
export type ReadGenerationResult =
  | { status: "ok"; generation: GenerationDoc }
  | { status: "not-retained" }   // id not in the authorized set (unknown id, or pin lapsed)
  | { status: "gone" }           // authorized, but ABSENT when read
  | { status: "unusable"; reason: ResetReason; detail: string; cause?: unknown }
  | { status: "unstable" }       // containers moved under us; attempts exhausted
  | { status: "no-store" };      // neither a usable manifest nor a live pin can authorize
```

**`unusable` carries the cause** (round-2 finding 10). Revision 2 said the result "carries its classified reason and cause" while typing it `{reason: string}` — proving a diagnostic at one layer and discarding it at the next, the sibling of a defect `store.ts` already documents. It now forwards `readStoreFile`'s `reason`, `detail` and `cause` **opaquely**; the cause is never inspected here, because only an adapter may inspect a native error.

**`unstable` is a real status** (round-2 finding 9). Revision 2's test said container replacement "produces no answer" while the union had no such member and `assertSameContainer` throws rather than retries — three implementations could satisfy that prose incompatibly. Defined now: a `root`, `generations` **or** `pins` identity change marks the attempt restarted and retries from all three entry identities; when `attempts` is exhausted the result is `unstable`. It is not `no-store` — "the store moved while I looked at it" and "there is nothing here" are different answers.

**`readStoreFile`, not `readGuarded`** (round-1 finding). `readGuarded` (`store.ts:306-309`) deliberately collapses absent and present-but-not-ours into one `null`, so building `gone` on it would report an authorized **symlink, wrong-mode file, non-regular file, oversized file or invalid-UTF-8 file as `gone`** — defeating the contract and my own symlink test. That is defect class (b) in my own plan: "`readGuarded` returned null" proven, used as though "the file is absent" had been proven. `readStoreFile` (`store.ts:335`) keeps the distinction: `state:"absent"` → `gone`, `state:"unusable"` → `unusable` carrying its classified reason and cause, `state:"ok"` → decode and validate.

`readStoreFile` also opens first and validates the descriptor it will read from (`store.ts:336-348`, `O_NOFOLLOW`), so the mode checked and the bytes read belong to the same inode by construction — the name/file race is closed by the primitive rather than by this function.

`not-retained` and `gone` stay **distinct**: a lapsed pin is ordinary expiry, an authorized-but-absent artifact is not, and collapsing them makes telemetry report one as the other.

**`gone` is not a damage signal** (round-1 minor). A pin-authorized generation disappears through *ordinary* concurrent GC with no manifest change at all: GC expires the pin, removes it, then removes the now-unretained generation (`store.ts:2993-3061`). Documented as "authorized at observation, absent when read, including ordinary concurrent pin expiry" — no damage-level telemetry.

`unusable` mirrors `readSnapshot`'s quarantine disposition (`store.ts:2701-2706`). The id binding at `store.ts:1029-1034` is what makes a generation non-substitutable, so `assertGenerationInvariants` is called with `expectedId = id` — the id the caller asked for — never the id the body declares.

### Concurrency — and what "reuse readSnapshot's bracket" does NOT cover

Round 1 was right that "wholesale" was false. **`readSnapshot` never traverses `pins/`**, so none of its bracket covers the new authorization pass. Left as written, a substituted `pins/` holding a valid-looking live pin would authorize an otherwise unretained on-disk generation. This is the same hole GC was fixed for at `store.ts:3018-3030`, where the *retention* side had to re-prove the container and not only the *deletion* side — I was about to reintroduce a closed defect at its sibling site.

The pin authorization pass, stated explicitly:

1. Capture `root`, `generations` **and `pins`** container identities up front, via `containerIdentity` (as `store.ts:2615-2620` does for the first two, and `store.ts:2851` does for pins).
2. Validate the clock input the same way `attempts` is validated (`store.ts:2595`): `now` must be a safe integer, or throw. An `Object` with a `valueOf` would otherwise run caller code inside the liveness comparison.
3. List `pins/`; skip entries failing `isArtifactFileName`; `lstat` and skip symlink, non-file, or non-`FILE_MODE` entries at the name — the filter GC applies at `store.ts:2954-2958`.
4. Read each surviving entry with `readStoreFile`; `decodeEnvelope("pin", …)`; `assertPinInvariants(doc, path, <filename id>)` — **bound to the filename**, so a pin whose body declares another id cannot authorize.
5. Narrow the catch exactly as GC does (`store.ts:2987`): only this module's own `SnapshotStoreResetError` means "unusable pin"; anything else propagates. An unusable pin authorizes nothing.
6. Liveness: `Date.parse(pin.until) > now`. **Strictly greater**, which makes exact expiry equality *expired* — identical to GC's `<= now` collectable rule (`store.ts:2995`) at the boundary. A `>=` here would let the reader serve a generation GC has already decided to collect.
7. Re-prove the `pins` container before returning any authorization derived from it, mirroring `store.ts:3027-3030`. A verdict assembled across two different filesystems is ambiguous, and ambiguous is not a thing to return as an answer.

The manifest side keeps `readSnapshot`'s bracket: `attempts` validation, container identity at entry and exit, manifest identity re-checked before any absence is called damage, narrowed catches via `isArtifactUnusable`. Retained for the pin-authorized path too even though it is redundant there, because an under-bracketed read returns a *wrong answer* while an over-bracketed one only retries — and two subtly different concurrency disciplines in one file is how they drift apart.

---

## 3. Item 3 — dominance amendments

### 3a. `retireSources` (N-008 1a)

`publishSnapshot`'s options gain `retireSources?: string[]`. `compareSourceVersions` gains a third parameter naming the retired keys. A key present in **live** and absent in **candidate** is permitted only when named there; unattested absence stays `incomparable` and fail-closed.

The retired list is validated like every other caller-supplied structure: inert, an array of strings, each a key that is actually present in live and actually absent from the candidate. Naming a key that is present in the candidate, or that live never had, is a caller error and is refused — a retirement list that silently tolerates junk is a list nobody can rely on.

`retireSources` is threaded through `assertInertDocument(options, …)` at `store.ts:2030`, which already covers the options object.

Retirement is reported as its own outcome so it appears in telemetry rather than looking like an ordinary publish — a `PublishWarning` with `stage: "dominance"` naming each retired source, on a result that is otherwise `published`.

### 3a-witness — who attests a retirement, and how (L-006)

Round 2 rejected revision 2's answer, correctly. I had written that the service attests "after verifying the input side — the source's transcript location exists and is empty or pruned". **That proves current filesystem state, not retirement.** It cannot distinguish a temporarily quiet source from a retired one, it names no adapter that enumerates *every* configured source location and archive, and it has no race bracket between inspecting the inputs and invoking ccusage. Filesystem inference was the wrong shape of answer — the same shape as the four dead T-011 designs.

**Corrected: the attestation is an explicit input, not an inference.**

- **Witness:** a configuration entry or an explicit user/admin action declaring a source retired. Retirement is a *statement of intent about a topology* — "I no longer use this tool" — and intent has exactly one honest witness, which is someone stating it.
- **Caller:** T-011 passes that declared value through to `retireSources` and derives nothing. It never infers retirement from ccusage output, from an empty directory, or from anything else.
- **What this ticket ships:** the mechanism and its validation. `retireSources` is inert until a caller passes it, and **it encodes no premise into stored data** — an unpassed option changes nothing about what a generation claims. That is the honest difference between 3a and item 4, which *does* bake a claim into every generation and is therefore held.
- **Deliberately not decided here:** where that configuration lives and how it is edited. That is T-011's surface, and inventing it from this ticket would be the same overreach as inventing the filesystem rule was.

### 3a-Q1 — the candidate-side rule (round-1 finding 5)

Round 1 upgraded my Q1 from an open question to a confirmed blocker, correctly. **My audit adds evidence the reviewer did not have:** the candidate-side case is not an untested gap — it is *asserted by a shipped test*. `snapshot-store.test.mjs:1112` uses live `{claude: 10}` against candidate `{claude: 20, gemini: 1}` as its `"incomparable"` case.

That assertion was **correct under consumed-offset semantics** (a new source's prior consumption is genuinely unknown; offsets start at 0) and is **invalidated by N-007's redefinition to watermarks**, where a candidate-only key means live simply made no claim while the candidate claims more. So this is a semantics change requiring owner ratification, not a bug fix, and it requires editing a shipped test — which is the honest signal that it is one.

**HELD on ISS-081** (round-2 finding 4). Candidate-only-as-progress is justified *only by* the watermark redefinition, which item 4 is holding. Landing it now would make runtime behaviour contradict the consumed-offset contract `dominance.ts` still documents, and would edit a shipped assertion on the strength of a premise this plan says is unresolved. It lands **with** item 4, in one change, or not at all.

Full truth table, settled now so it resumes as implementation rather than design. Round-2 finding 8 was right that revision 2 left addition-plus-retirement undefined:

| Live | Candidate | `retireSources` | Verdict | Lands |
|---|---|---|---|---|
| `{a:1}` | `{a:2}` | — | `dominates` | shipped |
| `{a:2}` | `{a:1}` | — | `regressed` | shipped |
| `{a:1}` | `{a:1}` | — | `equal` | shipped |
| `{a:1,b:2}` | `{a:1}` | — | `incomparable` (unattested removal) | shipped |
| `{a:1,b:2}` | `{a:2}` | `["b"]` | `dominates` — attested retirement + shared advance | **3a, now** |
| `{a:1,b:2}` | `{a:1}` | `["b"]` | **`dominates`** — retirement alone is topology progress | **3a, now** |
| `{a:2,b:2}` | `{a:1}` | `["b"]` | `regressed` — a shared regression defeats retirement | **3a, now** |
| `{a:1}` | `{a:1,b:1}` | — | `dominates` — addition alone is progress | held (item 4) |
| `{a:1}` | `{a:2,b:1}` | — | `dominates` | held (item 4) |
| `{a:2}` | `{a:1,b:1}` | — | `regressed` — addition never rescues a regression | held (item 4) |
| `{a:1,c:5}` | `{b:1,c:5}` | `["a"]` | `dominates` — addition + attested retirement + shared equality | held (item 4) |
| `{a:1,c:5}` | `{b:1,c:5}` | — | `incomparable` — addition never excuses an unattested removal | held (item 4) |
| `{a:1,c:9}` | `{b:1,c:5}` | `["a"]` | `regressed` | held (item 4) |
| `{a:1}` | `{b:1}` | `["a"]` | `dominates` — complete replacement, fully attested | held (item 4) |

The three rows landing now involve **no candidate-only key**, so they are expressible under the semantics `dominance.ts` documents today: they say only that an attested removal is permitted, never that a number means something new. Ratification for the held rows rides with ISS-081.

### 3b. `{status:"unchanged"}` — HELD on ISS-081, and unsound as I first wrote it

**First, the defect I introduced** (round-1 finding 2). Composing 3a with 3b without checking the pair: live `{a:10, b:20}`, candidate `{a:10}`, `retireSources: ["b"]`. Skipping the permitted missing key leaves only `a`, `a === a`, verdict `"equal"` → my 3b returns `{status:"unchanged"}` → **the retirement is never persisted**, and cannot be until some unrelated source happens to advance. A wedge created by the fix for a wedge.

Correct construction, if and when 3b lands: **`unchanged` is decided by exact canonical `sourceVersion` equality with no effective retirement, computed separately from the dominance verdict** — never inferred from `verdict === "equal"`. An attested retirement with otherwise-equal watermarks is *topology progress* and publishes; it is never `unchanged`.

**Second, why it is held.** `unchanged` means "nothing new" and, per ISS-081, an equal day-granular watermark does not witness that. Landing 3b now ships the freshness lie it exists to prevent. It resumes once ISS-081 is answered — and under resolution (b) its definition changes anyway, from watermark-equal to payload-identical.

---

## 4. Item 4 — sourceVersion semantics rewrite — **HELD on ISS-081**

This item writes the watermark definition into the store's contracts, comments and tests. Per ISS-081 no *per-source* sub-day witness exists, and all **four** candidate resolutions change what the text should say — (a) changes the `sourceVersion` *type*, (b) changes what `unchanged` means, (c) changes the advertised refresh cadence, (d) adds a second global tiebreak dimension. Writing any of them now guarantees rewriting it.

Held rather than dropped. The audit below stands and is what item 4 executes once ISS-081 is answered.

Contracts, comments and tests move from consumed-offset language to **verified input watermark**: per source, the newest event time the computation reflects — at whatever granularity ISS-081 settles on, stated explicitly rather than implied. The consumed-offset ideal is explicitly deferred to the v0.5 owned-parsing ticket, named in the text so it reads as deferred rather than abandoned.

Sites carrying consumed-offset language: `dominance.ts:2, 4, 31, 60, 74, 75, 83, 111, 117, 122, 134, 148`; `envelope.ts:112`; `store.ts:2127, 2213`.

**Trap, called out because a grep-and-replace would hit it:** seven occurrences of "offset" in `store.ts` (`997, 1037, 1071, 1084, 1126, 1129, 1186`) mean **UTC offset**, not consumed offset. They are correct as written and must not be touched. The two categories are distinguished by hand, not by pattern.

The dominance *shape* does not change here: every live source present, at least one strictly newer, missing source fails closed (now modulo attested retirement). Only the claim the number makes changes.

---

## 5. Item 5 — `ccusageFetchedAt` → `ccusageInvokedAt`

Mechanical rename across the 15 sites enumerated in §1, keeping the field **required** and documenting it as the instant we invoked ccusage. The doc comment states what it does **not** claim — that ccusage fetched pricing then — because that false reading is what made the old name unusable.

**Witness (L-006) — corrected.** Revision 2 said `runCcusage` "records the instant immediately before the spawn and hands it to the publish candidate". **It does not.** `src/ccusage.ts:26-31` builds the argument list and calls `runner`; it captures no instant, has no injected clock, and returns only parsed output. Round 2 was right, and it also caught the contradiction with this plan's own claim that all five items live in `src/snapshot` — the capture would be a *process-boundary* change, outside it.

Scoped honestly instead:

- **This ticket renames the store contract only.** `ccusageInvokedAt` is a required field whose meaning is now stated exactly: the instant the invoking process spawned ccusage. That is a contract change in `src/snapshot`, entirely within scope.
- **The production witness is deferred to the caller that publishes**, i.e. T-011. What it must do is specified so it is not rediscovered: inject an instant clock at the process boundary, read it **immediately before** the `runner` call at `src/ccusage.ts:31`, and forward it into the publish candidate. No inference, no reconstruction after the fact.
- **Why item 5 is still not blocked by ISS-081** while item 4 is: the value is knowable exactly by the code performing the action, so a witness demonstrably *can* exist and only needs building. `sourceVersion`'s per-source sub-day watermark, by contrast, has no witness available at any granularity ccusage offers. A witness not yet built is a scheduling fact; a witness that cannot exist is a design defect.

**Accepted consequence, written down per N-008 2a:** this is an exact-key schema change to shipped T-010. A pre-rename generation fails `assertExactKeys` (`store.ts:1058`) and classifies to reset. Pre-release that is acceptable; the store is a derived cache and reset is the migration. No migration machinery is added.

---

## 6. Round-1 questions — now resolved

**Q1 → decided, and now HELD.** The rule is settled as the §3a-Q1 truth table; the candidate-side rows land with item 4 once ISS-081 resolves. Original reasoning kept below.

**Q2 → decided, and corrected by round-2 finding 5.** Revision 2 said `PublishResult` becomes `published | unchanged` while *also* holding `unchanged` — which would have **recreated the exact defect being removed**: a second uninhabited public status. Deleting one dead member and adding another is not a fix.

Landing subset: **`PublishResult = { status: "published"; generationId; warnings }` — one member.** Every non-publish outcome throws, and the doc says so plainly. `unchanged` is added **only** in the same change that implements a reachable `unchanged` return and its exhaustive tests. A union member and its producer land together or neither lands.

<details>
<summary>Original Q1 text (round 1) — kept as the reasoning record</summary>

### Q1 — the new-source wedge is the untouched sibling of N-008 1a

`dominance.ts:178-181` returns `"incomparable"` for a one-sided key on **either** side. N-008 1a fixes the live-side (a source disappears). The **candidate-side** is untouched:

- live `{claude: 100}`, candidate `{claude: 105, codex: 3}` → key `codex` is one-sided → `incomparable` → refuse
- next run: live still `{claude: 100}`, candidate `{claude: 110, codex: 5}` → still incomparable

**Permanent wedge**, identical in shape to the one N-008 1a was written to close, and `retireSources` does not reach it — that option attests *removal*, and this is an *addition*. Under watermark semantics a user starting to use a new tool ccusage reports separately trips it.

The asymmetry looks justified on the merits: `dominance.ts:157-159` says absence is "no claim", and reads a candidate-side gap as *a dropped source masquerading as progress* — which is the live-key-missing case. A key missing from **live** is the opposite: live made no claim, the candidate claims more, and nothing regressed.

**Recommendation:** admit a candidate-only key as progress, provided every live key is present and non-regressed. This is a dominance semantics change and therefore an owner decision, so I am flagging rather than building it. If the review declines, the wedge should be filed as a known issue rather than left undocumented — shipping the retirement fix while its sibling stays open is the exact defect class this arc is about.

### Q2 — `PublishResult`'s `refused` member is uninhabited

`{status: "refused"; reason; warnings}` is declared at `store.ts:1989` and **never produced anywhere in the file**. Every refusal is a thrown `SnapshotNotDominatingError` (`2173`, `2187`). A caller writing `if (result.status === "refused")` gets a branch that never runs and no compiler complaint.

Item 3b adds a third member to this union, which makes the dead one materially more dangerous: `unchanged` is exactly what someone reaching for "the publish did not happen" would otherwise handle as `refused`. **Recommendation:** delete `refused` in this ticket, or produce it. Either is defensible; leaving a three-member union where one member is unreachable is not.

</details>

---

## 7. Test plan

Every test below must be able to **fail for the reason its name gives**. Each names the mutation that kills it.

**Authorization — the cases that decide whether pin authorization is trustworthy rather than merely present.** Round 1 was right that without these the whole path can do nothing, or trust malformed state, while a happy-path pin test still passes.

| Test | Mutation it must catch |
|---|---|
| `readGeneration: an unpinned, unretained id is not-retained even when the file exists` | drop the authorization check → serves from disk |
| `readGeneration: a live pin authorizes a generation the manifest no longer retains` | authorize from the manifest only → pins do nothing |
| `readGeneration: an EXPIRED pin does not authorize` | drop the `until` comparison |
| `readGeneration: expiry is EXACT — until === now is expired, agreeing with GC` | `>=` instead of `>` → reader serves what GC will collect |
| `readGeneration: one live pin among several expired and unusable ones still authorizes` | stop at the first unusable pin → authorization silently does nothing |
| `readGeneration: an invalid-checksum pin does not authorize` | skip `decodeEnvelope` |
| `readGeneration: a structurally invalid pin does not authorize` | skip `assertPinInvariants` |
| `readGeneration: a pin whose BODY id differs from its filename does not authorize` | pass the body-declared id instead of the filename id |
| `readGeneration: a symlinked / wrong-mode / non-regular pin entry is skipped at the name` | drop the `lstat` filter |
| `readGeneration: replacing pinsDir mid-listing retries, then returns unstable when attempts are exhausted` | omit the pins-container closing bracket; or return `no-store`/`not-retained` instead of `unstable` |
| `readGeneration: a live pin authorizes even when the manifest is UNUSABLE` | return `no-store` on any unusable manifest → pins become worthless exactly when they matter |
| `readGeneration: no-store only when neither manifest nor live pin can authorize` | return `no-store` whenever the manifest is unusable |
| `readGeneration: invalid attempts throws` | omit the `attempts` validation |
| `readGeneration: a non-safe-integer now throws` | omit the clock validation → caller code runs in the comparison |

**Artifact disposition — one test per `readStoreFile` state, because `gone` and `unusable` are exactly what round 1 showed a single collapsed read cannot distinguish.**

| Test | Mutation it must catch |
|---|---|
| `readGeneration: an authorized-but-absent artifact is gone` | map `unusable` → `gone` |
| `readGeneration: an authorized SYMLINK is unusable, not gone` | use `readGuarded` → collapses to `gone` |
| `readGeneration: an authorized wrong-mode file is unusable, not gone` | as above |
| `readGeneration: an authorized non-regular file is unusable, not gone` | as above |
| `readGeneration: an authorized oversized file is unusable, not gone` | as above |
| `readGeneration: an authorized invalid-UTF-8 file is unusable, not gone` | as above |
| `readGeneration: a checksum-valid generation under the WRONG filename is unusable, never served` | drop `expectedId` from the invariants call |
| `readGeneration: a manifest that moves mid-read retries rather than reporting damage` | drop the re-check bracket |

**Dominance (item 3a).**

| Test | Mutation it must catch |
|---|---|
| `dominance: an UNATTESTED missing source still refuses` | permit any missing key |
| **`dominance: an attested retirement with all shared values EQUAL publishes`** | leave retirement-only returning `equal` → throws |
| `dominance: an attested retirement PLUS a shared advance publishes, and reports the retired source` | ignore `retireSources`; drop the warning |
| `dominance: an attested retirement does NOT rescue a shared regression` | let the retirement mask the regression |
| `dominance: retiring a key the candidate still has is refused` | accept any string in the list |
| `dominance: retiring a key live never had is refused` | as above |
| `provenance: a body carrying the OLD ccusageFetchedAt key is refused` | leave the key in `PROVENANCE_KEYS` |

**The retirement-only test is mandatory in the landing set** (round-2 finding 7). Revision 2 put it under item 3b and named the landing test only "an ATTESTED retirement publishes" — which does not say the surviving shared values are *equal*, so an implementation could use an advancing survivor and pass while retirement-only still computed `equal` and threw. §3a states retirement-only is topology progress and 3a lands now, so the test that pins it lands now. It asserts `published`, the new manifest's **shrunk key set**, and the retirement warning.

**Held with items 3b and 4, pending ISS-081** — specified now so they resume as implementation:

| Test | Mutation it must catch |
|---|---|
| `publish: an equal watermark reports unchanged and performs NO mutating seam call` | return `published`; or return `unchanged` after staging |
| `publish: an attested retirement with otherwise-equal watermarks PUBLISHES, never unchanged` | infer `unchanged` from `verdict === "equal"` |
| `dominance: a candidate-only key alone counts as progress` | keep the one-sided `incomparable` |
| `dominance: a candidate-only key PLUS a shared advance publishes` | as above |
| `dominance: a candidate-only key PLUS a shared REGRESSION still refuses` | admit additions unconditionally |
| `dominance: addition + attested retirement + shared equality publishes` | treat either topology change as disqualifying |
| `dominance: addition + UNATTESTED removal refuses` | let an addition excuse a removal |
| `dominance: complete replacement with no shared keys, fully attested, publishes` | require a surviving shared key |

One row of the §3a-Q1 table per test, so the table and the suite cannot drift.

**On "writes NOTHING" — round-1 finding 6, and it was right.** A byte-identical postcondition proves nothing: an implementation may create, write, `chmod` and then `unlink` a staging artifact and still leave the store byte-identical, so the test passes while violating its own name. The assertion is `assert.deepEqual(fs.mutations(), [])` — the fake already exposes this and the suite already uses it exactly this way at `snapshot-store.test.mjs:326` and `:603`. Byte identity (`fs.snapshotBytes()`, as at `:131`) is kept as an **additional** assertion, not the primary one.

---

## 8. Order of work

**Landing now** — each is expressible under the semantics `dominance.ts` documents *today*, which is the test round 2 imposed and revision 2 failed:

1. Close ISS-064 with the §0 evidence (no code).
2. Item 5 — the **store-side rename only**. Lands first so later items are written against final names. The production witness is T-011's (§5).
3. Q2 — delete the uninhabited `refused`; `PublishResult` becomes single-member `published`; document that every non-publish outcome throws. **No `unchanged` member is added.**
4. Item 3a — `retireSources`, **live-side only**: the three rows of the §3a-Q1 table marked *3a, now*. No shipped assertion is edited, because no candidate-only key is involved.
5. Item 2 — `readGeneration`, the only genuinely new surface, landing last so it is written against final names.
6. `npm test` after each; `npm run test:pure` and `npm run test:allowlist` before finalize.

**Held on ISS-081** — item 3b (`unchanged`), item 4 (semantics rewrite), **and the candidate-side dominance rows**. All three encode the unresolved premise, and per round-2 finding 4 they must land in **one** change so runtime behaviour and documented contract never disagree. All are fully specified above, so they resume as implementation rather than fresh design.

**If PLAN_REVIEW judges the split still unacceptable**, the correct move is `park_item` on T-025 with ISS-081 as the reason — not a plan that writes the premise down anyway. Recorded so that choice stays explicit rather than defaulted into.

## 9. Non-goals

No new authority semantics. No lease machinery (cut per N-007 decision 4). No migration machinery — the store is a derived cache and reset is the migration. No change to `readSnapshot`'s manifest-following behaviour. No fsync on snapshot data. No change to the fs adapter's native-error boundary (T-011 owns the network adapter).
