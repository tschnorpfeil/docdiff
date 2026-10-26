<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark-square.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light-square.png">
    <img alt="Doc Diff logo" src="docs/logo-light-square.png" width="96" height="96">
  </picture>
</p>

<h1 align="center">Doc Diff</h1>

<p align="center">
  Compare two versions of a document (PDF, Word .docx, or plain text) in the browser and see every changed word.<br>
  The files are processed on your computer and are not uploaded.
</p>

<p align="center">
  <a href="https://docdiff.app">docdiff.app</a> (<a href="https://docdiff.app/en/">English</a>) ·
  <a href="https://github.com/tschnorpfeil/docdiff/raw/main/DocDiff.html">Offline version (single HTML file)</a> ·
  MIT license
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/screenshot-light.png">
    <img alt="Two versions of a contract side by side, with removed words struck through in red, added words in green, and a list of changes on the right." src="docs/screenshot-light.png" width="100%">
  </picture>
</p>

## Your documents stay on your device

- **No upload.** Files are read and compared inside the browser tab. The page's Content Security Policy (`connect-src 'none'`) makes the browser block every network connection from the page.
- **Works offline.** The whole app is one HTML file. Download it, disconnect, keep working.
- **Nothing stored, nothing shared.** No account, no cookies, no tracking, no browser storage. Close the tab and everything is gone.
- **Verifiable.** The code is open (MIT), and the browser's Network tab shows no request while you compare.

This makes it suitable for confidential contracts and documents with personal data (GDPR): the documents reach no server, neither ours nor anyone else's. Details and limits are under [Privacy](#privacy).

## What it is

Doc Diff is a small tool for one job: you have an old and a new version of a document, typically a contract or a tender, and you want to know exactly what changed. It is free, has no accounts, no ads and no tracking, and the whole app is a single HTML file you can also run offline.

It was written with German contracts in mind (`§ 1`, `(1)`, `1.1` clause numbering), and the interface is in German and English.

## How to use it

1. Open [docdiff.app](https://docdiff.app), or download [`DocDiff.html`](https://github.com/tschnorpfeil/docdiff/raw/main/DocDiff.html) and open it from disk.
2. Choose the old version and the new version (file picker, drag and drop, or paste text). There is a built-in example if you just want to look around.
3. Go through the changes: removed text is struck through in red, added text is green. `J` / `K` or the arrows in the top bar jump from change to change; the list on the right shows each change in short form.
4. Accept or reject each change (`A` / `R`), optionally edit paragraphs of the new version, and export the result.

## What it does

- **Inputs:** PDF with a text layer, Word `.docx`, `.html` (text only), and UTF-8/UTF-16 text. Any combination works, e.g. PDF against DOCX.
- **Paragraph alignment, then word diff:** paragraphs of both versions are matched first, then the words inside each matched pair are compared. Inserted and deleted paragraphs show up as such.
- **Faithful output:** unchanged plus removed parts always reproduce the old text exactly, unchanged plus added parts the new text. Tests enforce this.
- **Less noise:**
  - Running headers, footers and page numbers that repeat on at least half of the pages are hidden (View › "Hide headers & footers"). If a header or footer actually differs between versions, it is shown.
  - Renumbering alone (`(1)` → `(2)`, `§ 4` → `§ 5`) is shown in a muted style and not counted as a change.
  - Paragraphs that moved unchanged are labelled "Moved" at both positions.
  - Hyphenated line breaks in PDFs are joined.
- **Views:** side by side or one column (default on phones), with or without the original page breaks. An overview bar between the two versions (next to the text in one column) shows where the changes are; click it to jump.
- **Review:** accept a change (keep the new wording) or reject it (restore the old wording of that paragraph) with the small ✓ / ✗ buttons next to the current paragraph or `A` / `R`; both mark it as reviewed, move on to the next open change and leave a quiet ✓ or ✗ in the margin, with an undo arrow below it. The same header or footer change on several pages is one decision. The list of changes can be filtered by review status or by kind of change. Paragraphs of the new version can also be edited in place.
- **Export:**
  - **Final version** (the new version with your decisions and edits applied, without marks) as a Word `.docx` file — in the original format when the new version is a `.docx` file (keeping styles, numbering, links, footnotes, tables and images) — or as PDF or plain text (`.txt` / clipboard)
  - **Comparison** (old → new with marks) as a Word `.docx` file in which open changes are tracked changes (accept or reject them in Word or LibreOffice) and accepted changes are already applied — also in the original format when the new version is a `.docx` file — or as PDF side by side or inline
  - HTML report (self-contained, read-only) and Markdown report, both with the review status of every change
- **Saved work:** you can save the current state (both documents, your edits and the review status) as a `.docdiff` file and open it again later. The browser asks before you leave the page with unsaved work.

## What it does not do

- **No OCR.** Scanned PDFs or images without a text layer are rejected with a message.
- **No legacy `.doc` or `.rtf`.** Save them as `.docx` or PDF first.
- **Formatting is not compared.** Bold, fonts, tables and layout are ignored; only the text is compared. Table cells come through as text in reading order, which can be hard to follow.
- **Multi-column PDF layouts** are read line by line and can come out in the wrong order.
- **Moves are only detected when the moved paragraph is identical.** A paragraph that was moved and edited shows as one deletion and one insertion.
- **Very large documents take a few seconds.** See [Performance](#performance).
- It is not a legal review tool. It shows differences in the text; whether they matter is up to you.

## Privacy

The documents never leave the browser tab. This is enforced by the browser, not only promised:

- The page sets a Content Security Policy that forbids all network connections from the page (`connect-src 'none'`, `form-action 'none'`):
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src 'self' data: blob:; manifest-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; child-src 'none'; worker-src blob:; frame-src 'none'; form-action 'none'; base-uri 'none';" />
  ```
- All libraries and fonts are inside the HTML file; nothing is loaded from other servers.
- Nothing is stored in the browser (no `localStorage`, `sessionStorage`, IndexedDB or cookies). Closing or reloading the tab discards everything, unless you saved a session file yourself.

You can check this yourself: open the browser's developer tools, switch to the Network tab and compare two files. No request is made. Or use the offline file without an internet connection.

What this does not cover, to be precise:

- Opening docdiff.app is a normal page load from GitHub Pages, which sees your IP address like any web server. The page also loads its own icon and manifest from the same site. The offline file avoids this.
- Browser extensions you have installed can read any page, including this one.
- A `.docdiff` session file and every export contain the document text. Store them as carefully as the documents themselves.

## Performance

The comparison runs in a background worker, so the page stays usable while it works. Rough numbers measured in Chromium on a laptop-class machine (your results will differ):

| Input | Time to result |
| :-- | :-- |
| Two versions of a 10-page contract | well under a second |
| 2,000 paragraphs per side (about 80 pages) | about 0.5 s |
| Two 1,000-page PDFs | about 4 s (mostly reading the PDFs) |

Reading PDFs is the slowest part. Very long single paragraphs (hundreds of thousands of characters) are compared with a bounded algorithm that can show a larger block as replaced instead of word by word.

## Keyboard

| Key | Action |
| :-- | :-- |
| `J` / `K` | Next / previous open change |
| `A` / `R` | Accept / reject the current change and move on to the next open one |
| `E` | Edit the current paragraph |
| `Enter` | In the list of changes: jump to the change |
| `/`, `Ctrl+F` / `Cmd+F` | Find in document |
| `Ctrl+Z` / `Cmd+Z` | Undo |
| `Ctrl+Y`, `Shift+Cmd+Z` | Redo |
| `Esc` | Close menus, search and dialogs |

Single-key shortcuts only work while the document or the list of changes has focus, never while typing. They can be switched off in the help dialog.

## Building from source

The app is plain HTML, CSS and JavaScript without a framework or package manager. The sources are in [`src/`](src):

- `src/template.html`: page shell and markup
- `src/styles.css`: styles
- `src/js/*.js`: application code, concatenated in file-name order into one inline script

```sh
python3 scripts/build.py   # writes site/index.html, site/en/index.html and DocDiff.html
node scripts/check.mjs     # invariants and tests
```

`scripts/check.mjs` verifies the Content Security Policy, the absence of external URLs and storage APIs, matching German and English strings, the search metadata of both language pages (title, canonical, hreflang, JSON-LD that matches the visible FAQ, sitemap, `llms.txt`), and runs the unit tests for the diff core (`scripts/test-core.mjs`) and the export builders (`scripts/test-export.mjs`). CI runs the same and also checks that the committed bundle is up to date.

Bundled libraries: [PDF.js](https://github.com/mozilla/pdf.js), [Mammoth.js](https://github.com/mwilliamson/mammoth.js), [jsdiff](https://github.com/kpdecker/jsdiff), and the [Geist](https://vercel.com/font) fonts. Versions and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
