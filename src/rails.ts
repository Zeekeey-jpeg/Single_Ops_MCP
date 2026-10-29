/**
 * Rails form conventions, for routes mined from the app's own <form>s.
 *
 * Request: nested objects become bracket keys the way a browser submits them
 * (client[first_name], job[line_items_attributes][0][qty]); booleans become the
 * "1"/"0" a Rails checkbox sends.
 *
 * Response: a plain Rails form answers success with a 302 to the record and
 * failure with a 200 re-render carrying error markup. Neither is JSON, so the
 * outcome is read from the status, the Location header and the error block.
 */

export type Pair = [string, string];

function scalar(v: unknown): string {
  if (v === true) return "1";
  if (v === false) return "0";
  if (v === null || v === undefined) return "";
  return String(v);
}

export function railsPairs(value: unknown, prefix = ""): Pair[] {
  if (Array.isArray(value)) {
    // Arrays of objects use index keys (Rails nested attributes); scalars use [].
    return value.flatMap((v, i) =>
      v !== null && typeof v === "object" ? railsPairs(v, `${prefix}[${i}]`) : ([[`${prefix}[]`, scalar(v)]] as Pair[]),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => railsPairs(v, prefix ? `${prefix}[${k}]` : k));
  }
  return prefix ? [[prefix, scalar(value)]] : [];
}

export function encodeForm(body: unknown): string {
  return new URLSearchParams(railsPairs(body)).toString();
}

export function encodeMultipart(body: unknown): FormData {
  const fd = new FormData();
  for (const [k, v] of railsPairs(body)) fd.append(k, v);
  return fd;
}

const ERROR_BLOCK =
  /<(div|ul)[^>]*(id=["']error_explanation["']|class=["'][^"']*(alert-danger|alert-error|form-errors|error-messages)[^"']*["'])[^>]*>([\s\S]*?)<\/\1>/i;

/** Plain-text validation messages from a Rails error block, if the page has one. */
export function railsErrors(html: string): string[] | undefined {
  const block = html.match(ERROR_BLOCK)?.[4];
  const items = block
    ? [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1])
    : /field_with_errors|has-error|is-invalid/.test(html)
      ? ["One or more fields were rejected (field_with_errors)."]
      : undefined;
  return items?.map((t) => t.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Record id from a redirect such as /clients/123 or /jobs/123/edit. */
export function idFromLocation(location: string): string | undefined {
  try {
    const segs = new URL(location, "https://x").pathname.split("/").filter(Boolean);
    return [...segs].reverse().find((s) => /^\d+$/.test(s));
  } catch {
    return undefined;
  }
}
