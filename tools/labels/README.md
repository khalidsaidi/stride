# Guessing the words beside a box

This folder is not part of Stride. Stride is a language: it takes a form's header as input and checks a program
against it. It does not work anything out about a form.

Which printed words belong to which box is not written in a PDF. A person reading the form knows; software can only
guess from where the words and the boxes sit on the page. That guess lives here, apart from the language, as a
suggestion for whoever writes a header:

- `suggest.mjs`: the words guessed for each box of a PDF, printed, or put into a header's boxes as `near`.
- `beside.mjs`, `paragraphs.mjs`: the guess itself.
- `measure.mjs`: how good the guess is, against labels given by hand on real forms.
- `test.mjs`: the cases that set the guess's numbers.

Measured on one real form from each of 91 issuers (7,931 boxes), tuned on 40 forms and judged on the other 51:

| | tuned | judged |
|---|---|---|
| the right label is the first guessed | 80.0% | 75.8% |
| the right label is among those guessed | 97.1% | 95.0% |

So a guess is wrong for about one box in four, and the right words are missing altogether for about one in twenty.
That is why a person checks it, and why Stride takes the header's word and never its own.
