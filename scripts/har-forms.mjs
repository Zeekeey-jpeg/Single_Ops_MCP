#!/usr/bin/env node
/**
 * Reports the write endpoints hidden in captured HTML (Rails forms and
 * data-method links). Names and types only, no values. `npm run map` folds
 * the same routes into api-map.json; this is the quick standalone view.
 *
 *   node scripts/har-forms.mjs capture/<file>.har
 */
import { loadHarLean } from "./lib/har-stream.mjs";
import { formsToRoutes } from "./lib/form-mine.mjs";

const pages = [];
for (const f of process.argv.slice(2)) await loadHarLean(f, { pages });
const routes = formsToRoutes(pages);

const keys = (s, pre = "") =>
  !s
    ? []
    : s.type === "array"
      ? keys(s.items, pre + "[]")
      : s.properties
        ? Object.entries(s.properties).flatMap(([k, v]) => (v.properties || v.items ? keys(v, pre ? `${pre}.${k}` : k) : [pre ? `${pre}.${k}` : k]))
        : [];
console.log(`${routes.length} write routes from ${pages.length} pages\n`);
for (const r of routes) {
  const k = keys(r.body);
  const tag = r.policy === "deny" ? `DENY: ${r.denyReason}` : r.source;
  console.log(`${r.method.padEnd(6)} ${r.path}  [${tag}${r.bodyKind === "multipart" ? ", multipart" : ""}]  ${k.length} fields`);
}
