/**
 * dsh-subagent-gate — configuration.
 *
 * Everything tunable lives here and is persisted to
 * `$DSH_HOME/dsh-subagent-gate/config.json` (same trust domain as the rest of
 * the user's DSH state, outside any profile so reinstalls never touch it).
 *
 * The file is versioned on purpose: future stages (rules, denylist, judge,
 * autoapprove) are added as new keys and new `stages` entries, never by
 * changing the meaning of an existing key.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONFIG_VERSION = 1;

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "dsh-subagent-gate");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");

/** `humanTimeoutMs: 0` means "wait for the human, no limit". */
export const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  /** Master switch. Off = the plugin never touches a session. */
  enabled: true,
  /**
   * Where the confirmation prompt is shown. Any registered target strategy id
   * works (built-ins: "root", "self", "auto"; other plugins may register more).
   * `root` is the default: it is the only target guaranteed to be visible —
   * the stock Web UI binds the approval card to the session you are viewing.
   */
  forwardTo: "root",
  /** Probe budget for `auto` mode before falling back to the root session. */
  directProbeMs: 5000,
  /** 0 = wait for the human indefinitely. */
  humanTimeoutMs: 0,
  /** What a timed-out ask resolves to. */
  onTimeout: "reject",
  /** What an ask resolves to when no answerer is composed (headless). */
  onNoAnswerer: "reject",
  /** Prefix forwarded asks with the child id / depth / tool. */
  provenance: true,
  /**
   * Extra text appended to the model-facing note for armed children. Empty by
   * default: the tool schema already carries the escalation procedure, and the
   * note only has to correct the one statement that is false for a child.
   * Add sentences here (no rebuild needed) only after an observed failure.
   */
  promptSuffix: "",
  /** Append one JSONL record per decision. */
  audit: true,
  /**
   * Ordered decision stages. MVP ships only `human`; later versions append
   * `rules`, `denylist`, `trust`, `judge`, `autoapprove` entries here without
   * touching the core.
   */
  stages: [{ id: "human", enabled: true, order: 100 }],
});

const TIMEOUT_MIN = 0;
const TIMEOUT_MAX = 24 * 60 * 60 * 1000;

function num(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Merge one parsed file over the defaults, ignoring anything unusable. */
export function normalize(raw) {
  const cfg = { ...DEFAULTS };
  if (raw === null || typeof raw !== "object") return cfg;
  if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
  // Any non-empty id is accepted: a future transport may be registered under a
  // name this version does not know, and the registry falls back to `root` at
  // runtime if nothing claims it.
  if (typeof raw.forwardTo === "string" && raw.forwardTo.trim() !== "") cfg.forwardTo = raw.forwardTo.trim();
  cfg.directProbeMs = num(raw.directProbeMs, DEFAULTS.directProbeMs, 0, 120000);
  cfg.humanTimeoutMs = num(raw.humanTimeoutMs, DEFAULTS.humanTimeoutMs, TIMEOUT_MIN, TIMEOUT_MAX);
  // A missing human decision is never a grant, including legacy configs
  // that selected "allow" here. Keep keys for readable config compatibility.
  cfg.onTimeout = "reject";
  cfg.onNoAnswerer = "reject";
  if (typeof raw.provenance === "boolean") cfg.provenance = raw.provenance;
  if (typeof raw.promptSuffix === "string") cfg.promptSuffix = raw.promptSuffix.slice(0, 2000);
  if (typeof raw.audit === "boolean") cfg.audit = raw.audit;
  if (Array.isArray(raw.stages)) {
    const stages = [];
    for (const entry of raw.stages) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.id !== "string" || entry.id === "") continue;
      stages.push({
        id: entry.id,
        enabled: entry.enabled !== false,
        order: num(entry.order, 100, 0, 10000),
        // Stage-specific settings are passed through untouched: the core does
        // not need to know what a future stage reads.
        options: entry.options && typeof entry.options === "object" ? entry.options : {},
      });
    }
    stages.sort((a, b) => a.order - b.order);
    if (stages.length > 0) cfg.stages = stages;
  }
  cfg.version = CONFIG_VERSION;
  return cfg;
}

/** Load config; a corrupt or missing file yields the defaults, never throws. */
export async function loadConfig() {
  try {
    const text = await readFile(CONFIG_FILE, "utf8");
    return normalize(JSON.parse(text));
  } catch {
    return { ...DEFAULTS };
  }
}

/** Best-effort persist (used by the `/subagent-gate` command). */
export async function saveConfig(cfg) {
  try {
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
