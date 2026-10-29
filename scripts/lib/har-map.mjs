/**
 * HAR -> route map. The reverse-engineering core, same idea as
 * alufers/mitmproxy2swagger and jonluca/har-to-openapi, specialised for one
 * session-authenticated web app and for one hard rule:
 *
 *   The map carries SHAPES, never VALUES. Field names and types go in;
 *   client names, addresses, prices, tokens and cookie values never do.
 *
 * Pure functions only (no fs), so they are unit-tested in test/har-map.test.ts.
 */

const STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|webp|mp4|webmanifest)$/i;
const NOISE_PATH = /^\/(assets|packs|cable|sspa_mfes|rails\/active_storage\/representations)\b/i;
const NOISE_QUERY = new Set(["_", "timestamp", "cachebuster", "_cb"]);
const PAGINATION_PARAM = /^(page|per_page|perpage|page_size|pagesize|limit|offset|cursor|after|before)$/i;
const PAGINATION_KEY = /^(meta|total|total_count|total_pages|count|next|next_page|prev|links|pagination|page|per_page)$/i;
/**
 * Rails datatable/report endpoints are reads sent as POST (the filter set is the
 * body). They are classified read-only so the read gate, not the write gate,
 * governs them. Anything saving/updating is excluded even if it matches.
 */
export const READ_POST = /(data_?table|_report|report$|\/reports?\/|totals|search|check_batch|\/filter|lookup)/i;
const WRITE_WORDS = /(save|update|create|destroy|delete|remove|send|import|upload|toggle|submit|approve|reject)/i;
export function isReadOnly(method, path) {
  if (method === "GET" || method === "HEAD") return true;
  return method === "POST" && READ_POST.test(path) && !WRITE_WORDS.test(path);
}
/**
 * Writes that must never be exposed, whatever the gates say: they move money,
 * change the subscription or billing, touch logins, send mail/SMS to the
 * customers, or reconfigure the whole account.
 */
export const WRITE_DENY = [
  [/payment_gateway|propay|financings|subscription|salesforce|licenses/i, "billing, payments or subscription"],
  [/^\/users\b|invitation|password/i, "user accounts and logins"],
  [/email|prepare_email|text_message|sms|signatures/i, "sends to customers"],
  [/^\/accounts?\b|account_settings/i, "account-wide settings"],
  [/^\/imports?\b/i, "bulk import"],
  [/margins|repredict|tooltip|table_settings/i, "bulk recalculation or UI state"],
];

export function denyReason(path) {
  return WRITE_DENY.find(([re]) => re.test(path))?.[1];
}

const SAFE_EXTRA_HEADERS = new Set(["x-requested-with", "accept-version", "x-api-version", "x-client-version"]);

// ---------------------------------------------------------------- shapes

export function shapeOf(value, depth = 0) {
  if (value === null || value === undefined) return { type: "null" };
  if (Array.isArray(value)) {
    let items = null;
    for (const v of value.slice(0, 50)) items = items ? mergeShapes(items, shapeOf(v, depth + 1)) : shapeOf(v, depth + 1);
    return items ? { type: "array", items } : { type: "array" };
  }
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      if (depth > 6) return { type: "object" };
      const properties = {};
      for (const [k, v] of Object.entries(value)) properties[k] = shapeOf(v, depth + 1);
      return { type: "object", properties };
    }
    default:
      return { type: "mixed" };
  }
}

export function mergeShapes(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.type === "null") return b;
  if (b.type === "null") return a;
  if ((a.type === "integer" && b.type === "number") || (a.type === "number" && b.type === "integer")) return { type: "number" };
  if (a.type !== b.type) return { type: "mixed" };
  if (a.type === "object") {
    const properties = { ...(a.properties ?? {}) };
    for (const [k, v] of Object.entries(b.properties ?? {})) properties[k] = mergeShapes(properties[k], v);
    return { type: "object", properties };
  }
  if (a.type === "array") {
    const items = mergeShapes(a.items, b.items);
    return items ? { type: "array", items } : { type: "array" };
  }
  return a;
}

// ---------------------------------------------------------------- paths

const isNumeric = (s) => /^\d+$/.test(s);
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isOpaqueId = (s) => s.length >= 16 && /\d/.test(s) && /^[A-Za-z0-9_-]+$/.test(s);

function singular(word) {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(ses|xes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * /api/v1/clients/123/jobs/456.json -> { path: /api/v1/clients/{client_id}/jobs/{job_id}.json,
 *                                        params: [client_id, job_id] }
 */
export function templatePath(pathname) {
  const segs = pathname.split("/");
  const params = [];
  const out = segs.map((seg, i) => {
    if (!seg) return seg;
    const m = /^(.*?)(\.json)?$/.exec(seg);
    const core = m[1];
    const ext = m[2] ?? "";
    if (isNumeric(core) || isUuid(core) || isOpaqueId(core)) {
      const prev = segs[i - 1];
      let name = prev && !isNumeric(prev) && !isUuid(prev) ? `${singular(prev).replace(/[^A-Za-z0-9]/g, "_")}_id` : "id";
      const laterIds = segs.slice(i + 1).map((s) => s.replace(/\.json$/, "")).filter((s) => isNumeric(s) || isUuid(s) || isOpaqueId(s));
      if (params.length === 0 && laterIds.length === 0) {
        // Single trailing id keeps the conventional name {id}.
        name = "id";
      }
      while (params.includes(name)) name = `${name}_${params.length + 1}`;
      params.push(name);
      return `{${name}}${ext}`;
    }
    return seg;
  });
  return { path: out.join("/"), params };
}

export function routeId(method, templ) {
  const slug = templ
    .replace(/\.json$/, "")
    .replace(/\{(\w+)\}/g, "$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `${method.toLowerCase()}_${slug}`.slice(0, 54);
}

// ---------------------------------------------------------------- entries

function headerMap(headers = []) {
  const m = {};
  for (const h of headers) m[h.name.toLowerCase()] = h.value;
  return m;
}

function decodeContent(content) {
  if (!content || typeof content.text !== "string") return undefined;
  const raw = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
  return raw;
}

function tryJson(text) {
  if (typeof text !== "string" || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Rails-style form body -> object of keys (values replaced by "") for shaping. */
function parseForm(text) {
  const obj = {};
  for (const [k] of new URLSearchParams(text)) obj[k] = "";
  return obj;
}

export function isApiEntry(entry, hostSuffix = "singleops.com") {
  let url;
  try {
    url = new URL(entry.request.url);
  } catch {
    return false;
  }
  if (!url.hostname.endsWith(hostSuffix)) return false;
  if (STATIC_EXT.test(url.pathname) || NOISE_PATH.test(url.pathname)) return false;
  if (entry.request.method === "OPTIONS") return false;
  // Auth endpoints are never tools: the human owns login.
  if (/sign_in|sign_out|password|\/login\b/i.test(url.pathname)) return false;
  const resType = (entry.response?.content?.mimeType ?? "").toLowerCase();
  const reqType = (entry.request.postData?.mimeType ?? "").toLowerCase();
  return url.pathname.startsWith("/api/") || url.pathname.endsWith(".json") || resType.includes("json") || reqType.includes("json");
}

// ---------------------------------------------------------------- auth

/**
 * Infer how the app authenticates, using HAR request headers, and locate where
 * each secret lives in the saved session (storageState) so it can be replayed.
 * Returns names/locations only.
 */
export function inferAuth(apiEntries, session) {
  const cookieNames = new Set();
  let bearerHeader;
  let bearerValue;
  let csrfHeader;
  let csrfValue;
  const extra = {};
  const extraSeen = {};

  for (const e of apiEntries) {
    const h = headerMap(e.request.headers);
    if (h.cookie) for (const part of h.cookie.split(";")) cookieNames.add(part.split("=")[0].trim());
    if (h.authorization && /^bearer\s+/i.test(h.authorization)) {
      bearerHeader = "Authorization";
      bearerValue = h.authorization.replace(/^bearer\s+/i, "");
    }
    for (const name of ["x-csrf-token", "x-xsrf-token", "csrf-token"]) {
      if (h[name]) {
        csrfHeader = name;
        csrfValue = h[name];
      }
    }
    for (const [name, value] of Object.entries(h)) {
      if (!SAFE_EXTRA_HEADERS.has(name)) continue;
      extraSeen[name] = extraSeen[name] === undefined || extraSeen[name] === value ? value : null;
    }
  }
  for (const [k, v] of Object.entries(extraSeen)) if (v) extra[k] = v;

  const locate = (value) => {
    if (!value || !session) return undefined;
    for (const c of session.cookies ?? []) {
      let dv = c.value;
      try {
        dv = decodeURIComponent(c.value);
      } catch {
        /* keep raw */
      }
      if (c.value === value || dv === value) return `cookie:${c.name}`;
    }
    for (const o of session.origins ?? []) {
      for (const item of o.localStorage ?? []) {
        if (item.value === value || item.value.includes(`"${value}"`)) return `localStorage:${item.name}`;
      }
    }
    return undefined;
  };

  const auth = { scheme: "unknown", cookieNames: [...cookieNames].sort(), extraHeaders: extra };
  if (bearerHeader) auth.bearer = { header: bearerHeader, source: locate(bearerValue) ?? "unlocated" };
  if (csrfHeader) auth.csrf = { header: csrfHeader, source: locate(csrfValue) ?? "meta" };

  if (auth.bearer && cookieNames.size) auth.scheme = "bearer+cookie";
  else if (auth.bearer) auth.scheme = "bearer";
  else if (auth.csrf) auth.scheme = "cookie+csrf";
  else if (cookieNames.size) auth.scheme = "cookie";
  return auth;
}

// ---------------------------------------------------------------- build

export function buildMap(hars, { session, previous, captureNames = [], formRoutes = [] } = {}) {
  const entries = hars.flatMap((h) => h.log?.entries ?? []).filter((e) => isApiEntry(e));
  const routes = new Map();

  for (const e of entries) {
    const url = new URL(e.request.url);
    const method = e.request.method.toUpperCase();
    const { path, params } = templatePath(url.pathname);
    const key = `${method} ${path}`;
    const r =
      routes.get(key) ??
      {
        id: routeId(method, path),
        method,
        path,
        pathParams: params,
        queryParams: [],
        bodyKind: null,
        body: null,
        response: null,
        statuses: [],
        seen: 0,
        verified: false,
        auth: "session",
      };
    r.seen++;
    const status = e.response?.status ?? 0;
    if (status && !r.statuses.includes(status)) r.statuses.push(status);

    for (const [q] of url.searchParams) {
      if (!NOISE_QUERY.has(q) && !q.startsWith("user_") && !r.queryParams.includes(q)) r.queryParams.push(q);
    }

    const pd = e.request.postData;
    if (pd?.text) {
      const mt = (pd.mimeType ?? "").toLowerCase();
      if (mt.includes("json")) {
        const j = tryJson(pd.text);
        if (j !== undefined) {
          r.bodyKind = "json";
          r.body = mergeShapes(r.body, shapeOf(j));
        }
      } else if (mt.includes("x-www-form-urlencoded")) {
        r.bodyKind = r.bodyKind ?? "form";
        r.body = mergeShapes(r.body, shapeOf(parseForm(pd.text)));
      }
    }

    if (status >= 200 && status < 300) {
      const j = tryJson(decodeContent(e.response.content));
      if (j !== undefined) r.response = mergeShapes(r.response, shapeOf(j));
    }
    routes.set(key, r);
  }

  // Write routes mined from HTML forms (form-mine.mjs). Observed XHR traffic wins
  // where both exist; the form fills in a body the XHR capture never saw.
  for (const f of formRoutes) {
    const key = `${f.method} ${f.path}`;
    const seen = routes.get(key);
    if (!seen) {
      routes.set(key, { ...f });
      continue;
    }
    if (!seen.body && f.body) {
      seen.body = f.body;
      seen.bodyKind = f.bodyKind;
    }
    for (const k of ["source", "remote", "policy", "denyReason"]) if (f[k] !== undefined) seen[k] ??= f[k];
  }

  // Ids must be unique; suffix collisions deterministically.
  const ids = new Set();
  const out = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const r of out) {
    let id = r.id;
    for (let n = 2; ids.has(id); n++) id = `${r.id}_${n}`;
    r.id = id;
    ids.add(id);
    r.statuses.sort();
    r.readOnly = isReadOnly(r.method, r.path);
    const deny = denyReason(r.path);
    if (deny && !r.readOnly) {
      r.policy = "deny";
      r.denyReason = deny;
    }
    const pagParams = r.queryParams.filter((q) => PAGINATION_PARAM.test(q));
    const respKeys = r.response?.type === "object" ? Object.keys(r.response.properties ?? {}).filter((k) => PAGINATION_KEY.test(k)) : [];
    if (pagParams.length) r.pagination = { params: pagParams, responseKeys: respKeys };

    // Keep hand edits (summary, verified) from the previous map.
    const prev = previous?.routes?.find((p) => p.method === r.method && p.path === r.path);
    if (prev?.summary) r.summary = prev.summary;
    if (prev?.verified) r.verified = true;
    if (prev?.policy && !r.policy) {
      r.policy = prev.policy; // a hand-set deny survives remapping
      r.denyReason = prev.denyReason;
    }
    if (prev) r.seen += prev.seen;
    if (prev) {
      r.body = mergeShapes(prev.body, r.body);
      r.response = mergeShapes(prev.response, r.response);
      for (const q of prev.queryParams) if (!r.queryParams.includes(q)) r.queryParams.push(q);
    }
  }
  // Routes seen before but not in this capture are kept, so maps accumulate.
  for (const p of previous?.routes ?? []) {
    if (!out.some((r) => r.method === p.method && r.path === p.path)) out.push(p);
  }

  const auth = entries.length ? inferAuth(entries, session) : previous?.auth ?? { scheme: "unknown", cookieNames: [], extraHeaders: {} };

  return {
    generatedAt: new Date().toISOString(),
    host: "app.singleops.com",
    captures: [...new Set([...(previous?.captures ?? []), ...captureNames])],
    auth,
    routes: out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
  };
}

// ---------------------------------------------------------------- report

function keys(shape) {
  if (!shape) return "";
  if (shape.type === "object") return Object.keys(shape.properties ?? {}).slice(0, 12).join(", ");
  if (shape.type === "array") return `[ ${keys(shape.items)} ]`;
  return shape.type;
}

export function renderMarkdown(map) {
  const byResource = {};
  for (const r of map.routes) {
    const res = r.path.replace(/^\/api\/v\d+/, "").split("/").filter(Boolean)[0] ?? "/";
    (byResource[res] ??= []).push(r);
  }
  const lines = [
    "# SingleOps API map",
    "",
    `Generated ${map.generatedAt} from ${map.captures.length} capture(s). **${map.routes.length} routes.** Shapes only — no client values.`,
    "",
    "## Auth",
    "",
    `- Scheme: **${map.auth.scheme}**`,
    `- Cookies: ${map.auth.cookieNames.join(", ") || "(none)"}`,
    map.auth.csrf ? `- CSRF: \`${map.auth.csrf.header}\` from \`${map.auth.csrf.source}\`` : "- CSRF: none seen",
    map.auth.bearer ? `- Bearer: \`${map.auth.bearer.header}\` from \`${map.auth.bearer.source}\`` : "- Bearer/JWT: none seen",
    "",
    "## Routes",
  ];
  for (const res of Object.keys(byResource).sort()) {
    lines.push("", `### ${res}`, "", "| Method | Path | Seen | Status | Query | Body keys | Response keys |", "|---|---|---|---|---|---|---|");
    for (const r of byResource[res]) {
      lines.push(
        `| ${r.method} | \`${r.path}\` | ${r.seen} | ${r.statuses.join(",")} | ${r.queryParams.join(", ")} | ${keys(r.body)} | ${keys(r.response)} |`,
      );
    }
  }
  lines.push(
    "",
    "## Backfill questions to answer from this map",
    "",
    "- Can `created_at` / completed / invoice dates be set on create (look for date keys in POST bodies)?",
    "- Can a job be created directly in a completed state without generating an invoice?",
    "- Is there a custom input / external id field to hold the ServiceM8 UUID?",
    "- Attachment upload flow (presigned S3 vs multipart)?",
    "- QuickBooks integration status route?",
    "",
  );
  return lines.join("\n");
}
