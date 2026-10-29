/**
 * The route map: the single source of truth for which SingleOps endpoints this
 * server may call. It is generated from captured browser traffic by
 * scripts/har-to-map.mjs and holds shapes only (names and types, never values).
 *
 * A route not in the map cannot be called. There is no free-form URL tool.
 */

import fs from "node:fs";
import { MAP_FILE } from "./config.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A tiny JSON-schema subset, inferred from observed traffic. */
export interface Shape {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" | "mixed";
  properties?: Record<string, Shape>;
  items?: Shape;
}

export interface Route {
  /** Stable id, also the tool-name suffix, e.g. get_api_v1_clients_id. */
  id: string;
  method: HttpMethod;
  /** Templated path, e.g. /api/v1/clients/{id}. */
  path: string;
  pathParams: string[];
  queryParams: string[];
  bodyKind: "json" | "form" | "multipart" | null;
  body: Shape | null;
  response: Shape | null;
  statuses: number[];
  /** How many times the route was seen in captures. */
  seen: number;
  /** true = documented by SingleOps or confirmed by contract test. */
  verified: boolean;
  auth: "session" | "lead_token";
  /** GET, or a POST that only queries (Rails datatable/report). Governed by the read gate. */
  readOnly?: boolean;
  pagination?: { params: string[]; responseKeys: string[] };
  /** One-line human note, hand-editable in api-map.json. */
  summary?: string;
  /** Where the route came from: observed XHR traffic, or a Rails <form> / data-method link in captured HTML. */
  source?: "xhr" | "form" | "link";
  /** Rails UJS remote form (submitted via XHR, answers with JS). Plain forms answer with a redirect. */
  remote?: boolean;
  /** "deny" = never registered, whatever the gates say (billing, logins, customer sends). Hand-editable. */
  policy?: "deny";
  denyReason?: string;
}

export interface AuthSpec {
  /** Observed scheme. "unknown" until a capture has been mapped. */
  scheme: "cookie" | "cookie+csrf" | "bearer" | "bearer+cookie" | "unknown";
  /** Names only. Values live in state/session.json. */
  cookieNames: string[];
  csrf?: { header: string; source: string };
  bearer?: { header: string; source: string };
  /** Other non-standard request headers the app always sends (names only). */
  extraHeaders: Record<string, string>;
}

export interface ApiMap {
  generatedAt: string | null;
  host: string;
  captures: string[];
  auth: AuthSpec;
  routes: Route[];
}

/**
 * The four routes SingleOps documents for the Lead Entry API. These work with
 * the issued API user and need no capture, so the server is useful from day one.
 */
export const LEAD_ROUTES: Route[] = [
  {
    id: "lead_get_operations",
    method: "GET",
    path: "/api/v1/operations",
    pathParams: [],
    queryParams: [],
    bodyKind: null,
    body: null,
    response: null,
    statuses: [200],
    seen: 0,
    verified: true,
    auth: "lead_token",
    summary: "Lead Entry API: list operations (divisions).",
  },
  {
    id: "lead_get_custom_inputs",
    method: "GET",
    path: "/api/v1/custom_inputs",
    pathParams: [],
    queryParams: [],
    bodyKind: null,
    body: null,
    response: null,
    statuses: [200],
    seen: 0,
    verified: true,
    auth: "lead_token",
    summary: "Lead Entry API: list custom input (custom field) definitions.",
  },
  {
    id: "lead_search_clients",
    method: "GET",
    path: "/api/v1/clients/search_by_field",
    pathParams: [],
    queryParams: ["search_field", "search_term", "page"],
    bodyKind: null,
    body: null,
    response: null,
    statuses: [200],
    seen: 0,
    verified: true,
    auth: "lead_token",
    summary: "Lead Entry API: search clients. search_field = email | phone (prefix match).",
  },
  {
    id: "lead_create_job",
    method: "POST",
    path: "/api/v1/jobs",
    pathParams: [],
    queryParams: [],
    bodyKind: "json",
    body: { type: "object" },
    response: null,
    statuses: [200, 201],
    seen: 0,
    verified: true,
    auth: "lead_token",
    summary: "Lead Entry API: create a lead (for an existing client_id, or with a new client profile).",
  },
];

export function emptyMap(): ApiMap {
  return {
    generatedAt: null,
    host: "app.singleops.com",
    captures: [],
    auth: { scheme: "unknown", cookieNames: [], extraHeaders: {} },
    routes: [],
  };
}

export function loadMap(file = MAP_FILE): ApiMap {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ApiMap;
  } catch {
    return emptyMap();
  }
}

/** Fills {param} placeholders. Values are URI-encoded; missing params throw. */
export function fillPath(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === "") throw new Error(`Missing path parameter "${name}" for ${template}`);
    return encodeURIComponent(String(v));
  });
}
