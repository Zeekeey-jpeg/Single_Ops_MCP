#!/usr/bin/env node
/**
 * Build api-map.json + api-map.md from every HAR in capture/.
 *
 *   npm run map                  # all capture/*.har, merged into the existing map
 *   npm run map -- path/to.har   # specific files
 *
 * Merges with the existing api-map.json so routes accumulate across captures
 * and hand edits (summary, verified) survive.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMap, renderMarkdown } from "./lib/har-map.mjs";
import { loadHarLean } from "./lib/har-stream.mjs";
import { formsToRoutes } from "./lib/form-mine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURE_DIR = path.join(ROOT, "capture");
const SESSION_FILE = path.join(ROOT, "state", "session.json");
const MAP_FILE = path.join(ROOT, "api-map.json");
const MD_FILE = path.join(ROOT, "api-map.md");

const args = process.argv.slice(2);
const files = args.length
  ? args
  : fs.existsSync(CAPTURE_DIR)
    ? fs.readdirSync(CAPTURE_DIR).filter((f) => f.endsWith(".har")).map((f) => path.join(CAPTURE_DIR, f))
    : [];

if (!files.length) {
  console.error("No HAR files found. Run `npm run capture` first.");
  process.exit(1);
}

const hars = [];
const pages = [];
for (const f of files) hars.push(await loadHarLean(f, { pages }));
const formRoutes = formsToRoutes(pages);
const session = fs.existsSync(SESSION_FILE) ? JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) : undefined;
const previous = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, "utf8")) : undefined;

const map = buildMap(hars, { session, previous, formRoutes, captureNames: files.map((f) => path.basename(f)) });
fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + "\n");
fs.writeFileSync(MD_FILE, renderMarkdown(map));

const count = (m) => map.routes.filter((r) => r.method === m).length;
const reads = map.routes.filter((r) => r.readOnly).length;
const denied = map.routes.filter((r) => r.policy === "deny").length;
console.log(
  `api-map.json: ${map.routes.length} routes (GET ${count("GET")}, POST ${count("POST")}, PUT ${count("PUT")}, ` +
    `PATCH ${count("PATCH")}, DELETE ${count("DELETE")}) · read-only ${reads} · denied ${denied} · from forms ${formRoutes.length} · auth=${map.auth.scheme}` +
    (map.auth.bearer ? ` · bearer from ${map.auth.bearer.source}` : "") +
    (map.auth.csrf ? ` · csrf from ${map.auth.csrf.source}` : ""),
);
console.log(`api-map.md written. Restart the MCP to load the new tools.`);
