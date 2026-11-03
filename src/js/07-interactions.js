/* ── Overview ruler: where the changes are, and which part of the document is in view ─── */

const rulerEl = document.getElementById('ruler');
const rulerTrack = document.getElementById('ruler-track');
const rulerWindow = document.getElementById('ruler-window');
let rulerRaf = 0;
let rulerWindowRaf = 0;

function scheduleRulerDraw() {
  if (rulerRaf) return;
  rulerRaf = requestAnimationFrame(() => {
    rulerRaf = 0;
    drawRuler();
  });
}

function clearRuler() {
  rulerTrack.innerHTML = '';
  rulerWindow.style.height = '0';
}

// "S. 2 · § 3 (1) · geändert"
function rulerLabel(item) {
  return [`${t('pageShort')} ${getItemPage(item)}`, getItemRef(item), getChangeTypeLabel(item)].filter(Boolean).join(' · ') +
    (item.status !== 'open' ? ` (${getStatusLabel(item.status)})` : '');
}

function drawRuler() {
  if (!document.body.classList.contains('is-comparing')) return clearRuler();
  const pane = activeDocPane();
  const H = rulerTrack.clientHeight;
  const sh = pane.scrollHeight;
  if (!H || !sh) return;
  const paneTop = pane.getBoundingClientRect().top - pane.scrollTop;
  const key = state.viewMode === 'inline' ? 'u' : 'r';
  const total = state.alignedRows.length || 1;
  const activeItem = getActiveItem();
  const html = [];
  for (const item of state.listItems.flatMap(it => (it.members ? it.members.map(m => ({ ...m, id: it.id, index: it.index, members: it.members })) : [it]))) {
    const el = getRowElements(item.rowId)[key];
    let top;
    let h = 3;
    const rect = el && el.isConnected ? el.getBoundingClientRect() : null;
    if (rect && rect.height) {
      top = ((rect.top - paneTop) / sh) * H;
      h = Math.max(3, (rect.height / sh) * H);
    } else if (rect) {
      continue; // hidden ("only changes" or a collapsed header/footer group)
    } else {
      top = ((item.row.rowNumber - 1) / total) * H; // not rendered yet
    }
    if (item.ghost && item.type === 'inserted') top += h;
    const isActive = activeItem && (item === activeItem || item.id === activeItem.id);
    const cls = `rm rm-${item.type === 'modified' ? 'mod' : item.type === 'inserted' ? 'ins' : 'del'} is-${item.status}${isActive ? ' is-active' : ''}`;
    html.push(
      `<div class="${cls}" style="top:${Math.min(H - 3, top).toFixed(1)}px;height:${Math.min(h, 40).toFixed(1)}px" data-row-id="${item.rowId}" data-item-id="${item.id}" data-tooltip="${escapeHtml(rulerLabel(item))}"></div>`
    );
  }
  rulerTrack.innerHTML = html.join('');
  updateRulerWindow();
}

function updateRulerWindow() {
  const pane = activeDocPane();
  const H = rulerTrack.clientHeight;
  const sh = pane.scrollHeight;
  if (!H || !sh) return;
  const h = Math.max(18, (pane.clientHeight / sh) * H);
  const top = Math.min(H - h, (pane.scrollTop / sh) * H);
  rulerWindow.style.transform = `translateY(${top.toFixed(1)}px)`;
  rulerWindow.style.height = `${h.toFixed(1)}px`;
}

function scheduleRulerWindow() {
  if (rulerWindowRaf) return;
  rulerWindowRaf = requestAnimationFrame(() => {
    rulerWindowRaf = 0;
    updateRulerWindow();
  });
}

// Click a marker to jump to that change; press and drag anywhere else to scroll.
(function initRulerPointer() {
  let drag = null;
  const scrollTo = clientY => {
    const pane = activeDocPane();
    const rect = rulerTrack.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    pane.scrollTop = frac * pane.scrollHeight - pane.clientHeight / 2;
  };
  rulerEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const rect = rulerTrack.getBoundingClientRect();
    const y = e.clientY - rect.top;
    // Markers are slim: accept a click within a few pixels.
    let best = null;
    let bestDist = 6;
    for (const m of rulerTrack.children) {
      const top = parseFloat(m.style.top);
      const bottom = top + parseFloat(m.style.height);
      const d = y < top ? top - y : y > bottom ? y - bottom : 0;
      if (d < bestDist) {
        best = m;
        bestDist = d;
      }
    }
    e.preventDefault();
    if (best) {
      selectAndScrollToRow(best.getAttribute('data-row-id'), true, true, { itemId: best.getAttribute('data-item-id') });
      announceActiveChange();
      return;
    }
    drag = { id: e.pointerId };
    rulerEl.setPointerCapture(e.pointerId);
    rulerEl.classList.add('is-dragging');
    scrollTo(e.clientY);
  });
  rulerEl.addEventListener('pointermove', e => {
    if (drag && e.pointerId === drag.id) scrollTo(e.clientY);
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    rulerEl.classList.remove('is-dragging');
  };
  rulerEl.addEventListener('pointerup', end);
  rulerEl.addEventListener('pointercancel', end);
})();

/* ── Hover (mouse only), selection and scrolling ───────────────────────── */

// Elements of a row across panes, list and ruler, without scanning the whole document.
function getRowDecoratedElements(rowId) {
  if (!rowId) return [];
  const els = getRowElements(rowId);
  const out = [els.l, els.r, els.u].filter(Boolean);
  for (const nav of sidebarList.querySelectorAll(`.nav-item[data-row-id="${rowId}"]`)) out.push(nav);
  return out;
}

function setHoveredRow(rowId) {
  if (state.hoveredRowId === rowId) return;
  const prevId = state.hoveredRowId;
  state.hoveredRowId = rowId;
  for (const el of getRowDecoratedElements(prevId)) el.classList.remove('is-hovered');
  if (rowId) for (const el of getRowDecoratedElements(rowId)) el.classList.add('is-hovered');
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function scrollBehavior(smooth) {
  return smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
}

let programmaticScrollTimer = null;
let lastActiveRowId = null;

function getScrollTargetTop(pane, targetEl) {
  const paneRect = pane.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();
  const offsetInContent = pane.scrollTop + (targetRect.top - paneRect.top);
  const leadSpace = Math.max(56, Math.min(140, Math.round(pane.clientHeight * 0.22)));
  return Math.max(0, Math.round(offsetInContent - leadSpace));
}

function isFullyInView(pane, el) {
  const p = pane.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.top >= p.top + 40 && r.bottom <= p.bottom - 8;
}

// Only the previously active and the newly active row are touched: no re-render, no
// document-wide queries, and no forced re-measurement of every row.
// opts.flash (default true): brief outline pulse; opts.keepIfVisible: no scroll when in view.
function selectAndScrollToRow(rowId, smooth = true, scrollPanes = true, opts = {}) {
  const prevIds = new Set([lastActiveRowId, state.activeRowId]);
  state.activeRowId = rowId;
  lastActiveRowId = rowId;
  for (const id of prevIds) {
    for (const el of getRowDecoratedElements(id)) el.classList.remove('is-active', 'is-jump-flash');
  }

  updateStepper();
  if (!rowId) {
    placeReviewBar();
    updateListActiveCard(opts.itemId);
    return;
  }

  // The target may sit in a page that is still waiting to be rendered.
  if (!getRowElements(rowId).l) flushPaneRender();

  const els = getRowElements(rowId);
  // A collapsed header/footer group opens when one of its rows is selected.
  for (const el of [els.l, els.r, els.u]) {
    const group = el && el.closest('.hf-group.is-collapsed');
    if (group) toggleHfGroup(group.getAttribute('data-hf-group'), false);
  }
  const flash = opts.flash !== false && scrollPanes;
  for (const el of [els.l, els.r, els.u]) {
    if (!el) continue;
    el.classList.add('is-active');
    if (flash) el.classList.add('is-jump-flash');
  }
  placeReviewBar();
  updateListActiveCard(opts.itemId);
  const behavior = scrollBehavior(smooth);

  if (scrollPanes) {
    const targets =
      state.viewMode === 'inline'
        ? [[paneUnified, els.u]]
        : [
            [paneLeft, els.l],
            [paneRight, els.r],
          ];
    const needed = !opts.keepIfVisible || targets.some(([pane, el]) => el && !isFullyInView(pane, el));
    if (needed) {
      state.isProgrammaticScroll = true;
      clearTimeout(programmaticScrollTimer);
      for (const [pane, target] of targets) {
        if (target) pane.scrollTo({ top: getScrollTargetTop(pane, target), behavior });
      }
      programmaticScrollTimer = setTimeout(
        () => {
          state.isProgrammaticScroll = false;
          // Rows rendered for the first time during the scroll may have changed height above
          // the target (content-visibility); settle on the exact position.
          if (state.activeRowId === rowId) {
            for (const [pane, target] of targets) {
              if (!target || !target.isConnected) continue;
              const top = getScrollTargetTop(pane, target);
              const drift = Math.abs(pane.scrollTop - top);
              if (drift > 2 && drift < pane.clientHeight) pane.scrollTo({ top, behavior: 'auto' });
            }
          }
          scheduleRulerDraw();
        },
        behavior === 'smooth' ? 480 : 50
      );
    }
  }
  scheduleRulerDraw();
  const navTarget = sidebarList.querySelector('.nav-item.is-active');
  if (navTarget) navTarget.scrollIntoView({ block: 'nearest', behavior });
}

// Moves the "active" card in the list without re-rendering it (cards carry no actions).
function updateListActiveCard(itemId) {
  const item = itemId ? state.listItems.find(i => i.id === itemId) || getActiveItem() : getActiveItem();
  const focusInList = sidebarList.contains(document.activeElement);
  for (const el of sidebarList.querySelectorAll('.nav-item.is-active')) {
    if (item && el.getAttribute('data-item-id') === item.id) continue;
    el.classList.remove('is-active');
    const main = el.querySelector('.nav-item-main');
    if (main) main.removeAttribute('aria-current');
  }
  if (!item) return;
  const card = sidebarList.querySelector(`.nav-item[data-item-id="${item.id}"]`);
  if (!card) return;
  card.classList.add('is-active');
  const main = card.querySelector('.nav-item-main');
  main.setAttribute('aria-current', 'true');
  if (!focusInList) {
    for (const b of sidebarList.querySelectorAll('.nav-item-main')) b.tabIndex = b === main ? 0 : -1;
  }
}

// Edits, rejections and undo re-render the row (or the whole pane) and remove the control that
// had keyboard focus. A request made right before such an action puts focus back on the
// same row once it is rendered, instead of leaving it on <body>.
let pendingRowFocus = null;

function requestRowFocus(rowId, fromSidebar) {
  const items = Array.from(sidebarList.querySelectorAll('.nav-item[data-row-id]'));
  const sidebarIndex = items.findIndex(el => el.getAttribute('data-row-id') === rowId);
  pendingRowFocus = { rowId, fromSidebar: Boolean(fromSidebar), sidebarIndex };
}

// A request that was not consumed by a re-render (no-op, comparison still running in the
// worker) must not move focus later; the worker path consumes it when its result lands.
function applyPendingRowFocusIfIdle() {
  if (isShownComparisonCurrent()) applyPendingRowFocus();
}

function applyPendingRowFocus() {
  const req = pendingRowFocus;
  pendingRowFocus = null;
  if (!req || !document.body.classList.contains('is-comparing')) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && active.getClientRects().length) return;
  let target = null;
  if (req.fromSidebar) {
    target =
      sidebarList.querySelector(`.nav-item[data-row-id="${state.activeRowId}"] .nav-item-main`) ||
      sidebarList.querySelector(`.nav-item[data-row-id="${req.rowId}"] .nav-item-main`);
    if (!target && req.sidebarIndex >= 0) {
      const items = sidebarList.querySelectorAll('.nav-item[data-row-id] .nav-item-main');
      target = items[Math.min(req.sidebarIndex, items.length - 1)] || null;
    }
  }
  if (!target && reviewBar && reviewBar.isConnected) target = reviewBar.querySelector('button[tabindex="0"]');
  if (target) target.focus({ preventScroll: true });
  // Hidden controls (e.g. a closed list drawer) cannot take focus: use the pane.
  if (document.activeElement !== target) activeDocPane().focus({ preventScroll: true });
}

/* ── Undo / redo: snapshots of the new version's text and the review status ─ */

function updateUndoRedoButtons() {
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  if (btnUndo) btnUndo.disabled = state.undoStack.length === 0;
  if (btnRedo) btnRedo.disabled = state.redoStack.length === 0;
}

// Undo/redo history and review status belong to the currently loaded pair of documents. Call
// this whenever a document is replaced (upload, paste dialog, swap, sample, clear), so Undo can
// never bring back text from a different document under the new file name.
function resetEditHistory() {
  state.undoStack = [];
  state.redoStack = [];
  resetReviews();
  // A row id of the previous document would select an unrelated row in the new one.
  state.activeRowId = null;
  state.hoveredRowId = null;
  // A new pair of documents: the next comparison is announced like a first one.
  newDocumentsPending = true;
  updateUndoRedoButtons();
}
var newDocumentsPending = false; // `var`: set before the first comparison

function makeHistorySnapshot() {
  return { text: state.rightText, reviews: cloneReviews() };
}

// Returns true when the text of the new version changed (a re-comparison is needed).
function restoreHistorySnapshot(snap) {
  const text = typeof snap === 'string' ? snap : snap.text;
  const changed = text !== state.rightText;
  state.rightText = text;
  state.reviews = cloneReviews(typeof snap === 'string' ? {} : snap.reviews);
  return changed;
}

function pushUndoSnapshot() {
  state.undoStack.push(makeHistorySnapshot());
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack = [];
  updateUndoRedoButtons();
}

function performUndo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(makeHistorySnapshot());
  const changed = restoreHistorySnapshot(state.undoStack.pop());
  updateUndoRedoButtons();
  if (changed) runComparison();
  else refreshReviewState();
}

function performRedo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(makeHistorySnapshot());
  const changed = restoreHistorySnapshot(state.redoStack.pop());
  updateUndoRedoButtons();
  if (changed) runComparison();
  else refreshReviewState();
}

// True when the rows on screen (state.alignedRows) were computed from the current texts.
// While a long document is re-compared in the worker they are not: an edit or review built
// from those rows would silently drop the change that started the comparison.
function isShownComparisonCurrent() {
  const req = typeof lastComparison !== 'undefined' && lastComparison && lastComparison.request;
  return Boolean(
    req &&
      req.leftText === (state.leftText || '') &&
      req.rightText === (state.rightText || '') &&
      req.ignoreHeadersFooters === state.ignoreHeadersFooters
  );
}

// Exports and printing read state.alignedRows: bring them up to date first (synchronously).
function ensureComparisonCurrent() {
  if (!isShownComparisonCurrent()) runComparison({ sync: true });
}

// Rebuilds the revised document with the paragraph of one row replaced. Every other block
// of the revised document — including hidden header/footer lines and page breaks — is
// written back in its original order (state.rightAllBlocks), so an edit of one paragraph
// changes exactly that paragraph and nothing else in the comparison.
function rebuildRightTextFromRows(targetRowId, replacementText) {
  const allBlocks = state.rightAllBlocks || [];
  const rows = state.alignedRows;
  const targetIdx = rows.findIndex(r => r.id === targetRowId);
  const target = targetIdx >= 0 ? rows[targetIdx] : null;
  const hasExplicit = allBlocks.some(b => b.hasExplicitPage);

  // Typed text is sanitized so it can never carry page/header-footer metadata; the edited
  // block keeps its own structural metadata (indent, header/footer).
  const template = target ? target.rightBlock || target.leftBlock : null;
  const replacementLines = [];
  for (const line of sanitizeExternalText(replacementText || '').split(/\n+/)) {
    if (!line.trim()) continue;
    replacementLines.push(
      serializeBlockLine({
        text: line.trim(),
        kind: template ? template.kind : 'p',
        headingMarker: template ? template.headingMarker : '',
        indent: template ? template.indent : 0,
        isHeaderFooter: Boolean(target && target.rightBlock && target.rightBlock.isHeaderFooter),
      })
    );
  }

  // A row without a right block (a deletion) gets its text after the right block of the
  // nearest row above it that has one (or at the very start).
  let anchorBlock = null;
  let insertPage = target ? target.pageNum || 1 : 1;
  if (target && !target.rightBlock) {
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (rows[i].rightBlock) {
        anchorBlock = rows[i].rightBlock;
        break;
      }
    }
  }

  const out = [];
  let lastPage = null;
  const pageBreak = pageNum => {
    if (hasExplicit && pageNum !== lastPage) out.push(pageMarkerLine(pageNum));
    lastPage = pageNum;
  };
  let inserted = !target || Boolean(target.rightBlock);
  if (!inserted && !anchorBlock) {
    const firstPage = allBlocks.length ? allBlocks[0].pageNum || 1 : insertPage;
    pageBreak(Math.min(firstPage, insertPage));
    out.push(...replacementLines);
    inserted = true;
  }
  for (const b of allBlocks) {
    pageBreak(b.pageNum || 1);
    const isTarget = target && target.rightBlock && sameBlock(b, target.rightBlock);
    out.push(...(isTarget ? replacementLines : [serializeBlockLine(b)]));
    if (!inserted && sameBlock(b, anchorBlock)) {
      out.push(...replacementLines);
      inserted = true;
    }
  }
  if (!inserted) out.push(...replacementLines);
  return out.join('\n\n');
}

// The new version with several paragraphs replaced at once (rows that have a right block),
// e.g. the same header/footer line on every page.
function rebuildRightTextReplacingRows(replacements) {
  const allBlocks = state.rightAllBlocks || [];
  const hasExplicit = allBlocks.some(b => b.hasExplicitPage);
  const targets = [];
  for (const [rowId, text] of replacements) {
    const row = state.alignedRows.find(r => r.id === rowId);
    if (!row || !row.rightBlock) continue;
    const lines = [];
    for (const line of sanitizeExternalText(text || '').split(/\n+/)) {
      if (!line.trim()) continue;
      lines.push(
        serializeBlockLine({
          text: line.trim(),
          kind: row.rightBlock.kind,
          headingMarker: row.rightBlock.headingMarker,
          indent: row.rightBlock.indent,
          isHeaderFooter: Boolean(row.rightBlock.isHeaderFooter),
        })
      );
    }
    targets.push({ block: row.rightBlock, lines });
  }
  const out = [];
  let lastPage = null;
  for (const b of allBlocks) {
    const pageNum = b.pageNum || 1;
    if (hasExplicit && pageNum !== lastPage) out.push(pageMarkerLine(pageNum));
    lastPage = pageNum;
    const hit = targets.find(x => sameBlock(b, x.block));
    out.push(...(hit ? hit.lines : [serializeBlockLine(b)]));
  }
  return out.join('\n\n');
}

// Row blocks are the very objects in state.rightAllBlocks (also after the worker's structured
// clone); the position check is a fallback.
function sameBlock(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.text === b.text && a.pageNum === b.pageNum && a.index === b.index && a.isHeaderFooter === b.isHeaderFooter;
}

// "Ablehnen" for one row: restores the old wording of the paragraph (see rejectItem()).
function revertRowToOriginal(targetRowId) {
  if (!state.alignedRows.length) return;
  const targetRow = state.alignedRows.find(r => r.id === targetRowId);
  if (!targetRow || !isShownComparisonCurrent()) return;
  const item = state.listItems.find(i => itemHasRow(i, targetRowId) && !i.ghost);
  if (item) rejectItem(item, { stay: true });
}

function startInlineClauseEdit(clauseEl, rowId) {
  if (!clauseEl || clauseEl.classList.contains('is-editing')) return;
  // Not while the shown rows are being re-compared (the sheet is dimmed meanwhile).
  if (!isShownComparisonCurrent()) return;
  const row = state.alignedRows.find(r => r.id === rowId);
  if (!row) return;
  const rightTextAtOpen = state.rightText;

  hideTooltip();
  if (state.activeRowId !== rowId) selectAndScrollToRow(rowId, false, false);
  // Where keyboard focus returns once the edit is saved or cancelled with the keyboard.
  const opener = document.activeElement;
  const openerInSidebar = Boolean(opener && opener.closest && opener.closest('#sidebar-list'));
  if (reviewBar && reviewBar.parentElement === clauseEl) reviewBar.remove();

  const initialText = row.rightBlock ? row.rightBlock.text : row.leftBlock ? row.leftBlock.text : '';
  const originalHtml = clauseEl.innerHTML;

  clauseEl.classList.add('is-editing');
  const editor = document.createElement('textarea');
  editor.className = 'clause-inline-editor';
  editor.value = initialText;
  editor.setAttribute('aria-label', `${t('editBtn')}: ${getDisplayRef(row) || t('colRight')}`);

  const helperBar = document.createElement('div');
  helperBar.className = 'clause-editor-bar';
  helperBar.innerHTML = `
    <span>${escapeHtml(t('editorHintText'))}</span>
    <div class="clause-editor-btns">
      <button type="button" class="btn clause-editor-btn cancel" data-editor-cancel>${escapeHtml(t('editorCancel'))}</button>
      <button type="button" class="btn btn-primary clause-editor-btn save" data-editor-save>${escapeHtml(t('editorSave'))}</button>
    </div>
  `;

  clauseEl.innerHTML = '';
  clauseEl.appendChild(editor);
  clauseEl.appendChild(helperBar);

  // Row heights follow the editor automatically (ResizeObserver in 06b-row-layout.js).
  const autoSize = () => {
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(32, editor.scrollHeight)}px`;
  };
  autoSize();
  editor.addEventListener('input', autoSize);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);

  let finished = false;
  // Saving or cancelling from the keyboard (Enter, Esc, the editor buttons) keeps focus on
  // this row; a commit by blur leaves focus wherever the user moved it.
  const restoreFocus = () => {
    if (opener && opener !== document.body && opener.isConnected && opener !== editor && opener.getClientRects().length) {
      opener.focus({ preventScroll: true });
    } else {
      requestRowFocus(rowId, openerInSidebar);
      applyPendingRowFocus();
    }
  };
  const closeUnchanged = keepFocus => {
    clauseEl.classList.remove('is-editing');
    clauseEl.innerHTML = originalHtml;
    resetEqualizedRowHeights(rowId);
    placeReviewBar();
    if (keepFocus) restoreFocus();
  };
  const commit = keepFocus => {
    if (finished) return;
    finished = true;
    const newText = editor.value.replace(/\r\n/g, '\n').trim();
    const oldText = row.rightBlock ? row.rightBlock.text : '';
    // The document was replaced or re-compared while the editor was open (e.g. a file
    // dropped meanwhile): this row may no longer exist, so the edit cannot be applied.
    const stale = state.rightText !== rightTextAtOpen || !isShownComparisonCurrent();
    if (newText === oldText || stale) {
      closeUnchanged(keepFocus && !stale);
      return;
    }
    // Editing a reviewed paragraph makes it an open change again: say so.
    const wasReviewed = row.reviewStatus === 'accepted' || Boolean(row.ghostNote);
    pushUndoSnapshot();
    state.rightText = rebuildRightTextFromRows(rowId, newText);
    if (keepFocus) requestRowFocus(rowId, openerInSidebar);
    runComparison();
    showUndoToast(wasReviewed ? 'toastEditedReopened' : 'toastEdited');
  };

  const cancel = () => {
    if (finished) return;
    finished = true;
    closeUnchanged(true);
  };

  helperBar.querySelector('[data-editor-cancel]').addEventListener('mousedown', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  });
  helperBar.querySelector('[data-editor-save]').addEventListener('mousedown', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    commit(true);
  });
  // Keyboard activation of the editor buttons (mousedown does not fire).
  helperBar.addEventListener('click', ev => {
    if (ev.target.closest('[data-editor-cancel]')) cancel();
    else if (ev.target.closest('[data-editor-save]')) commit(true);
  });

  editor.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
    } else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey || !ev.shiftKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      commit(true);
    }
  });
  editor.addEventListener('blur', ev => {
    // Moving to the editor's own buttons is not leaving the editor.
    if (ev.relatedTarget && helperBar.contains(ev.relatedTarget)) return;
    commit(false);
  });
}

function toggleHfGroup(id, collapse) {
  document.querySelectorAll(`.hf-group[data-hf-group="${id}"]`).forEach(g => {
    const now = collapse === undefined ? !g.classList.contains('is-collapsed') : collapse;
    g.classList.toggle('is-collapsed', now);
    const btn = g.querySelector('.hf-toggle');
    if (btn) btn.setAttribute('aria-expanded', String(!now));
  });
  scheduleRulerDraw();
}

/* ── Pointer and keyboard in the panes and the list ─────────────────────── */

[sheetLeft, sheetRight, sheetUnified, sidebarList].forEach(container => {
  // Hover highlight only for a real mouse (never sticky after a tap).
  container.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const target = e.target.closest('[data-row-id]');
    if (target) setHoveredRow(target.getAttribute('data-row-id'));
  });
  container.addEventListener('pointerleave', () => setHoveredRow(null));
  container.addEventListener('click', e => {
    const actionBtn = e.target.closest('[data-review-action]');
    if (actionBtn) {
      e.stopPropagation();
      // "Rückgängig" in the status line of a reviewed paragraph: make that change current first.
      const statusLine = actionBtn.closest('[data-status-row]');
      if (statusLine) {
        const rowId = statusLine.getAttribute('data-status-row');
        const row = state.alignedRows.find(r => r.id === rowId);
        const wantGhost = Boolean(row && row.ghostNote && row.reviewStatus !== 'accepted');
        const item = state.listItems.find(it => itemHasRow(it, rowId) && it.status !== 'open' && Boolean(it.ghost) === wantGhost);
        if (!item) return;
        selectAndScrollToRow(rowId, false, false, { itemId: item.id, flash: false });
        requestRowFocus(rowId, false);
        if (reopenItem(item)) requestRowFocus(state.activeRowId, false);
        applyPendingRowFocusIfIdle();
        return;
      }
      runReviewAction(actionBtn.getAttribute('data-review-action'), false);
      return;
    }
    const hfToggle = e.target.closest('[data-hf-toggle]');
    if (hfToggle) {
      toggleHfGroup(hfToggle.getAttribute('data-hf-toggle'));
      return;
    }
    if (e.target.closest('.clause-inline-editor') || e.target.closest('.clause-editor-bar')) return;
    // Selecting text must not jump around.
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && container !== sidebarList) return;
    const target = e.target.closest('[data-row-id]');
    if (!target) return;
    const fromSidebar = container === sidebarList;
    selectAndScrollToRow(target.getAttribute('data-row-id'), true, fromSidebar, { itemId: target.getAttribute('data-item-id') });
    if (fromSidebar) {
      announceActiveChange();
      if (isTabletOrSmaller()) closeListSheet(false);
    }
  });
});

// The list: one tab stop; arrow keys move between the cards (selection follows focus).
sidebarList.addEventListener('keydown', e => {
  const main = e.target.closest('.nav-item-main');
  if (!main) return;
  const all = Array.from(sidebarList.querySelectorAll('.nav-item-main'));
  const i = all.indexOf(main);
  let next = null;
  if (e.key === 'ArrowDown') next = all[Math.min(all.length - 1, i + 1)];
  else if (e.key === 'ArrowUp') next = all[Math.max(0, i - 1)];
  else if (e.key === 'Home') next = all[0];
  else if (e.key === 'End') next = all[all.length - 1];
  if (!next) return;
  e.preventDefault();
  for (const b of all) b.tabIndex = b === next ? 0 : -1;
  next.focus();
  const card = next.closest('.nav-item');
  selectAndScrollToRow(card.getAttribute('data-row-id'), true, true, { itemId: card.getAttribute('data-item-id'), flash: false });
  next.focus({ preventScroll: true });
});

// Tab into the list lands on the active card.
sidebarList.addEventListener('focusin', e => {
  if (!e.target.classList.contains('nav-item-main')) return;
  for (const b of sidebarList.querySelectorAll('.nav-item-main')) b.tabIndex = b === e.target ? 0 : -1;
});

// The list filter: a review status ("Offen", "Geprüft") or a kind of change, never both.
function setListFilter(value) {
  const isStatus = value === 'open' || value === 'reviewed';
  state.statusFilter = isStatus ? value : 'all';
  state.sidebarFilter = isStatus ? 'all' : value;
  applyListFilters();
}
function applyListFilters() {
  renderSidebarList(state.alignedRows.length > 0);
  // The stepper follows the filter: a current change outside it gives way to the first one in it.
  const visible = getFilteredListItems();
  const active = getActiveItem();
  if (visible.length && (!active || !visible.includes(active))) {
    selectAndScrollToRow(visible[0].rowId, true, true, { itemId: visible[0].id, flash: false });
  }
  updateStepper();
}
document.getElementById('list-filter').addEventListener('change', e => setListFilter(e.target.value));

// Editing the new version: double-click a paragraph.
[sheetRight, sheetUnified].forEach(editableSheet => {
  editableSheet.addEventListener('dblclick', e => {
    if (
      e.target.closest('[data-review-action]') ||
      e.target.closest('.review-bar') ||
      e.target.closest('.clause-inline-editor') ||
      e.target.closest('.clause-editor-bar') ||
      e.target.closest('.hf-toggle')
    ) {
      return;
    }
    const clauseEl = e.target.closest('.clause[data-row-id]');
    if (clauseEl) startInlineClauseEdit(clauseEl, clauseEl.getAttribute('data-row-id'));
  });
});

function handlePaneScroll(sourcePane, targetPane) {
  if (Math.abs(targetPane.scrollTop - sourcePane.scrollTop) > 0.5) {
    targetPane.scrollTop = sourcePane.scrollTop;
  }
  scheduleRulerWindow();
}

paneLeft.addEventListener('scroll', () => handlePaneScroll(paneLeft, paneRight), { passive: true });
paneRight.addEventListener('scroll', () => handlePaneScroll(paneRight, paneLeft), { passive: true });
paneUnified.addEventListener('scroll', scheduleRulerWindow, { passive: true });

let resizeTimer = null;
let lastTier = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    updateFileLabels();
    applyLayoutTier();
    scheduleRulerDraw();
  }, 60);
});

/* ── Direct swap in the top bar ─────────────────────────────────────────────
 * A second entry point to the swap in the documents popover. It only forwards the click, so the
 * swap itself (and the guard in front of it that protects unsaved review work) stays in one place.
 * The aria-label comes from data-i18n-label; the visual tooltip reads the same text on demand,
 * so it follows the language without a separate update step. */
const btnSwapQuick = document.getElementById('btn-swap-quick');
if (btnSwapQuick) {
  const syncSwapTooltip = () => btnSwapQuick.setAttribute('data-tooltip', t('swapBtn'));
  syncSwapTooltip();
  // Runs on the button itself, before the document-level tooltip handlers read the attribute.
  btnSwapQuick.addEventListener('pointerover', syncSwapTooltip);
  btnSwapQuick.addEventListener('focusin', syncSwapTooltip);
  btnSwapQuick.addEventListener('click', () => {
    hideTooltip();
    document.getElementById('btn-swap-docs').click();
  });
}
