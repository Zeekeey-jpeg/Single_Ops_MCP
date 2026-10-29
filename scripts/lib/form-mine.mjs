/**
 * Mines write endpoints out of the HTML the crawl already captured, without
 * performing a single write.
 *
 * SingleOps is a Rails app: every create/edit screen renders a <form> whose
 * action, method (hidden `_method` for PATCH/PUT/DELETE) and field names are
 * exactly the request the browser would send on submit. Rails UJS links
 * (`data-method="delete"`) do the same for one-click actions.
 *
 * Keeps names and input types only. Values (prefilled client data, select
 * options, hidden ids, tokens) are never read into the result.
 */

import { templatePath, routeId, denyReason } from "./har-map.mjs";

const SKIP_FIELDS = /^(authenticity_token|utf8|_method|commit|button|submit|redirect_to|return_to)$/i;
/** Forms that are auth, search or navigation, not data writes. */
const SKIP_ACTION = /(sign_in|sign_out|password|login|logout|\/search\b|_search\b|\/filter\b)/i;

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : undefined;
};

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** client[address][0][city] -> ["client","address","[]","city"] */
export function fieldPath(name) {
  const parts = [];
  const head = name.match(/^[^[]+/);
  if (!head) return [];
  parts.push(head[0]);
  for (const m of name.slice(head[0].length).matchAll(/\[([^\]]*)\]/g)) {
    parts.push(m[1] === "" || /^\d+$/.test(m[1]) || /^new_\w+$/.test(m[1]) ? "[]" : m[1]);
  }
  return parts;
}

function typeOfInput(tag, kind) {
  if (kind === "textarea") return "string";
  if (kind === "select") return attr(tag, "multiple") !== undefined ? "array" : "string";
  const t = (attr(tag, "type") ?? "text").toLowerCase();
  if (t === "number" || t === "range") return "number";
  if (t === "checkbox") return "boolean";
  if (t === "file") return "file";
  return "string"; // text, hidden, email, tel, date, datetime-local, …
}

/** Inserts a field path into a Shape tree. */
function addField(node, parts, type) {
  const [p, ...rest] = parts;
  if (p === undefined) return;
  if (p === "[]") {
    node.type = "array";
    if (!rest.length) {
      node.items ??= { type };
      return;
    }
    if (node.items?.type !== "object") node.items = { type: "object", properties: {} };
    addField(node.items, rest, type);
    return;
  }
  node.type = "object";
  node.properties ??= {};
  if (!rest.length) {
    node.properties[p] ??= { type };
    return;
  }
  node.properties[p] ??= {};
  addField(node.properties[p], rest, type);
}

/** Extracts forms and data-method links from one HTML document. */
export function extractForms(html, pageUrl) {
  const out = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const [, open, inner] = m;
    const tag = `<form${open}>`;
    const action = decode(attr(tag, "action") ?? "");
    let method = (attr(tag, "method") ?? "get").toUpperCase();
    const override = inner.match(/<input\b[^>]*name\s*=\s*["']_method["'][^>]*>/i);
    if (override) method = (attr(override[0], "value") ?? method).toUpperCase();
    if (method === "GET") continue;

    const fields = [];
    for (const f of inner.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const kind = f[1].toLowerCase();
      const ftag = `<${kind}${f[2]}>`;
      const name = attr(ftag, "name");
      if (!name || SKIP_FIELDS.test(name)) continue;
      const t = (attr(ftag, "type") ?? "").toLowerCase();
      if (t === "submit" || t === "button" || t === "image" || t === "reset") continue;
      fields.push({ name: decode(name), type: typeOfInput(ftag, kind) });
    }
    const multipart = /multipart/i.test(attr(tag, "enctype") ?? "") || fields.some((f) => f.type === "file");
    out.push({ method, action: action || pageUrl, fields, multipart, remote: attr(tag, "data-remote") === "true" });
  }
  for (const m of html.matchAll(/<a\b[^>]*\sdata-(?:turbo-)?method\s*=\s*["'](\w+)["'][^>]*>/gi)) {
    const href = attr(m[0], "href");
    if (href) out.push({ method: m[1].toUpperCase(), action: decode(href), fields: [], multipart: false, remote: true, link: true });
  }
  return out;
}

/** Field names with a record id baked in (visit_24416437_can_update_recurrence) are per-record UI state, not API fields. */
const ID_IN_NAME = /\d{5,}/;

/**
 * Folds extracted forms into write routes, shaped like api-map routes.
 * @param {{forms: ReturnType<typeof extractForms>, pageUrl: string}[]} pages
 */
export function formsToRoutes(pages, host = "singleops.com") {
  const routes = new Map();
  for (const { forms, pageUrl } of pages) {
    for (const f of forms) {
      // data-method="get" links are navigation; JS-template actions ('+o+') are not real URLs.
      if (f.method === "GET" || /['"+]/.test(f.action)) continue;
      let url;
      try {
        // Client-side templates render {{:id}} into hrefs; treat it as an id.
        url = new URL(f.action.replace(/\{\{:?\w+\}\}|%7B%7B:?\w+%7D%7D/gi, "1"), pageUrl);
      } catch {
        continue;
      }
      if (!url.hostname.endsWith(host) || SKIP_ACTION.test(url.pathname)) continue;
      if (/\.\d+$|\.(csv|pdf|xlsx)$/i.test(url.pathname)) continue;
      const { path, params } = templatePath(url.pathname);
      const id = routeId(f.method, path);
      let r = routes.get(id);
      if (!r) {
        r = {
          id,
          method: f.method,
          path,
          pathParams: params,
          queryParams: [],
          bodyKind: f.multipart ? "multipart" : "form",
          body: null,
          response: null,
          statuses: [],
          seen: 0,
          verified: false,
          auth: "session",
          source: f.link ? "link" : "form",
          remote: f.remote,
        };
        const deny = denyReason(path);
        if (deny) {
          r.policy = "deny";
          r.denyReason = deny;
        }
        routes.set(id, r);
      }
      r.seen++;
      if (f.multipart) r.bodyKind = "multipart";
      for (const fld of f.fields) {
        if (ID_IN_NAME.test(fld.name)) continue;
        r.body ??= { type: "object", properties: {} };
        addField(r.body, fieldPath(fld.name), fld.type);
      }
    }
  }
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
