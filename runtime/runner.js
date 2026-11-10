// A form's workflow, run in a page beside its PDF. The workflow is a Stride program (docs/grammar.md), compiled
// to bytecode; the virtual machine (runtime/vm.mjs) runs it on the person's answers and says which questions it
// reaches and what goes into each box. The runner shows those questions one at a time, in the reader's language,
// and puts each answer into the PDF's own boxes as the person goes. What they type stays on their device.
//
// The language says what is asked and what goes where; how it is shown, in which language, and how a person
// moves through it are the runner's. The page that hosts it gives the boxes (box, read, show) and, with speak(),
// its language and its own words for the runner's phrases.

// The reader's language, and the runner's phrases in it: t(english, { name: value }) gives a phrase. English, with
// {name} filled in, until the host says otherwise.
let lang = "en";
let t = (en, vars = {}) => en.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
export function speak(host) {
  if (host.lang) lang = host.lang;
  if (host.t) t = host.t;
}
import { boxValues, faultWords, load, resource, run, textOf } from "./vm.mjs";

const blank = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);
// An answer as the page keeps it: a number or a date as its words, the way a person would type it.
const kept = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? textOf(v) : v);

// The compiled workflow, from the bytes of its file, with the words it carries for its questions.
export function workflow(bytes) {
  const p = load(bytes);
  p.words = JSON.parse(resource(p, "words") ?? "{}");
  p.fieldIndex = new Map(p.boxes.map((b, i) => [b.name, i]));
  return p;
}

// A key's words in the reader's language, else in English: its own (representatives[2].name), else those of
// every turn of its list or loop (representatives.name).
const general = (key) => key.replace(/\[\d+\]/g, "").replace(/\([^)]*\)/g, "");
function words(p, key, part) {
  for (const k of [key, general(key)]) {
    const w = p.words[k]?.[lang]?.[part] ?? p.words[k]?.en?.[part];
    if (w) return w;
  }
  return null;
}

// What a question says: its prompt or its help, falling back to the words printed on the form. `at` is a step
// of a run, or a link of a box: each has the question's key and its printed words.
export function say(p, at, part) {
  return words(p, at.key, part) ?? (part === "prompt" ? at.printed : "");
}

// What a box's card says: the question whose answer goes into the box, by the PDF's full field name; one that
// fills it with the answer as it is comes before one that only decides it. Gives a link: { key, printed, … }.
export function askOf(p, field) {
  const i = p.fieldIndex.get(field);
  if (i === undefined) return null;
  const here = p.links.filter((l) => l.box === i && !p.questions[l.question].item);
  return here.find((l) => l.direct) ?? here[0] ?? null;
}

// box(field, value): puts a value in one of the PDF's boxes (an export value or "Off" for a check box or a radio
// group); read(field): what the box holds now; show(field): brings the box into view and outlines it; unshow():
// no box outlined (a question that writes none, such as "another?"). onRun(result), when given, is told of each run
// that fills the boxes: its prints and its fault.
export function interview(p, { box, read, show, unshow, saved = {}, onChange, onToggle, onRun, today = null }) {
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

  const panel = Object.assign(document.createElement("aside"), { className: "interview", hidden: true });
  let at = 0;
  const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  // What the page says about an answer (§8.4, §8.7): that it could not be read, and the message of every check it
  // fails. The answer stays, and the person goes on: a check does not stop them.
  const notesOf = (s) => [...(s?.unreadable ? [t("This could not be read: {why}.", { why: s.unreadable })] : []), ...(s?.failed.length ? [words(p, s.key, "check") ?? s.failed.join(" ")] : [])];
  const noted = (s) => notesOf(s).map((m) => el("p", { className: "check", role: "alert", textContent: m }));

  function render() {
    const { steps, fault } = run(p, answers, { today });
    at = Math.max(0, Math.min(at, steps.length));
    panel.replaceChildren();
    const close = el("button", { type: "button", className: "close", textContent: "×" });
    close.setAttribute("aria-label", t("Close"));
    close.onclick = () => toggle(false);
    // The question scrolls in its own area; Back and Next sit under it, never over it.
    const body = el("div", { className: "body" });
    const nav = el("div", { className: "nav" });
    panel.append(close, body, nav);
    // A run that stops at a fault still asks every question it reached before the fault: an answer to one of them
    // may be what avoids it. The fault is the end, after the last question reached, and Back goes to any of them.
    if (fault && at === steps.length) {
      if (!onRun) console.error(faultWords(fault)); // a host told of each run says it itself
      body.append(el("h2", { textContent: t("These questions stopped working.") }), el("p", { className: "check", role: "alert", textContent: t("Your answers so far are kept. You can fill the form's boxes yourself.") }));
      const back = el("button", { type: "button", className: "quiet", textContent: t("Back"), disabled: at === 0 });
      back.onclick = () => (at--, render());
      nav.append(back);
      return;
    }
    if (at === steps.length) {
      body.append(el("h2", { textContent: t("That is every question.") }), el("p", { textContent: t("Your answers are in the form. Check it, then download.") }));
      // Answers still not read, or failing a check, are listed with what is said about them, each a way back to it.
      const doubtful = steps.map((s, i) => [s, i]).filter(([s]) => notesOf(s).length);
      if (doubtful.length) {
        body.append(el("p", { className: "check", role: "alert", textContent: t("These answers need a look:") }));
        for (const [s, i] of doubtful) {
          const go = el("button", { type: "button", className: "quiet", textContent: say(p, s, "prompt") });
          go.onclick = () => ((at = i), render());
          body.append(go, ...noted(s));
        }
      }
      const back = el("button", { type: "button", className: "quiet", textContent: t("Back") });
      back.onclick = () => ((at = steps.length - 1), render());
      nav.append(back);
      return;
    }
    const step = steps[at];
    const q = step.question;
    const into = p.linksOf.get(step.key) ?? [];
    if (into.length) show(p.boxes[(into.find((l) => l.direct) ?? into[0]).box].name);
    else unshow?.();
    body.append(el("p", { className: "where", textContent: t("Question {n} of {total}", { n: at + 1, total: steps.length }) }), el("h2", { textContent: say(p, step, "prompt") }));
    const help = say(p, step, "help");
    if (help) body.append(el("p", { className: "help", textContent: help }));
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
    const optionWords = (o) => words(p, `${step.key}.${o.value}`, "label") ?? o.printed;
    if (q.type === "yes-no") body.append(choose([["yes", t("Yes")], ["no", t("No")]], false));
    else if (q.type === "one-of" || q.type === "any-of") body.append(choose(q.options.map((o) => [o.value, optionWords(o)]), q.type === "any-of"));
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
    const back = el("button", { type: "button", className: "quiet", textContent: t("Back"), disabled: at === 0 });
    back.onclick = () => (at--, render());
    const next = el("button", { type: "button", className: "next", textContent: t("Next") });
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
