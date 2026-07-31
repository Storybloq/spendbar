/**
 * Config loading and project-name normalization. Ports usage.py's encode_path,
 * load_config, clean_name and model_family.
 */
import { readFileSync } from "node:fs";
import type { Config, RuntimeDeps } from "./context.js";
import { DEFAULT_CONFIG } from "./context.js";

/**
 * ccusage encodes a project's absolute path into a directory name by replacing every
 * non-alphanumeric character with a dash. Encoding the home dir the same way yields the
 * prefix to strip, so display names work for any user / OS (no hardcoded username).
 */
export function encodePath(p: string): string {
  // The `u` flag is load-bearing (ISS-006). Without it the class iterates UTF-16 code
  // units, so one astral character becomes TWO dashes where Python's `re.sub` — which
  // iterates code points — produces one. That shifts every subsequent character of the
  // encoded key, so `homeEnc` stops matching and every project under such a path is
  // mis-attributed while both implementations exit 0.
  return p.replace(/[^A-Za-z0-9]/gu, "-");
}

/**
 * Read the config file. Missing file -> defaults silently (Python: FileNotFoundError).
 * Malformed/unreadable -> defaults plus a warning through the injected sink (Python
 * prints to stderr; the core must not touch stderr directly).
 */
export function loadConfig(deps: RuntimeDeps): Config {
  let raw: string;
  try {
    raw = readFileSync(deps.configPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    deps.warn(`warning: could not read ${deps.configPath} (${err.message}); using defaults`);
    return { ...DEFAULT_CONFIG };
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    deps.warn(`warning: could not read ${deps.configPath} (${(e as Error).message}); using defaults`);
    return { ...DEFAULT_CONFIG };
  }
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { ...DEFAULT_CONFIG };
  }
  const o = cfg as Record<string, unknown>;
  const renames = isStringMap(o.renames) ? o.renames : {};
  const workspaceRoots = isStringArray(o.workspace_roots) ? o.workspace_roots : ["Developer"];
  const legacyGroups = isStringMap(o.groups) ? o.groups : {};
  return { renames, workspaceRoots, legacyGroups };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v);
}

/** Bootstrap: the single place that performs config I/O. */
export function bootstrap(deps: RuntimeDeps): { deps: RuntimeDeps; config: Config } {
  return { deps, config: loadConfig(deps) };
}

/**
 * Map a raw ccusage project key to its display name.
 * Order is load-bearing: legacy groups -> home-exact -> home-prefix (workspace roots,
 * first match wins) -> outside-home passthrough -> rename lookup last.
 */
export function cleanName(raw: string, ctx: { deps: RuntimeDeps; config: Config }): string {
  const { legacyGroups, workspaceRoots, renames } = ctx.config;
  const homeEnc = ctx.deps.homeEnc;

  if (Object.prototype.hasOwnProperty.call(legacyGroups, raw)) {
    return legacyGroups[raw];
  }

  let bare: string;
  if (raw === homeEnc) {
    bare = "~";
  } else if (raw.startsWith(homeEnc + "-")) {
    const rest = raw.slice(homeEnc.length + 1);
    let found: string | null = null;
    for (const root of workspaceRoots) {
      if (rest === root) {
        found = "~/" + rest;
        break;
      }
      if (rest.startsWith(root + "-")) {
        found = rest.slice(root.length + 1);
        break;
      }
    }
    bare = found === null ? "~/" + rest : found;
  } else {
    bare = raw;
  }

  return Object.prototype.hasOwnProperty.call(renames, bare) ? renames[bare] : bare;
}

const FAMILIES = ["fable", "opus", "sonnet", "haiku", "gpt"] as const;

/** Classify a model name into a family. Substring match, in fixed order. */
export function modelFamily(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  for (const fam of FAMILIES) {
    if (n.includes(fam)) return fam;
  }
  // OpenAI Codex models not named gpt-* (defensive; today all contain 'gpt')
  if (n.includes("codex")) return "gpt";
  return "other";
}
