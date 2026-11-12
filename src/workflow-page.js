// The page `stride run` serves in the browser (§17.18): the program's workflow beside its PDF, as Stride's runner
// runs it (runtime/runner.js): its questions one at a time, each answer going into the PDF's boxes as it is
// given. A source program is compiled again at each reload; its mistakes, if it has
// any, are the page. The date today() gives is the run's --today when it has one. What the program prints, and a
// fault in full, go to the browser's console (§17.11). Nothing leaves this computer.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import "./page.css";
import { questions, workflow } from "../runtime/runner.js";
import { faultWords } from "../runtime/vm.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
const status = document.querySelector(".status");

// What stops the page, said in place of the PDF: the compiler's mistakes as `stride check` shows them, or why the
// workflow could not be opened.
const stopped = (text) => {
  document.querySelector("#viewerContainer").replaceChildren(Object.assign(document.createElement("pre"), { className: "fallback mistakes", textContent: text }));
  status.textContent = "There is no workflow to give: put this right and reload.";
};
const compiled = await fetch("/workflow.sbc");
if (!compiled.ok) stopped(await compiled.text());
else
try {
  const p = workflow(new Uint8Array(await compiled.arrayBuffer()));
  // The PDF must be the one this workflow is for: its sha256 is checked here against the one compiled into the
  // program the page holds, whatever happened on disk between the two requests (§17.18).
  const pdfResponse = await fetch("/form.pdf");
  if (!pdfResponse.ok) throw new Error(await pdfResponse.text());
  const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pdfBytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sha !== p.pdf) throw new Error(`the PDF the run gave (sha256 ${sha.slice(0, 12)}…) is not the one this workflow is for (${p.pdf.slice(0, 12)}…): it was replaced while the page loaded; reload`);
  const pdf = await pdfjs.getDocument({ data: pdfBytes, standardFontDataUrl: "/standard_fonts/" }).promise;
  const storage = pdf.annotationStorage;
  const fields = (await pdf.getFieldObjects()) ?? {};
  const byName = new Map(Object.entries(fields).map(([name, objs]) => [name, objs.filter((o) => o.id && o.type)]));

  const eventBus = new EventBus();
  const container = document.querySelector("#viewerContainer");
  const linkService = new PDFLinkService({ eventBus });
  const viewer = new PDFViewer({ container, viewer: document.querySelector("#viewer"), eventBus, linkService, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS });
  linkService.setViewer(viewer);
  const fit = () => viewer.pagesCount && (viewer.currentScaleValue = "page-width");
  eventBus.on("pagesinit", fit);
  addEventListener("resize", fit);
  viewer.setDocument(pdf);
  linkService.setDocument(pdf);

  // A box by the PDF's own field name: words, or an export value (or "Off") for a check box or a radio group.
  const box = (name, value) => {
    for (const o of byName.get(name) ?? []) {
      const tick = o.type === "checkbox" || o.type === "radiobutton";
      const v = !tick ? value : value === o.exportValues;
      storage.setValue(o.id, { value: v });
      const el = document.querySelector(`[data-element-id="${o.id}"]`);
      const input = el?.matches("input, textarea, select") ? el : el?.querySelector("input, textarea, select");
      if (input) tick ? (input.checked = v === true) : (input.value = v);
    }
  };
  const read = (name) => {
    for (const o of byName.get(name) ?? []) {
      const raw = storage.getRawValue(o.id)?.value;
      if (o.type === "checkbox" || o.type === "radiobutton") {
        if (raw === true) return o.exportValues;
      } else if (raw !== undefined) return raw;
    }
    return undefined;
  };
  const show = (name) => {
    const o = byName.get(name)?.[0];
    if (!o || !viewer.pagesCount) return;
    viewer.scrollPageIntoView({ pageNumber: (o.page ?? 0) + 1 });
    requestAnimationFrame(() => {
      document.querySelectorAll(".asked").forEach((x) => x.classList.remove("asked"));
      const el = document.querySelector(`[data-element-id="${o.id}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("asked");
    });
  };
  // Run from its source, the page is its writer's: each box says its name, as a program writes it, so the writer
  // sees which box of the form is which.
  if (document.querySelector('meta[name="stride-writing"]')) {
    const name = () => {
      for (const [full, objs] of byName) {
        const short = full.startsWith(p.prefix) ? full.slice(p.prefix.length) : full;
        for (const o of objs) {
          const el = document.querySelector(`[data-element-id="${o.id}"]`);
          if (!el || el.dataset.named) continue;
          el.dataset.named = "yes";
          const input = el.matches("input, textarea, select") ? el : el.querySelector("input, textarea, select");
          const tick = o.type === "checkbox" || o.type === "radiobutton";
          const words = tick && o.exportValues ? `${short}  (${o.exportValues})` : short;
          el.title = words;
          if (input) input.title = words;
          // Its last part on the box itself, small; the whole name when pointed at.
          (el.closest("section") ?? el.parentElement ?? el).append(Object.assign(document.createElement("span"), { className: "boxname", textContent: short.split(".").pop() }));
        }
      }
    };
    eventBus.on("annotationlayerrendered", name);
  }
  const unshow = () => document.querySelectorAll(".asked").forEach((x) => x.classList.remove("asked"));
  const today = document.querySelector('meta[name="stride-today"]')?.content ?? null;
  // A run's prints, each time they are other lines than the last run printed; apart from them, its fault in full,
  // each time it is another fault than the last run's (§17.11).
  let printed = null;
  let faulted = null;
  const onRun = ({ prints, fault }) => {
    const lines = JSON.stringify(prints);
    if (lines !== printed) {
      printed = lines;
      for (const line of prints) console.log(line);
    }
    const said = fault ? faultWords(fault) : null;
    if (said !== faulted) {
      faulted = said;
      if (said) console.error(said);
    }
  };
  const run = questions(p, { box, read, show, unshow, today, onRun, onToggle: () => requestAnimationFrame(fit) });
  document.body.append(run.panel);
  run.toggle(true);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  status.textContent = `${count(p.questions.length, "question", "questions")}, ${count(p.boxes.length, "box", "boxes")}. Answers stay on this computer.`;

  // What each box holds, by the PDF's field name: for the programmer, at the browser's console (stride.boxes()).
  window.stride = { boxes: () => Object.fromEntries([...byName.keys()].map((name) => [name, read(name) ?? ""])) };
  document.querySelector("#questions").onclick = () => run.toggle();
} catch (e) {
  stopped(`The workflow could not be opened: ${e.message}`);
}
