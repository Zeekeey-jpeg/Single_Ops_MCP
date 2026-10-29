/**
 * Append-only audit trail for every call that changes data, plus failures.
 *
 * SingleOps attributes actions to whichever login the session belongs to, which
 * is the account owner's. This file is how an automated action can be told apart from a
 * human one. Bodies are reduced to their key names: no client values on disk.
 */

import fs from "node:fs";
import path from "node:path";
import { AUDIT_DIR } from "./config.js";

export type AuditKind = "write" | "write_failed" | "auth_failed";

export interface AuditEntry {
  ts: string;
  kind: AuditKind;
  route: string;
  status?: number;
  detail?: unknown;
}

export function audit(entry: Omit<AuditEntry, "ts">): void {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    fs.appendFileSync(path.join(AUDIT_DIR, `${day}.jsonl`), line, "utf8");
  } catch {
    process.stderr.write("[singleops-mcp] WARNING: audit write failed\n");
  }
}

/** Top-level key names of a body, for audit lines that must not carry values. */
export function shapeOf(body: unknown): string[] | undefined {
  if (!body || typeof body !== "object") return undefined;
  return Object.keys(body as Record<string, unknown>);
}
