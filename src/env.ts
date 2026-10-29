/**
 * Minimal .env loader — deliberately dependency-free. Same contract as the
 * ServiceM8 MCP: secrets live in a gitignored .env next to the package, so the
 * MCP registration in .claude.json stays credential-free.
 *
 * Existing process.env values always win, so a caller can still override.
 */

import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "./config.js";

export function loadDotEnv(file = path.join(PKG_ROOT, ".env")): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

/** Redacts a secret for safe logging: first 4 chars, then a length marker. */
export function redact(secret: string | undefined): string {
  if (!secret) return "(none)";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…(${secret.length} chars)`;
}
