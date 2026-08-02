// Is THIS module the one node was asked to run? (review round 2)
//
// Every executable module in this repository ends with a direct-entry guard, so that importing
// it for one of its exported functions does not also run its main(). The obvious spelling,
//
//     if (import.meta.url === `file://${process.argv[1]}`) main();
//
// is wrong in two ways, and both of them fail SILENTLY — main() simply never runs, the process
// exits 0, and the caller reads that as success. For scripts/privacy-scan.mjs, which
// guarded-commit.mjs spawns and whose exit code is the gate on every commit, "exits 0 having
// scanned nothing" is indistinguishable from "scanned everything and found nothing":
//
//   * `import.meta.url` is a URL, so a path component containing a space arrives percent-encoded
//     (`/my%20repo/`) while `process.argv[1]` holds the literal path. A repository checked out
//     under a directory with a space in its name silently loses its privacy scanner.
//   * node resolves `process.argv[1]` to an absolute path but does NOT follow symlinks, while
//     the module URL is the realpath. Running anything through a symlinked directory — on macOS
//     /tmp is a symlink to /private/tmp, which is where the tests build their fixtures — does
//     not match either.
//
// Normalising both sides through realpath and the same URL encoder is what makes the comparison
// mean what it looks like it means.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string} moduleUrl the caller's own `import.meta.url`
 * @returns {boolean} true only when node was invoked on that module
 */
export function isDirectEntry(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false; // `node -e`, a REPL, or an embedder: nothing was run from a file
  try {
    // BOTH sides go through realpath, and the comparison happens on filesystem paths rather than
    // URLs. Normalising only argv[1] was still wrong under `--preserve-symlinks-main` (settable
    // via NODE_OPTIONS, so not an exotic invocation): that flag makes the main module URL keep
    // the SYMLINK path while realpath resolves argv[1] to the target, and the two disagree again
    // — silently, in the same direction as before (review round 2, chunk 2).
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    // Either path does not name a file that exists, so this module cannot be the entry point.
    // Returning false rather than throwing keeps a merely-imported module importable; the only
    // thing lost is a main() that was never going to be the right one to run.
    return false;
  }
}
