// A fillable PDF whose fields are not one widget each, for the tests of `stride header`: a text box "name" with two
// widgets (two copies of the form); a check box "sex" whose two widgets have their own on values, Female and Male (a
// group of check boxes used as a radio group); a read-only text box "total" (a calculated total); and a text box
// "month" of two character cells (a comb field) that the form's field tree holds and the page's annotations leave
// out. One page, written object by object.
export function widgetsPdf() {
  const ap = (on) => `/AS /Off /AP << /N << /${on} 13 0 R /Off 13 0 R >> >>`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 10 0 R 11 0 R] /NeedAppearances true /DA (/F1 10 Tf 0 g) /DR << /Font << /F1 12 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] /Resources << /Font << /F1 12 0 R >> >> >>",
    "<< /FT /Tx /T (name) /DA (/F1 10 Tf 0 g) /Kids [6 0 R 7 0 R] >>",
    "<< /FT /Btn /T (sex) /Kids [8 0 R 9 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /Parent 4 0 R /Rect [100 250 300 270] /P 3 0 R /F 4 >>",
    "<< /Type /Annot /Subtype /Widget /Parent 4 0 R /Rect [100 100 300 120] /P 3 0 R /F 4 >>",
    `<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [100 200 114 214] /P 3 0 R /F 4 ${ap("Female")} >>`,
    `<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [200 200 214 214] /P 3 0 R /F 4 ${ap("Male")} >>`,
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (total) /Ff 1 /Rect [100 160 200 180] /P 3 0 R /F 4 /DA (/F1 10 Tf 0 g) >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (month) /Ff 16777216 /Rect [250 160 300 180] /P 3 0 R /F 4 /DA (/F1 10 Tf 0 g) /MaxLen 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Form /BBox [0 0 14 14] /Length 0 >>\nstream\n\nendstream",
  ];
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
