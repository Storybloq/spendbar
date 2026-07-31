#!/usr/bin/env node
/**
 * The shipped executable — `package.json`'s `bin` points here.
 *
 * It is the sibling of `tests-ts/harness/cli-wrapper.mjs` and shares `runCli` with it, so
 * the write path, the EPIPE guard and the exit-code rules that parity exercises are the
 * same ones users get. The only differences are the three values this file supplies:
 *
 *   prog   "spendbar", the product name. The wrapper passes "usage" instead so its output
 *          can be compared against the Python oracle byte-for-byte; that substitution is
 *          ALLOWLIST 22 and is the ONLY sanctioned difference between the two entrypoints.
 *   today  the real local clock, where the wrapper freezes an anchor so two sequential runs
 *          cannot straddle midnight.
 *   env    the real environment.
 *
 * `prog` is a compile-time constant on purpose: reading it from the environment would let a
 * caller forge the program name that appears in usage and error text.
 *
 * The shebang above must survive compilation — `tsc` preserves it, but emits no executable
 * bit, so the build sets that separately. Both are checked by the packaging contract test.
 */
import { runCli } from "./io.js";

runCli({
  argv: process.argv.slice(2),
  prog: "spendbar",
  today: () => {
    const d = new Date();
    return (
      String(d.getFullYear()) +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0")
    );
  },
  env: process.env,
});
