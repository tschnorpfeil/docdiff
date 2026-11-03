# Review assessment and implementation

The previous review mixed reproducible defects, product proposals and unverified claims. This assessment records what was changed and what remains open. No numeric quality score or search-ranking improvement has been established.

## Implemented

- **DOCX safety:** ambiguous table-cell boundaries and edits to cells containing several nonempty paragraphs stop original-format rewriting. The user chooses whether to download a generated document before downloading it; its filename ends in `_Generated.docx`. Unchanged content keeps the existing source-preservation path.
- **Bounded DOCX archives:** a shared reader limits archives to 4,096 entries, 64 MiB per entry and 256 MiB total decompressed bytes. Import validates the archive before handing it to Mammoth; source export uses the same limits. These bounds reduce decompression risk; they do not guarantee a fixed peak memory usage.
- **PDF cleanup:** each extracted page is cleaned up and the loading task is destroyed after success or failure.
- **Review correctness:** rejected header/footer entries retain substantive numeric differences. They recompute their changed words from the rejected text, so a rejected group whose pages differ only in the page number stays one entry. Live modified entries already included changed-token evidence, so the previous blanket grouping diagnosis was too broad.
- **Session continuity:** switching language preserves edited/reviewed demos. Result exports no longer mark the session as saved. Oversized session downloads are blocked without clearing dirty state or allowing a pending destructive action.
- **Review workflow:** stepper and floating review controls support reading shortcuts. Batch acceptance explicitly names the whole-comparison scope, confirms the count, revalidates the selection and creates one undo step. After all entries are reviewed, the action offers final Word export.
- **Numeric filter:** changed digits, currency symbols and percentages can be isolated. This is a text filter, not a legal-risk classifier; dates or amounts spelled without digits may not match.
- **Import workflow:** both document pickers allow two files and use the existing drop order: first file is the old version, second is the new version. No age or filename heuristic silently reorders them. Cancelling the unsaved-work prompt clears the pickers, so the same file can be chosen again. Browsers without `DecompressionStream` keep importing DOCX text through Mammoth and only skip list numbering, as before.
- **UI:** direct toolbar swap reuses the existing guarded action; dark-mode links use the readable ink token; smaller laptop widths receive narrower sidebar and pane padding; decorative list markers are hidden from supported screen readers. Review tooltips explain acceptance, restoration and undoing a review.
- **Localized manifest:** English pages use an English manifest with `/en/` as its start URL and scope. Both manifests, their descriptions and icon files are checked. This corrects installation metadata; no SEO or AEO benefit is claimed.

## Rejected recommendations

- **Mark final Word export as a saved session:** it loses source files, review state and history. Only a `.docdiff` save establishes the saved point. Session history remains subject to its existing serialization budget.
- **Automatically infer old/new from timestamps or filenames:** such evidence can be misleading. Keep explicit ordering and make swapping easy.
- **Update sitemap timestamps on every build:** rebuilds alone do not establish that page content changed. Keep content dates intentional.
- **Delete assets solely because the application does not reference them:** external consumers may use published paths. No deletion was necessary for this task.
- **Add another landing preview:** the hero already demonstrates deleted and inserted text. Extra content needs a demonstrated usability benefit.
- **Promise ranking gains from keywords or `llms.txt`:** no ranking evidence was provided.

## Deferred proposals and limitations

- Moved-and-edited matching, paragraph split/merge alignment and expanded numbering grammar need representative fixtures and reconstruction checks before changing matching decisions.
- Structured cell editing and table rendering need persistent cell identities. The current safety fix refuses ambiguous source edits rather than claiming full table fidelity.
- Batch rejection needs a replacement model covering deleted rows and grouped changes; only batch acceptance is implemented.
- Notes, scoped search and suppressed-content inspection remain product proposals, not verified defects.
- Lazy mounting, virtualization and separate hosted assets need render-time/memory measurements and accessibility checks. Existing comparison-time figures do not establish DOM rendering performance.
- OCR, formatting comparison and reliable multi-column PDF reading remain outside the current feature set. Identical moves are detected; moved-and-edited content can appear as deletion plus insertion.

## Verification

Run `python3 scripts/build.py` and `node scripts/check.mjs`. Checks cover security/privacy invariants, both languages and manifests, worker parity, core diff behavior, export builders and application-state guards. New regression cases cover table refusal, fallback cancellation/naming, numeric filtering, session continuity and batch acceptance.

## Browser and office verification on 2026-11-03

Additional interactive checks used locally generated DOCX files with delivery and price changes, plus PDFs rendered from those files by LibreOffice.

- Two DOCX files selected in one picker loaded both versions and produced the expected two changes. This exposed a live `FileList` bug: clearing the picker after the first upload removed the second file. The intake now snapshots the selection before awaiting either upload.
- PDF/PDF import produced the expected two changed passages. Mixed PDF/DOCX import succeeded, but the compact PDF fixture merged several paragraphs, increasing alignment noise. Cross-format paragraph reconstruction remains a limitation.
- Batch acceptance confirmed the count and whole-comparison scope. Twenty demo entries were accepted with one undo snapshot; one keyboard undo restored all twenty open entries.
- The numeric filter reduced the demo list to fifteen entries and updated navigation counts. Accepting via the keyboard after clicking the stepper worked.
- Language switching kept review decisions. Saving and reopening a `.docdiff` file restored review counts, undo history and the original DOCX source.
- Replacing a saved pair revealed a second bug: review resets could make the second upload prompt again. Intake now guards the pair as one operation. Explicit loads establish a clean baseline even when the right text is unchanged. Reloading a reviewed, saved pair was rechecked without an intermediate dialog or stale dirty state.
- Direct toolbar swap reversed the document names without creating a dirty state on a fresh comparison. Replacing either document and changing either paste field now guards pending review work.
- Ambiguous table redline export displayed the fallback confirmation. Cancellation produced no new download; confirmation downloaded a file ending in `_Generated.docx`.
- Original-format final and tracked DOCX exports, plus the generated fallback, opened and rendered successfully in LibreOffice. Rendered pages were visually inspected: text, table columns and revision markings were present without clipping or overlap in these fixtures.
- Layout was checked at 1280×800 and 390×844 CSS pixels. The interactive comparison had no horizontal overflow. Because the preview screenshot endpoint timed out, visual inspection used local Chrome renders of captured DOM with the built CSS and fonts; the mobile capture used a 390-pixel iframe. These captures verify layout, not touch-device behavior.

The additional checks found and fixed the import and baseline issues above. Regression coverage now totals 15 app-state groups, alongside 426 export groups, 51 core tests and 18 worker comparisons. Build, checks and whitespace validation pass.

Microsoft Word, Safari, Firefox, physical mobile devices and interactive assistive technologies were not tested. These fixture checks do not establish fidelity for every Word feature or every PDF layout. The deferred proposals above remain separate work; this verification does not turn them into completed features.
