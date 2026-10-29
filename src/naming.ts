/**
 * Human tool names from route shapes, following the {service}_{read|write}_{verb}_{entity}
 * convention: GET /items -> singleops_read_list_items, PATCH /clients/{id} ->
 * singleops_write_update_client, POST /jobs/jobs_datatable -> singleops_read_search_jobs.
 */

import type { Route } from "./map.js";

const PREFIX = /^\/(?:(client|public)\/)?api\/v\d+/;
const TABLE = /^(.*?)_?(data_?table)(?:_(\w+))?$/;

function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + "y";
  if (/(ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

function tidy(words: string[]): string {
  const out: string[] = [];
  for (const w of words.join("_").split("_").filter(Boolean)) if (out[out.length - 1] !== w) out.push(w);
  return out.join("_");
}

export function verbEntity(route: Route): { kind: "read" | "write"; verb: string; entity: string } {
  const portal = route.path.match(PREFIX)?.[1];
  const segs = route.path.replace(PREFIX, "").split("/").filter(Boolean).map((s) => s.replace(/\.json$/, ""));
  const words = segs.filter((s) => !s.startsWith("{"));
  const endsWithId = segs.length > 0 && segs[segs.length - 1].startsWith("{");
  const first = words[0] ?? "root";
  const last = words[words.length - 1] ?? first;
  const pre = portal === "public" ? ["public"] : portal === "client" ? ["portal"] : [];
  const readOnly = route.method === "GET" || route.readOnly;

  if (readOnly) {
    const table = last.match(TABLE);
    if (table) {
      // jobs/jobs_datatable -> jobs; jobs/visits_report_datatable -> jobs visits_report; tasks/data_table/all -> tasks
      const what = table[1] && table[1] !== first ? [first, table[1]] : [first];
      return { kind: "read", verb: "search", entity: tidy([...pre, ...what, ...words.slice(1, -1).filter((w) => w !== first)]) };
    }
    if (words.length > 1 && /^data_?table$/.test(words[words.length - 2])) {
      return { kind: "read", verb: "search", entity: tidy([...pre, first, last === "all" ? "" : last]) };
    }
    if (first === "reports") {
      const name = words.slice(1).join("_");
      return { kind: "read", verb: "get", entity: tidy([...pre, /report$/.test(name) ? name : `${name}_report`]) };
    }
    if (endsWithId && words.length === segs.length - 1 && segs.length >= 2 && words.length === 1) {
      return { kind: "read", verb: "get", entity: tidy([...pre, singular(first)]) };
    }
    if (endsWithId) {
      return { kind: "read", verb: "get", entity: tidy([...pre, ...words.slice(0, -1).map(singular), singular(last)]) };
    }
    // /clients/{id}/jobs -> list client jobs; /visits/route_planner_data -> list visits route_planner_data
    const owner = segs.findIndex((s) => s.startsWith("{")) > 0 ? words.slice(0, -1).map(singular) : words.slice(0, -1);
    return { kind: "read", verb: "list", entity: tidy([...pre, ...owner, last]) };
  }

  const noun = singular(first);
  const action = !endsWithId && segs.some((s) => s.startsWith("{")) ? last : words.length > 1 ? last : undefined;
  if (route.method === "DELETE") return { kind: "write", verb: "delete", entity: tidy([noun]) };
  if (action) {
    // update_notes -> update client_notes; unschedule -> unschedule task; check_batch_emails etc.
    const [verb, ...rest] = action.split("_");
    return { kind: "write", verb, entity: tidy([noun, ...rest]) };
  }
  return { kind: "write", verb: route.method === "POST" ? "create" : "update", entity: tidy([noun]) };
}

/** Assigns unique, <=64-char names. Lead Entry API routes keep a `lead_` marker. */
export function assignToolNames(routes: Route[], service = "singleops"): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const r of routes) {
    const { kind, verb, entity } = verbEntity(r);
    const base = `${service}_${kind}_${r.auth === "lead_token" ? "lead_" : ""}${verb}_${entity}`.slice(0, 60);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    names.set(r.id, name);
  }
  return names;
}
