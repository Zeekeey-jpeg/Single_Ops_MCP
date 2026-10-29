/**
 * Streams HAR entries one at a time. Captures with embedded bodies run to
 * hundreds of MB, past V8's max string length, so JSON.parse on the whole file
 * is not an option.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { extractForms } from "./form-mine.mjs";

const require = createRequire(import.meta.url);
const { parser } = require("stream-json");
const { pick } = require("stream-json/filters/Pick");
const { streamArray } = require("stream-json/streamers/StreamArray");

export async function* harEntries(file) {
  const pipeline = fs
    .createReadStream(file)
    .pipe(parser())
    .pipe(pick({ filter: "log.entries" }))
    .pipe(streamArray());
  for await (const { value } of pipeline) yield value;
}

/**
 * Reads a HAR into the { log: { entries } } shape buildMap expects, dropping bodies we don't use.
 * Pass `pages` to also collect the write forms found in HTML/JS responses (see form-mine.mjs).
 */
export async function loadHarLean(file, { pages } = {}) {
  const entries = [];
  for await (const e of harEntries(file)) {
    const content = e.response?.content;
    const mime = (content?.mimeType ?? "").toLowerCase();
    if (pages && content?.text && (mime.includes("html") || mime.includes("javascript"))) {
      let text = content.encoding === "base64" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
      if (mime.includes("javascript") && /<form/i.test(text)) {
        text = text.replace(/\\n/g, "\n").replace(/\\(["'\/])/g, "$1"); // Rails .js.erb modals
      }
      const forms = extractForms(text, e.request.url);
      if (forms.length) pages.push({ forms, pageUrl: e.request.url });
    }
    // Keep JSON bodies (needed for response shapes); drop HTML/images/etc.
    if (content && !mime.includes("json")) delete content.text;
    entries.push(e);
  }
  return { log: { entries } };
}
