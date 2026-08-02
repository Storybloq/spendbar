// The tee wrapper the real client spawns as its "MCP server" (plan §9).
//
//   node capture-wrapper.mjs <isolated-root> <raw-capture-dir>
//
// It spawns the actual candidate server from the assembled isolated root and tees both
// directions raw, BEFORE any parsing: client->server bytes, server->client bytes, server
// stderr. This is what makes the stream-discipline oracle a claim about bytes that existed
// rather than frames that survived — and it is also where the §2 environment allowlist is
// ENFORCED AT PROCESS CREATION: whatever environment the client hands this wrapper, the
// candidate server's env is constructed from the literal allowlist, never inherited.

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildServerEnv } from "../isolate.mjs";

const [root, rawDir] = process.argv.slice(2);
if (!root || !rawDir) {
  process.stderr.write("capture-wrapper: usage: capture-wrapper.mjs <root> <raw-dir>\n");
  process.exit(2);
}

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: buildServerEnv({}),
  stdio: ["pipe", "pipe", "pipe"],
});

const tee = (name) => join(rawDir, name);
writeFileSync(tee("client-to-server.raw"), "");
writeFileSync(tee("server-stdout.raw"), "");
writeFileSync(tee("server-stderr.raw"), "");

process.stdin.on("data", (d) => {
  appendFileSync(tee("client-to-server.raw"), d);
  child.stdin.write(d);
});
process.stdin.on("end", () => child.stdin.end());
child.stdout.on("data", (d) => {
  appendFileSync(tee("server-stdout.raw"), d);
  process.stdout.write(d);
});
child.stderr.on("data", (d) => {
  appendFileSync(tee("server-stderr.raw"), d);
  process.stderr.write(d);
});
child.on("exit", (code, signal) => {
  writeFileSync(tee("server-exit.json"), JSON.stringify({ code, signal }) + "\n");
  process.exit(code ?? 0);
});
