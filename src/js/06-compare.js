// Applies a comparison result (from the worker, the sync fallback or the incremental fast path)
// to the state and the DOM. `opts.changedRowIds` marks an incremental update of a few rows.
// runComparison() itself lives in 06a-compare-async.js.
function applyComparisonResult(request, result, opts = {}) {
  lastComparison = { request, result };
  state.rightAllBlocks = result.allRightBlocks;
  state.filteredHfCount = result.filteredHfCount;

  const { leftBlocks, rightBlocks, leftPages, rightPages } = result;

  // Captions: the same shortening rule as the top bar, with more room.
  const capLeft = state.leftName || t('noFileLeft');
  const capRight = state.rightName || t('noFileRight');
  document.getElementById('filename-left').textContent = truncateFileName(capLeft, capRight, 44);
  document.getElementById('filename-right').textContent = truncateFileName(capRight, capLeft, 44);
  updateFileLabels();

  const bothLoaded = leftBlocks.length > 0 && rightBlocks.length > 0;
  const wasComparing = document.body.classList.contains('is-comparing');
  const emptyLaunchpad = document.getElementById('empty-launchpad');
  // Focus sat on something that is about to disappear (landing page or comparison chrome)?
  const active = document.activeElement;
  // (A control in a dialog that just closed, or in a closed menu, counts as lost focus too.)
  const focusWasLost = !active || active === document.body || !active.getClientRects().length;
  const focusInLanding = Boolean(emptyLaunchpad && active && emptyLaunchpad.contains(active));
  const focusInCompareChrome = Boolean(active && active.closest && active.closest('.compare-only'));
  // Focus inside a document pane or the change list is lost when they are re-rendered.
  const focusInDocument = Boolean(
    active && active.closest && active.closest('#sheet-left, #sheet-right, #sheet-unified, #sidebar-list')
  );

  document.body.classList.toggle('has-docs', leftBlocks.length > 0 || rightBlocks.length > 0);
  document.body.classList.toggle('is-comparing', bothLoaded);

  if (!bothLoaded) {
    pendingRowFocus = null;
    pendingSelectAfterReject = null;
    state.activeRowId = null;
    state.hoveredRowId = null;
    cancelPaneRender();
    resetRowLayoutRegistry();
    state.alignedRows = [];
    state.changeRows = [];
    state.listItems = [];
    removeReviewBar();
    updateStepper();
    updateUndoRedoButtons();
    closeSearch(false);

    // Panes stay hidden until both versions exist; the landing slots show what is loaded.
    setSafeContainerHtml(sheetLeft, '');
    setSafeContainerHtml(sheetRight, '');
    setSafeContainerHtml(sheetUnified, '');
    updateLandingSlots(
      { blocks: leftBlocks.length, pages: leftPages },
      { blocks: rightBlocks.length, pages: rightPages }
    );

    bindEmptyStateButtons();
    renderSidebarList(false);
    clearRuler();

    if (wasComparing && (focusWasLost || focusInCompareChrome || focusInDocument)) {
      const heading = document.getElementById('landing-title');
      if (emptyLaunchpad) emptyLaunchpad.scrollTop = 0;
      if (heading) heading.focus({ preventScroll: true });
    }
    return;
  }

  state.alignedRows = result.alignedRows;
  state.changeRows = state.alignedRows.filter(r => r.type !== 'equal');
  rebuildReviewIndex();
  // The selected / hovered row may be gone after an edit that removed paragraphs.
  if (state.activeRowId && !state.alignedRows.some(r => r.id === state.activeRowId)) state.activeRowId = null;
  if (state.hoveredRowId && !state.alignedRows.some(r => r.id === state.hoveredRowId)) state.hoveredRowId = null;
  // After "Ablehnen": on to the next open change, or the rejected one when none is left.
  const scrollAfterReject = pendingSelectAfterReject !== null && consumePendingReject();
  // Change 1 is selected as soon as a comparison is shown.
  const preselect = !state.activeRowId && state.listItems.length > 0;
  if (preselect) state.activeRowId = state.listItems[0].rowId;

  const compareHeading = document.getElementById('compare-heading');
  if (compareHeading) {
    compareHeading.textContent = formatMsg('compareHeading', {
      left: state.leftName || t('colLeft'),
      right: state.rightName || t('colRight'),
    });
  }

  applyPageBreaks();
  updateHfMenuItem();

  // Edits, rejections, undo and redo usually change a single row: patch it in place instead of
  // re-rendering all three panes. Clauses of the active row get `is-active` while rendering.
  if (!(opts.changedRowIds && patchRenderedRows(opts.changedRowIds))) {
    renderDocumentPanes();
  }
  renderSidebarList(true);
  updateStepper();
  updateUndoRedoButtons();
  placeReviewBar();
  if (state.searchQuery) scheduleSearchRecount();

  scheduleRulerDraw();
  if (scrollAfterReject) {
    const id = state.activeRowId;
    requestAnimationFrame(() => {
      if (state.activeRowId === id) selectAndScrollToRow(id, true, true, { flash: false, keepIfVisible: true });
    });
  }
  if (preselect || !wasComparing) {
    const id = state.activeRowId;
    if (id) requestAnimationFrame(() => {
      if (state.activeRowId === id) selectAndScrollToRow(id, false, !wasComparing || preselect, { flash: false, keepIfVisible: wasComparing });
    });
  }
  applyPendingRowFocus();
  const focusNow = document.activeElement;
  if (focusInDocument && wasComparing && (!focusNow || focusNow === document.body || !focusNow.isConnected)) {
    activeDocPane().focus({ preventScroll: true });
  }

  const freshDocuments = !wasComparing || newDocumentsPending;
  newDocumentsPending = false;
  if (wasComparing && freshDocuments) {
    // A file was replaced from the file menu: focus must not stay on <body>.
    const now = document.activeElement;
    if (!now || now === document.body || !now.getClientRects().length) {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!a || a === document.body || !a.getClientRects().length) activeDocPane().focus({ preventScroll: true });
      });
    }
  }
  if (freshDocuments) {
    const total = state.listItems.length;
    announce(
      total === 0
        ? t('announceIdentical')
        : total === 1
        ? t('announceComparedOne')
        : formatMsg('announceCompared', { n: total })
    );
    // The landing page (and whatever had focus in it) just disappeared: hand focus to the
    // document so keyboard users continue with Tab or J / K from a sensible place.
    if (!wasComparing && (focusWasLost || focusInLanding)) {
      requestAnimationFrame(() => activeDocPane().focus({ preventScroll: true }));
    }
  }
}

function activeDocPane() {
  return state.viewMode === 'inline' ? paneUnified : paneRight;
}

// Counts per change type over the whole list (rejected changes keep their type).
function getChangeCounts() {
  const counts = { mod: 0, ins: 0, del: 0 };
  for (const item of state.listItems) {
    if (item.type === 'modified') counts.mod++;
    else if (item.type === 'inserted') counts.ins++;
    else if (item.type === 'deleted') counts.del++;
  }
  return counts;
}

function updateHfMenuItem() {
  setMenuChecked('btn-filter-hf', state.ignoreHeadersFooters);
  const badge = document.getElementById('hf-count-badge');
  if (badge) {
    badge.textContent =
      state.ignoreHeadersFooters && state.filteredHfCount > 0 ? formatMsg('hfHiddenCount', { n: state.filteredHfCount }) : '';
  }
}

function loadSampleComparison() {
  const sample = SAMPLES[state.lang] || SAMPLES.de;
  state.leftName = t('sampleLeftName');
  state.leftFormat = 'DEMO';
  state.leftText = sample.v1;
  state.rightName = t('sampleRightName');
  state.rightFormat = 'DEMO';
  state.rightText = sample.v2;
  state.docSources = { left: null, right: null };
  resetEditHistory();
  runComparison();
}

function clearLandingSide(side) {
  cancelPendingUploads(side);
  if (side === 'left') {
    state.leftText = '';
    state.leftName = '';
    state.leftFormat = '';
    state.docSources.left = null;
    document.getElementById('file-input-left').value = '';
  } else {
    state.rightText = '';
    state.rightName = '';
    state.rightFormat = '';
    state.docSources.right = null;
    resetEditHistory();
    document.getElementById('file-input-right').value = '';
  }
  runComparison();
  const btn = document.getElementById(`btn-empty-upload-${side}`);
  if (btn) btn.focus();
}

let landingBound = false;
function bindEmptyStateButtons() {
  if (landingBound) return;
  landingBound = true;

  const slotLeft = document.getElementById('lp-slot-left');
  const slotRight = document.getElementById('lp-slot-right');
  [
    { el: slotLeft, side: 'left', inputId: 'file-input-left' },
    { el: slotRight, side: 'right', inputId: 'file-input-right' },
  ].forEach(({ el, side, inputId }) => {
    if (!el) return;
    document
      .getElementById(`btn-empty-upload-${side}`)
      .addEventListener('click', () => document.getElementById(inputId).click());
    const clearBtn = document.getElementById(`lp-clear-${side}`);
    if (clearBtn) clearBtn.addEventListener('click', () => clearLandingSide(side));
    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });
    el.addEventListener('drop', async e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
      dragCounter = 0;
      document.body.classList.remove('is-dragging-file');
      await handleDropFiles(e.dataTransfer.files, side);
    });
  });

  const lpOverlay = document.getElementById('empty-launchpad');
  if (lpOverlay && !lpOverlay.dataset.dropBound) {
    lpOverlay.dataset.dropBound = '1';
    lpOverlay.addEventListener('dragover', e => e.preventDefault());
    lpOverlay.addEventListener('drop', async e => {
      e.preventDefault();
      dragCounter = 0;
      document.body.classList.remove('is-dragging-file');
      const defaultSide = state.leftText && !state.rightText ? 'right' : 'left';
      await handleDropFiles(e.dataTransfer.files, defaultSide);
    });
  }

  document.querySelectorAll('.btn-open-paste').forEach(btn => {
    btn.addEventListener('click', () => openPasteModal());
  });

  document.querySelectorAll('.btn-open-privacy').forEach(btn => {
    btn.addEventListener('click', () => document.getElementById('privacy-modal').showModal());
  });

  document.querySelectorAll('.btn-load-sample').forEach(btn => {
    btn.addEventListener('click', loadSampleComparison);
  });

  // Start page: from the first screen on to the next section below the fold.
  const more = document.getElementById('landing-more');
  if (more) {
    more.addEventListener('click', () => {
      const next = document.getElementById('landing-local') || document.getElementById('landing-scope');
      const pad = document.getElementById('empty-launchpad');
      const heading = next.querySelector('h2');
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
      const top = next.getBoundingClientRect().top - pad.getBoundingClientRect().top + pad.scrollTop - 16;
      pad.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
  }
}

// Moved blocks keep type 'deleted' (old position) / 'inserted' (new position); this note
// labels them so they are not read as a removal plus an unrelated addition.
function renderMovedNoteHtml(row) {
  if (!row.moved) return '';
  const label = row.type === 'deleted' ? t('movedFromHere') : t('movedToHere');
  return `<span class="moved-note">${escapeHtml(label)}</span>`;
}

function renderPageCardHeaderHtml(pageNum, totalPages) {
  return `<header class="doc-page-header"><span class="page-num-label">${escapeHtml(t('pageLabel'))} ${pageNum} ${escapeHtml(t('pageOf'))} ${totalPages}</span></header>`;
}

function getRowStateClass(row, side) {
  if (row.type === 'equal') return 'state-equal';
  if (row.type === 'modified') return 'state-modified';
  if (side === 'left') return 'state-deleted';
  if (side === 'right') return 'state-inserted';
  return row.type === 'inserted' ? 'state-inserted' : 'state-deleted';
}

function isHeaderFooterRow(row) {
  const b = row.rightBlock || row.leftBlock;
  return Boolean(b && (b.isHeaderFooter || b.kind === 'hf'));
}

// HTML of one aligned row in the three panes (left, right, unified). Kept free of
// indentation whitespace: every whitespace text node is a DOM node to parse and lay out.
function renderRowAnchorsHtml(row, idx, q) {
  const deferClass = idx > 18 ? ' deferred-block' : '';
  const activeClass = row.id === state.activeRowId ? ' is-active' : '';
  const reviewClass = row.reviewStatus === 'accepted' ? ' is-accepted' : '';
  const extra = deferClass + activeClass + reviewClass;
  const movedClass = row.moved ? ' is-moved' : '';
  const movedNote = renderMovedNoteHtml(row);
  const ghostClass = row.ghostNote ? ' has-ghost' : '';
  // "✓ Angenommen · Rückgängig" / "✗ Abgelehnt … · Rückgängig" on top of a reviewed paragraph.
  const ghostNote = reviewStatusHtml(row);
  const anchorOpen = `<div class="diff-row-anchor${ghostClass}" data-row-id="${row.id}" data-type="${row.type}">`;

  const left = row.leftBlock
    ? `${anchorOpen}<div class="clause ${getRowStateClass(row, 'left')} ${getClauseTypeClasses(row.leftBlock)}${movedClass}${extra}" data-row-id="${row.id}">${movedNote}${renderLeftBlockHtml(row, q)}</div></div>`
    : `${anchorOpen}<div class="clause state-placeholder${extra}" data-row-id="${row.id}"></div></div>`;

  const right = row.rightBlock
    ? `${anchorOpen}<div class="clause ${getRowStateClass(row, 'right')} ${getClauseTypeClasses(row.rightBlock)}${movedClass}${extra}" data-row-id="${row.id}">${ghostNote}${movedNote}${renderRightBlockHtml(row, q)}</div></div>`
    : `${anchorOpen}<div class="clause state-placeholder${extra}" data-row-id="${row.id}">${ghostNote}</div></div>`;

  const primaryBlock = row.rightBlock || row.leftBlock;
  const unified = `${anchorOpen}<div class="clause ${getRowStateClass(row, 'unified')} ${getClauseTypeClasses(primaryBlock)}${movedClass}${extra}" data-row-id="${row.id}">${ghostNote}${movedNote}${renderUnifiedBlockHtml(row, q, true)}</div></div>`;

  return { left, right, unified };
}

// Pane rendering is chunked: the first pages are rendered synchronously, the rest in short
// background tasks so that no single task blocks the main thread for long (an 80-page contract
// produces ~50k DOM nodes). flushPaneRender() completes a pending render on demand.
let paneRenderJob = null;
const PANE_RENDER_FIRST_PAGES = 6;
const PANE_RENDER_CHUNK_MS = 14;

function renderDocumentPanes() {
  cancelPaneRender();
  cancelSearchHighlightJob();
  resetRowLayoutRegistry();
  const panes = [paneLeft, paneRight, paneUnified];
  const prevScroll = panes.map(p => p.scrollTop);

  const pageGroups = new Map();
  state.alignedRows.forEach((row, idx) => {
    const p = row.pageNum || 1;
    if (!pageGroups.has(p)) pageGroups.set(p, []);
    pageGroups.get(p).push({ row, idx });
  });

  setSafeContainerHtml(sheetLeft, '');
  setSafeContainerHtml(sheetRight, '');
  setSafeContainerHtml(sheetUnified, '');

  const job = {
    pages: Array.from(pageGroups.entries()),
    totalPages: pageGroups.size || 1,
    next: 0,
    timer: null,
  };
  paneRenderJob = job;
  renderPaneChunk(job, PANE_RENDER_FIRST_PAGES, 0);

  // Re-render of a document the user had scrolled into (header/footer toggle, undo of a large
  // change): render up to the previous position right away so the view does not jump.
  const activePane = activeDocPane();
  const target = prevScroll[panes.indexOf(activePane)];
  if (target > 0) {
    while (paneRenderJob === job && activePane.scrollHeight < target + 2 * activePane.clientHeight) {
      renderPaneChunk(job, 1, PANE_RENDER_CHUNK_MS);
    }
    panes.forEach((p, i) => {
      if (prevScroll[i]) p.scrollTop = prevScroll[i];
    });
  }
  schedulePaneRenderChunk(job);
}

// Consecutive header/footer lines of a page form one muted, collapsible group (in all three
// panes alike, so the rows stay aligned).
function wrapHeaderFooterGroups(entries, pageNum, rowsHtml) {
  const out = [];
  let i = 0;
  let groupNo = 0;
  while (i < entries.length) {
    if (!isHeaderFooterRow(entries[i].row)) {
      out.push(rowsHtml[i]);
      i++;
      continue;
    }
    const start = i;
    while (i < entries.length && isHeaderFooterRow(entries[i].row)) i++;
    const id = `hf-${pageNum}-${groupNo++}`;
    out.push(
      `<div class="hf-group" data-hf-group="${id}"><button type="button" class="hf-toggle" tabindex="-1" aria-expanded="true" data-hf-toggle="${id}">${escapeHtml(t('hfGroup'))}</button>${rowsHtml.slice(start, i).join('')}</div>`
    );
  }
  return out.join('');
}

function renderPageCardsHtml(pageNum, entries, totalPages, q) {
  const pageHeaderHtml = renderPageCardHeaderHtml(pageNum, totalPages);
  const leftRows = [];
  const rightRows = [];
  const unifiedRows = [];
  for (const { row, idx } of entries) {
    const html = renderRowAnchorsHtml(row, idx, q);
    leftRows.push(html.left);
    rightRows.push(html.right);
    unifiedRows.push(html.unified);
  }
  const card = rowsHtml =>
    `<section class="doc-page-card" data-page="${pageNum}">${pageHeaderHtml}<div class="doc-page-body">${wrapHeaderFooterGroups(entries, pageNum, rowsHtml)}</div></section>`;
  return { left: card(leftRows), right: card(rightRows), unified: card(unifiedRows) };
}

function renderPaneChunk(job, minPages, budgetMs) {
  if (job !== paneRenderJob || job.next >= job.pages.length) return;
  const t0 = performance.now();
  const q = state.searchQuery;
  const left = [];
  const right = [];
  const unified = [];
  let count = 0;
  while (
    job.next < job.pages.length &&
    (count < minPages || performance.now() - t0 < budgetMs)
  ) {
    const [pageNum, entries] = job.pages[job.next++];
    const html = renderPageCardsHtml(pageNum, entries, job.totalPages, q);
    left.push(html.left);
    right.push(html.right);
    unified.push(html.unified);
    count++;
  }
  const firstNewCard = sheetLeft.children.length;
  sheetLeft.insertAdjacentHTML('beforeend', left.join(''));
  sheetRight.insertAdjacentHTML('beforeend', right.join(''));
  sheetUnified.insertAdjacentHTML('beforeend', unified.join(''));
  registerRenderedCards(firstNewCard);
  if (job.next >= job.pages.length) paneRenderJob = null;
}

function schedulePaneRenderChunk(job) {
  if (job !== paneRenderJob) return;
  job.timer = setTimeout(() => {
    job.timer = null;
    renderPaneChunk(job, 1, PANE_RENDER_CHUNK_MS);
    if (paneRenderJob === job) schedulePaneRenderChunk(job);
    else {
      scheduleRulerDraw();
      if (state.searchQuery) scheduleSearchRecount();
    }
  }, 0);
}

function flushPaneRender() {
  const job = paneRenderJob;
  if (!job) return;
  clearTimeout(job.timer);
  renderPaneChunk(job, Infinity, Infinity);
}

function cancelPaneRender() {
  if (paneRenderJob) clearTimeout(paneRenderJob.timer);
  paneRenderJob = null;
}

// Re-renders one row in all three panes (search highlights, edits). Returns false if the row
// is not in the DOM yet.
function rerenderRowInPlace(row) {
  const els = getRowElements(row.id);
  if (!els.l || !els.r || !els.u) return false;
  const html = renderRowAnchorsHtml(row, row.rowNumber - 1, state.searchQuery);
  const replaceAnchor = (clauseEl, anchorHtml) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = anchorHtml;
    const anchor = tpl.content.firstElementChild;
    clauseEl.parentElement.replaceWith(anchor);
    return anchor.firstElementChild;
  };
  const l = replaceAnchor(els.l, html.left);
  const r = replaceAnchor(els.r, html.right);
  const u = replaceAnchor(els.u, html.unified);
  registerRowElements(row.id, l, r, u);
  if (row.id === state.activeRowId) placeReviewBar();
  return true;
}

// Incremental update after an edit / rejection / undo (same row ids, a few rows changed).
// Returns false if the DOM does not hold the previous rendering, so a full render is needed.
function patchRenderedRows(changedRowIds) {
  flushPaneRender();
  const rows = changedRowIds.map(id => state.alignedRows.find(r => r.id === id));
  if (rows.some(row => !row || !getRowElements(row.id).l)) return false;
  // A header/footer row that joins or leaves a group needs the group markup: render fully.
  if (rows.some(row => isHeaderFooterRow(row) !== Boolean(getRowElements(row.id).l.closest('.hf-group')))) return false;
  for (const row of rows) {
    if (!rerenderRowInPlace(row)) return false;
  }
  // Ghost notes and review classes of other rows may have changed (undo of a rejection).
  for (const row of state.alignedRows) {
    const els = getRowElements(row.id);
    if (!els.r) continue;
    const anchor = els.r.parentElement;
    const hasGhost = anchor.classList.contains('has-ghost');
    if (hasGhost !== Boolean(row.ghostNote) && !changedRowIds.includes(row.id)) rerenderRowInPlace(row);
  }
  decorateReviewedRows();
  return true;
}

// Rows are kept height-aligned between the left and right panes by a ResizeObserver that also
// notices width changes (see 06b-row-layout.js), so there is nothing left to do here. Kept for
// existing callers (resize, list toggle, view mode switch).
function equalizeRowHeights() {}

function truncateClean(str, maxLen = 40) {
  const clean = str.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 16 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.]+$/, '') + '…';
}

function extractDeltaPairs(wordDiffs) {
  const pairs = [];
  let i = 0;
  const isChange = tok => Boolean(tok && (tok.removed || tok.added));
  const isBridgeSpace = idx =>
    idx > 0 &&
    idx + 1 < wordDiffs.length &&
    !isChange(wordDiffs[idx]) &&
    /^\s+$/.test(wordDiffs[idx].value) &&
    isChange(wordDiffs[idx - 1]) &&
    isChange(wordDiffs[idx + 1]);
  const isSingleWordBridge = idx =>
    idx > 0 &&
    idx + 1 < wordDiffs.length &&
    !isChange(wordDiffs[idx]) &&
    /^\s*\S{1,12}\s*$/.test(wordDiffs[idx].value) &&
    isChange(wordDiffs[idx - 1]) &&
    isChange(wordDiffs[idx + 1]) &&
    (wordDiffs[idx - 1].value.trim().includes(' ') || wordDiffs[idx + 1].value.trim().includes(' '));

  while (i < wordDiffs.length) {
    if (!isChange(wordDiffs[i])) {
      i++;
      continue;
    }
    const run = [];
    while (
      i < wordDiffs.length &&
      (isChange(wordDiffs[i]) || isBridgeSpace(i) || isSingleWordBridge(i))
    ) {
      run.push(wordDiffs[i]);
      i++;
    }
    const rawDel = run
      .filter(tok => !tok.added)
      .map(tok => tok.value)
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/^[,;\s]+|[,;\s]+$/g, '')
      .trim();
    const rawIns = run
      .filter(tok => !tok.removed)
      .map(tok => tok.value)
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/^[,;\s]+|[,;\s]+$/g, '')
      .trim();

    if (!rawDel && !rawIns) continue;
    pairs.push({ del: rawDel, ins: rawIns });
  }
  return pairs;
}

// "1 weitere Änderung" / "2 weitere Änderungen" (the number is written by the caller).
function moreDeltasText(n) {
  return n === 1 ? t('moreDeltasOne') : t('moreDeltas');
}

// Word diffs of a list item: the row's own, or (rejected change) recomputed from what was rejected.
const ghostDiffCache = new WeakMap();
function getItemWordDiffs(item) {
  if (!item.ghost) return item.row.wordDiffs || [];
  if (!ghostDiffCache.has(item.ghost)) {
    ghostDiffCache.set(item.ghost, computeCleanWordDiff(item.ghost.leftText || '', item.ghost.rightText || ''));
  }
  return ghostDiffCache.get(item.ghost);
}

function getItemTexts(item) {
  if (item.ghost) return { left: item.ghost.leftText || '', right: item.ghost.rightText || '' };
  return { left: item.row.leftBlock ? item.row.leftBlock.text : '', right: item.row.rightBlock ? item.row.rightBlock.text : '' };
}

// A card scans like an inbox line: the first change in its sentence (up to four grey words before
// and after, removed words struck through, added ones underlined), at most two lines. Further
// changes in the same paragraph are counted in the card head. A paragraph that is removed or
// added as a whole reads "entfernt: …" / "hinzugefügt: …".
function renderSidebarDeltaHtml(item) {
  const { left, right } = getItemTexts(item);
  if (item.type === 'deleted') {
    return { html: `<span class="nav-item-snippet"><span class="nav-ctx-label">${escapeHtml(t('cardRemoved'))}</span> <del class="tok-del">${escapeHtml(truncateClean(left, 140))}</del></span>`, more: 0 };
  }
  if (item.type === 'inserted') {
    return { html: `<span class="nav-item-snippet"><span class="nav-ctx-label">${escapeHtml(t('cardAdded'))}</span> <ins class="tok-ins">${escapeHtml(truncateClean(right, 140))}</ins></span>`, more: 0 };
  }
  const snippets = buildContextSnippets(getItemWordDiffs(item));
  if (snippets.length === 0) {
    return { html: `<span class="nav-item-snippet">${item.ghost ? escapeHtml(truncateClean(right, 140)) : renderUnifiedBlockHtml(item.row, '')}</span>`, more: 0 };
  }
  return { html: `<span class="nav-item-snippet">${snippets[0]}</span>`, more: snippets.length - 1 };
}

// The changed runs of a word diff (as in extractDeltaPairs; runs separated by at most two
// unchanged words are joined), each with up to four unchanged words of the new wording on
// either side.
function buildContextSnippets(wordDiffs, ctxWords = 4) {
  const isChange = tok => Boolean(tok && (tok.removed || tok.added));
  const wordCount = s => (s.trim() ? s.trim().split(/\s+/).length : 0);
  const runs = [];
  let i = 0;
  while (i < wordDiffs.length) {
    if (!isChange(wordDiffs[i])) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    let j = i + 1;
    while (j < wordDiffs.length) {
      if (isChange(wordDiffs[j])) {
        end = j;
        j++;
        continue;
      }
      // Unchanged text up to the next change: join when it is two words or fewer.
      let k = j;
      let gap = '';
      while (k < wordDiffs.length && !isChange(wordDiffs[k])) gap += wordDiffs[k++].value;
      if (k < wordDiffs.length && wordCount(gap) <= 2) {
        end = k;
        j = k + 1;
        continue;
      }
      break;
    }
    runs.push([start, end]);
    i = end + 1;
  }
  const clean = s => s.replace(/\s+/g, ' ');
  const newText = (from, to) => wordDiffs.slice(from, to).filter(tok => !tok.removed).map(tok => tok.value).join('');
  return runs.map(([start, end]) => {
    const run = wordDiffs.slice(start, end + 1);
    const del = clean(run.filter(tok => !tok.added).map(tok => tok.value).join('')).trim();
    const ins = clean(run.filter(tok => !tok.removed).map(tok => tok.value).join('')).trim();
    const beforeWords = clean(newText(0, start)).trimEnd().split(' ').filter(Boolean);
    const afterWords = clean(newText(end + 1, wordDiffs.length)).trimStart().split(' ').filter(Boolean);
    const before = beforeWords.length
      ? (beforeWords.length > ctxWords ? '…' : '') + beforeWords.slice(-ctxWords).join(' ') + ' '
      : '';
    const after = afterWords.length
      ? ' ' + afterWords.slice(0, ctxWords).join(' ') + (afterWords.length > ctxWords ? '…' : '')
      : '';
    const ctx = s => (s.trim() ? `<span class="nav-ctx">${escapeHtml(s)}</span>` : '');
    const parts = [];
    if (del) parts.push(`<del class="tok-del">${escapeHtml(truncateClean(del, 44))}</del>`);
    if (ins) parts.push(`<ins class="tok-ins">${escapeHtml(truncateClean(ins, 44))}</ins>`);
    return ctx(before) + parts.join(' ') + ctx(after);
  });
}

// "geändert" / "hinzugefügt" / "entfernt" / "Verschoben"
function getChangeTypeLabel(rowOrItem) {
  if (rowOrItem.moved || (rowOrItem.row && !rowOrItem.ghost && rowOrItem.row.moved)) return t('typeMoved');
  const type = rowOrItem.type;
  return type === 'modified' ? t('statMod') : type === 'inserted' ? t('statIns') : t('statDel');
}

function getStatusLabel(status) {
  return status === 'accepted' ? t('statusAccepted') : status === 'rejected' ? t('statusRejected') : t('statusOpen');
}

// Clause reference for display, without the bullet glyph used internally for list items.
function getDisplayRef(row) {
  const block = row.rightBlock || row.leftBlock;
  const ref = block && block.refCode ? String(block.refCode) : '';
  // Unnumbered paragraphs carry an internal "#n" reference: show "Absatz" instead.
  return ref.replace(/\s*[•‣▪◦]\s*$/, '').replace(/\s*#\d+$/, '').trim() || t('paragraphShort');
}

function getItemRef(item) {
  if (item.members) return formatMsg('hfMergedRef', { n: item.pages || item.members.length });
  if (item.ghost) return String(item.ghost.refCode || '').replace(/\s*#\d+$/, '').trim() || t('paragraphShort');
  return getDisplayRef(item.row);
}

function getItemPage(item) {
  return item.ghost ? item.ghost.pageNum || 1 : item.row.pageNum || 1;
}

// List items under the active list filter (search never filters the list).
function getFilteredListItems() {
  const f = state.sidebarFilter;
  const s = state.statusFilter;
  return state.listItems.filter(item => {
    if (s === 'open' && item.status !== 'open') return false;
    if (s === 'reviewed' && item.status === 'open') return false;
    return f === 'all' || item.type === f;
  });
}
// Kept for callers and QA scripts written against the earlier name.
const getFilteredChangeRows = getFilteredListItems;

function updateSidebarHeaderState() {
  const total = state.listItems.length;
  const counts = getChangeCounts();
  const review = getReviewCounts();
  const filtered = state.sidebarFilter !== 'all' || state.statusFilter !== 'all';
  document.getElementById('list-title').textContent = filtered
    ? formatMsg('listTitleFiltered', { k: getFilteredListItems().length, n: total })
    : changesTitle(total);
  document.getElementById('list-progress').textContent = total ? formatMsg('listProgress', { k: review.reviewed, n: total }) : '';
  document.getElementById('progress-fill').style.width = total ? `${(review.reviewed / total) * 100}%` : '0';
  const btnListCount = document.getElementById('btn-list-count');
  if (btnListCount) btnListCount.textContent = String(total);
  const btnList = document.getElementById('btn-list');
  if (btnList) btnList.setAttribute('aria-label', formatMsg('listBtnLabel', { n: total }));

  // One filter: "Alle", a review status or a kind of change, each with its count.
  const select = document.getElementById('list-filter');
  const value = state.statusFilter !== 'all' ? state.statusFilter : state.sidebarFilter;
  const options = [
    ['all', 'filterAll', total],
    ['open', 'filterOpen', review.open],
    ['reviewed', 'filterReviewed', review.reviewed],
    ['modified', 'filterMod', counts.mod],
    ['inserted', 'filterIns', counts.ins],
    ['deleted', 'filterDel', counts.del],
  ];
  for (const [v, key, n] of options) {
    const opt = select.querySelector(`option[value="${v}"]`);
    opt.textContent = `${t(key)} (${n})`;
    opt.disabled = n === 0 && v !== value;
  }
  document.getElementById('lf-group-status').label = t('filterGroupStatus');
  document.getElementById('lf-group-kind').label = t('filterGroupKind');
  if (select.value !== value) select.value = value;
  select.classList.toggle('is-filtered', value !== 'all');
}

function renderSidebarList(bothLoaded) {
  updateSidebarHeaderState();
  if (!bothLoaded) {
    setSafeContainerHtml(sidebarList, '');
    return;
  }

  const filtered = getFilteredListItems();
  if (filtered.length === 0) {
    const isFilter = state.sidebarFilter !== 'all' || state.statusFilter !== 'all';
    setSafeContainerHtml(
      sidebarList,
      `<div class="empty-state empty-state-sm" data-empty-state><p class="empty-title">${escapeHtml(
        isFilter ? t('noMatchesTitle') : t('identicalTitle')
      )}</p><div class="empty-desc">${escapeHtml(isFilter ? t('noMatchesDesc') : t('identicalDesc'))}</div></div>`
    );
    return;
  }

  const activeItem = getActiveItem();
  const activeVisible = activeItem && filtered.includes(activeItem);
  const focusId = activeVisible ? activeItem.id : filtered[0].id;
  setSafeContainerHtml(
    sidebarList,
    filtered
      .map(item => {
        const cls = (item.type === 'modified' ? 'mod' : item.type === 'inserted' ? 'ins' : 'del') + (item.row && item.row.moved && !item.ghost ? ' moved' : '');
        const isActive = activeItem === item;
        const ref = getItemRef(item);
        const page = getItemPage(item);
        const statusIcon =
          item.status === 'accepted'
            ? `<span class="nav-status is-accepted" aria-hidden="true">${ICON_CHECK}</span>`
            : item.status === 'rejected'
            ? `<span class="nav-status is-rejected" aria-hidden="true">${ICON_X}</span>`
            : '';
        const pages = item.members ? itemMembers(item).map(m => getItemPage(m)) : [page];
        const pageLabel = pages.length > 1 ? `${t('pageShort')} ${Math.min(...pages)}–${Math.max(...pages)}` : `${t('pageShort')} ${page}`;
        const head = item.members ? `${ref} · ${pageLabel}` : [ref, pageLabel].filter(Boolean).join(' · ');
        const delta = renderSidebarDeltaHtml(item);
        const moreHtml = delta.more > 0 ? `<span class="nav-more"><span aria-hidden="true">+${delta.more}</span><span class="sr-only">, ${delta.more} ${escapeHtml(moreDeltasText(delta.more))}</span></span>` : '';
        return `<div class="nav-item ${cls} is-${item.status}${isActive ? ' is-active' : ''}" data-row-id="${item.rowId}" data-item-id="${item.id}"><button type="button" class="nav-item-main" tabindex="${item.id === focusId ? 0 : -1}"${isActive ? ' aria-current="true"' : ''}><span class="nav-item-head"><span class="nav-item-ref">${escapeHtml(head)}</span>${moreHtml}${statusIcon}<span class="sr-only">, ${escapeHtml(getChangeTypeLabel(item))}, ${escapeHtml(getStatusLabel(item.status))}. </span></span>${delta.html}</button></div>`;
      })
      .join('')
  );
}
