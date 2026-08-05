# T-013 — MCP server — re-plan against N-007 / N-008 (revision 3)

> **AMENDED 2026-08-05 — two rows of §2's supersession map are now false about the tree.** Not
> rewritten; the reasoning stands and is what produced the owner action. Commit `9524902` (ticket
> **T-026**) landed T-025 items 2 and 5.
>
> - **The `N-008 5a + N-007 #5 — pin path, readGeneration(id)` row** discharges to *"T-025 (parked),
>   T-011 (parked), ISS-083"*. Two of those three moved: `readGeneration` **exists** at
>   `src/snapshot/store.ts:2806`, and **T-011 is unparked**. **ISS-083 stays open** and is now the
>   whole of that row — `createPin` still accepts any `generationId`. AC 4's HOLD is still correct,
>   because no T-011 writer or pin-request path is *built* yet; "not built" is the premise to carry,
>   not "parked".
> - **The `N-007 #2` row** rests on *"a rename owned by a parked ticket"*. The rename **landed**:
>   the required field is `ccusageInvokedAt` (`src/snapshot/types.ts:301`). The decision to OMIT the
>   field from the public MCP schema may still be right, but it must be re-argued on its own merits
>   — the stated reason no longer exists.
>
> Unchanged: T-025's registry, coverage policies and `SnapshotPayloadV1` remain parked on
> ISS-090/ISS-091, so N-007 #1 / N-008 1a / 1b are still blocked exactly as the map says.

**Base:** `docs/t013-mcp-server-plan.md`, 295 lines, read in full.

**Revision 1: REJECTED**, 15 findings. **Revision 2: REVISE**, 12 findings. All 27 accepted, none contested. Review affirmed the structural call both times — *"The NOT-parked distinction is real: the filing explicitly cuts AC 6 and holds AC 4, unlike T-011's forbidden design"* — so this ticket revises rather than parks, and revision 2 was judged to have *"fixed the authority and ordering failures"*. Revision 3 closes the four remaining blockers: an underspecified payload contract, unresolved packaging prerequisites, inaccessible capped rows, and an AC 2 capture path no current infrastructure can execute.

**Risk: MEDIUM-HIGH.** Two prerequisites surfaced during re-planning that were absent from the plan entirely — no internal payload schema exists (ISS-087), and nothing shipping enforces the no-lifecycle-scripts constraint (ISS-074).

---

## 0. What revision 1 got wrong

| Revision 1 said | The truth | Effect |
|---|---|---|
| Base §2 Q5 "survives intact": `usage_blocks` gains a runtime `CCUSAGE_CMD` validator, recorded as a divergence from ISS-023 | **A recorded owner decision, reversed.** ISS-026 is **resolved** and says verbatim: *"the CCUSAGE_CMD runtime-validator gap is an ACCEPTED tradeoff (ISS-023, owner-delegated) — T-013 open question 6 is thereby answered: **no validator lands in T-013**; revisit only if own-the-parsing replaces ccusage."* | **Reversed. The validator is cut.** §5. And the deeper error is the method: I incorporated the base plan's *conclusions* without re-checking the decisions under them. That is incorporating by reference, one level down — the same failure that cost the T-011 re-plan its first reject. The prior session made this exact mistake on this exact question and wrote it into its handover as a lesson; I reproduced it anyway. |
| `serviceStatus` is weakened to `"undetermined-no-service-support"` on L-006 grounds, with ratification listed as an open question | The weakening **is** the honest L-006 result — review agreed no caller can witness machine-wide service absence. But **a planner may not unilaterally change an owner amendment**, and a plan cannot implement a replacement while listing its authorization as open. | **The AC 6 replacement is HELD** pending ratification (ISS-086), not implemented. §3. |
| The schema advertises `running \| not-running \| undetermined`, and `"not-running"` is "not constructible from any v0.2 code path" | Advertising two values nothing can produce is a dishonest public surface. And the absence claim is **false**: with the capability's return type including all three, `"not-running"` is merely absent from the intended composition, not unconstructible. | **Both corrected** in §3. *Caught by my own audit before review returned, and it is the same absence-proof class I criticised in revision 1's own §7 — committed one section earlier, inside the fix for it.* |
| "The packaging contract's dependency lifecycle-script scan must cover both new packages and their transitive tree" | **No such scan exists.** `packaging.contract.mjs` asserts `--ignore-scripts` was *passed* (lines 363-408) — which proves scripts did not RUN, not that none are DECLARED. The real inspector lives only in `spikes/mcp/supply-chain.mjs`, which this repo classifies as evidence, not shipping infrastructure. | **False premise.** §8 promotes it. |
| ISS-074 is "T-011's prerequisite rather than this ticket's" | T-013 cannot merge in a state that violates a hard constraint. And the removal is **not cheap**: `packaging.contract.mjs:349-353` *asserts the scripts exist* (`assert.equal(MANIFEST.scripts.prepack, "npm run build")`), for a recorded reason — `prepack` alone does not cover `npm install <git-url>`. | **ISS-074 becomes T-013's prerequisite too**, at its real cost. §8. ISS-074 updated. |
| The five tools are "pure over a `SnapshotView`" | **They have no source shape.** `GenerationDoc.payload` is `unknown` (`types.ts:305`) and the store validates only that it exists (`store.ts:1045-1049`, "The payload only has to EXIST here"; `store.ts:937` says payload is "deliberately NOT here as shapes"). No internal payload schema exists anywhere in the repo. | **The largest gap of the round, and I missed it entirely.** Filed as **ISS-087**; §6 is the new layer that closes it. |

**Also found by my own audit, and not raised by review:** AC 2 says the conformance suite runs *"against recorded real-client transcripts"*. The recorded manifests carry structured observations and SHA-256 digests, **not replayable frame bodies** — `clientToServer` is `{bytes:874, lines:4, messages:4, …}`, the whole manifest is ~4.4 KB — and they record the single probe tool `spendbar_probe`, not the five real tools. Nothing there can be replayed and the digests cannot be asserted against a different server. Filed as **ISS-088**.

### From revision 2 — verdict improved to REVISE; 12 findings, all accepted

| Revision 2 said | The truth | Effect |
|---|---|---|
| §11 restated AC 2 outright on the authority of ISS-088 | **An issue I filed myself is not an amendment.** This is the *identical* authority violation revision 1 committed on AC 6 — which I had just fixed, in this same document, exactly as instructed. Fixed the site, missed the sibling, inside the fix. **Third instance of the class-and-siblings defect this session.** | **AC 2's transcript half is now HELD** pending amendment (ISS-088), with the conformance suite kept as independently dischargeable work. §11. |
| §6: the payload schema is "derived from the shipped v0.1 aggregation core" | That names a **direction, not a schema.** `renderers.ts` is a presentation consumer that invokes live data sources, not a stored domain model. As written, nothing stopped an implementer working backward from the five MCP outputs while calling it internal-first. | **The concrete v1 schema is now in the plan.** §6. |
| §6: "validate `generation.payload` before any tool computes over it" | Validating one object and then using the original is the **exact defect already fixed once in this repo**, in `deriveFreshness` — accessors, aliases and unnormalized values come back. Proving a property of value A and then using value B. | **Branded `ValidatedPayloadV1`**, detached and normalized; tools cannot accept `GenerationDoc.payload` at all. §6. |
| §6: ISS-087 records the contract "for those tickets to pick up when they unpark" | A note **binds nobody.** T-013 could complete against synthetic payloads while T-011/T-012 later construct something different, leaving the only production integration unowned. | **A shipped writer-side conformance test**, plus recommended ticket amendments. §6. |
| §9: caps are "registry entries with declared units" | Categories, not **values**. And row caps cannot bound bytes when strings are large. | **Concrete numbers and byte-overflow behaviour.** §9. |
| §9: `usage_blocks` overflow is "range-narrow, same axis" | **Unreachable rows.** Inputs are date-based, so a client cannot narrow below one day, and one day can hold more blocks than the row cap. I fixed the unreachable-tail class for `usage_by_project` and `usage_share` and left its sibling. *(Caught by my own audit before review returned — and it is the same class as the AC 2 miss above, in the same revision.)* | **Rollup for `usage_blocks` too.** §9. |
| §9: rows + rollup "reconcile to the untruncated total" | Ambiguous, and dangerous in the bounded-partial case: a partial total could read as a complete one. Review sharpened it further — nothing required agreement with `usage_summary` over the *same* normalized query, so two adapters could give self-consistent but contradictory public answers. | **One canonical aggregate per normalized query**, shared by every tool. §6, §9. |
| §8: ISS-074 = "keep the git-URL path honest or declare it unsupported" | Two materially different outcomes left open is not an implementable prerequisite, and no command was named to replace `prepack`. | **Decided.** §8. |
| §8: the closure scan "runs before the dependency step" | The final **root** closure does not exist until the manifest and lockfile change. T-009's isolated tree proves the pair, not the resolved root lock. | **Two gates.** §8. |

---

## 1. Facts verified before this revision

| Claim | Checked | Result |
|---|---|---|
| T-009 adapter importable | `find spikes -iname "*adapter*"`, `ls src/mcp` | **Absent.** Only `spikes/mcp/candidates/{v1,v2}/server.mjs`. This ticket writes the production adapter. |
| Dependency set | `package.json`, `spikes/mcp/candidates/v2/package.json` | `dependencies` is exactly `{"ccusage":"20.0.19"}`. T-009's adopted pair is **`@modelcontextprotocol/server@2.0.0` + `zod@4.4.3`** — the zod version revision 1 left unnamed. |
| Reader API | `store.ts:2555-2564`, `2581` | `SnapshotView = {generation, quarantined: string[]}`; `readSnapshot → {status:"no-snapshot"} \| {status:"ok",view} \| {status:"partial",view,reason}`. |
| **`payload` is opaque** | `types.ts:305`, `store.ts:937`, `1045-1049` | **`payload: unknown`, existence-checked only, deliberately unshaped.** No internal payload schema anywhere. `envelope.ts`'s `SCHEMA_VERSION` versions the store **envelope**, not the payload. → §6, ISS-087. |
| `deriveFreshness` already ships | `freshness.ts:590`, `640-644`, `653-660` | Per-request, per-field, absence-is-not-covered, and returns `timezoneMismatch`. **Consume, do not rewrite.** |
| ALLOWLIST check already bidirectional | `scripts/allowlist-coverage.mjs`, `tests-ts/harness/allowlist-witness.mjs` | Execution-witnessed; both directions already fail. **Consume, do not rebuild.** |
| **Packaging contract requires the lifecycle scripts** | `packaging.contract.mjs:349-353`, `:134` | Asserts `prepack` and `prepare` equal `"npm run build"`. No transitive script scan exists. → §8. |
| **Real-client evidence is not replayable** | `evidence/real-clients/*.manifest.json` | Counters + digests + a 3-entry frame summary over `spendbar_probe`. → §11 AC 2, ISS-088. |
| No production writer | `grep publishSnapshot\|createWriteAuthority\|startWriter\|createPin src --include=*.ts` outside `src/snapshot/` | **Nothing.** → §10. |

---

## 2. Supersession map — per amendment, with an owner for each consequence

| Amendment | Effect on T-013 | Who discharges it |
|---|---|---|
| **N-007 #4 — cut the reader lease** | AC 6 CUT. Base §1 (native-error collapse argument), §2 Q2 (4000 ms, cap 1), §4 (the lease), §7's AC 6 row, §10.1 — all **withdrawn**. The replacement is **HELD** pending ratification. | T-013 deletes; owner ratifies the replacement (ISS-086). |
| **N-008 5a + N-007 #5 — pin path, `readGeneration(id)`** | AC 4 HELD by explicit instruction. Base §2 Q1 (30-min retention) and §5's cursor paragraph **suspended**, not discarded. | T-025 (parked), T-011 (parked), ISS-083. |
| N-007 #2 — `ccusageFetchedAt` → `ccusageInvokedAt` | **Revision 1 was wrong to call this "no T-013 change".** Putting the field in a public MCP schema creates an undeclared dependency on a rename owned by a parked ticket, and lets acceptance run against the obsolete key. **The field is OMITTED from the MCP public schema**, recorded as a deliberate omission in §6's total-mapping check. Freshness is already carried by `coverage`/`fieldCoverage`/`sourceTimestamps`, which are stable. | T-011 (parked) owns the rename; T-013 adds the field only after it lands. |
| N-007 #1, N-008 1a, 1b | **No T-013 surface** — all publish-path contracts; T-013 never publishes. | Blocked on ISS-082 → ISS-081. |
| N-003 — SDK pin, token budget | Consumed unchanged: exact pins, baseline +10% at completion. **No exemption for future cursor fields** (§4). | T-013. |
| **ISS-023 / ISS-026 (resolved owner decision)** | **No `CCUSAGE_CMD` runtime validator lands in T-013.** Revision 1 planned the opposite. | Settled; revisit only if own-the-parsing replaces ccusage. |

**Base-plan sections incorporated unchanged:** §2 Q3 (`--cached` = all 9 views; missing snapshot is a typed error, never empty output), §2 Q4 (validated absolute paths for the exit test; launcher registration deferred, not discharged), §6 (five tools; the `usage_hourly` test asserts the list **equals** the five), §9.

**Base-plan section CUT:** §2 Q5 — see §0.

---

## 3. AC 6 — cut, and its replacement is held rather than invented

The lease is deleted: its module, allocation and `purpose`, domain-separation tests, herd test, kill-the-holder test, private-temporary-generation rule, the 4000 ms deadline and the subprocess cap. All of it supported computation readers no longer do.

The amendment's replacement requires "a **service-not-running signal**", and **no caller can witness that premise.** Probing liveness needs T-011's coordination state (parked). Snapshot age is not process liveness. "This build has no service support" proves a fact about the artifact, not about the machine — a different installed version could be running one.

Revision 1 weakened the signal itself. Review agreed the weakening is the honest L-006 result **and** ruled that a planner may not unilaterally rewrite an owner amendment. So:

- **T-013 ships no service-status field at all until ISS-086 is answered.** The decision request is on that issue, with both options costed: (a) ratify an explicit "undetermined" value, or (b) require a true signal, in which case this half holds on T-011 beside AC 4.
- **If (a) is ratified, only the witnessable value is advertised.** A schema offering `running` and `not-running` while nothing can produce them is a dishonest public surface, and — separately — revision 1's claim that `"not-running"` was "not constructible from any v0.2 code path" was false: with all three in the capability's return type it was merely absent from the intended composition, which is an absence-proof, not a guarantee. Future values arrive as an ordinary additive versioned change (§6) when T-011 supplies a real probe.
- The rest of the amendment — an immediate answer, freshness metadata, readers never compute — ships now and is not affected.

---

## 4. AC 4 held — and the surface test must survive zod's stripping

AC 4 must not be attempted. Applying the ticket's own rule (*"Do not register a stub"*, stated for `usage_hourly`) to its sibling: **no `cursor` input and no `nextCursor` output are registered** while AC 4 is held. A parameter that always errors teaches a model to ask for something that never works.

**Revision 1's test for that was not failable, and this is the sharpest finding of the round.** Asserting `cursor` is absent from the advertised property map proves nothing about behaviour: **zod object schemas strip unknown keys by default**, so a `tools/call` carrying `cursor` would succeed with the field silently ignored while the test stayed green. Two assertions per applicable tool instead:

1. `cursor` is absent from that tool's `tools/list` input schema; and
2. a **real `tools/call` carrying `cursor` returns the typed unknown-field validation error** — which requires every input schema to be **strict**, not stripping.

Plus the mutant that makes it fail: flip one schema to strip mode and assertion 2 must go red. Input strictness is now a property of the whole tool surface, so it is generated from `schemas.ts` (§6) rather than set per tool by hand — the class-and-siblings rule applied to schema construction.

**Token budget, corrected.** Revision 1 said a note on the baseline would keep future cursor fields from tripping the +10% gate. **A note cannot change CI behaviour**, and exempting or quietly re-baselining would contradict N-003's rule that regressions past the ceiling are breaking changes. So: future cursor fields are **measured normally**, and if they exceed the ceiling the change is breaking and goes through the project's explicit schema-version and baseline-change process.

---

## 5. Decisions consumed rather than re-litigated

**`usage_blocks` ships no runtime `CCUSAGE_CMD` validator.** ISS-023 accepted the gap, ISS-026 resolved it *naming this ticket*, and the reasoning I found persuasive is not authorization to reverse it. If the MCP blast-radius argument is worth acting on, it is worth a new owner decision that explicitly supersedes ISS-023/ISS-026 — recorded, not assumed inside a plan. Until then `usage_blocks` consumes the accepted behaviour: bundled-schema contract coverage exists (ISS-002, mutation-verified); custom `CCUSAGE_CMD` payloads are unvalidated at runtime, as decided.

**Freshness is `deriveFreshness`, not a second implementation.** `src/mcp/` gets no `freshness.ts`. The tools call the shipped function and map `FreshnessResult` into the output schema; the mapping is **total**, enforced at compile time by the `satisfies` disposition of §13 — every field reaches the schema or appears in an explicit omission list, and a field added upstream breaks the build rather than being silently dropped. AC 3 uses the same call: `timezoneMismatch` already exists and becomes a typed validation error naming both zones and stating that re-bucketing is out of scope.

**Parity divergences ride the shipped ALLOWLIST.** No new checker. T-013 adds numbered entries to `tests/golden/ALLOWLIST.md`, declares them in `allowlist-assertions.json`, and calls `witness(id)` where each assertion succeeds; `scripts/allowlist-coverage.mjs` already fails both directions from execution rather than from a test's name.

**Quarantine:** `readSnapshot` returning `partial` with non-empty `quarantined` yields bounded partials from the known-good generation plus warnings — never a fabricated total, never a silent drop to a smaller number that reads as "you spent less".

---

## 6. The payload schema, the adapter layer, and real schema versioning

This section did not exist in revision 1 and is the largest change. **Three distinct versioned things**, conflated until now:

| | what it versions | where it lives | owner |
|---|---|---|---|
| `envelope.ts` `SCHEMA_VERSION` | the store envelope | `src/snapshot/envelope.ts` | T-010, shipped |
| **internal payload schema version** | what `generation.payload` contains | `src/snapshot/payload.ts` — **new** | T-013 defines; writers must satisfy |
| **MCP public schema version** | the tool input/output surface | `src/mcp/schemas.ts` | T-013 |

### 6.1 The concrete v1 payload schema

Revision 2 named a *direction* and called it a schema. The v1 core does carry real domain records, verified: `ProjectAgg {tokens, cost, byModel: Map, byCost: Map, first, last}` (`aggregate.ts:17`), `DayRow {period, totalCost, totalTokens, modelBreakdowns}` (`:26`), `ModelBreakdown {modelName, cost, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens}` (`:33`), and ccusage block rows (`startTime`, `endTime`, `actualEndTime`, `isActive`, `isGap`, `costUSD`, `totalTokens`). Those are the domain; **`renderers.ts` is not** — it is a presentation consumer that invokes live sources, and naming it as a source was the error.

`SnapshotPayloadV1` is the **JSON-canonical projection** of those records — note the stored form cannot literally be `ProjectAgg`, because `Map` is not JSON-serializable, which is exactly why the stored schema has to be written down rather than gestured at:

| dataset | record | units / identity |
|---|---|---|
| `projects[]` | `{projectId, tokens, cost, byModel: Record<model, tokens>, byCost: Record<model, cost>, first, last}` | `cost` USD as a finite non-negative number; `tokens` a non-negative safe integer; `first`/`last` explicit UTC instants; identity = `projectId`, unique |
| `days[]` | `{period, totalCost, totalTokens, modelBreakdowns[]}` | `period` a local calendar date under the generation's `timezone` + `dayBoundaryPolicy`; identity = `period`, unique |
| `modelBreakdowns[]` | `{modelName, cost, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens}` | all token fields non-negative safe integers; identity = `modelName` within its parent |
| `blocks[]` | `{startTime, endTime, actualEndTime, isActive, isGap, costUSD, totalTokens}` | explicit UTC instants; identity = `startTime`, unique |
| `totals` | `{cost, tokens}` | the canonical aggregate over the whole payload |

**Invariants, each tested:** every numeric field passes the v1 core's own `cnum` discipline (finite, non-negative, real, booleans excluded — `aggregate.ts:48`); arrays are stored in their identity's canonical sort order and a mis-sorted payload is refused; `totals` equals the sum over `projects[]` and independently over `days[]`, and a mismatch is a refusal rather than a preferred side; `modelBreakdowns` sums do not exceed their parent row. **Datasets to consumers:** `usage_summary` ← `totals`; `usage_by_project` and `usage_share` ← `projects[]`; `usage_by_day` ← `days[]`; `usage_blocks` ← `blocks[]`; the nine `--cached` CLI views read the same records, so CLI and MCP are two consumers of one domain rather than two domains.

### 6.2 The proven value is the value used

"Validate before computing" does not establish that the *validated* object is the one that gets read — and this repo has already fixed that exact defect once, in `deriveFreshness`, where validating one object and then reading the caller's could reintroduce accessors, aliases and unnormalized values. Proving a property of value A and using value B is the project's defect class (b), and revision 2 re-specified it.

So the validator **returns a detached, normalized value carrying an opaque runtime brand, `ValidatedPayloadV1`**, produced by the same detach discipline the store uses on its own documents. Every tool signature and every `--cached` view accepts `ValidatedPayloadV1` and **cannot accept `GenerationDoc.payload`** — the brand is unforgeable outside the validator, so the barrier is structural, not a convention. Mutants: one that validates and then forwards the *original* object must fail; one that hand-constructs a branded-looking value must fail. Refusals are typed for malformed, missing, extra-field and **newer-version** payloads — an older reader meeting a newer payload refuses rather than guessing.

### 6.3 One canonical aggregate

Every tool computes from **one canonical aggregate per normalized query**, not from its own pass. That is what makes cross-tool consistency a property rather than a coincidence: `usage_summary` for a range and `usage_by_project` rows plus rollup for the *same* normalized range and provider filter reconcile to the same numbers, by construction. Summation order is fixed by the canonical sort so floating-point results are deterministic; share percentages derive from the same aggregate's total. Tested across cost, tokens, count and share, including ties, zero totals, and every provider-filter combination.

**Reconciliation says what it means.** "Rows + rollup = the total" is a claim about the *validated payload*, not about reality: on a quarantined generation the payload is a bounded partial, so the total is the known-good total and the warnings say so. Two separate claims, never merged — merging them is how a partial reads as complete.

### 6.4 Public schemas, and binding the writers

**MCP public schemas are derived through adapters**, one per tool, carrying an explicit version in a registry. `tools/list`, input validators, response validation and AC 10's measurement all derive from that registry — a tool added without an entry fails the build rather than shipping unmeasured. Compatibility rule, tested: an internal payload change **cannot** silently alter MCP output; internal→public adapters are tested independently of the tools, so a version bump on either side fails a test rather than propagating.

**Binding the writers is code, not a note.** Recording ISS-087 for parked tickets to "pick up" binds nobody: T-013 could complete against synthetic payloads while T-011/T-012 later construct something different, leaving the only production integration unowned. So T-013 ships a **writer-side conformance test** alongside the schema — an executable contract, wired into the suite, that any producer of a payload must pass, plus the constructor API through which a conforming payload is built. A future writer that publishes a non-conforming payload fails a shipped test rather than diverging quietly. **Additionally recommended, and flagged as owner action** (§13): amend T-011 and T-012 so their publish acceptance requires building the payload through that API.

---

## 7. What gets built

| module | responsibility |
|---|---|
| `src/snapshot/payload.ts` | The §6.1 schema, versioned; the branded `ValidatedPayloadV1` validator (§6.2); the canonical-aggregate builder (§6.3); the writer-side constructor API and conformance test (§6.4). |
| `src/mcp/schemas.ts` | Versioned public registry — input (strict) and output schemas; single source of truth for `tools/list`, validators and AC 10. |
| `src/mcp/adapters/*.ts` | Internal payload → public DTO, one per tool, independently tested. |
| `src/mcp/adapter.ts` | The ~50-line SDK adapter, written here, informed by `spikes/mcp/candidates/v2/server.mjs` but importing nothing from `spikes/`. The only module touching `@modelcontextprotocol/server`. Exposes a registration seam instrumentable for AC 1. |
| `src/mcp/server.ts` | Registration of exactly 5 tools, stdio wiring, stdout purity. |
| `src/mcp/tools/*.ts` | One per tool, pure over a validated payload DTO + `FreshnessResult`. |
| `src/mcp/cached.ts` | `--cached` for the CLI, and its ALLOWLIST entries. |

No `freshness.ts`, no `lease.ts`, no `cursor.ts`, no `service-status.ts` (held, §3), no `CCUSAGE_CMD` validator (§5).

**Dependencies:** `@modelcontextprotocol/server@2.0.0` and `zod@4.4.3`, both exact-pinned in the **root** manifest per N-003, `zod` direct per T-009's phantom-dependency finding, added only as `src/mcp` lands — and only after §8's gates, because adding them under an unenforceable constraint would be an unchecked claim.

---

## 8. Prerequisites — now T-013's, at their real cost

**1. ISS-074 — remove root `prepack` and `prepare`.** Not the cheap fix an earlier handover recorded: `packaging.contract.mjs:349-353` **asserts both scripts exist**, deliberately, and line 134 relies on `npm pack` running `prepack` to prove `dist` is not stale. Revision 2 left two outcomes open, which is not an implementable prerequisite. **Decided:**

- **Registry-package installation is the supported channel; `npm install <git-url>` is NOT supported.** That is already this project's stated distribution posture (T-016's matrix is registry-package extraction across npm/pnpm/yarn/bun), and `prepare` existed only to cover the git-URL path. Its contract case is removed and the boundary is documented rather than left implied.
- **Replacing `prepack`'s guarantee:** the release/CI path runs `npm run build && npm pack` as an explicit step, and the packaging contract takes the **candidate tarball as an input** rather than cutting its own. The non-stale-`dist` witness becomes a content check — every `dist/*.js` the tarball ships is byte-identical to a fresh build from the same tree — which is a *stronger* proof than "`prepack` ran", because it fails on a stale `dist` even if a build step ran and produced nothing.
- **The stale-`dist` mutant:** edit a source file without rebuilding, then pack. The contract must fail. That mutant is what makes the replacement real; `prepack`'s guarantee was never itself tested.

**2. Two supply-chain gates, not one.** Revision 2 said the closure scan runs "before the dependency step", but the final **root** closure does not exist until the manifest and lockfile change — T-009's isolated candidate tree proves the adopted *pair*, not that the root lock resolves the same closure.

- **Preflight:** scan T-009's exact candidate closure before the manifest is edited.
- **Post-resolution:** after `@modelcontextprotocol/server@2.0.0` + `zod@4.4.3` land and the lockfile resolves, scan the **final installed root closure** — every transitive package manifest for lifecycle scripts, plus `gypfile` and `binding.gyp` for native builds, with install scripts disabled during inspection. This gate is a prerequisite of *acceptance*, not of the edit.
- The inspector is promoted from `spikes/mcp/supply-chain.mjs` to a maintained root contract **with its existing mutation tests**, and the final-root scan is wired into `test:contract` so it runs on every change rather than once.

**3. ISS-086 ratification** decides whether the service-status half is in scope (§3). The rest proceeds either way.

---

## 9. Bounded results — concrete caps, and no unreachable rows

Revision 1 removed cursors without choosing caps or checking that truncated rows stay reachable, and asserted narrowing "by project" that the input schema does not offer (the ticket names provider filters, not project filters). Per tool:

| tool | rows | sort | overflow behaviour |
|---|---|---|---|
| `usage_summary` | 1 | — | none possible |
| `usage_by_day` | one per day in range | date asc | **top-N + `otherDays` rollup**, *and* range-narrow reaches every omitted row (the date range is the axis and one day is one row) |
| `usage_blocks` | one per block in range | start time asc | **top-N + `otherBlocks` rollup** — and this is the one where range-narrowing is *not* enough. Revision 2 said "range-narrow, same axis" and that was wrong: inputs are date-based, so a client cannot narrow below one day, and one day can hold more blocks than the row cap. |
| `usage_by_project` | one per project | sort key desc | **top-N + `otherProjects` rollup** `{count, cost, tokens}` |
| `usage_share` | one per project | share desc | **top-N + `otherProjects` rollup**, share included |

**Every row-producing tool carries a rollup**, including the two whose date axis already makes omitted rows reachable. Revision 2's table gave rollups only to the tools with no narrowing axis, which left `usage_by_day` able to truncate 366 days to 100 with no accounting for the other 266 — so §6.3's reconciliation would have held for three tools and silently not for the fourth. A per-tool exemption is exactly the class-and-siblings defect; the rollup is uniform and range-narrowing is an additional convenience where the axis exists, not a substitute for the invariant.

**Concrete caps** (registry entries, §13, declared units, validated as positive bounded safe integers):

| cap | value | unit | over-limit behaviour |
|---|---|---|---|
| range | **366** | days | **reject** with a typed error naming the limit — silently truncating a *requested range* would answer a different question than the one asked |
| rows | **100** | count | **truncate + rollup**, `truncated: true` with the applied cap |
| string field | **512** | bytes | reject the payload at validation (§6.2), not at render — an over-long identifier is a payload defect |
| response body | **1 048 576** | bytes | reduce N and re-serialize until it fits, then report the *effective* cap; if a **single row** exceeds it the tool returns a typed error rather than a partial row |

Row caps cannot bound bytes on their own, which is why the byte cap is enforced independently and the string cap sits at validation. Each boundary is mutation-tested at cap−1 / cap / cap+1, and unit confusion (days passed as ms, bytes as count) fails.

**What the rollup does and does not claim.** It keeps the *totals* correct without fabricating rows, and it is the honest answer where no narrowing axis exists. It reconciles to the canonical aggregate of §6.3 — the same aggregate `usage_summary` uses for the identical normalized query — so the two tools cannot contradict each other. It does **not** claim completeness against reality: on a quarantined generation the aggregate is a bounded partial and the warnings say so (§6.3).

Tested per row-producing tool: every omitted row is either retrievable by a documented narrower query **or** accounted for in the rollup; rows + rollup equal the canonical aggregate; and `usage_summary` over the same normalized query equals that same aggregate.

---

## 10. Snapshots with no writer

Nothing in production writes a snapshot — verified, no caller of `publishSnapshot` outside `src/snapshot/`. Generations come from a **test-only publisher** writing through T-010's real `publishSnapshot` behind a real authority: real store, real invariants, real atomic publish, test caller.

Revision 1 said it was "nominally runtime-branded" and left it there — which conflates compile-time nominal typing with a runtime brand and specifies nothing executable. Made concrete:

- It lives at **`tests-ts/harness/seed-publisher.mjs`**, outside `src/`, so it cannot be reached by a production import path.
- The brand is a **runtime-unforgeable value** minted in that module and checked by the helper, not a TypeScript-only nominal type.
- A test asserts the **packed file list excludes it** (the packaging contract already enumerates tarball contents).
- **The mutant:** move or import it under `src/` and packaging or the architecture check must fail. A source scan alone proves only today's composition — any sibling helper that publishes reaches production without constructing the branded class, which is the absence-proof defect the T-011 base document had already rejected for its own recording publisher.

**AC 9 measures the read path against a seeded warm store.** Honest for what T-013 owns, and recorded plainly: **v0.2 cannot exit AC 9 in the product sense while nothing writes a snapshot.** That is T-011's.

---

## 11. Verification by acceptance criterion

- **AC 1** — two assertions, because the exact-set check does not witness "registered once": the **adapter seam is instrumented** and asserts exactly one registration call per tool name and exactly one output schema supplied (duplicate registration can collapse to a single listed tool, or fail inside the SDK, and `tools/list` would look identical); **plus** the end-to-end assertion that `tools/list` **equals** the five names — not "does not contain `usage_hourly`", which passes trivially and survives the tool being registered under another name.
- **AC 2 — split: half discharged, half HELD.** Revision 2 restated this AC outright on the authority of ISS-088, an issue I had filed myself. **That is the same authority violation revision 1 committed on AC 6, at the sibling site, inside the fix for it.** An issue is not an amendment.
  - **(i) Discharged now — the conformance suite.** Promoted from `spikes/mcp/` with the §8 infrastructure and run against the production five-tool server: initialize, tools/list, tools/call, malformed framing, schema-violating arguments, cancellation, EOF, stdout purity — with a mutant writing one stray `console.log` that must fail. This half depends on nothing external and is the substance of AC 2.
  - **(ii) HELD — the recorded-transcript requirement.** The recorded evidence cannot satisfy it: the manifests are counters, digests and a 3-entry frame summary over `spendbar_probe`, with no replayable bodies, and digests over a probe tool's traffic cannot be asserted against a five-tool server. **Fresh capture is also not executable with the current harness** — `spikes/mcp/real-client/capture.mjs` hard-codes four `client × candidate` cells, the `spendbar_probe` tool, nonce-specific prompting and classification, candidate assembly, capture IDs, evidence filenames and receipt verification; and a production server additionally needs a **synthetic seeded store**, or the call reads the operator's real usage state (a fixture-hygiene violation) or returns `no-snapshot`. So this half waits on an owner amendment (ISS-088) authorizing the replacement, and on the capture-profile work below.
  - **What the replacement would require, specified so the amendment can be costed:** a T-013 capture profile of two `client × production-v2` cells; a synthetic seeded store outside the repo; one deterministic five-tool call with schema-valid arguments; updated classifier, sanitizer, provenance and receipt verification; and no access to user snapshot state. The caller is the **authenticated owner-machine operator** — unavailable credentials or quota is a *recorded environmental result*, never a CI pass. Per `docs/codex-mcp-approval.md` the non-interactive Codex capture sets `default_tools_approval_mode = "approve"` **and asserts `tools/call` was received**, or a client-side cancellation records as a spendbar failure and the test measures the harness. Scrubbing rules apply to any fresh capture.
- **AC 3** — unequal-timezone query errors naming both zones and stating re-bucketing is out of scope; equal-timezone succeeds.
- **AC 4** — **HELD.** Replaced by §4's two failable assertions per applicable tool plus the strip-mode mutant, and truncation reporting the applied cap.
- **AC 5** — freshness per actual range coverage; a field absent from `fieldCoverage` reported as not covered; quarantine → bounded partials with warnings; the `FreshnessResult` mapping is total.
- **AC 6** — **CUT**; replacement **HELD** on ISS-086 (§3).
- **AC 7** — `--cached` spawns no ccusage subprocess, asserted via the **injected runner** (an observable, not an absence of evidence); snapshot-derived output with freshness; no snapshot → typed error naming the view, never empty output.
- **AC 8** — every `--cached` divergence has an ALLOWLIST entry, a declaration, and an execution witness; `npm run test:allowlist` green both directions; byte parity green for all non-`--cached` invocations.
- **AC 9** — week-per-project under 2 s warm from both real clients against a seeded warm store; deterministic proxies hard-gate CI.
- **AC 10** — `tools/list` serialized size and proxy token count committed as baseline at completion; CI fails past baseline +10%; **no exemption** for future cursor fields (§4).
- **New, from §6** — internal payload validation: malformed, missing, extra-field and newer-version payloads each refuse with a typed error; internal→public adapters tested independently; an internal schema change cannot silently alter MCP output.

---

## 12. Build order

### Construction
1. **Gates:** ISS-074 removal + the tarball-input contract and stale-`dist` mutant; promotion of the closure inspector with its mutation tests; **preflight** closure scan (§8).
2. `src/snapshot/payload.ts` — the §6.1 schema, its version, the branded `ValidatedPayloadV1` validator (§6.2), the canonical-aggregate builder (§6.3), and the **writer-side conformance test + constructor API** (§6.4).
3. `src/mcp/schemas.ts` — versioned registry, strict inputs generated, numeric registry with §9's values.
4. `adapter.ts` against `@modelcontextprotocol/server@2.0.0` + `zod@4.4.3`; dependencies enter the root manifest, then the **post-resolution root-closure scan** (§8) wired into `test:contract`.
5. `server.ts` — stdio wiring, stdout purity, registration through the adapter only.
6. Store read seam + branded seed publisher + `deriveFreshness` mapping + `src/mcp/adapters/*`.
7. `tools/*.ts`, five of them, with §9's caps and rollups.
8. `cached.ts` + ALLOWLIST entries and witnesses.
9. Token-cost measurement, baseline commit, CI gate.
10. **The T-013 real-client capture profile** (§11 AC 2(ii)) — built only if ISS-088 is amended; it is a distinct body of work from the scripted suite and revision 2 had no step owning it.

### Acceptance — each AC after the step that makes it honest
| After | ACs |
|---|---|
| 3 | the §4 cursor-surface assertions (schema-level half) |
| 4 | the post-resolution closure scan (a prerequisite of accepting the dependency step, not of making it) |
| 7 | **1** (registration instrumentation + exact set), **2(i)** (the scripted conformance suite — needs every handler callable and its payload/freshness dependencies), **3**, **5**, §6's payload-validation, aggregate-reconciliation and cross-tool-agreement checks |
| 8 | **7**, **8** |
| 9 | **10** |
| 10 | **2(ii)** — only after verified two-client receipts, and only if amended |
| everything | **9** (real clients, seeded warm store); the §4 assertions re-run last so a late-added cursor field cannot slip in |

---

## 13. Obligations, open questions, honest gaps

**Obligations live in generated artefacts, not prose.** One typed numeric registry — row cap `100` (`count`), range cap `366` (`count`, days), string-field cap `512` (`bytes`), response-body cap `1 048 576` (`bytes`), `readSnapshot` attempts (`count`, bounded 1..16 by the store) — with validation and mutation cases **generated** from it; an undeclared numeric field fails the build. Counts are positive bounded safe integers, not durations (`2.5` and `2**60` pass a duration check; neither is a count). `schemas.ts` is the single source of truth for the tool surface, input strictness included. The seed publisher is runtime-branded and packaging-excluded (§10). The `ValidatedPayloadV1` brand is unforgeable outside the validator (§6.2).

**The total `FreshnessResult` mapping is a COMPILE-time obligation.** Revision 2 said a test asserts the mapping is total, but a runtime fixture cannot observe a newly added interface key the fixture never contains — the test would stay green through exactly the change it exists to catch. So the disposition is declared as `satisfies Record<keyof FreshnessResult, "mapped" | "omitted">` and the adapter checks derive from it: adding a field to `FreshnessResult` upstream produces a **build failure**, not a passing test.

**Open, each with its holder:**

1. **ISS-086** — ratify the `serviceStatus` weakening, or hold that half on T-011. Blocks only §3.
2. **ISS-088** — amend AC 2 to authorize the two-part replacement, or AC 2(ii) stays held (§11). AC 2(i) proceeds either way.
3. **AC 4** — held on T-025, T-011 and **ISS-083**.
4. **ISS-087 / owner action** — T-013 binds writers in code (§6.4), which is the part within its power. **T-011 and T-012 should additionally be amended** so their publish acceptance requires building the payload through the shared constructor API. Recommended here rather than done, because amending another ticket's acceptance is the authority line this plan has now crossed twice; the shipped conformance test is what makes the omission non-fatal meanwhile.
5. **ISS-074 + the closure-scan promotion** — prerequisites (§8), now decided rather than optional, and ISS-074 is materially more expensive than previously recorded.
6. **AC 9 cannot exit v0.2 in the product sense** while nothing writes a snapshot (§10).
7. **Base Q4's launcher registration is deferred, not discharged** — absolute paths measure the same latency but do not prove the registration path; v0.3's doctor/upgrade matrix owns it.
8. **ISS-086's housekeeping half** — the ticket still carries the full lease design as live text.

**Not built here:** `usage_hourly`; timezone re-bucketing; MCP resources and prompts; non-stdio transports; registration UX and `doctor` health checks (v0.3).
