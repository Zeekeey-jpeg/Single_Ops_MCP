/**
 * Environment parsing and capability gates.
 *
 * Every capability defaults to OFF. An absent variable is a disabled variable.
 * This server points at an undocumented API on a live business account, and
 * SingleOps may later be connected to the account's QuickBooks company file.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
/** Package root, resolved from the compiled file's location (dist/ -> ..). */
export const PKG_ROOT = path.resolve(path.dirname(__filename), "..");

/** Overridable so tests and the stress harness never touch a real session or audit log. */
export const STATE_DIR = process.env.SINGLEOPS_STATE_DIR || path.join(PKG_ROOT, "state");
export const AUDIT_DIR = process.env.SINGLEOPS_AUDIT_DIR || path.join(PKG_ROOT, "audit");
export const CAPTURE_DIR = path.join(PKG_ROOT, "capture");
/** Playwright storageState written by scripts/capture.mjs. Holds live cookies. */
export const SESSION_FILE = path.join(STATE_DIR, "session.json");
/** Route map written by scripts/har-to-map.mjs. Shapes only, no client values. */
export const MAP_FILE = path.join(PKG_ROOT, "api-map.json");

export const BASE_URL = "https://app.singleops.com";

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Config {
  leadUserEmail?: string;
  leadUserToken?: string;
  enableWrite: boolean;
  /** DELETE tools exist only when true, and each call still needs a typed confirmation. */
  enableDelete: boolean;
  /** Live writes allowed per server process. Stops a runaway loop; a backfill raises it on purpose. */
  maxWrites: number;
  maxRps: number;
  baseUrl: string;
}

export function loadConfig(): Config {
  return {
    leadUserEmail: process.env.SINGLEOPS_LEAD_USER_EMAIL?.trim() || undefined,
    leadUserToken: process.env.SINGLEOPS_LEAD_USER_TOKEN?.trim() || undefined,
    enableWrite: bool("SINGLEOPS_ENABLE_WRITE", false),
    enableDelete: bool("SINGLEOPS_ENABLE_DELETE", false),
    maxWrites: num("SINGLEOPS_MAX_WRITES", 25),
    maxRps: num("SINGLEOPS_MAX_RPS", 1),
    baseUrl: process.env.SINGLEOPS_BASE_URL?.trim() || BASE_URL,
  };
}
