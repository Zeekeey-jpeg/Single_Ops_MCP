/**
 * Markdown rendering for read results. SingleOps answers with arbitrary JSON
 * (datatables, report rows, records), so this is generic: arrays of records
 * become tables of their scalar columns, objects become key lists, and nested
 * arrays get their own sub-table.
 */

const MAX_ROWS = 50;
const MAX_COLS = 12;

const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return (s.length > 80 ? `${s.slice(0, 77)}…` : s).replace(/\|/g, "\\|");
}

function table(rows: Record<string, unknown>[]): string {
  const cols: string[] = [];
  for (const r of rows.slice(0, MAX_ROWS)) {
    for (const [k, v] of Object.entries(r)) if (isScalar(v) && !cols.includes(k) && cols.length < MAX_COLS) cols.push(k);
  }
  if (!cols.length) return "_(no scalar columns)_";
  const lines = [`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`];
  for (const r of rows.slice(0, MAX_ROWS)) lines.push(`| ${cols.map((c) => cell(r[c])).join(" | ")} |`);
  if (rows.length > MAX_ROWS) lines.push(`\n_${rows.length - MAX_ROWS} more rows. Use paging params, or response_format "json"._`);
  return lines.join("\n");
}

export function toMarkdown(data: unknown, depth = 0): string {
  if (isScalar(data)) return cell(data);
  if (Array.isArray(data)) {
    if (!data.length) return "_(empty)_";
    if (data.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      return `${data.length} rows\n\n${table(data as Record<string, unknown>[])}`;
    }
    if (data.every(Array.isArray)) {
      return `${data.length} rows\n\n${table(data.map((row) => Object.fromEntries((row as unknown[]).map((v, i) => [`col${i}`, v]))))}`;
    }
    return data.slice(0, MAX_ROWS).map((x) => `- ${isScalar(x) ? cell(x) : JSON.stringify(x).slice(0, 200)}`).join("\n");
  }
  const obj = data as Record<string, unknown>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isScalar(v)) out.push(`- **${k}**: ${cell(v)}`);
  }
  if (depth < 2) {
    for (const [k, v] of Object.entries(obj)) {
      if (!isScalar(v)) out.push(`\n${"#".repeat(Math.min(depth + 3, 6))} ${k}\n\n${toMarkdown(v, depth + 1)}`);
    }
  }
  return out.join("\n") || "_(empty object)_";
}
