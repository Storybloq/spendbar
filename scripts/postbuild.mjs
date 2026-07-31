/**
 * Post-build packaging fixups that `tsc` cannot do itself.
 *
 * `tsc` preserves the `#!/usr/bin/env node` line at the top of `src/cli.ts` but emits every
 * file 0644, so the declared `bin` would be installed non-executable. npm re-chmods bin
 * targets when it links them, which is exactly what makes this easy to miss: the published
 * package works while running `./dist/cli.js` from a clone does not, and so does anything
 * that execs the file by path rather than through the npm shim.
 *
 * Both properties are asserted by the packaging contract test rather than assumed here.
 */
import { chmodSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "dist", "cli.js");

const first = readFileSync(CLI, "utf8").split("\n", 1)[0];
if (first !== "#!/usr/bin/env node") {
  process.stderr.write(
    `postbuild: dist/cli.js must start with the node shebang, found ${JSON.stringify(first)}\n` +
      "  (tsc only preserves it while it is the FIRST line of src/cli.ts)\n",
  );
  process.exit(1);
}

chmodSync(CLI, 0o755);

// Prove the bit actually took rather than trusting the call: a read-only checkout or an
// exotic filesystem can make chmod a silent no-op, and the failure would then surface as a
// broken install rather than a failed build.
if (!(statSync(CLI).mode & 0o111)) {
  process.stderr.write("postbuild: chmod did not make dist/cli.js executable\n");
  process.exit(1);
}
