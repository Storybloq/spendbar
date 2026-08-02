/**
 * Platform gates for the T-008 spikes.
 *
 * The locking and credential evidence is POSIX-specific by nature — it uses `ps`, `process.getuid`,
 * Unix-domain sockets, Unix permission and ownership semantics, and SIGKILL. Wiring all of it
 * into `test:all` unconditionally made the repository-wide gate unrunnable on Windows, which the
 * package advertises support for. Gating only the two Darwin-empirical assertions did not fix
 * that: the surrounding suites are POSIX-only regardless of what they assert.
 *
 * So the split is by REQUIREMENT, not by convenience:
 *
 *   POSIX_ONLY   needs uid/permissions/unix sockets/signals   -> skipped with a reason elsewhere
 *   DARWIN_ONLY  asserts a measured macOS fact (the /tmp symlink layout), and gates the
 *                non-asserting ephemeral-range REPORT -- round 14 demoted that range check from an
 *                assertion to a diagnostic, because the module accepts any non-privileged port
 *
 * `npm run test:spikes` runs the portable group everywhere and the POSIX group where it applies.
 * The Darwin CI job must report ZERO skips, so a skip can never quietly become permanent on the
 * platform this gate was measured for.
 */
export const POSIX_ONLY = process.platform === "win32"
  ? "POSIX-only: needs uid, Unix permissions, Unix-domain sockets and SIGKILL"
  : false;

export const DARWIN_ONLY = process.platform !== "darwin"
  ? "measured on macOS only: /tmp symlink layout, plus ephemeral-range reporting"
  : false;
