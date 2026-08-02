// Tests for the personal-data scanner (T-024).
//
// A scanner reporting "clean" is worthless unless it can be shown to fail. Every assertion here
// either plants a value that must be caught, or pairs a synthetic value against a real-shaped
// counterpart of the SAME class and requires opposite verdicts — otherwise "semantic classifier" is
// a claim rather than a behaviour.
//
// THIS FILE IS SCANNED BY THE SCANNER IT TESTS. Real-shaped fixtures are therefore assembled at
// runtime from fragments that individually match nothing, so the source itself stays clean. Review
// round 8 found 25 self-violations here and in the scanner; `scans its own source cleanly` below is
// what keeps them from coming back.

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { scanText, isSynthetic, decode, scan, CLASSES } from "../scripts/privacy-scan.mjs";
import { pushRange } from "../scripts/push-range.mjs";
import { firstContentChangingArg } from "../scripts/guarded-commit.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCANNER = join(REPO, "scripts", "privacy-scan.mjs");

// Split so no complete forbidden-shaped value appears in this source. The join happens at runtime.
const cat = (...parts) => parts.join("");

// Fabricated, not this machine's — the scanner must reject them for their SHAPE, which is the point
// of a semantic classifier.
const REAL_SHAPED = {
  "macos-home": cat("/Users", "/jdoe/Developer/thing"),
  "linux-home": cat("/home", "/jdoe/src"),
  "windows-home": cat("C:\\Users", "\\jdoe\\src"),
  "mangled-home": cat("-Users", "-jdoe-Developer-thing"),
  email: cat("jdoe", "@realcompany.co"),
  "session-id": cat("7c3e91a4-2b8d-4f16-9a5e", "-1d0f8b2c6e47"),
  "workflow-id": cat("wf_7c3e91a4", "-2b8"),
};
// Documented synthetic values are permitted, so they are safe to write out in full.
const SYNTHETIC_COUNTERPART = {
  "macos-home": "/Users/testuser/Developer/thing",
  "linux-home": "/home/testuser/src",
  "windows-home": "C:\\Users\\testuser\\src",
  "mangled-home": "-Users-fixture-Developer-alpha",
  email: "someone@example.com",
  "session-id": "019c0000-0000-7000-8000-000000000001",
  "workflow-id": "wf_00000000-000",
};

test("every class distinguishes a synthetic value from a real-shaped one", () => {
  for (const { name } of CLASSES) {
    const real = REAL_SHAPED[name];
    const synth = SYNTHETIC_COUNTERPART[name];
    assert.ok(real && synth, `test data missing for class ${name}`);

    // Caught AS THIS CLASS. Asserting only "some finding" would pass if a different class matched.
    assert.ok(
      scanText(real, "f").some((f) => f.class === name),
      `class ${name}: real-shaped value produced no finding of that class`,
    );
    // The synthetic counterpart may legitimately trip another class, so this is scoped.
    assert.deepEqual(
      scanText(synth, "f").filter((f) => f.class === name),
      [],
      `class ${name}: documented synthetic value was reported`,
    );
  }
});

test("scans its own source, config and tests cleanly", () => {
  // The scanner must be able to live in the repository it guards. Without this, staging it would
  // make the repository permanently unscannable — which is what round 8 found.
  const r = run(["--mode=dir", `--dir=${join(REPO, "scripts")}`]);
  assert.equal(r.status, 0, `scripts/ is not self-compliant:\n${r.stderr}`);

  const self = scanText(readSelf(), "tests-ts/privacy-scan.test.mjs");
  assert.deepEqual(self, [], "this test file is not self-compliant");
});

test("account allowlisting is exact, not by prefix", () => {
  assert.equal(isSynthetic("fixture", "macos-home"), true);
  // A declared synthetic name is not a licence for every account that begins with it.
  assert.equal(isSynthetic("fixture-evil", "macos-home"), false);
  assert.equal(isSynthetic("alice-smith", "linux-home"), false);
  assert.equal(isSynthetic("testuser2", "macos-home"), false);

  for (const [text, cls] of [
    [cat("/Users", "/fixture-evil/x"), "macos-home"],
    [cat("/home", "/alice-smith/x"), "linux-home"],
    [cat("C:\\Users", "\\fixture-evil\\x"), "windows-home"],
  ]) {
    assert.ok(
      scanText(text, "f").some((f) => f.class === cls),
      `class ${cls}: an undeclared account sharing a synthetic prefix was not reported`,
    );
  }
});

test("windows paths are matched case-insensitively and with either separator", () => {
  // Windows paths are case-insensitive and tooling emits both separators; a backslash-only,
  // case-sensitive pattern missed most real forms while the ticket claimed Windows coverage.
  for (const text of [
    cat("c:\\users", "\\jdoe\\src"),
    cat("C:/Users", "/jdoe/src"),
    cat("D:\\USERS", "\\jdoe"),
  ]) {
    assert.ok(
      scanText(text, "f").some((f) => f.class === "windows-home"),
      "a Windows path variant was missed",
    );
  }
  assert.deepEqual(scanText("c:/users/testuser/src", "f"), []);
});

test("mangled paths clear only by exact enumeration, never by prefix", () => {
  // The hyphen is both separator and a legal account character, so no boundary can be inferred
  // from a mangled run. An anchored pattern with an optional tail is still prefix matching: it
  // cannot tell `<declared>` + project from `<declared>-<someone-else>` + project.
  for (const mangled of [
    cat("-Users", "-me-jones-Dev-x"),
    cat("-Users", "-first-last-Dev-x"),
    // The regression that killed the optional-tail pattern: an undeclared account that begins
    // with a declared one.
    cat("-Users", "-testuser-evil-Developer-project"),
    cat("-Users", "-fixture-evil-Developer-project"),
  ]) {
    assert.ok(
      scanText(mangled, "f").some((f) => f.class === "mangled-home"),
      "an undeclared account was cleared by a declared prefix",
    );
  }
  // Only the enumerated fixture paths clear.
  for (const declared of ["-Users-fixture", "-Users-fixture-Developer-alpha", "-Users-testuser"]) {
    assert.deepEqual(scanText(declared, "f"), [], `${declared} should be declared synthetic`);
  }
});

test("delimited paths clear only collision-resistant accounts", () => {
  // The scanner cannot tell a fixture using a generic name from a contributor whose real account
  // has that name, so a generic token in the allowlist silently exempts a real person's home path.
  for (const generic of ["alice", "bob", "user", "runner", "me", "u", "x"]) {
    assert.equal(
      isSynthetic(generic, "macos-home"),
      false,
      `${generic} is a plausible real account and must not be globally allowlisted`,
    );
  }
  assert.deepEqual(scanText("/Users/testuser/x", "f"), []);
});

test("synthetic session ids are matched by anchored pattern, not by prefix", () => {
  assert.equal(isSynthetic("019c0000-0000-7000-8000-000000000001", "session-id"), true);
  // A synthetic prefix followed by arbitrary real-looking data is not synthetic.
  assert.equal(isSynthetic(cat("019c0000-0000-7000-8000", "-deadbeefcafe"), "session-id"), false);
  // One nonzero digit inside the pinned padding is enough to break the convention.
  assert.equal(isSynthetic(cat("019c0000-0000-7000-8000", "-100000000001"), "session-id"), false);
});

test("email allowlisting is a domain suffix at a label boundary", () => {
  const email = (local, domain) => cat(local, "@", domain);
  // A declared domain covers its subdomains: `endsWith("@example.com")` reported every one of
  // them, and made the reserved TLDs match nothing at all (review round 1, chunk 15).
  for (const domain of ["example.com", "sub.example.com", "a.b.example.org", "box.test", "thing.invalid", "svc.localhost"]) {
    assert.deepEqual(scanText(email("someone", domain), "f"), [], `${domain} should be synthetic`);
  }
  // The boundary is a label, not a substring: a real domain merely ENDING in a declared one is
  // not covered.
  for (const domain of [cat("notexample", ".com"), cat("myexample", ".org"), cat("fake-", "example.net")]) {
    assert.ok(
      scanText(email("jdoe", domain), "f").some((f) => f.class === "email"),
      `${domain} must not be cleared by a suffix that is not a label boundary`,
    );
  }
  // Punycode TLDs are addresses too; `[A-Za-z]{2,}` stopped at the first digit and matched none.
  assert.ok(scanText(email("jdoe", cat("host.xn--", "p1ai")), "f").some((f) => f.class === "email"));
  // And a version specifier is still not an address.
  assert.deepEqual(scanText(cat("sdk", "@1.30.0"), "f"), []);
});

test("findings name file, line and class and never carry the value", () => {
  const text = ["clean line", `leak here ${REAL_SHAPED["macos-home"]}`, "clean again"].join("\n");
  const [finding, ...rest] = scanText(text, "some/file.md");
  assert.equal(rest.length, 0);
  assert.deepEqual(finding, { path: "some/file.md", line: 2, class: "macos-home" });
  // The rule ISS-046 established, enforced on the reporter itself.
  assert.equal(JSON.stringify(finding).includes("jdoe"), false);
});

test("dir mode scans dist/ — the directory that actually ships", () => {
  // The critical case. Repo-mode scans skip build output; an unpacked tarball IS build output, so
  // excluding `dist` there would recreate exactly the blind spot that let personal data into a
  // published package while the packaging contract stayed green.
  withTempDir((dir) => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "readme.md"), "nothing here\n");
    writeFileSync(join(dir, "dist", "index.js"), `// ${REAL_SHAPED["macos-home"]}\n`);
    const r = run(["--mode=dir", `--dir=${dir}`]);
    assert.equal(r.status, 1, "a leak under dist/ must fail a directory scan");
    assert.match(r.stderr, /dist\/index\.js:1\s+\[macos-home\]/);
  });
});

test("symlinks are not followed, and their targets are scanned as text", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "real.txt"), "clean\n");
    // Following this would walk the scanner out of the artifact root entirely.
    symlinkSync(REAL_SHAPED["macos-home"], join(dir, "escape"));
    const r = run(["--mode=dir", `--dir=${dir}`]);
    assert.equal(r.status, 1, "a symlink target carrying a personal path must be reported");
    assert.match(r.stderr, /escape:1\s+\[macos-home\]/);
  });
});

test("a symlink cycle does not hang or crash the scan", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "f.txt"), "clean\n");
    symlinkSync(dir, join(dir, "sub", "loop"));
    assert.equal(run(["--mode=dir", `--dir=${dir}`]).status, 0);
  });
});

test("UTF-16 is decoded in both byte orders, and a malformed one is reported", () => {
  // UTF-16 ASCII is NUL-interleaved, so a naive binary check would skip a file full of readable
  // personal data.
  const payload = `leak ${REAL_SHAPED["macos-home"]}`;
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload, "utf16le")]);
  const beBody = Buffer.from(payload, "utf16le");
  beBody.swap16();
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]);

  for (const [label, buf] of [["LE", le], ["BE", be]]) {
    const decoded = decode(buf);
    assert.equal(decoded.binary, undefined, `${label}: treated as binary`);
    assert.ok(
      scanText(decoded.text, "f").some((f) => f.class === "macos-home"),
      `${label}: personal path not found after decoding`,
    );
  }

  // An odd-length body is not valid UTF-16; decoding it anyway would silently drop a byte.
  const odd = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x41])]);
  assert.equal(decode(odd).malformed, true);
});

test("invalid UTF-8 is reported, never repaired into a scan that missed the value", () => {
  // Lossy decoding substitutes U+FFFD for the bad byte, which SPLITS the value: the file is then
  // counted as successfully scanned and the personal path it contains matches nothing. Nothing
  // here failed while the decoder was lossy, which is why the guarantee needed its own fixtures
  // (review round 1, chunk 15).
  const invalid = Buffer.from([0x80]); // a continuation byte with nothing to continue
  for (const [label, payload] of [
    ["a home path", REAL_SHAPED["macos-home"]],
    ["an address", REAL_SHAPED.email],
  ]) {
    const half = Math.floor(payload.length / 2);
    const buf = Buffer.concat([
      Buffer.from(`leak ${payload.slice(0, half)}`, "utf8"),
      invalid,
      Buffer.from(`${payload.slice(half)}\n`, "utf8"),
    ]);
    const decoded = decode(buf);
    assert.equal(decoded.malformed, true, `${label}: an invalid byte was decoded away instead of reported`);
    assert.equal(decoded.text, undefined, `${label}: a file that cannot be decoded has no text`);
  }

  // Valid UTF-8 with multibyte content still decodes, so the strictness is not a blanket refusal.
  assert.equal(decode(Buffer.from("é中🙂 clean\n", "utf8")).text, "é中🙂 clean\n");

  withTempDir((dir) => {
    writeFileSync(join(dir, "ok.txt"), "clean\n");
    writeFileSync(join(dir, "broken.txt"), Buffer.concat([Buffer.from("leak "), invalid, Buffer.from("\n")]));
    const r = run(["--mode=dir", `--dir=${dir}`]);
    assert.equal(r.status, 1, "an undecodable file must be a finding, not a silent success");
    assert.match(r.stderr, /broken\.txt:0\s+\[malformed-encoding\]/);
  });
});

test("an unscannable binary is reported, not silently skipped", () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, "ok.txt"), "clean\n");
    writeFileSync(join(dir, "mystery.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const r = run(["--mode=dir", `--dir=${dir}`]);
    assert.equal(r.status, 1, "an undeclared binary must be reported as unscannable");
    assert.match(r.stderr, /mystery\.bin:0\s+\[unscannable-binary\]/);

    // A declared binary extension is skipped without a finding.
    rmSync(join(dir, "mystery.bin"));
    writeFileSync(join(dir, "icon.png"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    assert.equal(run(["--mode=dir", `--dir=${dir}`]).status, 0);
  });
});

test("a scan that read no text refuses to report a pass", () => {
  withTempDir((dir) => {
    // Vacuous success is the failure mode this repo rejects everywhere else.
    assert.match(run(["--mode=dir", `--dir=${dir}`]).stderr, /read 0 text files/);
    assert.equal(run(["--mode=dir", `--dir=${dir}`]).status, 2);

    // A directory of nothing but declared binaries is the subtler case: entries exist, but no text
    // was ever examined, so "clean" would mean "looked at nothing".
    writeFileSync(join(dir, "icon.png"), Buffer.from([0x00, 0x01]));
    assert.equal(run(["--mode=dir", `--dir=${dir}`]).status, 2);
  });
});

test("unknown modes are hard errors and never fall back to index", () => {
  assert.equal(run(["--mode=nonsense"]).status, 2);
  assert.equal(run(["--mode=dir"]).status, 2);
  assert.equal(run(["--mode=commit"]).status, 2);
  assert.equal(run(["--unknown-flag"]).status, 2);
  // Via the exported function too: a mistyped mode silently scanning the index would report on
  // something other than what was asked.
  assert.throws(() => scan({ mode: "nonsense" }), /unknown mode/);
});

test("index and worktree modes answer different questions", () => {
  // Hermetic: built from a fixture repository rather than depending on this checkout being dirty,
  // which would make the test pass locally and fail in CI for reasons unrelated to the scanner.
  withTempRepo((repo) => {
    writeFileSync(join(repo, "f.txt"), "clean\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-m", "seed"]);

    // Edited on disk, not staged: invisible to index, must be caught by worktree.
    writeFileSync(join(repo, "f.txt"), `${REAL_SHAPED["session-id"]}\n`);
    assert.deepEqual(scan({ mode: "index", repo }).findings, []);
    assert.ok(scan({ mode: "worktree", repo }).findings.some((f) => f.class === "session-id"));

    // Once staged, index sees it too — the gate a pre-commit hook actually runs.
    gitIn(repo, ["add", "-A"]);
    assert.ok(scan({ mode: "index", repo }).findings.some((f) => f.class === "session-id"));
  });
});

test("worktree mode covers untracked files, deletions and symlinks", () => {
  withTempRepo((repo) => {
    writeFileSync(join(repo, "kept.txt"), "clean\n");
    writeFileSync(join(repo, "doomed.txt"), "clean\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-m", "seed"]);

    // Untracked but not ignored: `git add -A` would stage it, so the scan must see it. This is the
    // class that sits at a repo root one `git add -A` away from becoming a disclosure.
    writeFileSync(join(repo, "new-notes.md"), `${REAL_SHAPED.email}\n`);
    assert.ok(
      scan({ mode: "worktree", repo }).findings.some((f) => f.path === "new-notes.md"),
      "an untracked leaking file was not scanned",
    );

    // Ignored files are not staged by `git add -A`, so they are correctly out of scope.
    writeFileSync(join(repo, ".gitignore"), "ignored.md\n");
    writeFileSync(join(repo, "ignored.md"), `${REAL_SHAPED.email}\n`);
    assert.equal(
      scan({ mode: "worktree", repo }).findings.some((f) => f.path === "ignored.md"),
      false,
    );

    // A deleted tracked path has no content to stage; reading it must not throw.
    unlinkSync(join(repo, "doomed.txt"));
    assert.doesNotThrow(() => scan({ mode: "worktree", repo }));

    // A tracked symlink must be read as a link, not through it.
    symlinkSync(REAL_SHAPED["macos-home"], join(repo, "link"));
    const findings = scan({ mode: "worktree", repo }).findings;
    assert.ok(findings.some((f) => f.path === "link" && f.class === "macos-home"));

    // Dangling links must not crash the scan either.
    symlinkSync(join(repo, "does-not-exist"), join(repo, "dangling"));
    assert.doesNotThrow(() => scan({ mode: "worktree", repo }));
  });
});

test("a TRACKED file under a skipped directory is still scanned", () => {
  // The skip list is about where an untracked-file walk should not go. Applying it to tracked
  // paths as well dropped files that `git add -A` would still stage — a domain the mode claims
  // and did not cover, and no fixture noticed (review round 1, chunk 15).
  withTempRepo((repo) => {
    mkdirSync(join(repo, "node_modules", "inner"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "inner", "vendored.js"), "clean\n");
    writeFileSync(join(repo, "keep.txt"), "clean\n");
    gitIn(repo, ["add", "-A", "-f"]);
    gitIn(repo, ["commit", "-m", "seed with a vendored file"]);

    writeFileSync(join(repo, "node_modules", "inner", "vendored.js"), `${REAL_SHAPED["macos-home"]}\n`);
    assert.ok(
      scan({ mode: "worktree", repo }).findings.some((f) => f.path === "node_modules/inner/vendored.js"),
      "a tracked file under a skipped directory was not scanned",
    );

    // Untracked content under the same directory stays out of scope: that is what the skip list
    // is for, and the two cases must not be conflated.
    writeFileSync(join(repo, "node_modules", "inner", "stray.js"), `${REAL_SHAPED.email}\n`);
    assert.equal(
      scan({ mode: "worktree", repo }).findings.some((f) => f.path === "node_modules/inner/stray.js"),
      false,
    );
  });
});

test("a file swapped for a symlink between classification and read is a hard error", () => {
  // The no-follow guarantee is about a WINDOW, and every other symlink test uses a link that was
  // already a link when the scan classified it — so O_NOFOLLOW could have been deleted with the
  // suite green. `beforeRead` opens the window deliberately (review round 1, chunk 15).
  withTempDir((dir) => {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, `${REAL_SHAPED["macos-home"]}\n`);
    const root = join(dir, "root");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "clean\n");

    assert.throws(
      () =>
        scan({
          mode: "dir",
          dir: root,
          beforeRead: (entry) => {
            if (!entry.path.endsWith("a.txt")) return;
            rmSync(entry.full);
            symlinkSync(outside, entry.full);
          },
        }),
      /changed type during the scan/,
    );

    // The control: without the swap the same file scans normally, so the refusal above is the
    // race and not the fixture.
    assert.deepEqual(scan({ mode: "dir", dir: root }).findings, []);
  });
});

test("the config declares synthetic conventions only — there is no exemption mechanism", () => {
  // T-024 criterion 7 requires the exemption set to be EMPTY. Stronger than empty: the set does
  // not exist. Every key in the config declares a synthetic convention; none names a real value
  // to be tolerated. Pinning the key set means a future "exemptions" key cannot appear without
  // failing here first and having the argument in review.
  const config = JSON.parse(readFileSync(join(REPO, "scripts", "privacy-synthetic.json"), "utf8"));
  assert.deepEqual(
    Object.keys(config).sort(),
    [
      "_comment",
      "accounts",
      "binaryExtensions",
      "emailDomains",
      "mangledHomePatterns",
      "sessionIdPatterns",
      "workflowIdPatterns",
    ],
    "unexpected key in privacy-synthetic.json — exemption lists are not permitted",
  );
});

test("guarded-commit refuses a staged leak and commits a clean stage (fixture repo)", () => {
  // The wrapper end-to-end, not just the scanner underneath it: T-024 criterion 2 is verified
  // by staging an offending file and OBSERVING the refusal, never by watching a clean tree pass.
  withTempRepo((repo) => {
    const wrapper = join(REPO, "scripts", "guarded-commit.mjs");
    const guard = (args) => {
      const r = execFileSync(process.execPath, [wrapper, ...args], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, SPENDBAR_GUARD_REPO: repo },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, out: r };
    };
    const guardFail = (args) => {
      try {
        guard(args);
        return { status: 0 };
      } catch (error) {
        return { status: error.status, err: String(error.stderr) };
      }
    };

    // Nothing staged: an error, not a pass — the caller thought they were committing something.
    assert.equal(guardFail(["-m", "x"]).status, 2);

    writeFileSync(join(repo, "leak.md"), `${REAL_SHAPED["macos-home"]}\n`);
    gitIn(repo, ["add", "-A"]);
    const refused = guardFail(["-m", "should refuse"]);
    assert.equal(refused.status, 1, "a staged leak must refuse the commit");
    assert.match(refused.err, /REFUSED/);
    // Refused means NOT committed — check the repository, not the exit code alone.
    assert.throws(() => gitIn(repo, ["rev-parse", "HEAD"]));

    writeFileSync(join(repo, "leak.md"), "clean now\n");
    gitIn(repo, ["add", "-A"]);
    guard(["-m", "clean commit"]);
    assert.equal(gitIn(repo, ["log", "--format=%s", "-1"]).trim(), "clean commit");
  });
});

test("guarded-commit commits the tree it scanned, and nothing else", () => {
  // Scanning the index and then handing arbitrary arguments to `git commit` is not a gate: -a,
  // --include, --only and a bare pathspec all build the commit from worktree content the scan
  // never saw. The old wrapper forwarded every one of them (review round 1, chunk 15).
  for (const args of [
    ["-a", "-m", "x"],
    ["--all", "-m", "x"],
    ["-m", "x", "--include", "leak.md"],
    ["--only", "-m", "x"],
    ["-m", "x", "leak.md"],
    ["-m", "x", "--", "leak.md"],
    ["-m", "x", "--pathspec-from-file=list"],
    ["-p", "-m", "x"],
  ]) {
    assert.ok(firstContentChangingArg(args) !== null, `${args.join(" ")} must be refused`);
  }
  // Metadata options, in every spelling git accepts, must still be usable.
  for (const args of [
    ["-m", "message"],
    ["--message=message"],
    ["-m", "message", "--author", "A <a@example.com>"],
    ["--amend", "--no-edit"],
    ["-q", "-s", "-m", "message"],
    // The value of -m is consumed, so a message that looks like a pathspec is not one.
    ["-m", "leak.md"],
  ]) {
    assert.equal(firstContentChangingArg(args), null, `${args.join(" ")} must be allowed`);
  }
});

test("guarded-commit refuses the unsafe paths end to end", () => {
  const wrapper = join(REPO, "scripts", "guarded-commit.mjs");
  const guardIn = (repo, args, env = {}) =>
    runNode([wrapper, ...args], { cwd: repo, env: { ...process.env, SPENDBAR_GUARD_REPO: repo, ...env } });

  withTempRepo((repo) => {
    writeFileSync(join(repo, "seed.txt"), "clean\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-m", "seed"]);

    // A leak on disk that is NOT staged: the index is clean, so an index-domain guard commits —
    // and `-a` would have swept the leak in. The refusal is what proves the domain.
    writeFileSync(join(repo, "seed.txt"), `${REAL_SHAPED["macos-home"]}\n`);
    const swept = guardIn(repo, ["-a", "-m", "sweep it in"]);
    assert.equal(swept.status, 2, "-a must be refused, not scanned-then-obeyed");
    assert.match(swept.stderr, /REFUSED/);
    assert.equal(gitIn(repo, ["log", "--format=%s", "-1"]).trim(), "seed", "no commit may have been made");

    // A pre-commit hook that stages a leak after the scan has run. The wrapper is the pre-commit
    // verification, so it does not let another one race it.
    gitIn(repo, ["checkout", "--", "seed.txt"]);
    writeFileSync(join(repo, "clean.txt"), "clean\n");
    gitIn(repo, ["add", "-A"]);
    const hooks = gitIn(repo, ["rev-parse", "--git-path", "hooks"]).trim();
    mkdirSync(join(repo, hooks), { recursive: true });
    const hook = join(repo, hooks, "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "${REAL_SHAPED["linux-home"]}" > hooked.txt\ngit add hooked.txt\n`);
    chmodSync(hook, 0o755);
    assert.equal(guardIn(repo, ["-m", "clean with a hostile hook"]).status, 0);
    const tree = gitIn(repo, ["ls-tree", "--name-only", "HEAD"]).split("\n");
    assert.equal(tree.includes("hooked.txt"), false, "a hook staged content into the vouched-for commit");
  });

  withTempRepo((repo) => {
    // A subprocess that cannot be launched reports `status: null`, and `process.exit(null)` exits
    // ZERO. This drives that path by making `git` unfindable; the scanner runs from an absolute
    // path and so cannot be broken the same way, but the failure mode and its handling are the
    // same one — a spawn error is checked before a status is believed.
    writeFileSync(join(repo, "f.txt"), "clean\n");
    gitIn(repo, ["add", "-A"]);
    const broken = guardIn(repo, ["-m", "x"], { PATH: "" });
    assert.equal(broken.status, 2, "a guard whose subprocess cannot launch must exit nonzero");
    assert.match(broken.stderr, /could not run/);
    assert.throws(() => gitIn(repo, ["rev-parse", "HEAD"]), "nothing may have been committed");
  });
});

test("per-commit enumeration catches a leak introduced and removed within one push", () => {
  // The CI workflow scans EVERY commit in the push range with --mode=commit, because a
  // two-commit push can leak in the first commit and scrub in the second: auditing the
  // checked-out tip passes while the value sits in remote history permanently. This is that
  // fixture: tip-only must pass (that is the trap), per-commit must fail.
  withTempRepo((repo) => {
    writeFileSync(join(repo, "doc.md"), `${REAL_SHAPED.email}\n`);
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-m", "leak"]);
    writeFileSync(join(repo, "doc.md"), "scrubbed\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-m", "scrub"]);

    // The tip is clean — exactly why tip-auditing is insufficient.
    assert.deepEqual(scan({ mode: "commit", rev: "HEAD", repo }).findings, []);

    // The workflow's OWN enumeration, not a hand-rolled `rev-list HEAD` that happens to agree
    // with it: running something adjacent to the algorithm proves nothing about the algorithm
    // (review round 1, chunk 15).
    const head = gitIn(repo, ["rev-parse", "HEAD"]).trim();
    const commits = pushRange({ before: "", after: head, ref: "refs/heads/main", repo });
    assert.equal(commits.length, 2);
    const dirty = commits.filter((sha) => scan({ mode: "commit", rev: sha, repo }).findings.length > 0);
    assert.equal(dirty.length, 1, "the intermediate leaking commit must be caught");
  });
});

test("the push range is every introduced commit, in every push shape", () => {
  withTempRepo((repo) => {
    const sha = (rev) => gitIn(repo, ["rev-parse", rev]).trim();
    const commit = (name) => {
      writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
      gitIn(repo, ["add", "-A"]);
      gitIn(repo, ["commit", "-m", name]);
      return sha("HEAD");
    };
    gitIn(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const base = commit("base");
    const first = commit("first");
    const second = commit("second");

    // An ordinary push: exactly the two new commits, and not the one that was already there.
    assert.deepEqual(pushRange({ before: base, after: second, ref: "refs/heads/main", repo }).sort(), [first, second].sort());

    // A NEW BRANCH, two commits of its own beyond what main already carries. `before` is all
    // zeros, so the range is everything reachable from the tip and from no OTHER ref.
    gitIn(repo, ["checkout", "-q", "-b", "feature", base]);
    const featureA = commit("feature-a");
    const featureB = commit("feature-b");
    const expected = [featureA, featureB].sort();
    assert.deepEqual(
      pushRange({ before: "0".repeat(40), after: featureB, ref: "refs/heads/feature", repo }).sort(),
      expected,
      "a new branch must audit its own commits and not main's",
    );

    // The regression this module was written for: right after a push the branch ALSO exists as a
    // remote-tracking ref, so an exclusion set that removes only one spelling subtracts the push
    // from its own range and collapses to the tip.
    gitIn(repo, ["update-ref", "refs/remotes/origin/feature", featureB]);
    const newBranch = pushRange({ before: "0".repeat(40), after: featureB, ref: "refs/heads/feature", repo });
    assert.deepEqual(newBranch.sort(), expected, `a multi-commit new branch collapsed to ${newBranch.length} commit(s)`);

    // A FORCE PUSH: `before` names a commit this repository no longer has.
    const gone = "0123456789abcdef0123456789abcdef01234567";
    assert.deepEqual(pushRange({ before: gone, after: featureB, ref: "refs/heads/feature", repo }).sort(), expected);

    // Commits already reachable from another ref are not re-audited — they were audited when
    // that ref was pushed — and the tip alone is then the honest answer.
    gitIn(repo, ["update-ref", "refs/heads/mirror", featureB]);
    assert.deepEqual(pushRange({ before: "", after: featureB, ref: "refs/heads/feature", repo }), [featureB]);
  });
});

test("push-range refuses to resolve an empty range rather than passing vacuously", () => {
  withTempRepo((repo) => {
    writeFileSync(join(repo, "f.txt"), "clean\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-m", "seed"]);
    const head = gitIn(repo, ["rev-parse", "HEAD"]).trim();

    // before === after is a push that introduced nothing. The range is empty; the SCRIPT must
    // exit 2 rather than print nothing and let the caller's loop run zero times.
    assert.deepEqual(pushRange({ before: head, after: head, ref: "refs/heads/main", repo }), []);
    const r = runNode([join(REPO, "scripts", "push-range.mjs"), `--before=${head}`, `--after=${head}`, `--repo=${repo}`]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to report an empty audit range/);

    // And the tip alone is still a valid answer when the tip really is all there is.
    const ok = runNode([join(REPO, "scripts", "push-range.mjs"), "--before=", `--after=${head}`, `--repo=${repo}`]);
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), head);
  });
});

const readSelf = () => readFileSync(join(REPO, "tests-ts", "privacy-scan.test.mjs"), "utf8");

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "privscan-"));
  chmodSync(dir, 0o700);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempRepo(fn) {
  withTempDir((dir) => {
    gitIn(dir, ["init", "-q"]);
    gitIn(dir, ["config", "user.email", "someone@example.com"]);
    gitIn(dir, ["config", "user.name", "Fixture"]);
    fn(dir);
  });
}

function gitIn(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function run(args) {
  return runNode([SCANNER, ...args]);
}

function runNode(argv, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, argv, {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return { status: error.status ?? -1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
