// A small fillable PDF for the tests of `stride header`, `stride new` and `stride run` in the browser: one page, a text box
// "name" with "Full name" printed beside it, and a check box "agree" (export value Yes) beside "I agree to the
// terms". Written object by object, with its cross-reference table, so no tool is needed to make it. `label` puts
// other words beside the text box; `margin` prints words sideways, up the page, close under that box.
export function tinyPdf({ label = "Full name", margin = null } = {}) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R] /NeedAppearances true /DA (/F1 10 Tf 0 g) /DR << /Font << /F1 7 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 6 0 R /Annots [4 0 R 5 0 R] /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [120 140 360 160] /P 3 0 R /F 4 /DA (/F1 10 Tf 0 g) /MaxLen 40 >>",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /Rect [120 96 134 110] /P 3 0 R /F 4 /AS /Off /AP << /N << /Yes 8 0 R /Off 9 0 R >> >> >>",
    null, // the page's text, a stream
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length 0 >>\nstream\n\nendstream",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length 0 >>\nstream\n\nendstream",
  ];
  const pdfText = (t) => t.replace(/[\\()]/g, (c) => `\\${c}`);
  const sideways = margin === null ? "" : `BT /F1 10 Tf 0 1 -1 0 150 112 Tm (${pdfText(margin)}) Tj ET\n`;
  const text = `BT /F1 10 Tf 20 146 Td (${pdfText(label)}) Tj ET\nBT /F1 10 Tf 20 100 Td (I agree to the terms) Tj ET\n${sideways}`;
  objects[5] = `<< /Length ${text.length} >>\nstream\n${text}endstream`;
  let out = "%PDF-1.4\n";
  const at = [];
  objects.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
