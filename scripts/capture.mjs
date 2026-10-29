#!/usr/bin/env node
/**
 * Headed browser capture of SingleOps web-app traffic.
 *
 *   npm run capture              # record a HAR while you click through the app
 *   npm run capture -- jobs      # label the HAR (capture/<ts>-jobs.har)
 *   npm run login                # refresh the session only, no HAR
 *
 * A human types the login. This script never sees, stores or prompts for the
 * password. The persistent profile keeps you signed in between runs.
 * Outputs (both gitignored, both sensitive):
 *   capture/*.har        raw traffic incl. client data and cookie values
 *   state/session.json   Playwright storageState the MCP replays
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = path.join(ROOT, "state");
const CAPTURE_DIR = path.join(ROOT, "capture");
const PROFILE_DIR = path.join(STATE_DIR, "profile");
const SESSION_FILE = path.join(STATE_DIR, "session.json");
const START_URL = "https://app.singleops.com/";

const args = process.argv.slice(2);
const loginOnly = args.includes("--login-only");
/** --auto: wait for a human login, then crawl every page type read-only. */
const auto = args.includes("--auto") && !loginOnly;
const MAX_PAGES = Number(args.find((a) => a.startsWith("--max="))?.slice(6) ?? 200);
/** Pages per templated path: 2 samples of /clients/{id} is enough to learn its shape. */
const PER_TEMPLATE = 2;
/**
 * GET links that look like actions. Navigation is always GET (never a click on a
 * Rails data-method link), but some apps still do work on GET, so skip anything
 * that smells like sending, paying, converting or deleting.
 */
const UNSAFE =
  /(^|[\/_?=&-])(sign_out|logout|log_out|login|toggle_\w+|unaccept|reject_\w+|reject|close_\w+|reopen|submit|start|stop|split|merge|prepare_email|public_\w+|render_template|payments_dialog|upload_\w+|sso|destroy|delete|remove|send|send_email|email_\w+|sms|text_message|approve|accept|decline|convert|duplicate|clone|copy|archive|unarchive|cancel|complete|mark_\w+|sync|charge|pay|refund|void|impersonate|unsubscribe|download|export|print|oauth|connect|disconnect|reconnect|authorize|callback)($|[\/_?=&.-])|\.(pdf|csv|xlsx)$/i;

async function waitForLogin(p) {
  console.log("Waiting for you to sign in to SingleOps in the Chrome window (10 min max)…");
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const u = new URL(p.url());
    if (u.hostname.endsWith("singleops.com") && !/sign_in|login|password|sessions/i.test(u.pathname)) {
      await p.waitForLoadState("networkidle").catch(() => {});
      console.log(auto ? "Signed in. Crawling read-only — please don't click in the window." : "Signed in. Saving the session…");
      return;
    }
    await p.waitForTimeout(2000);
  }
  throw new Error("Timed out waiting for login.");
}

function templateOf(pathname) {
  return pathname
    .split("/")
    .map((s) => (/^\d+$/.test(s) || /^[0-9a-f-]{36}$/i.test(s) || (s.length >= 16 && /\d/.test(s)) ? "{id}" : s))
    .join("/");
}

async function crawl(p) {
  const origin = new URL(p.url()).origin;
  const queue = [p.url()];
  const seen = new Set();
  const perTemplate = new Map();
  let visited = 0;

  while (queue.length && visited < MAX_PAGES) {
    const href = queue.shift();
    let u;
    try {
      u = new URL(href, origin);
    } catch {
      continue;
    }
    if (u.origin !== origin || UNSAFE.test(u.pathname + u.search)) continue;
    u.hash = "";
    const key = u.pathname + u.search;
    if (seen.has(key)) continue;
    seen.add(key);
    const tpl = templateOf(u.pathname) + (u.searchParams.has("page") ? "?page" : "");
    const n = perTemplate.get(tpl) ?? 0;
    if (n >= PER_TEMPLATE) continue;
    perTemplate.set(tpl, n + 1);

    try {
      await p.goto(u.toString(), { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      /* slow page: keep whatever traffic it produced */
    }
    if (/sign_in|login/i.test(new URL(p.url()).pathname)) {
      console.log("Session ended mid-crawl; stopping.");
      break;
    }
    // Lazy lists load on scroll; trigger them.
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await p.waitForTimeout(800);
    visited++;
    console.log(`[${visited}] ${tpl}`); // template only — no names or ids in the log

    const links = await p
      .$$eval("a[href]:not([data-method]):not([data-turbo-method])", (as) => as.map((a) => a.getAttribute("href")))
      .catch(() => []);
    for (const l of links) if (l && !l.startsWith("mailto:") && !l.startsWith("tel:") && !l.startsWith("javascript:")) queue.push(l);
  }
  console.log(`Crawl done: ${visited} pages, ${perTemplate.size} page types.`);
}
const label = (args.find((a) => !a.startsWith("--")) ?? "session").replace(/[^A-Za-z0-9_-]/g, "");

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(CAPTURE_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const harPath = path.join(CAPTURE_DIR, `${stamp}-${label}.har`);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  channel: "chrome",
  viewport: null,
  ...(loginOnly ? {} : { recordHar: { path: harPath, content: "embed", urlFilter: /singleops\.com/ } }),
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(START_URL);

const CHECKLIST = `
  Sign in to SingleOps if asked. Then, ${loginOnly ? "once you see the dashboard," : "visit every screen below (open a record in each):"}
${
  loginOnly
    ? ""
    : `
   READ   Dashboard · Clients (list + one client) · Properties/Locations · Contacts
          Leads · Proposals/Estimates · Jobs (active + completed) · Visits/Schedule
          Items/Catalog · Categories · Operations · Invoices · Payments · Notes
          Attachments · Reports · Users · Custom inputs · Settings → Integrations (QuickBooks)
          Use search, filters and page 2 of long lists — that captures query params.
   WRITE  For each of: client, property, contact, item, job/proposal (with a line item),
          note, attachment — CREATE one record named ZZ-TEST-MCP, EDIT it, then DELETE it.
          That is the only way to learn the write payloads. Leave nothing behind.
`
}
  Press Enter here when done.`;

if (auto) {
  await waitForLogin(page);
  await crawl(page);
} else if (loginOnly) {
  // npm run login: sign in by hand; the session is saved as soon as the app loads.
  await waitForLogin(page);
} else {
  console.log(CHECKLIST);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question("", resolve));
  rl.close();
}

await context.storageState({ path: SESSION_FILE });
await context.close(); // flushes the HAR

console.log(`\nSession saved: ${path.relative(ROOT, SESSION_FILE)}`);
if (!loginOnly) {
  const size = fs.existsSync(harPath) ? (fs.statSync(harPath).size / 1e6).toFixed(1) : "0";
  console.log(`HAR saved:     ${path.relative(ROOT, harPath)} (${size} MB)`);
  console.log(`Next:          npm run map`);
}
