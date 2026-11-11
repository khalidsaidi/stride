// A form's workflow, run in a page beside its PDF. The workflow is a Stride program (docs/grammar.md), compiled
// to bytecode; the virtual machine (runtime/vm.mjs) runs it on the person's answers and says which questions it
// reaches and what goes into each box. The runner shows those questions one at a time, each in the words its
// program gives it, and puts each answer into the PDF's own boxes as the person goes. What they type stays on
// their device.
//
// The language says what is asked and what goes where; how it is shown and how a person moves through it are the
// runner's. The page that hosts it gives the boxes (box, read, show).
import { boxValues, faultWords, load, run, textOf } from "./vm.mjs";

const blank = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);
// An answer as the page keeps it: a number or a date as its words, the way a person would type it.
const kept = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? textOf(v) : v);

// The compiled workflow, from the bytes of its file.
export const workflow = (bytes) => load(bytes);

// box(field, value): puts a value in one of the PDF's boxes (an export value or "Off" for a check box or a radio
// group); read(field): what the box holds now; show(field): brings the box into view and outlines it; unshow():
// no box outlined (a question that writes none, such as "another?"). onRun(result), when given, is told of each run
// that fills the boxes: its prints and its fault.
export function questions(p, { box, read, show, unshow, saved = {}, onChange, onToggle, onRun, today = null }) {
  const answers = { ...saved };
  // A question the person has not answered here starts from what its box already holds, when the box takes the
  // answer as it is.
  for (const l of p.links) {
    if (!l.direct || l.key in answers) continue;
    const v = read(p.boxes[l.box].name);
    if (!blank(v)) answers[l.key] = v;
  }

  // Every box the program can write, written from one run: what this run does not write is emptied.
  function write() {
    const result = run(p, answers, { today });
    // A run that stopped part-way would empty every box after the place it stopped: the boxes are left as they
    // were, and the panel says so (render).
    if (!result.fault) for (const [field, value] of Object.entries(boxValues(p, result.writes))) box(field, value);
    onRun?.(result);
    onChange?.(answers);
    return result;
  }
  // The workflow's writes are put in the boxes when it is first opened, before any answer: a box it fills from no
  // answer is filled then.
  let opened = false;

  const panel = Object.assign(document.createElement("aside"), { className: "questions", hidden: true });
  let at = 0;
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  // What the page says about an answer (§8.4, §8.7): that it could not be read, and the message of every check it
  // fails. The answer stays, and the person goes on: a check does not stop them.
  const notesOf = (s) => [...(s?.unreadable ? [`This could not be read: ${s.unreadable}.`] : []), ...(s?.failed.length ? [s.failed.join(" ")] : [])];
  const noted = (s) => notesOf(s).map((m) => el("p", { className: "check", role: "alert", textContent: m }));

  function render() {
    const { steps, fault, links } = run(p, answers, { today });
    at = Math.max(0, Math.min(at, steps.length));
    panel.replaceChildren();
    const close = el("button", { type: "button", className: "close", textContent: "×" });
    close.setAttribute("aria-label", "Close");
    close.onclick = () => toggle(false);
    // The question scrolls in its own area; Back and Next sit under it, never over it.
    const body = el("div", { className: "body" });
    const nav = el("div", { className: "nav" });
    panel.append(close, body, nav);
    // A run that stops at a fault still asks every question it reached before the fault: an answer to one of them
    // may be what avoids it. The fault is the end, after the last question reached, and Back goes to any of them.
    if (fault && at === steps.length) {
      if (!onRun) console.error(faultWords(fault)); // a host told of each run says it itself
      body.append(el("h2", { textContent: "These questions stopped working." }), el("p", { className: "check", role: "alert", textContent: "Your answers so far are kept. You can fill the form's boxes yourself." }));
      const back = el("button", { type: "button", className: "quiet", textContent: "Back", disabled: at === 0 });
      back.onclick = () => (at--, render());
      nav.append(back);
      return;
    }
    if (at === steps.length) {
      body.append(el("h2", { textContent: "That is every question." }), el("p", { textContent: "Your answers are in the form. Check it, then download." }));
      // Answers still not read, or failing a check, are listed with what is said about them, each a way back to it.
      const doubtful = steps.map((s, i) => [s, i]).filter(([s]) => notesOf(s).length);
      if (doubtful.length) {
        body.append(el("p", { className: "check", role: "alert", textContent: "These answers need a look:" }));
        for (const [s, i] of doubtful) {
          const go = el("button", { type: "button", className: "quiet", textContent: s.printed });
          go.onclick = () => ((at = i), render());
          body.append(go, ...noted(s));
        }
      }
      const back = el("button", { type: "button", className: "quiet", textContent: "Back" });
      back.onclick = () => ((at = steps.length - 1), render());
      nav.append(back);
      return;
    }
    const step = steps[at];
    const q = step.question;
    // The boxes this answer goes into: those the program names outright, else those this run wrote from it.
    const into = p.linksOf.get(step.key) ?? (links ?? []).filter((l) => l.key === step.key);
    if (into.length) show(p.boxes[(into.find((l) => l.direct) ?? into[0]).box].name);
    else unshow?.();
    body.append(el("p", { className: "where", textContent: `Question ${at + 1} of ${steps.length}` }), el("h2", { textContent: step.printed }));
    // What is said about this answer, kept current as it changes: shown, and taken away, without leaving the input.
    const notes = el("div", { className: "notes" });
    notes.append(...noted(step));
    const set = (v) => {
      answers[step.key] = v;
      notes.replaceChildren(...noted(write().steps.find((s) => s.key === step.key)));
    };
    // Shown: the answer, else the default the program offers for it.
    const value = step.key in answers ? answers[step.key] : step.default;
    const choose = (options, many) => {
      const wrap = el("div", { className: "options" });
      const current = many ? (Array.isArray(value) ? value : []) : value;
      for (const [v, label] of options) {
        const input = el("input", { type: many ? "checkbox" : "radio", name: step.key, value: v });
        input.checked = many ? current.includes(v) : current === v || (current === true && v === "yes") || (current === false && v === "no");
        input.onchange = () => set(many ? [...wrap.querySelectorAll("input:checked")].map((i) => i.value) : v);
        const l = document.createElement("label");
        l.append(input, " ", label);
        wrap.append(l);
      }
      return wrap;
    };
    if (q.type === "yes-no") body.append(choose([["yes", "Yes"], ["no", "No"]], false));
    else if (q.type === "one-of" || q.type === "any-of") body.append(choose(q.options.map((o) => [o.value, o.printed]), q.type === "any-of"));
    else {
      const input = el(q.type === "long-text" ? "textarea" : "input");
      if (input.tagName === "INPUT") input.type = { date: "date", phone: "tel", email: "email" }[q.type] ?? "text";
      if (q.type === "number") input.inputMode = "decimal";
      if (q.type === "long-text") input.rows = 3;
      const most = into.find((l) => l.direct && l.max)?.max;
      if (most) input.maxLength = most;
      input.value = value == null ? "" : textOf(value);
      input.oninput = () => set(input.value);
      body.append(input);
      setTimeout(() => input.focus(), 0);
    }
    body.append(notes);
    const back = el("button", { type: "button", className: "quiet", textContent: "Back", disabled: at === 0 });
    back.onclick = () => (at--, render());
    const next = el("button", { type: "button", className: "next", textContent: "Next" });
    next.onclick = () => {
      // Next with the default still there keeps it as the answer.
      if (!(step.key in answers) && step.default !== undefined && !blank(step.default)) set(kept(step.default));
      at++;
      render();
    };
    nav.append(back, next);
    panel.onkeydown = (e) => e.key === "Enter" && e.target.tagName !== "TEXTAREA" && next.click();
  }

  const toggle = (open = panel.hidden) => {
    panel.hidden = !open;
    document.body.classList.toggle("asking", open);
    onToggle?.(open);
    if (open && !opened) (opened = true), write();
    if (open) render();
  };
  return { panel, toggle, write };
}
