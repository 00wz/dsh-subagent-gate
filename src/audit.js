/**
 * dsh-subagent-gate — audit trail.
 *
 * One JSONL file under `$DSH_HOME/dsh-subagent-gate/audit.jsonl`, append-only.
 * Kept outside session storage on purpose: the gate's decisions span the whole
 * delegation tree, so a per-session sidecar would scatter one story across N
 * files. Every record carries the session id, so a per-session view stays
 * possible (and is what a future UI tab would read).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AUDIT_FILE } from "./config.js";

export class Audit {
  constructor(config) {
    this.enabled = config.audit !== false;
    this.file = AUDIT_FILE;
    this.ready = null;
  }

  /** Best-effort: auditing must never break a decision. */
  async record(entry) {
    if (!this.enabled) return;
    try {
      if (this.ready === null) this.ready = mkdir(dirname(this.file), { recursive: true });
      await this.ready;
      await appendFile(this.file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
    } catch {
      /* ignore */
    }
  }
}
