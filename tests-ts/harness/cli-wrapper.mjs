/**
 * TEST-ONLY entrypoint for the TypeScript CLI, the mirror of tests/harness/usage-wrapper.py.
 *
 * It goes through the same `runCli` the shipped binary uses and differs only in what it
 * injects: `prog: "usage"` so output can be compared against the Python oracle, and a frozen
 * `today` so two sequential runs cannot straddle midnight. Neither value is read from the
 * environment on either side, so nothing a user sets can reach them.
 *
 * Sharing `runCli` is deliberate: the write path, the EPIPE guard and the exit-code rules are
 * the thing under test, so a wrapper with its own copy of them would be testing itself.
 *
 * Usage: node cli-wrapper.mjs --anchor YYYY-MM-DD -- <argv for the CLI>
 */
import { runCli } from "../../dist/io.js";

const argv = process.argv.slice(2);
if (argv[0] !== "--anchor" || argv[2] !== "--") {
  process.stderr.write(`cli-wrapper: expected \`--anchor YYYY-MM-DD -- <argv>\`, got ${JSON.stringify(argv)}\n`);
  process.exitCode = 2;
} else if (!/^\d{4}-\d{2}-\d{2}$/.test(argv[1])) {
  process.stderr.write(`cli-wrapper: malformed anchor ${JSON.stringify(argv[1])}\n`);
  process.exitCode = 2;
} else {
  const anchor = argv[1];
  runCli({
    argv: argv.slice(3),
    prog: "usage",
    // deps.today() is YYYYMMDD; the anchor is spelled YYYY-MM-DD so both wrappers take the
    // identical form on the command line.
    today: () => anchor.replaceAll("-", ""),
    env: process.env,
  });
}
