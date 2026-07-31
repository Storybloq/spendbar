/**
 * Step 4: the table frame and the process write path.
 *
 * `renderTable` is compared against CPython's `render_table` directly — the oracle is nine
 * lines of `print`, so a differential is both cheap and exact, and it removes any argument
 * about what "an empty total still prints" means.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { renderTable } from "../dist/table.js";
import { createPipeGuard, EPIPE_EXIT } from "../dist/io.js";

// ---------------------------------------------------------------- renderTable vs CPython

const PY = `
import json, sys
def render_table(hdr, rows, total=None, bottom_rule=True):
    out = []
    out.append(hdr); out.append("-" * len(hdr))
    for line in rows:
        out.append(line)
    if bottom_rule:
        out.append("-" * len(hdr))
    if total is not None:
        out.append(total)
    return "".join(l + "\\n" for l in out)
cases = json.loads(sys.stdin.read())
print(json.dumps([render_table(c["hdr"], c["rows"], c.get("total"), c.get("bottom_rule", True)) for c in cases]))
`;

const CASES = [
  { hdr: "Project        Cost", rows: ["alpha          $1.00", "beta           $2.00"] },
  { hdr: "H", rows: [] },
  { hdr: "", rows: [] },
  { hdr: "Project | Cost", rows: ["a | b"], total: "TOTAL          $3.00" },
  // `total is not None` is a presence test, not a truthiness test: an EMPTY total still
  // prints its blank line. Truthiness would silently drop it.
  { hdr: "H", rows: ["r"], total: "" },
  { hdr: "H", rows: ["r"], bottom_rule: false },
  { hdr: "H", rows: ["r"], total: "T", bottom_rule: false },
  // Rule length is len(hdr) in CODE POINTS: a UTF-16 count makes this rule two dashes long.
  { hdr: "a\u{1F600}b", rows: ["x"] },
  { hdr: "日本語ヘッダ", rows: ["行"], total: "計" },
  { hdr: "H", rows: ["", ""], total: "T" },
];

function askPython() {
  const r = spawnSync("python3", ["-c", PY], { input: JSON.stringify(CASES), encoding: "utf8" });
  if (r.error?.code === "ENOENT") return null;
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`the CPython oracle failed (exit ${r.status}):\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

const oracle = askPython();

describe("renderTable matches CPython's render_table", { skip: oracle === null ? "python3 is unavailable" : false }, () => {
  test("every frame shape is byte-identical", () => {
    const mine = CASES.map((c) =>
      renderTable(c.hdr, c.rows, {
        ...(c.total !== undefined ? { total: c.total } : {}),
        ...(c.bottom_rule !== undefined ? { bottomRule: c.bottom_rule } : {}),
      }),
    );
    assert.deepEqual(mine, oracle);
  });

  test("the corpus can actually detect a UTF-16 rule length", () => {
    const astral = CASES.find((c) => c.hdr.includes("\u{1F600}"));
    assert.ok(astral.hdr.length !== [...astral.hdr].length, "corpus lost its astral header");
  });
});

test("an empty total prints a blank line; an absent one prints nothing", () => {
  assert.equal(renderTable("H", ["r"], { total: "" }), "H\n-\nr\n-\n\n");
  assert.equal(renderTable("H", ["r"]), "H\n-\nr\n-\n");
  assert.equal(renderTable("H", ["r"], { total: undefined }), "H\n-\nr\n-\n");
});

test("bottomRule is omitted only when explicitly false", () => {
  assert.equal(renderTable("H", ["r"], { bottomRule: false }), "H\n-\nr\n");
  assert.equal(renderTable("H", ["r"], { bottomRule: true }), "H\n-\nr\n-\n");
});

// ---------------------------------------------------------------- the EPIPE guard

/** A stream that fails on demand and records what reached it. */
function mkStream(failWith) {
  const written = [];
  let handler = null;
  return {
    written,
    emitError: (err) => handler(err),
    write(chunk) {
      if (failWith) {
        const e = new Error("boom");
        e.code = failWith;
        throw e;
      }
      written.push(chunk);
    },
    on(_event, h) {
      handler = h;
    },
  };
}

function mkTarget(stdoutFail, stderrFail) {
  const stdout = mkStream(stdoutFail);
  const stderr = mkStream(stderrFail);
  const codes = [];
  return { stdout, stderr, codes, setExitCode: (c) => codes.push(c), prog: "usage" };
}

describe("the broken-pipe guard", () => {
  test("a synchronous EPIPE sets exit 120 and diagnoses once", () => {
    const t = mkTarget("EPIPE");
    const g = createPipeGuard(t);
    g.write(t.stdout, "a");
    assert.equal(g.isBroken(), true);
    assert.deepEqual(t.codes, [EPIPE_EXIT]);
    assert.deepEqual(t.stderr.written, ["usage: stdout closed before all output was written (broken pipe)\n"]);
  });

  test("EBADF is treated the same — a closed descriptor, not a pipe", () => {
    const t = mkTarget("EBADF");
    const g = createPipeGuard(t);
    g.write(t.stdout, "a");
    assert.equal(g.isBroken(), true);
    assert.deepEqual(t.codes, [EPIPE_EXIT]);
  });

  test("an asynchronous EPIPE event reaches the same state", () => {
    const t = mkTarget();
    const g = createPipeGuard(t);
    t.stdout.emitError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    assert.equal(g.isBroken(), true);
    assert.deepEqual(t.codes, [EPIPE_EXIT]);
  });

  test("a non-EPIPE stream error is rethrown, not swallowed into exit 120", () => {
    const t = mkTarget();
    createPipeGuard(t);
    assert.throws(
      () => t.stdout.emitError(Object.assign(new Error("nope"), { code: "ECONNRESET" })),
      /nope/,
    );
    assert.deepEqual(t.codes, []);
  });

  test("repeated errors diagnose exactly once", () => {
    const t = mkTarget();
    const g = createPipeGuard(t);
    for (let i = 0; i < 5; i++) t.stdout.emitError(Object.assign(new Error("x"), { code: "EPIPE" }));
    assert.equal(t.stderr.written.length, 1);
    assert.deepEqual(t.codes, [EPIPE_EXIT]);
    assert.equal(g.isBroken(), true);
  });

  test("writes after the break are dropped rather than retried", () => {
    const t = mkTarget();
    const g = createPipeGuard(t);
    g.write(t.stdout, "before");
    t.stdout.emitError(Object.assign(new Error("x"), { code: "EPIPE" }));
    g.write(t.stdout, "after");
    assert.deepEqual(t.stdout.written, ["before"]);
  });

  test("a dead stderr still yields exit 120 instead of crashing", () => {
    const t = mkTarget("EPIPE", "EPIPE");
    const g = createPipeGuard(t);
    g.write(t.stdout, "a");
    assert.equal(g.isBroken(), true);
    assert.deepEqual(t.codes, [EPIPE_EXIT]);
    assert.deepEqual(t.stderr.written, []);
  });

  test("a healthy stream is untouched", () => {
    const t = mkTarget();
    const g = createPipeGuard(t);
    g.write(t.stdout, "hello\n");
    assert.equal(g.isBroken(), false);
    assert.deepEqual(t.stdout.written, ["hello\n"]);
    assert.deepEqual(t.codes, []);
  });
});

/**
 * The unit tests above drive injected streams; this drives the REAL guard against a REAL
 * broken pipe, because the thing being reproduced is an operating-system condition and a
 * fake stream cannot prove Node's asynchronous pipe writes behave as assumed.
 *
 * Output must exceed the pipe buffer — measured, a small table is buffered whole and the
 * writer never sees EPIPE, which is exactly how an earlier measurement of this concluded
 * (wrongly) that Python does not hit EPIPE at all.
 */
describe("the guard against a real broken pipe", () => {
  const producer = `
    import { createPipeGuard } from "${new URL("../dist/io.js", import.meta.url).pathname}";
    const guard = createPipeGuard({
      stdout: process.stdout, stderr: process.stderr,
      setExitCode: (c) => { process.exitCode = c; }, prog: "usage",
    });
    for (let i = 0; i < 300000; i++) guard.write(process.stdout, "x".repeat(80) + "\\n");
    if (!guard.isBroken()) process.exitCode = 0;
  `;

  // `exit ${PIPESTATUS[0]}` is load-bearing: a pipeline's status is its LAST command's, so
  // without it this reports `head`'s 0 no matter what the producer did — and the
  // consumes-everything case would pass vacuously.
  // The producer is passed as a POSITIONAL argument and referenced as "$1", never
  // interpolated into the command string. It embeds this checkout's absolute path, so a
  // repository directory containing an apostrophe would otherwise terminate the single-quoted
  // program early and the test would fail before reaching the guard (code review R1).
  const run = (readerCmd) =>
    spawnSync(
      "bash",
      ["-c", `node --input-type=module -e "$1" | ${readerCmd}; exit \${PIPESTATUS[0]}`, "bash", producer],
      { encoding: "utf8" },
    );

  test("an early-closing reader yields CPython's exit 120 and one diagnostic line", () => {
    const r = run("head -1 >/dev/null");
    assert.equal(r.status, EPIPE_EXIT, `expected 120, got ${r.status}\n${r.stderr}`);
    assert.equal(r.stderr, "usage: stdout closed before all output was written (broken pipe)\n");
  });

  test("a reader that consumes everything exits 0 and says nothing", () => {
    const r = run("cat >/dev/null");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });
});
