/**
 * The connection: turns the logged-in browser session into request headers.
 *
 * We do not decide the auth scheme up front. scripts/har-to-map.mjs records how
 * the web app actually authenticates (cookies, a CSRF header, a bearer JWT, or a
 * mix) into api-map.json `auth`, and this module replays exactly that, sourcing
 * values from state/session.json (Playwright storageState).
 *
 * The session is created by a human typing their own login into a headed browser
 * (`npm run login`). This server never sees or stores the password, and it never
 * logs in on its own. When the session expires, tools fail with a clear message.
 */

import fs from "node:fs";
import { SESSION_FILE } from "./config.js";
import type { AuthSpec } from "./map.js";

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // seconds since epoch; -1 = session cookie
}

interface StorageState {
  cookies: StoredCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

export class AuthError extends Error {}

const LOGIN_HINT =
  "Run `npm run login` (a browser opens at app.singleops.com; sign in by hand and the session is saved automatically).";

export function loadSession(file = SESSION_FILE): StorageState {
  if (!fs.existsSync(file)) throw new AuthError(`No SingleOps session yet. ${LOGIN_HINT}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as StorageState;
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.replace(/^\./, "");
  return host === d || host.endsWith(`.${d}`);
}

function cookieValue(state: StorageState, host: string, name: string): string | undefined {
  return state.cookies.find((c) => c.name === name && domainMatches(c.domain, host))?.value;
}

function storageValue(state: StorageState, host: string, key: string): string | undefined {
  for (const o of state.origins) {
    if (!o.origin.includes(host)) continue;
    const hit = o.localStorage.find((e) => e.name === key);
    if (hit) return hit.value;
  }
  return undefined;
}

/** A stored token may be a bare string or JSON wrapping one. */
export function unwrapToken(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith("{") && !t.startsWith('"')) return t;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      for (const k of ["token", "access_token", "accessToken", "jwt", "id_token", "auth_token"]) {
        if (typeof o[k] === "string") return o[k] as string;
      }
    }
  } catch {
    /* not JSON */
  }
  return t;
}

/** Resolves "cookie:<name>" | "localStorage:<key>" | "meta" sources. */
function resolveSource(
  source: string,
  state: StorageState,
  host: string,
  metaCsrf: string | undefined,
): string | undefined {
  const [kind, ...rest] = source.split(":");
  const key = rest.join(":");
  if (kind === "cookie") {
    const v = cookieValue(state, host, key);
    return v === undefined ? undefined : decodeURIComponent(v);
  }
  if (kind === "localStorage") {
    const v = storageValue(state, host, key);
    return v === undefined ? undefined : unwrapToken(v);
  }
  if (kind === "meta") return metaCsrf;
  return undefined;
}

/** Decodes a JWT's exp claim without verifying it. Returns ms epoch or undefined. */
export function jwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class SessionAuth {
  private metaCsrf: string | undefined;

  constructor(
    private readonly spec: AuthSpec,
    private readonly baseUrl: string,
    private readonly sessionFile = SESSION_FILE,
  ) {}

  private get host(): string {
    return new URL(this.baseUrl).host;
  }

  /** Rails-style apps put the CSRF token in a <meta> tag on the HTML shell. */
  private async fetchMetaCsrf(cookieHeader: string): Promise<string | undefined> {
    const res = await fetch(this.baseUrl + "/", { headers: { cookie: cookieHeader }, redirect: "manual" });
    const html = await res.text();
    return /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  }

  async headers(method: string): Promise<Record<string, string>> {
    const state = loadSession(this.sessionFile);
    const host = this.host;
    const out: Record<string, string> = { accept: "application/json", ...this.spec.extraHeaders };

    // Send every cookie for the host, not just the ones seen in the capture:
    // apps rotate cookie names, and the browser would send them all anyway.
    const cookies = state.cookies.filter((c) => domainMatches(c.domain, host));
    if (cookies.length) out.cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    if (this.spec.bearer) {
      const token = resolveSource(this.spec.bearer.source, state, host, undefined);
      if (!token) throw new AuthError(`Bearer token not found in session (${this.spec.bearer.source}). ${LOGIN_HINT}`);
      const exp = jwtExpiry(token);
      if (exp !== undefined && exp < Date.now()) throw new AuthError(`SingleOps token expired. ${LOGIN_HINT}`);
      out[this.spec.bearer.header.toLowerCase()] = /^bearer /i.test(token) ? token : `Bearer ${token}`;
    }

    if (this.spec.csrf && method !== "GET") {
      if (this.spec.csrf.source === "meta" && !this.metaCsrf) {
        this.metaCsrf = await this.fetchMetaCsrf(out.cookie ?? "");
      }
      const csrf = resolveSource(this.spec.csrf.source, state, host, this.metaCsrf);
      if (!csrf) throw new AuthError(`CSRF token not found (${this.spec.csrf.source}). ${LOGIN_HINT}`);
      out[this.spec.csrf.header.toLowerCase()] = csrf;
    }
    return out;
  }

  /** Forget cached CSRF so the next write re-reads it (after a 422/419). */
  resetCsrf(): void {
    this.metaCsrf = undefined;
  }

  /** Non-secret description of the session for whoami. */
  status(): Record<string, unknown> {
    let state: StorageState;
    try {
      state = loadSession(this.sessionFile);
    } catch (e) {
      return { session: "missing", hint: (e as Error).message };
    }
    const host = this.host;
    const cookies = state.cookies.filter((c) => domainMatches(c.domain, host));
    const expiring = cookies.filter((c) => c.expires > 0).map((c) => c.expires * 1000);
    const out: Record<string, unknown> = {
      session: "present",
      scheme: this.spec.scheme,
      cookieCount: cookies.length,
      cookieNames: cookies.map((c) => c.name),
      earliestCookieExpiry: expiring.length ? new Date(Math.min(...expiring)).toISOString() : "session-only",
    };
    if (this.spec.bearer) {
      const token = resolveSource(this.spec.bearer.source, state, host, undefined);
      const exp = token ? jwtExpiry(token) : undefined;
      out.bearer = token ? { present: true, expires: exp ? new Date(exp).toISOString() : "unknown" } : { present: false };
    }
    return out;
  }
}
