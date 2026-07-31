/**
 * A subject process with fully specified behaviour, used to self-test the harness.
 *
 * The harness's job is to notice when two runs differ. A harness that compares nothing
 * passes every case it is given, which looks exactly like success. So before it is pointed
 * at the real implementations it is pointed at this stub, whose stdout bytes, stderr bytes
 * and manner of termination are dictated on the command line — including bytes that are
 * not valid UTF-8, and death by signal, which are the two cases a naive harness gets wrong.
 *
 *   node stub.mjs --stdout <base64> --stderr <base64> --exit <n>
 *   node stub.mjs --stdout <base64> --signal SIGTERM
 *   node stub.mjs --repeat <base64> --times <n> --stdout <base64>   # large output
 *   node stub.mjs --dump-env            # writes its own environment as JSON to stdout
 *
 * Large output goes through `--repeat`, not `--stdout`, because ARG_MAX is 1 MiB on macOS
 * (measured) and a multi-megabyte base64 argument fails to spawn at all — which the
 * harness correctly reports as a spawn error, and which is not the thing under test.
 */
import { writeSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

if (argv.includes("--dump-env")) {
  writeSync(1, JSON.stringify(process.env));
  process.exit(0);
}

const repeat = Buffer.from(flag("--repeat") ?? "", "base64");
const times = Number(flag("--times") ?? 0);
const out = Buffer.from(flag("--stdout") ?? "", "base64");
const err = Buffer.from(flag("--stderr") ?? "", "base64");
if (repeat.length && times) writeSync(1, Buffer.alloc(repeat.length * times).fill(repeat));
if (out.length) writeSync(1, out);
if (err.length) writeSync(2, err);

const signal = flag("--signal");
if (signal) {
  process.kill(process.pid, signal);
  // If the signal is caught or ignored, do NOT fall through to a clean exit: that would
  // turn "died by signal" into "exited 0" and quietly weaken the test.
  setTimeout(() => process.exit(99), 1000);
} else {
  process.exit(Number(flag("--exit") ?? 0));
}
