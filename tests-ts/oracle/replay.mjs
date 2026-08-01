/**
 * A Python-free stand-in for `tests/fake_ccusage.py`, served from the committed artifacts.
 *
 * The subject spawns whatever `CCUSAGE_CMD` names, so pointing that at
 * `node tests-ts/oracle/replay.mjs` puts this file exactly where the Python fixture normally
 * sits. It reads `FAKE_MODE` and its own argv, finds the recorded response, and reproduces it
 * byte for byte — including the exit status and whether the process was killed by a signal.
 *
 * There is NO default and NO nearest-match. An unrecorded (mode, argv) exits 97 with a
 * diagnostic naming the miss. That is deliberate and is the main design decision in this file:
 * a fixture that quietly served "normal" for an unknown mode would convert a hole in the
 * recording into a plausible wrong answer, and the test would pass. Failing loudly means the
 * only way this replayer can be wrong is by being obviously wrong.
 *
 * Exit 97 is chosen to collide with nothing the real fixture uses (0, 1, 2) so a replayer miss
 * can never be mistaken for a modelled ccusage failure.
 */
import { writeSync } from "node:fs";

import { lookup } from "./artifacts.mjs";

const MISS = 97;

const mode = process.env.FAKE_MODE ?? "normal";
const argv = process.argv.slice(2);

let response;
try {
  response = lookup(mode, argv);
} catch (err) {
  process.stderr.write(`replay.mjs: ${err.message}\n`);
  process.exit(MISS);
}

// Written synchronously so nothing is lost when the process exits below. `process.exit` does
// not flush a pending async write to a pipe, and a truncated payload here would surface as a
// JSON parse error in the subject — a confusing symptom several layers from its cause.
if (response.stdout.length) writeAll(1, response.stdout);
if (response.stderr.length) writeAll(2, response.stderr);

if (response.termination.kind === "signal") {
  // Reproduce the death, rather than reporting it as an exit code. The recording distinguishes
  // the two precisely so a replay cannot collapse them, and a subject that treats a signal
  // death differently from a nonzero exit must see the difference here.
  process.kill(process.pid, response.termination.status);
} else {
  process.exit(response.termination.status);
}

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      // EAGAIN on a non-blocking pipe is not an error, just backpressure; anything else is.
      if (err.code !== "EAGAIN") throw err;
    }
  }
}
