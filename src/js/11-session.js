/* ── Work-Loss Protection: Unsaved-Changes Guard & Saved Work (.docdiff) ──
 *
 * Nothing is ever written to browser storage. Work is protected in two ways:
 *  1. A dirty flag (inline edits, accepted / rejected changes since the last load, save or
 *     export) drives the native `beforeunload` prompt and an in-app dialog in front of every
 *     action that would throw this work away ("Abbrechen / Arbeitsstand speichern / Verwerfen").
 *  2. "Arbeitsstand speichern…" downloads a self-describing JSON file (.docdiff) to the
 *     user's own disk; "Arbeitsstand öffnen…" validates it strictly and restores it through
 *     the app's normal entry points (state fields + runComparison).
 *
 * To keep this module isolated from the rest of the code base, it hooks into a few global
 * functions by wrapping them (they are plain function declarations in the shared
 * classic-script scope, so every caller resolves the wrapped version at call time). The
 * wrappers never change behaviour, they only observe it.
 *
 * Format version 2 adds the review status (state.reviews) and stores it in every undo / redo
 * entry; version 1 files (no review status) still open.
 */

const DOCDIFF_APP_VERSION = '1.6.5';
const SESSION_FORMAT_ID = 'docdiff-session';
const SESSION_FORMAT_VERSION = 2;
const SESSION_FILE_EXT = '.docdiff';
const SESSION_MAX_FILE_BYTES = 50 * 1024 * 1024;
const SESSION_MAX_NAME_CHARS = 1024;
const SESSION_MAX_FORMAT_CHARS = 32;
const SESSION_MAX_HISTORY_ENTRIES = 100;
const SESSION_MAX_REVIEWS = 100000;
// Undo/redo snapshots are full copies of the right-hand text. Only as many of
// the most recent ones as fit into this budget are written into a session file.
const SESSION_HISTORY_CHAR_BUDGET = 8 * 1024 * 1024;
const SESSION_VIEW_MODES_V1 = ['pages', 'split', 'inline'];
const SESSION_VIEW_MODES = ['split', 'inline'];
const REVIEW_TYPES = ['modified', 'inserted', 'deleted'];

const sessionTracker = {
  // Right-hand text as it was last loaded (before any inline edits).
  originalRightText: state.rightText,
  // Right-hand text and review status at the last "clean point" (load, save, export).
  cleanRightText: state.rightText,
  cleanReviews: serializeReviews(),
  // Right-hand text seen by the previous runComparison call.
  lastSeenRightText: state.rightText,
  // Set by the edit entry points right before they trigger runComparison.
  editPending: false,
  // Set while a session is being restored, so it is not treated as a fresh load.
  restoring: false,
  // > 0 while a confirmed action is replayed, so it is not guarded twice.
  bypassGuard: 0,
};

function hasOpenInlineEditorChanges() {
  const editor = document.querySelector('.clause-inline-editor');
  if (!editor) return false;
  const clause = editor.closest('.clause[data-row-id]');
  const row = clause && state.alignedRows.find(r => r.id === clause.getAttribute('data-row-id'));
  const baseline = row && row.rightBlock ? row.rightBlock.text : '';
  return editor.value.replace(/\r\n/g, '\n').trim() !== baseline;
}

function isSessionDirty() {
  return (
    state.rightText !== sessionTracker.cleanRightText ||
    serializeReviews() !== sessionTracker.cleanReviews ||
    hasOpenInlineEditorChanges()
  );
}

function markSessionClean() {
  sessionTracker.cleanRightText = state.rightText;
  sessionTracker.cleanReviews = serializeReviews();
}

/* ── Hooks into existing entry points ───────────────────────────────────── */
function wrapGlobalFunction(name, makeWrapper) {
  const original = window[name];
  if (typeof original !== 'function') return;
  window[name] = makeWrapper(original);
}

// Every change of the right-hand text flows through runComparison. A change
// that was not announced by an edit entry point is a fresh load and becomes
// the new baseline. The wrapper passes the return value through, so it works
// whether runComparison is synchronous or returns a Promise.
wrapGlobalFunction('runComparison', original =>
  function runComparisonWithSessionTracking() {
    if (state.rightText !== sessionTracker.lastSeenRightText) {
      if (!sessionTracker.editPending && !sessionTracker.restoring) {
        sessionTracker.originalRightText = state.rightText;
        markSessionClean();
      }
      sessionTracker.lastSeenRightText = state.rightText;
    }
    sessionTracker.editPending = false;
    return original.apply(this, arguments);
  }
);

['pushUndoSnapshot', 'performUndo', 'performRedo'].forEach(name => {
  wrapGlobalFunction(name, original =>
    function markEditPending() {
      sessionTracker.editPending = true;
      return original.apply(this, arguments);
    }
  );
});

// A new pair of documents: a review-only action before it must not make the load look like an edit.
wrapGlobalFunction('resetEditHistory', original =>
  function resetEditHistoryForLoad() {
    sessionTracker.editPending = false;
    return original.apply(this, arguments);
  }
);

wrapGlobalFunction('handleFileUpload', original =>
  async function guardedFileUpload(file, side) {
    if (file && side === 'right' && !sessionTracker.bypassGuard && isSessionDirty()) {
      const ok = await confirmDiscardEdits();
      if (!ok) {
        const input = document.getElementById('file-input-right');
        if (input) input.value = '';
        return undefined;
      }
    }
    return original.apply(this, arguments);
  }
);

wrapGlobalFunction('handleDropFiles', original =>
  async function guardedDropFiles(files, targetSide) {
    const replacesRight = files && (files.length >= 2 || (files.length === 1 && targetSide === 'right'));
    if (replacesRight && !sessionTracker.bypassGuard && isSessionDirty()) {
      if (!(await confirmDiscardEdits())) return undefined;
      sessionTracker.bypassGuard++;
      try {
        return await original.apply(this, arguments);
      } finally {
        sessionTracker.bypassGuard--;
      }
    }
    return original.apply(this, arguments);
  }
);

/* ── Accessible confirm / message dialog ────────────────────────────────── */
const sessionDialog = document.getElementById('session-dialog');
const sessionDialogTitle = document.getElementById('session-dialog-title');
const sessionDialogBody = document.getElementById('session-dialog-body');
const sessionDialogCancel = document.getElementById('session-dialog-cancel');
const sessionDialogConfirm = document.getElementById('session-dialog-confirm');
const sessionDialogDiscard = document.getElementById('session-dialog-discard');
let sessionDialogResolve = null;
let sessionDialogReturnFocus = null;

function finishSessionDialog(result) {
  const resolve = sessionDialogResolve;
  sessionDialogResolve = null;
  if (sessionDialog.open) {
    sessionDialog.close();
    restoreSessionDialogFocus();
  }
  if (resolve) resolve(result);
}

// Back to where the dialog was opened from (the menu button for an action in a menu).
function restoreSessionDialogFocus() {
  const target = sessionDialogReturnFocus;
  const active = document.activeElement;
  if (
    target &&
    target.isConnected &&
    target.getClientRects().length &&
    (!active || active === document.body || !active.getClientRects().length)
  ) {
    target.focus();
  }
}

// Resolves with 'confirm', 'discard' or 'cancel'.
function showSessionDialog({ title, body, confirmLabel, cancelLabel, discardLabel }) {
  if (sessionDialogResolve) finishSessionDialog('cancel');
  hideTooltip();
  // A dialog opened from a menu item: focus goes back to the menu button afterwards.
  const active = document.activeElement;
  sessionDialogReturnFocus = (typeof menuReturnTarget === 'function' && menuReturnTarget()) || active;
  if (active && active.closest && active.closest('[role="menu"], .popover')) {
    const menu = active.closest('[role="menu"], .popover');
    sessionDialogReturnFocus = document.querySelector(`[aria-controls="${menu.id}"]`) || sessionDialogReturnFocus;
  }
  if (typeof closeAllMenus === 'function') closeAllMenus(false);
  sessionDialogTitle.textContent = title;
  sessionDialogBody.textContent = body;
  sessionDialogConfirm.textContent = confirmLabel;
  sessionDialogCancel.hidden = !cancelLabel;
  sessionDialogCancel.textContent = cancelLabel || '';
  sessionDialogDiscard.hidden = !discardLabel;
  sessionDialogDiscard.textContent = discardLabel || '';
  sessionDialog.setAttribute('role', cancelLabel ? 'alertdialog' : 'dialog');
  return new Promise(resolve => {
    sessionDialogResolve = resolve;
    sessionDialog.showModal();
    // The safe choice has the initial focus: "Abbrechen" (or "OK" for a message).
    (cancelLabel ? sessionDialogCancel : sessionDialogConfirm).focus();
  });
}

sessionDialogConfirm.addEventListener('click', () => finishSessionDialog('confirm'));
sessionDialogCancel.addEventListener('click', () => finishSessionDialog('cancel'));
sessionDialogDiscard.addEventListener('click', () => finishSessionDialog('discard'));
// Esc or any other way of closing counts as "cancel". The close event is
// dispatched asynchronously, so a late one from a previous dialog must not
// cancel a dialog that has been reopened in the meantime.
// Esc is "cancel", handled here so that focus returns right away (not only once the
// asynchronous close event arrives).
sessionDialog.addEventListener('cancel', e => {
  e.preventDefault();
  finishSessionDialog('cancel');
});
sessionDialog.addEventListener('close', () => {
  if (!sessionDialog.open) finishSessionDialog('cancel');
  restoreSessionDialogFocus();
});

// Unsaved work in front of an action that would discard it: [Abbrechen] (default focus),
// [Arbeitsstand speichern] (saves, then continues), [Verwerfen]. Resolves true to continue.
async function confirmDiscardEdits() {
  const choice = await showSessionDialog({
    title: t('sessionDiscardTitle'),
    body: t('sessionDiscardBody'),
    confirmLabel: t('sessionSaveContinue'),
    cancelLabel: t('cancel'),
    discardLabel: t('sessionDiscardConfirm'),
  });
  if (choice === 'confirm') {
    saveSession();
    return true;
  }
  return choice === 'discard';
}

function showSessionError(messageKey) {
  return showSessionDialog({
    title: t('sessionErrorTitle'),
    body: t(messageKey),
    confirmLabel: t('sessionOk'),
  });
}

/* ── Guards in front of in-app actions that discard work ───────────────── */
const SESSION_GUARDED_CLICKS = [
  { selector: '#btn-clear' },
  { selector: '#btn-clear-right' },
  { selector: '#lp-clear-right' },
  { selector: '#btn-swap-docs' },
  { selector: '.btn-load-sample' },
  { selector: '#btn-help-sample' },
  {
    // The paste dialog is pre-filled with the edited text; only an actual
    // change of the right-hand text discards edits.
    selector: '#btn-apply-modal',
    when: () => {
      const ta = document.getElementById('textarea-right');
      return !!ta && ta.value !== pasteModalShown.right;
    },
  },
  {
    // Toggling the language while the sample is shown reloads the sample.
    selector: '#btn-lang, #menu-lang, #footer-lang-link',
    when: () => state.leftFormat === 'DEMO' && state.rightFormat === 'DEMO',
  },
];

document.addEventListener(
  'click',
  e => {
    if (sessionTracker.bypassGuard || !(e.target instanceof Element)) return;
    let matched = null;
    for (const guard of SESSION_GUARDED_CLICKS) {
      const el = e.target.closest(guard.selector);
      if (el && (!guard.when || guard.when())) {
        matched = el;
        break;
      }
    }
    if (!matched || !isSessionDirty()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    confirmDiscardEdits().then(ok => {
      if (!ok || !matched.isConnected) return;
      sessionTracker.bypassGuard++;
      try {
        matched.click();
      } finally {
        sessionTracker.bypassGuard--;
      }
    });
  },
  true
);

window.addEventListener('beforeunload', e => {
  if (!isSessionDirty()) return undefined;
  e.preventDefault();
  // Legacy browsers need returnValue to be set to show the native prompt.
  e.returnValue = '';
  return '';
});

/* ── Saving ─────────────────────────────────────────────────────────────── */
function sanitizeSessionFileStem(name, fallback) {
  const stem = String(name || '')
    .replace(/\.[^.]+$/, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 60);
  return stem || fallback;
}

function buildSessionFileName() {
  const left = sanitizeSessionFileStem(state.leftName, 'Original');
  const right = sanitizeSessionFileStem(state.rightName, 'Revised');
  return `${left}_vs_${right}${SESSION_FILE_EXT}`;
}

function serializeReviewEntries(reviews) {
  return Object.keys(reviews || {})
    .sort()
    .map(key => {
      const e = reviews[key];
      const out = { key, status: e.status, type: e.type };
      if (e.status === 'rejected') {
        for (const k of ['leftText', 'rightText', 'leftAnchor', 'prevAnchor', 'refCode']) out[k] = String(e[k] || '');
        out.pageNum = Number.isInteger(e.pageNum) && e.pageNum > 0 ? e.pageNum : 1;
        if (e.hf) out.hf = true; // a header/footer line (listed after the body changes)
      }
      return out;
    });
}

function historyEntrySize(entry) {
  return entry.text.length + JSON.stringify(entry.reviews).length;
}

// Keeps the most recent snapshots that fit into the remaining budget.
function takeRecentHistory(stack, budget) {
  const kept = [];
  let used = 0;
  for (let i = stack.length - 1; i >= 0 && kept.length < SESSION_MAX_HISTORY_ENTRIES; i--) {
    const snap = stack[i];
    const entry =
      typeof snap === 'string'
        ? { text: snap, reviews: [] }
        : { text: String(snap.text), reviews: serializeReviewEntries(snap.reviews) };
    const size = historyEntrySize(entry);
    if (used + size > budget) break;
    used += size;
    kept.unshift(entry);
  }
  return { kept, used };
}

// The original .docx of a side (for the Word export in the original format), as base64.
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function sessionSourceOf(side) {
  const src = state.docSources && state.docSources[side];
  const name = side === 'left' ? state.leftName : state.rightName;
  const format = side === 'left' ? state.leftFormat : state.rightFormat;
  if (!src || format !== 'DOCX' || src.name !== name) return undefined;
  return { kind: 'docx', data: bytesToBase64(src.bytes), importedText: src.importedText };
}

function buildSessionPayload() {
  const redo = takeRecentHistory(state.redoStack, SESSION_HISTORY_CHAR_BUDGET);
  const undo = takeRecentHistory(state.undoStack, SESSION_HISTORY_CHAR_BUDGET - redo.used);
  return {
    format: SESSION_FORMAT_ID,
    version: SESSION_FORMAT_VERSION,
    app: 'Doc Diff',
    appVersion: DOCDIFF_APP_VERSION,
    savedAt: new Date().toISOString(),
    documents: {
      left: {
        name: state.leftName,
        format: state.leftFormat,
        text: state.leftText,
        source: sessionSourceOf('left'),
      },
      right: {
        name: state.rightName,
        format: state.rightFormat,
        originalText: sessionTracker.originalRightText,
        text: state.rightText,
        source: sessionSourceOf('right'),
      },
    },
    view: {
      mode: state.viewMode,
      pageBreaks: state.pageBreaks === null ? null : Boolean(state.pageBreaks),
      onlyChanges: !!state.onlyChanges,
      ignoreHeadersFooters: !!state.ignoreHeadersFooters,
    },
    reviews: serializeReviewEntries(state.reviews),
    history: {
      undo: undo.kept,
      redo: redo.kept,
    },
  };
}

function downloadSessionFile(json, filename) {
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveSession() {
  if (!state.leftText.trim() && !state.rightText.trim()) {
    showSessionDialog({
      title: t('sessionNothingTitle'),
      body: t('sessionNothingBody'),
      confirmLabel: t('sessionOk'),
    });
    return;
  }
  const name = buildSessionFileName();
  const json = JSON.stringify(buildSessionPayload(), null, 1);
  downloadSessionFile(json, name);
  markSessionClean();
  if (typeof showToast === 'function') showToast(formatMsg('toastSession', { name }));
}

/* ── Opening: strict validation, then restore ───────────────────────────── */
class SessionFileError extends Error {
  constructor(messageKey) {
    super(messageKey);
    this.messageKey = messageKey;
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function expectString(value, maxChars) {
  if (typeof value !== 'string' || value.length > maxChars) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  return value;
}

function expectBoolean(value) {
  if (typeof value !== 'boolean') throw new SessionFileError('sessionErrorInvalid');
  return value;
}

function expectStringArray(value) {
  if (!Array.isArray(value) || value.length > SESSION_MAX_HISTORY_ENTRIES) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  return value.map(entry => expectString(entry, SESSION_MAX_FILE_BYTES));
}

function expectFormatTag(value) {
  const tag = expectString(value, SESSION_MAX_FORMAT_CHARS);
  if (!/^[A-Za-z0-9_-]*$/.test(tag)) throw new SessionFileError('sessionErrorInvalid');
  return tag;
}

// A list of review entries -> a fresh key -> entry object (no prototype, only known fields).
function expectReviewEntries(value) {
  if (!Array.isArray(value) || value.length > SESSION_MAX_REVIEWS) throw new SessionFileError('sessionErrorInvalid');
  const out = {};
  for (const raw of value) {
    if (!isPlainObject(raw)) throw new SessionFileError('sessionErrorInvalid');
    const key = expectString(raw.key, REVIEW_KEY_MAX * 2);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new SessionFileError('sessionErrorInvalid');
    if (raw.status !== 'accepted' && raw.status !== 'rejected') throw new SessionFileError('sessionErrorInvalid');
    if (!REVIEW_TYPES.includes(raw.type)) throw new SessionFileError('sessionErrorInvalid');
    const entry = { status: raw.status, type: raw.type };
    if (raw.status === 'rejected') {
      for (const k of ['leftText', 'rightText', 'leftAnchor', 'prevAnchor']) entry[k] = expectString(raw[k], SESSION_MAX_FILE_BYTES);
      entry.refCode = expectString(raw.refCode, 1000);
      if (!Number.isInteger(raw.pageNum) || raw.pageNum < 1 || raw.pageNum > 1e6) throw new SessionFileError('sessionErrorInvalid');
      entry.pageNum = raw.pageNum;
      if (raw.hf !== undefined) {
        if (raw.hf !== true) throw new SessionFileError('sessionErrorInvalid');
        entry.hf = true;
      }
    }
    Object.defineProperty(out, key, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function expectHistoryV2(value) {
  if (!Array.isArray(value) || value.length > SESSION_MAX_HISTORY_ENTRIES) throw new SessionFileError('sessionErrorInvalid');
  return value.map(entry => {
    if (!isPlainObject(entry)) throw new SessionFileError('sessionErrorInvalid');
    return { text: expectString(entry.text, SESSION_MAX_FILE_BYTES), reviews: expectReviewEntries(entry.reviews) };
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Optional original .docx of a side: { kind: 'docx', data (base64), importedText }.
function expectSource(value, name) {
  if (value === undefined) return null;
  if (!isPlainObject(value) || value.kind !== 'docx') throw new SessionFileError('sessionErrorInvalid');
  const data = expectString(value.data, SESSION_MAX_FILE_BYTES);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new SessionFileError('sessionErrorInvalid');
  return { name, bytes: base64ToBytes(data), importedText: expectString(value.importedText, SESSION_MAX_FILE_BYTES) };
}

// Returns a fresh, fully validated object; throws SessionFileError otherwise.
function validateSessionData(raw) {
  if (!isPlainObject(raw) || raw.format !== SESSION_FORMAT_ID) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  if (raw.version > SESSION_FORMAT_VERSION) {
    throw new SessionFileError('sessionErrorVersion');
  }
  const v1 = raw.version === 1;
  expectString(raw.appVersion, 64);
  expectString(raw.savedAt, 64);

  const docs = raw.documents;
  if (!isPlainObject(docs) || !isPlainObject(docs.left) || !isPlainObject(docs.right)) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  const view = raw.view;
  if (!isPlainObject(view) || !(v1 ? SESSION_VIEW_MODES_V1 : SESSION_VIEW_MODES).includes(view.mode)) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  // Version 1 knew three views; "pages" is now "side by side with page breaks".
  let pageBreaks = null;
  if (v1) pageBreaks = view.mode === 'pages' ? true : view.mode === 'split' ? false : null;
  else if (view.pageBreaks !== null && view.pageBreaks !== undefined) pageBreaks = expectBoolean(view.pageBreaks);

  let history = { undo: [], redo: [] };
  if (raw.history !== undefined) {
    if (!isPlainObject(raw.history)) throw new SessionFileError('sessionErrorInvalid');
    history = v1
      ? {
          undo: expectStringArray(raw.history.undo).map(text => ({ text, reviews: {} })),
          redo: expectStringArray(raw.history.redo).map(text => ({ text, reviews: {} })),
        }
      : { undo: expectHistoryV2(raw.history.undo), redo: expectHistoryV2(raw.history.redo) };
  }

  const result = {
    left: {
      name: expectString(docs.left.name, SESSION_MAX_NAME_CHARS),
      format: expectFormatTag(docs.left.format),
      text: expectString(docs.left.text, SESSION_MAX_FILE_BYTES),
      source: expectSource(docs.left.source, docs.left.name),
    },
    right: {
      name: expectString(docs.right.name, SESSION_MAX_NAME_CHARS),
      format: expectFormatTag(docs.right.format),
      originalText: expectString(docs.right.originalText, SESSION_MAX_FILE_BYTES),
      text: expectString(docs.right.text, SESSION_MAX_FILE_BYTES),
      source: expectSource(docs.right.source, docs.right.name),
    },
    view: {
      mode: view.mode === 'pages' ? 'split' : view.mode,
      pageBreaks,
      onlyChanges: expectBoolean(view.onlyChanges),
      ignoreHeadersFooters: expectBoolean(view.ignoreHeadersFooters),
    },
    reviews: v1 || raw.reviews === undefined ? {} : expectReviewEntries(raw.reviews),
    history,
  };
  if (!result.left.text.trim() && !result.right.text.trim()) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  return result;
}

async function readSessionFile(file) {
  if (!file || typeof file.size !== 'number') throw new SessionFileError('sessionErrorInvalid');
  if (file.size > SESSION_MAX_FILE_BYTES) throw new SessionFileError('sessionErrorTooLarge');
  if (file.size === 0) throw new SessionFileError('sessionErrorInvalid');
  let text;
  try {
    text = await file.text();
  } catch (err) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SessionFileError('sessionErrorInvalid');
  }
  return validateSessionData(raw);
}

async function applySessionData(session) {
  // Let a still-open inline editor finish against the old state first, so it
  // cannot fire later against the restored rows.
  const openEditor = document.querySelector('.clause-inline-editor');
  if (openEditor) openEditor.blur();

  state.leftName = session.left.name;
  state.leftFormat = session.left.format;
  state.leftText = session.left.text;
  state.rightName = session.right.name;
  state.rightFormat = session.right.format;
  state.rightText = session.right.text;
  state.docSources = { left: session.left.source || null, right: session.right.source || null };
  state.reviews = cloneReviews(session.reviews);
  state.undoStack = session.history.undo.map(e => ({ text: e.text, reviews: cloneReviews(e.reviews) }));
  state.redoStack = session.history.redo.map(e => ({ text: e.text, reviews: cloneReviews(e.reviews) }));
  state.activeRowId = null;
  state.hoveredRowId = null;
  state.sidebarFilter = 'all';
  state.statusFilter = 'all';
  state.searchQuery = '';
  state.ignoreHeadersFooters = session.view.ignoreHeadersFooters;
  state.pageBreaks = session.view.pageBreaks;

  const searchEl = document.getElementById('search-input');
  if (searchEl) searchEl.value = '';
  if (typeof closeSearch === 'function') closeSearch(false);
  ['file-input-left', 'file-input-right'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });

  if (typeof clearImportNotice === 'function') clearImportNotice();
  // Phones show one column only.
  setViewMode(isPhoneWidth() ? 'inline' : session.view.mode, { user: true });
  if (!!state.onlyChanges !== session.view.onlyChanges) toggleOnlyChanges();

  sessionTracker.restoring = true;
  try {
    await Promise.resolve(runComparison());
  } finally {
    sessionTracker.restoring = false;
  }
  sessionTracker.originalRightText = session.right.originalText;
  sessionTracker.lastSeenRightText = state.rightText;
  markSessionClean();
  updateUndoRedoButtons();
}

async function openSessionFile(file) {
  let session;
  try {
    session = await readSessionFile(file);
  } catch (err) {
    await showSessionError(err instanceof SessionFileError ? err.messageKey : 'sessionErrorInvalid');
    return false;
  }
  if (isSessionDirty() && !(await confirmDiscardEdits())) return false;
  try {
    await applySessionData(session);
  } catch (err) {
    console.warn('Doc Diff: session restore failed', err);
    await showSessionError('sessionErrorInvalid');
    return false;
  }
  return true;
}

function isSessionFile(file) {
  return !!file && typeof file.name === 'string' && file.name.toLowerCase().endsWith(SESSION_FILE_EXT);
}

/* ── UI wiring: menu items, landing / paste-dialog buttons, file drop ──── */
const sessionFileInput = document.getElementById('file-input-session');

function requestOpenSession() {
  const pasteDialog = document.getElementById('paste-modal');
  if (pasteDialog && pasteDialog.open) pasteDialog.close();
  sessionFileInput.value = '';
  sessionFileInput.click();
}

sessionFileInput.addEventListener('change', async () => {
  const file = sessionFileInput.files && sessionFileInput.files[0];
  sessionFileInput.value = '';
  if (file) await openSessionFile(file);
});

document.addEventListener('click', e => {
  if (!(e.target instanceof Element)) return;
  if (e.target.closest('.btn-open-session')) {
    requestOpenSession();
    return;
  }
  if (e.target.closest('[data-session-action="save"]')) saveSession();
});

// Downloading the result counts as saving it. Copying and printing do not: the
// clipboard is volatile, and neither a failed copy nor a cancelled print dialog can be
// detected, so they must not silence the unsaved-changes warning.
const SESSION_CLEANING_EXPORTS = ['txt', 'word', 'html', 'md'];
document.addEventListener('click', e => {
  if (!(e.target instanceof Element)) return;
  const item = e.target.closest('#export-menu [data-export]');
  if (item && SESSION_CLEANING_EXPORTS.includes(item.getAttribute('data-export'))) {
    markSessionClean();
  }
});

// A dropped .docdiff file is saved work, never a document to compare. This
// capture listener runs before the pane / landing drop handlers.
window.addEventListener(
  'drop',
  e => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const sessionFile = Array.from(files).find(isSessionFile);
    if (!sessionFile) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter = 0;
    document.body.classList.remove('is-dragging-file');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    openSessionFile(sessionFile);
  },
  true
);
