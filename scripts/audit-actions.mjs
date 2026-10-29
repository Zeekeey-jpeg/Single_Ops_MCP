#!/usr/bin/env node
/**
 * Post-crawl safety audit: lists every request in a HAR whose path looks like a
 * state-changing action, with method, status and redirect target — templated,
 * so no names or ids are printed. Use it to decide whether a crawl touched data.
 *
 *   node scripts/audit-actions.mjs capture/<file>.har
 */

import { harEntries } from "./lib/har-stream.mjs";
import { templatePath } from "./lib/har-map.mjs";

const ACTION =
  /(toggle|unaccept|accept|reject|close|reopen|submit|approve|start|stop|split|merge|convert|duplicate|clone|archive|cancel|complete|send|email|sms|text_message|pay|charge|refund|void|sync|delete|destroy|remove|login|logout|sign_out|mark|schedule|assign|unassign|publish)/i;

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/audit-actions.mjs <har>");
  process.exit(1);
}

const rows = new Map();
let total = 0;
let nonGet = 0;
for await (const e of harEntries(file)) {
  let u;
  try {
    u = new URL(e.request.url);
  } catch {
    continue;
  }
  if (!u.hostname.endsWith("singleops.com")) continue;
  total++;
  const method = e.request.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") nonGet++;
  const tpl = templatePath(u.pathname).path;
  if (!ACTION.test(tpl) && method === "GET") continue;
  const loc = (e.response?.headers ?? []).find((h) => h.name.toLowerCase() === "location")?.value;
  let locTpl = "";
  if (loc) {
    try {
      locTpl = templatePath(new URL(loc, u.origin).pathname).path;
    } catch {
      locTpl = "(unparseable)";
    }
  }
  const mime = (e.response?.content?.mimeType ?? "").split(";")[0];
  const key = `${method} ${tpl} -> ${e.response?.status} ${mime}${locTpl ? ` redirect:${locTpl}` : ""}`;
  rows.set(key, (rows.get(key) ?? 0) + 1);
}

console.log(`singleops.com requests: ${total} · non-GET: ${nonGet}`);
for (const [k, n] of [...rows.entries()].sort()) console.log(`${String(n).padStart(4)}  ${k}`);
