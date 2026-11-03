#!/usr/bin/env node
/**
 * Regression tests for application-state guards (no browser needed). They cover bugs where
 * an edit, revert or export used rows that were still being re-compared, and where a failed
 * copy or a cancelled print silenced the unsaved-changes warning. Full UI coverage of these
 * paths lives in the Playwright QA scripts; this keeps the essential invariants in `check.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, 'src', 'js', f), 'utf8');
const interactions = read('07-interactions.js');
const exportJs = read('08-export.js');
const session = read('11-session.js');

// Extracts a top-level function declaration by name.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

let groups = 0;

// 1. isShownComparisonCurrent(): rows are current only when computed from the current texts.
{
  const ctx = { state: {}, lastComparison: null, calls: [] };
  vm.createContext(ctx);
  vm.runInContext(
    `${extractFunction(interactions, 'isShownComparisonCurrent')}
     ${extractFunction(interactions, 'ensureComparisonCurrent')}
     function runComparison(opts) { calls.push(opts); lastComparison = { request: { leftText: state.leftText, rightText: state.rightText, ignoreHeadersFooters: state.ignoreHeadersFooters } }; }`,
    ctx
  );
  const set = (l, r, hf, req) => {
    vm.runInContext(`state = ${JSON.stringify({ leftText: l, rightText: r, ignoreHeadersFooters: hf })}; lastComparison = ${JSON.stringify(req)};`, ctx);
  };
  const current = () => vm.runInContext('isShownComparisonCurrent()', ctx);
  set('a', 'b', true, null);
  assert.equal(current(), false, 'no comparison yet');
  set('a', 'b', true, { request: { leftText: 'a', rightText: 'b', ignoreHeadersFooters: true } });
  assert.equal(current(), true, 'same texts');
  set('a', 'b2', true, { request: { leftText: 'a', rightText: 'b', ignoreHeadersFooters: true } });
  assert.equal(current(), false, 'right text edited, worker still running');
  set('a2', 'b', true, { request: { leftText: 'a', rightText: 'b', ignoreHeadersFooters: true } });
  assert.equal(current(), false, 'left text replaced');
  set('a', 'b', false, { request: { leftText: 'a', rightText: 'b', ignoreHeadersFooters: true } });
  assert.equal(current(), false, 'header/footer filter toggled');
  set('', '', true, { request: { leftText: '', rightText: '', ignoreHeadersFooters: true } });
  assert.equal(current(), true, 'empty texts');
  // ensureComparisonCurrent() re-compares synchronously only when needed.
  set('a', 'b2', true, { request: { leftText: 'a', rightText: 'b', ignoreHeadersFooters: true } });
  vm.runInContext('calls.length = 0; ensureComparisonCurrent(); ensureComparisonCurrent();', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls)), [{ sync: true }], 'one synchronous re-comparison');
  groups++;
}

// 2. Edit, revert and export entry points use the guards.
{
  const startEdit = extractFunction(interactions, 'startInlineClauseEdit');
  assert.match(startEdit, /if \(!isShownComparisonCurrent\(\)\) return;/, 'edits wait for the running comparison');
  assert.match(startEdit, /state\.rightText !== rightTextAtOpen \|\| !isShownComparisonCurrent\(\)/, 'stale editors are discarded');
  assert.match(extractFunction(interactions, 'revertRowToOriginal'), /!isShownComparisonCurrent\(\)/, 'reverts wait');
  assert.match(extractFunction(exportJs, 'handleExportAction'), /ensureComparisonCurrent\(\);/, 'exports re-compare first');
  assert.match(extractFunction(exportJs, 'preparePrintView'), /ensureComparisonCurrent\(\)/, 'printing re-compares first');
  groups++;
}

// 3. Lossy result downloads never mark the full session saved; failed copy stays unreported.
{
  const m = session.match(/const SESSION_CLEANING_EXPORTS = (\[[^\]]*\]);/);
  assert.ok(m, 'SESSION_CLEANING_EXPORTS present');
  const list = vm.runInNewContext(m[1]);
  assert.deepEqual([...list], [], 'only a session save preserves the full work');
  const copy = extractFunction(exportJs, 'copyFinalTextToClipboard');
  assert.match(copy, /if \(copied\) flashCopied\(\);/, 'copied label only after a successful copy');
  groups++;
}

// 4. Undo/Redo menu items are updated right away (not only after a long comparison); a step that
//    only changes the review status refreshes it without a re-comparison.
{
  for (const fn of ['performUndo', 'performRedo']) {
    assert.match(
      extractFunction(interactions, fn),
      /updateUndoRedoButtons\(\);\s*if \(changed\) runComparison\(\);\s*else refreshReviewState\(\);/
    );
  }
  assert.match(extractFunction(interactions, 'resetEditHistory'), /state\.activeRowId = null;/, 'stale selection reset');
  groups++;
}

// 5. Editing one paragraph changes exactly that paragraph of the revised text: hidden
//    header/footer lines, page breaks and the order of all other blocks are kept, so the
//    re-comparison keeps the header/footer filter (regression: the sample jumped 22 -> 26).
{
  const ctx = { console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor/libs/diff.min.js'), 'utf8'), ctx);
  vm.runInContext('var t = key => key;', ctx);
  for (const f of ['02-samples.js', '04-core.js', '04a-align.js']) vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext(
    `${extractFunction(interactions, 'rebuildRightTextFromRows')}
     ${extractFunction(interactions, 'sameBlock')}
     var state = {};
     function compareNow() {
       const r = computeComparison({ leftText: state.leftText, rightText: state.rightText, ignoreHeadersFooters: state.ignoreHeadersFooters, labels: { typeHf: 'HF' } });
       state.alignedRows = r.alignedRows; state.rightAllBlocks = r.allRightBlocks;
       return r;
     }`,
    ctx
  );
  let edits = 0;
  for (const lang of ['de', 'en']) {
    for (const hf of [true, false]) {
      const base = vm.runInContext(
        `state = { leftText: SAMPLES.${lang}.v1, rightText: SAMPLES.${lang}.v2, ignoreHeadersFooters: ${hf} }; compareNow();`,
        ctx
      );
      const ids = base.alignedRows.filter(r => r.rightBlock && !r.rightBlock.isHeaderFooter).map(r => r.id);
      for (const id of ids) {
        const res = vm.runInContext(
          `(() => {
            state.rightText = SAMPLES.${lang}.v2; compareNow();
            const row = state.alignedRows.find(r => r.id === ${JSON.stringify(id)});
            const before = state.rightText.split(String.fromCharCode(10)).filter(Boolean);
            const hfBefore = compareNow().filteredHfCount;
            const text = rebuildRightTextFromRows(row.id, row.rightBlock.text + ' Zusatz.');
            const after = text.split(String.fromCharCode(10)).filter(Boolean);
            state.rightText = text;
            const r2 = compareNow();
            const changed = after.filter((l, k) => l !== before[k]);
            return { sameLength: after.length === before.length, changed: changed.length, hf: [hfBefore, r2.filteredHfCount] };
          })()`,
          ctx
        );
        assert.ok(res.sameLength && res.changed === 1, `${lang}/${hf}/${id}: exactly one line changes (${JSON.stringify(res)})`);
        assert.equal(res.hf[1], res.hf[0], `${lang}/${hf}/${id}: hidden header/footer lines kept`);
        edits++;
      }
      // Editing a deleted row (no right block) inserts its text without disturbing the rest.
      const del = base.alignedRows.find(r => r.type === 'deleted');
      if (del) {
        const n = vm.runInContext(
          `(() => { state.rightText = SAMPLES.${lang}.v2; compareNow();
             const before = state.rightText.split(String.fromCharCode(10)).filter(Boolean).length;
             const text = rebuildRightTextFromRows(${JSON.stringify(del.id)}, 'Wieder eingefügt.');
             return [before, text.split(String.fromCharCode(10)).filter(Boolean).length, text.includes('Wieder eingefügt.')]; })()`,
          ctx
        );
        assert.deepEqual(JSON.parse(JSON.stringify(n)).slice(1), [JSON.parse(JSON.stringify(n))[0] + 1, true], `${lang}/${hf}: edit of a deleted row adds one line`);
      }
    }
  }
  assert.ok(edits > 50, 'enough single-paragraph edits tested');
  groups++;
}

// 6. Single-letter shortcuts only act while reading (body, document panes, change list).
{
  const controls = read('10-controls.js');
  const fn = extractFunction(controls, 'isShortcutFocusContext');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`var document = { body: { id: 'body' }, documentElement: {} };
    ${extractFunction(controls, 'isTextEntryElement')} ${fn}`, ctx);
  const el = (tagName, inside, extra = {}) => ({ tagName, type: extra.type || '', isContentEditable: !!extra.ce, closest: sel => (sel.split(',').some(s => inside.includes(s.trim())) ? {} : null) });
  const ok = e => vm.runInContext('isShortcutFocusContext(x)', Object.assign(ctx, { x: e }));
  assert.equal(ok(ctx.document.body), true, 'body');
  assert.equal(ok(el('SECTION', ['#pane-right'])), true, 'document pane');
  assert.equal(ok(el('BUTTON', ['#sidebar-list'])), true, 'change list item');
  assert.equal(ok(el('BUTTON', [])), false, 'toolbar button');
  assert.equal(ok(el('BUTTON', ['.stepper'])), true, 'stepper');
  assert.equal(ok(el('BUTTON', ['.review-bar'])), true, 'floating review controls');
  assert.equal(ok(el('TEXTAREA', ['#pane-right', '.clause-inline-editor'])), false, 'inline editor');
  assert.equal(ok(el('INPUT', [], { type: 'search' })), false, 'search box');
  assert.equal(ok(el('DIV', ['#pane-right', '[contenteditable]'], { ce: true })), false, 'contenteditable');
  groups++;
}

// 7. Review status: kept per change across re-comparisons, part of every undo / redo step, and a
//    rejected change stays in the list. Undo of a review-only step needs no re-comparison.
{
  const review = read('06d-review.js');
  const ctx = { console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor/libs/diff.min.js'), 'utf8'), ctx);
  vm.runInContext('var t = key => key; var formatMsg = k => k; function getDisplayRef(row) { const b = row.rightBlock || row.leftBlock; return (b && b.refCode) || ""; }', ctx);
  for (const f of ['02-samples.js', '04-core.js', '04a-align.js']) vm.runInContext(read(f), ctx, { filename: f });
  vm.runInContext(review, ctx, { filename: '06d-review.js' });
  vm.runInContext(
    `${['rebuildRightTextFromRows', 'sameBlock', 'makeHistorySnapshot', 'restoreHistorySnapshot', 'pushUndoSnapshot', 'performUndo', 'performRedo']
      .map(n => extractFunction(interactions, n))
      .join('\n')}
     var state = { reviews: {}, undoStack: [], redoStack: [], listItems: [], alignedRows: [] };
     var comparisons = 0, refreshes = 0;
     function updateUndoRedoButtons() {}
     function refreshReviewState() { refreshes++; rebuildReviewIndex(); }
     function runComparison() {
       comparisons++;
       const r = computeComparison({ leftText: state.leftText, rightText: state.rightText, ignoreHeadersFooters: true, labels: { typeHf: 'HF' } });
       state.alignedRows = r.alignedRows; state.rightAllBlocks = r.allRightBlocks;
       rebuildReviewIndex();
     }
     function statuses() { return state.listItems.map(i => i.status[0]).join(''); }
     function accept(n) {
       const item = state.listItems.filter(i => i.status === 'open')[n];
       pushUndoSnapshot();
       state.reviews[item.row.reviewKey] = { status: 'accepted', type: item.type };
       rebuildReviewIndex();
       return item.row.reviewKey;
     }
     function reject(n) {
       const row = state.listItems.filter(i => i.status === 'open')[n].row;
       const a = computeRowAnchors(state.alignedRows);
       pushUndoSnapshot();
       state.reviews[row.reviewKey] = { status: 'rejected', type: row.type, leftText: row.leftBlock ? row.leftBlock.text : '', rightText: row.rightBlock ? row.rightBlock.text : '', leftAnchor: a.left.get(row.id) || '', prevAnchor: a.prev.get(row.id) || '', pageNum: 1, refCode: '' };
       state.rightText = rebuildRightTextFromRows(row.id, row.leftBlock ? row.leftBlock.text : '');
       runComparison();
     }`,
    ctx
  );
  const run = code => vm.runInContext(code, ctx);
  for (const lang of ['de', 'en']) {
    run(`comparisons = 0; refreshes = 0; state.leftText = SAMPLES.${lang}.v1; state.rightText = SAMPLES.${lang}.v2; state.reviews = {}; state.undoStack = []; state.redoStack = []; runComparison();`);
    const total = run('state.listItems.length');
    const fresh = run('statuses()');
    assert.ok(/^o+$/.test(fresh), `${lang}: everything open at first`);
    run('accept(0)');
    const afterAccept = run('statuses()');
    assert.equal(run('comparisons'), 1, `${lang}: accepting does not re-compare`);
    run('reject(1)');
    const afterReject = run('statuses()');
    assert.equal(run('state.listItems.length'), total, `${lang}: a rejected change stays in the list`);
    assert.equal((afterReject.match(/r/g) || []).length, 1, `${lang}: one rejected`);
    assert.equal((afterReject.match(/a/g) || []).length, 1, `${lang}: one accepted`);
    const rejectedText = run('state.rightText');
    // Undo the rejection: text and status come back together.
    run('performUndo()');
    assert.equal(run('statuses()'), afterAccept, `${lang}: undo restores the review status of a rejection`);
    assert.equal(run('state.rightText'), run(`SAMPLES.${lang}.v2`), `${lang}: undo restores the text`);
    // Undo the acceptance: a review-only step, no re-comparison.
    const before = run('comparisons');
    run('performUndo()');
    assert.equal(run('statuses()'), fresh, `${lang}: undo of an acceptance`);
    assert.equal(run('comparisons'), before, `${lang}: review-only undo does not re-compare`);
    assert.equal(run('refreshes') > 0, true, `${lang}: review-only undo refreshes the view`);
    run('performRedo(); performRedo();');
    assert.equal(run('statuses()'), afterReject, `${lang}: redo restores both reviews`);
    assert.equal(run('state.rightText'), rejectedText, `${lang}: redo restores the rejected text`);
    // An accepted change keeps its status when another paragraph is edited.
    const key = run('Object.keys(state.reviews).find(k => state.reviews[k].status === "accepted")');
    run(`(() => { const row = state.alignedRows.filter(r => r.type === 'equal' && r.rightBlock && !r.rightBlock.isHeaderFooter).slice(-1)[0];
      pushUndoSnapshot(); state.rightText = rebuildRightTextFromRows(row.id, row.rightBlock.text + ' Zusatz.'); runComparison(); })()`);
    assert.ok(run(`state.listItems.some(i => i.status === 'accepted' && i.row.reviewKey === ${JSON.stringify(key)})`), `${lang}: acceptance survives an edit elsewhere`);
    assert.ok(run('state.listItems.length') > total, `${lang}: the edit is a new change`);
  }
  groups++;
}

// 8. Saved work: version 2 carries the review status; version 1 files still open.
{
  const session = read('11-session.js');
  const ctx = { atob };
  vm.createContext(ctx);
  const consts = session.split('\n').filter(l => /^const (SESSION_|REVIEW_TYPES).*;$/.test(l)).join('\n');
  const start = session.indexOf('class SessionFileError');
  const end = session.indexOf('async function readSessionFile');
  vm.runInContext(`const REVIEW_KEY_MAX = 200000;\n${consts}\n${session.slice(start, end)}\nthis.validate = validateSessionData;`, ctx);
  const base = {
    format: 'docdiff-session', appVersion: '1.5.0', savedAt: '2026-10-22T00:00:00Z',
    documents: { left: { name: 'a', format: 'TXT', text: 'A' }, right: { name: 'b', format: 'TXT', originalText: 'B', text: 'B2' } },
  };
  const v1 = { ...base, version: 1, view: { mode: 'pages', onlyChanges: false, ignoreHeadersFooters: true }, history: { undo: ['B'], redo: [] } };
  const accepted = { key: 'M|A#1|B', status: 'accepted', type: 'modified' };
  const rejected = { key: 'D|X#1', status: 'rejected', type: 'deleted', leftText: 'X', rightText: '', leftAnchor: 'X#1', prevAnchor: 'A#1', pageNum: 2, refCode: '§ 1' };
  const v2 = {
    ...base, version: 2,
    view: { mode: 'inline', pageBreaks: false, onlyChanges: true, ignoreHeadersFooters: false },
    reviews: [accepted, rejected],
    history: { undo: [{ text: 'B', reviews: [accepted] }], redo: [] },
  };
  // Parsed inside the context, like a real file (plain objects of that realm).
  const ok = raw => vm.runInContext('validate(JSON.parse(src))', Object.assign(ctx, { src: JSON.stringify(raw) }));
  const bad = (raw, key = 'sessionErrorInvalid') => {
    try {
      ok(raw);
    } catch (err) {
      assert.equal(err.messageKey, key, JSON.stringify(raw).slice(0, 80));
      return;
    }
    assert.fail(`accepted: ${JSON.stringify(raw).slice(0, 120)}`);
  };
  const r1 = ok(v1);
  assert.deepEqual(JSON.parse(JSON.stringify(r1.view)), { mode: 'split', pageBreaks: true, onlyChanges: false, ignoreHeadersFooters: true }, 'v1 "pages" = side by side with page breaks');
  assert.deepEqual(JSON.parse(JSON.stringify(r1.history.undo)), [{ text: 'B', reviews: {} }], 'v1 history: text only');
  assert.deepEqual(JSON.parse(JSON.stringify(r1.reviews)), {}, 'v1: nothing reviewed');
  assert.equal(ok({ ...v1, view: { ...v1.view, mode: 'split' } }).view.pageBreaks, false, 'v1 "split" = no page breaks');
  const r2 = ok(v2);
  assert.deepEqual(Object.keys(r2.reviews), [accepted.key, rejected.key], 'v2 review status');
  assert.equal(r2.reviews[rejected.key].pageNum, 2);
  assert.equal(r2.history.undo[0].reviews[accepted.key].status, 'accepted', 'v2 history carries review status');
  assert.equal(r2.view.mode, 'inline');
  bad({ ...v2, version: 3 }, 'sessionErrorVersion');
  bad({ ...v2, view: { ...v2.view, mode: 'pages' } });
  bad({ ...v2, history: { undo: ['B'], redo: [] } });
  bad({ ...v1, history: { undo: [{ text: 'B', reviews: [] }], redo: [] } });
  bad({ ...v2, reviews: [{ ...accepted, status: 'maybe' }] });
  bad({ ...v2, reviews: [{ ...accepted, type: 'equal' }] });
  bad({ ...v2, reviews: [{ ...accepted, key: '__proto__' }] });
  bad({ ...v2, reviews: [{ ...rejected, pageNum: 0 }] });
  bad({ ...v2, reviews: [{ ...rejected, leftText: 5 }] });
  bad({ ...v2, reviews: 'x' });
  // The original .docx of a side travels along (Word export in the original format).
  const withSource = side => ({ ...v2, documents: { ...v2.documents, [side]: { ...v2.documents[side], source: { kind: 'docx', data: 'UEsDBA==', importedText: 'B' } } } });
  const rs = ok(withSource('right'));
  assert.deepEqual([...rs.right.source.bytes], [0x50, 0x4b, 3, 4], 'source bytes decoded');
  assert.equal(rs.right.source.name, 'b', 'source belongs to its document');
  assert.equal(rs.left.source, null, 'no source on the other side');
  bad({ ...withSource('left'), documents: { ...v2.documents, left: { ...v2.documents.left, source: { kind: 'pdf', data: '', importedText: '' } } } });
  bad({ ...withSource('left'), documents: { ...v2.documents, left: { ...v2.documents.left, source: { kind: 'docx', data: 'no base64!', importedText: '' } } } });
  assert.equal(({}).status, undefined, 'no prototype pollution');
  groups++;
}

// Language changes preserve saved demo edits, reviews and undo history.
{
  const ctx = { state: {}, SAMPLES: { de: { v1: 'old', v2: 'new' }, en: { v1: 'old en', v2: 'new en' } },
    document: { getElementById: () => null }, t: k => k,
    resetEditHistory() { throw new Error('history must survive'); },
    applyTranslationsToStaticDom() {}, runComparison() {} };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(read('10-controls.js'), 'toggleLanguage'), ctx);
  for (const extra of [{ rightText: 'saved edit' }, { reviews: { k: { status: 'accepted' } } }, { undoStack: ['new'] }]) {
    ctx.state = { lang: 'de', leftFormat: 'DEMO', rightFormat: 'DEMO', leftText: 'old', rightText: 'new', reviews: {}, undoStack: [], redoStack: [], ...extra };
    const before = JSON.stringify({ ...ctx.state, lang: 'en' });
    vm.runInContext('toggleLanguage()', ctx);
    assert.equal(JSON.stringify(ctx.state), before);
  }
  groups++;
}

// Exact changed tokens protect substantive digits; missing tokens require exact text.
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extractFunction(read('06d-review.js'), 'headerFooterGroupKey'), ctx);
  const key = (left, right, diffs, ghost = false) => {
    ctx.item = { type: 'modified', status: ghost ? 'rejected' : 'open',
      ghost: ghost ? { leftText: left, rightText: right } : null,
      row: { leftBlock: { text: left }, rightBlock: { text: right }, wordDiffs: diffs } };
    return vm.runInContext('headerFooterGroupKey(item)', ctx);
  };
  const tokens = n => [{ removed: true, value: '100' }, { added: true, value: String(n) }];
  assert.equal(key('Page 1 total 100', 'Page 1 total 200', tokens(200)), key('Page 2 total 100', 'Page 2 total 200', tokens(200)));
  assert.notEqual(key('Total 100', 'Total 200', tokens(200)), key('Total 100', 'Total 300', tokens(300)));
  for (const ghost of [true, false]) assert.notEqual(key('Total 100', 'Total 200', undefined, ghost), key('Total 100', 'Total 300', undefined, ghost));
  groups++;
}

// Batch acceptance is confirmed, revalidated and one undo step, including grouped members.
{
  const ctx = { state: {}, canReviewNow: () => true, itemMembers: item => item.members || [item],
    showSessionDialog: async () => 'confirm', pushUndoSnapshot() { ctx.undos++; },
    refreshReviewState() {}, announce() {}, undos: 0 };
  vm.createContext(ctx);
  vm.runInContext('async ' + extractFunction(read('06d-review.js'), 'acceptAllOpenChanges'), ctx);
  const member = k => ({ row: { reviewKey: k, type: 'modified' } });
  const reset = () => { ctx.undos = 0; ctx.state = { lang: 'en', leftText: 'a', rightText: 'b', reviews: {}, listItems: [
    { status: 'open', members: [member('one'), member('two')] }, { status: 'accepted', ...member('prior') }] }; };
  reset();
  assert.equal(await vm.runInContext('acceptAllOpenChanges()', ctx), true);
  assert.equal(ctx.undos, 1);
  assert.deepEqual(Object.keys(ctx.state.reviews), ['one', 'two']);
  reset(); ctx.showSessionDialog = async () => 'cancel';
  assert.equal(await vm.runInContext('acceptAllOpenChanges()', ctx), false);
  assert.equal(ctx.undos, 0);
  reset(); ctx.showSessionDialog = async () => { ctx.state.rightText = 'changed'; return 'confirm'; };
  assert.equal(await vm.runInContext('acceptAllOpenChanges()', ctx), false);
  assert.equal(ctx.undos, 0);
  groups++;
}

// A file exceeding the loader limit is never downloaded or marked clean.
{
  let downloads = 0, clean = 0;
  const ctx = { state: { leftText: 'A', rightText: 'B', lang: 'en' },
    SESSION_MAX_FILE_BYTES: 10, Blob: class { constructor() { this.size = 11; } },
    t: k => k, buildSessionFileName: () => 'work.docdiff', buildSessionPayload: () => ({}),
    showSessionDialog() {}, downloadSessionFile() { downloads++; }, markSessionClean() { clean++; } };
  vm.createContext(ctx);
  vm.runInContext(extractFunction(session, 'saveSession'), ctx);
  assert.equal(vm.runInContext('saveSession()', ctx), false);
  assert.equal(downloads, 0);
  assert.equal(clean, 0);
  groups++;
}

// A picker FileList is live and can be cleared by the first asynchronous upload.
{
  const files = { 0: { name: 'old.docx' }, 1: { name: 'new.docx' }, length: 2 };
  const calls = [];
  const ctx = { files, clearImportNotice() {}, async handleFileUpload(file, side) {
    calls.push([file?.name, side]);
    delete files[0]; delete files[1]; files.length = 0;
  } };
  vm.createContext(ctx);
  vm.runInContext('async ' + extractFunction(read('09-import.js'), 'handleDropFiles'), ctx);
  await vm.runInContext("handleDropFiles(files, 'left')", ctx);
  assert.deepEqual(calls, [['old.docx', 'left'], ['new.docx', 'right']]);
  groups++;
}

// Pair replacement has one guard, including when resetting the left side changes dirty state.
{
  const start = session.indexOf("wrapGlobalFunction('handleDropFiles'");
  const end = session.indexOf('/* ── Accessible', start);
  for (const [dirty, allow] of [[false, true], [true, true], [true, false]]) {
    let wrapped, calls = 0, prompts = 0;
    const tracker = { bypassGuard: 0 };
    const ctx = { sessionTracker: tracker, isSessionDirty: () => dirty,
      confirmDiscardEdits: async () => { prompts++; return allow; },
      wrapGlobalFunction: (_, factory) => { wrapped = factory(async files => {
        calls++;
        assert.equal(tracker.bypassGuard, 1, 'the entire pair bypasses nested guards');
        assert.ok(Array.isArray(files), 'selection is snapshotted before waiting');
      }); } };
    vm.createContext(ctx);
    vm.runInContext(session.slice(start, end), ctx);
    await wrapped({ 0: {}, 1: {}, length: 2 }, 'left');
    assert.equal(prompts, dirty ? 1 : 0);
    assert.equal(calls, !dirty || allow ? 1 : 0);
    assert.equal(tracker.bypassGuard, 0, 'guard restored');
  }
  groups++;
}

// Explicitly loading a pair establishes a baseline even when its right text is unchanged.
{
  const tracker = { restoring: false, editPending: true };
  let wrapped, clean = 0;
  const ctx = { sessionTracker: tracker, state: { rightText: 'same text' },
    markSessionClean: () => { clean++; },
    wrapGlobalFunction: (_, factory) => { wrapped = factory(() => 42); } };
  vm.createContext(ctx);
  const start = session.indexOf("wrapGlobalFunction('resetEditHistory'");
  const end = session.indexOf("wrapGlobalFunction('handleFileUpload'", start);
  vm.runInContext(session.slice(start, end), ctx);
  assert.equal(wrapped(), 42);
  assert.equal(clean, 1);
  assert.equal(tracker.originalRightText, 'same text');
  assert.equal(tracker.editPending, false);
  tracker.restoring = true;
  wrapped();
  assert.equal(clean, 1, 'session restoration keeps its own baseline');
  groups++;
}

console.log(`✓ App state guard tests passed (${groups} groups).`);
