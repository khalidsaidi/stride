// `stride guide` (§17.9): the guides, built into the tools so they are there wherever stride is installed:
// docs/guide.md, how to write Stride, and docs/coming-from.md, for someone who knows another language.
// With a topic, the part whose heading holds it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* global STRIDE_GUIDES */
const here = fileURLToPath(new URL(".", import.meta.url));
const disk = (name) => {
  const p = join(here, "../docs", name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};
const GUIDES = typeof STRIDE_GUIDES !== "undefined" ? STRIDE_GUIDES : { guide: disk("guide.md"), "coming-from": disk("coming-from.md") };

// Each part: { guide, heading, text }.
function parts() {
  const out = [];
  for (const [guide, text] of Object.entries(GUIDES)) {
    const sections = text.split(/^(?=## )/m);
    for (const s of sections) {
      const heading = s.match(/^##? (.*)$/m)?.[1] ?? guide;
      out.push({ guide, heading, text: s.trim() });
    }
  }
  return out;
}

// The text for a topic: no topic, the guide; "topics", the headings; a guide's name, that guide; else the parts
// whose heading holds the words. null when nothing does.
export function guide(topic) {
  if (topic === null) return GUIDES.guide;
  if (GUIDES[topic]) return GUIDES[topic];
  if (topic === "topics") return parts().map((p) => `${p.guide.padEnd(12)} ${p.heading}`).join("\n");
  const w = topic.toLowerCase();
  const found = parts().filter((p) => p.heading.toLowerCase().includes(w));
  return found.length ? found.map((p) => p.text).join("\n\n") : null;
}
