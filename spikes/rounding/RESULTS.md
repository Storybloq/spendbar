# T-001 rounding spike — RESULTS (2026-07-31)

**Verdict: GATE PASSED.** `pyFixed2()` in `spike.mjs` reproduces Python's `f"{x:,.2f}"`
byte-for-byte on every tested double. Ready to become `src/format.ts`.

## Run

```
$ node spikes/rounding/spike.mjs        # node v22.18.0, python3 (system)
corpus size:      123,576
float mismatches: 0
int   mismatches: 0
corpus catches toFixed divergences: 17274
corpus catches Intl divergences:    17548
```

## Algorithm

Decode IEEE-754 bits → `|x| = M × 2^E` (BigInt M; subnormals via `E = −1074`, no implicit
bit). Cents `= M × 100 × 2^E` computed exactly: for `E ≥ 0` a BigInt shift; for `E < 0`
quotient/remainder against `2^k`, comparing the exact remainder to `half = 2^(k−1)` —
round up above, down below, **half-even only at a true binary tie** (only exactly-
representable midpoints, i.e. odd multiples of 1/8, ever hit this branch). Sign from the
sign bit (matches Python's `-0.00`). No floating-point intermediate exists anywhere.

## Corpus design (why a green result is meaningful)

The plan review showed a naive spike would green-light broken formatters (0.125 passes on
Intl; all exact-2-decimal fixture values pass everywhere). This corpus therefore includes:

- every divergence value from the review table (2.675, 0.005, 0.015, 0.025, 12.345, 0.125…)
- **midpoint neighborhoods**: `d.cc5` decimal strings across 10 magnitudes, nearest double
  plus both bit-neighbors (just-below/just-above), positive and negative
- **exact binary ties**: odd multiples of 1/8 (the only class where `x×100` is a
  half-integer), small and at 1e6/1e9/1e12 scale
- specials: ±0, subnormals (5e-324), max double, 1e21, 1e300
- fuzz (deterministic xorshift64*, FUZZ=120000): 30% bit-random finite doubles,
  40% uniform cost-like ranges, 30% log-uniform magnitudes

Negative controls: the corpus catches **17,274** `toFixed` divergences and **17,548**
`Intl halfEven` divergences — i.e., it demonstrably detects both known-broken approaches.

## Cross-process exactness

Values cross to Python as 16-hex-digit bit patterns (`struct.unpack(">d", …)`), never as
decimal strings — the comparison is on identical bit patterns by construction.

## Carry into v0.1

- Port `pyFixed2`/`pyThousands` verbatim to `src/format.ts`; keep this spike as the
  standing differential test (CI: FUZZ=120000 deterministic; seed fixed at 0x5eed).
- Seed long-decimal sentinels (e.g. 83.99499999999999, 7.377597) into fake-ccusage
  fixtures so golden tests permanently carry this class (plan §TypeScript port).
- Integer grouping (`fmt()`) verified against `f"{n:,}"` including negatives.
