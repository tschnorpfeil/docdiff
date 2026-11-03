/* ── Review workflow: accept / reject each change (Word terminology) ──────────────────────
 *
 * "Annehmen" (accept) keeps the new wording and marks the change as reviewed. "Ablehnen"
 * (reject) restores the old wording of that paragraph in the new version (the former
 * "revert") and marks it as reviewed.
 *
 * Row ids are positional and change with every re-comparison, so the status of a change is
 * stored under a content key instead (state.reviews: key -> entry). The old version never
 * changes during a review, so a paragraph of it is identified by its text and occurrence
 * ("left anchor"). A rejected change no longer differs and disappears from the comparison;
 * its entry keeps what is needed to list it as "rejected" (a "ghost" item that points at
 * the restored paragraph).
 *
 * state.reviews is part of every undo / redo snapshot and of the session file.
 */

const REVIEW_KEY_MAX = 200000;

// Left anchors ("text#occurrence") for every row that has an old paragraph, plus the anchor
// of the nearest old paragraph above each row (for inserted paragraphs).
function computeRowAnchors(rows) {
  const seen = new Map();
  const left = new Map();
  const prev = new Map();
  let lastAnchor = '';
  for (const row of rows) {
    prev.set(row.id, lastAnchor);
    if (row.leftBlock) {
      const text = row.leftBlock.text;
      const n = (seen.get(text) || 0) + 1;
      seen.set(text, n);
      const anchor = `${text}#${n}`;
      left.set(row.id, anchor);
      lastAnchor = anchor;
    }
  }
  return { left, prev };
}

function reviewKeyForRow(row, anchors, insertCounts) {
  if (row.type === 'modified') return `M|${anchors.left.get(row.id)}|${row.rightBlock.text}`;
  if (row.type === 'deleted') return `D|${anchors.left.get(row.id)}`;
  if (row.type === 'inserted') {
    const base = `I|${anchors.prev.get(row.id)}|${row.rightBlock.text}`;
    const n = (insertCounts.get(base) || 0) + 1;
    insertCounts.set(base, n);
    return `${base}#${n}`;
  }
  return '';
}

// Builds state.listItems: every current change plus the rejected changes, in document order,
// with their review status. Also sets row.reviewKey / row.reviewStatus on the rows.
// Identical header/footer changes on several pages become one item (with `members`), listed
// after the changes in the body text.
function rebuildReviewIndex() {
  const rows = state.alignedRows;
  const anchors = computeRowAnchors(rows);
  const insertCounts = new Map();
  const rowByLeftAnchor = new Map();
  for (const row of rows) {
    const a = anchors.left.get(row.id);
    if (a) rowByLeftAnchor.set(a, row);
  }
  const liveKeys = new Set();
  const items = [];
  rows.forEach((row, idx) => {
    row.reviewStatus = '';
    row.ghostNote = '';
    if (row.type === 'equal') return;
    const key = reviewKeyForRow(row, anchors, insertCounts);
    row.reviewKey = key;
    liveKeys.add(key);
    const entry = state.reviews[key];
    const status = entry && entry.status === 'accepted' ? 'accepted' : 'open';
    row.reviewStatus = status === 'accepted' ? 'accepted' : '';
    items.push({ id: row.id, key, rowId: row.id, row, type: row.type, status, ghost: null, order: idx, sub: 0 });
  });

  // Rejected changes, placed where they were.
  for (const [key, entry] of Object.entries(state.reviews)) {
    if (!entry || entry.status !== 'rejected' || liveKeys.has(key)) continue;
    let target = null;
    let order = 0;
    let sub = 0;
    if (entry.type === 'inserted') {
      target = entry.prevAnchor ? rowByLeftAnchor.get(entry.prevAnchor) : rows[0];
      if (!target) continue;
      order = rows.indexOf(target);
      sub = entry.prevAnchor ? 0.5 : -0.5;
      if (!target.ghostNote) target.ghostNote = 'rejected-ins';
    } else {
      target = rowByLeftAnchor.get(entry.leftAnchor);
      if (target) {
        // Only while the old wording is really back (an edit afterwards makes it a new change).
        if (target.type !== 'equal') continue;
        order = rows.indexOf(target);
        if (!target.ghostNote) target.ghostNote = 'rejected';
      } else {
        // The restored line is no longer shown (an identical header/footer line is hidden):
        // keep the item where it was, after the paragraph above it.
        target = entry.prevAnchor ? rowByLeftAnchor.get(entry.prevAnchor) : rows[0];
        if (!target) continue;
        order = rows.indexOf(target);
        sub = entry.prevAnchor ? 0.5 : -0.5;
        if (!target.ghostNote) target.ghostNote = 'rejected-ins';
      }
    }
    items.push({
      id: `ghost-${key.length}-${hashString(key)}`,
      key,
      rowId: target.id,
      row: target,
      type: entry.type,
      status: 'rejected',
      ghost: entry,
      order,
      sub,
    });
  }
  const merged = mergeHeaderFooterItems(items, rows.length);
  merged.sort((a, b) => a.order - b.order || a.sub - b.sub);
  merged.forEach((item, i) => {
    item.index = i + 1;
  });
  state.listItems = merged;
  return merged;
}

function isHeaderFooterItem(item) {
  if (item.ghost) return Boolean(item.ghost.hf);
  const b = item.row.rightBlock || item.row.leftBlock;
  return Boolean(b && (b.isHeaderFooter || b.kind === 'hf'));
}

// Running headers and footers repeat on every page with the page number in them: the same
// change on several pages is one decision. Digits in the surrounding text are ignored, but the
// changed words themselves (numbers included) must be identical. Rejected entries recompute
// their changed words from the rejected text so a rejected group stays one entry.
function headerFooterGroupKey(item) {
  if (item.type !== 'modified') return '';
  const diffs = getItemWordDiffs(item);
  const changedParts = Array.isArray(diffs) ? diffs.filter(d => d.added || d.removed) : [];
  const hasTokens = changedParts.length > 0;
  const norm = s => {
    const text = String(s || '');
    return (hasTokens ? text.replace(/\d+/g, '#') : text).replace(/\s+/g, ' ').trim();
  };
  const left = item.ghost ? item.ghost.leftText : item.row.leftBlock ? item.row.leftBlock.text : '';
  const right = item.ghost ? item.ghost.rightText : item.row.rightBlock ? item.row.rightBlock.text : '';
  const changed = changedParts.map(d => (d.added ? '+' : '-') + d.value).join('\u0001');
  return [item.status, item.ghost ? 'g' : 'l', norm(left), norm(right), changed].join('\u0000');
}

function mergeHeaderFooterItems(items, rowCount) {
  const out = [];
  const groups = new Map();
  for (const item of items) {
    if (!isHeaderFooterItem(item)) {
      out.push(item);
      continue;
    }
    // Header / footer changes come after the changes in the body text.
    item.order += rowCount + 1;
    const key = headerFooterGroupKey(item);
    if (!key) {
      out.push(item);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [key, list] of groups) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    list.sort((a, b) => a.order - b.order || a.sub - b.sub);
    const first = list[0];
    const pageOf = m => (m.ghost ? m.ghost.pageNum : m.row.pageNum) || 1;
    out.push({ ...first, id: `hf-${hashString(key)}`, members: list, pages: new Set(list.map(pageOf)).size });
  }
  return out;
}

// The items a list entry stands for (itself, or every page of a merged header/footer change).
function itemMembers(item) {
  return item && item.members ? item.members : item ? [item] : [];
}

function itemHasRow(item, rowId) {
  return item.rowId === rowId || Boolean(item.members && item.members.some(m => m.rowId === rowId));
}

function itemHasKey(item, key) {
  return item.key === key || Boolean(item.members && item.members.some(m => m.key === key));
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function getReviewCounts() {
  const c = { total: state.listItems.length, accepted: 0, rejected: 0, open: 0 };
  for (const item of state.listItems) c[item.status]++;
  c.reviewed = c.accepted + c.rejected;
  return c;
}

// The list item shown as "current" for the active row (a real change wins over a ghost).
function getActiveItem() {
  if (!state.activeRowId) return null;
  let ghost = null;
  for (const item of state.listItems) {
    if (!itemHasRow(item, state.activeRowId)) continue;
    if (!item.ghost) return item;
    if (!ghost) ghost = item;
  }
  return ghost;
}

function cloneReviews(reviews = state.reviews) {
  const out = {};
  for (const [k, v] of Object.entries(reviews || {})) out[k] = { ...v };
  return out;
}

function serializeReviews(reviews = state.reviews) {
  // Field order is not significant; sort it so equal states serialize equally.
  const sorted = v => Object.fromEntries(Object.keys(v).sort().map(f => [f, v[f]]));
  return JSON.stringify(Object.keys(reviews).sort().map(k => [k, sorted(reviews[k])]));
}

// Review status belongs to the loaded pair of documents.
function resetReviews() {
  state.reviews = {};
}

// The next open change after the one with this key (wrapping around), or null.
function nextOpenItemAfter(key) {
  const items = state.listItems;
  const i = items.findIndex(it => itemHasKey(it, key));
  for (let k = 1; k <= items.length; k++) {
    const it = items[(Math.max(i, 0) + k) % items.length];
    if (it && it.status === 'open') return it;
  }
  return null;
}

function reviewAnnouncement(kind, idx, next) {
  const n = state.listItems.length;
  if (next) return formatMsg(kind === 'accepted' ? 'announceAcceptedNext' : 'announceRejectedNext', { i: idx, j: next.index, n });
  return formatMsg(kind === 'accepted' ? 'announceAcceptedDone' : 'announceRejectedDone', { i: idx, n });
}

/* ── Actions ───────────────────────────────────────────────────────────── */

function canReviewNow() {
  return document.body.classList.contains('is-comparing') && isShownComparisonCurrent();
}

// Where focus goes once the next change is current: its "accept" button (or the list card).
let reviewFocusRequest = null;

function acceptItem(item, opts = {}) {
  if (!item || item.ghost || item.status === 'accepted' || !canReviewNow()) return false;
  const members = itemMembers(item);
  const idx = item.index;
  const key = item.key;
  pushUndoSnapshot();
  for (const m of members) state.reviews[m.row.reviewKey] = { status: 'accepted', type: m.row.type };
  refreshReviewState();
  // On to the next open change (like "Accept and move to next" in Word).
  const next = opts.stay ? null : nextOpenItemAfter(key);
  if (next) {
    reviewFocusRequest = opts.fromList ? 'list' : 'bar';
    selectAndScrollToRow(next.rowId, true, true, { itemId: next.id, flash: false, keepIfVisible: true });
  }
  announce(reviewAnnouncement('accepted', idx, next));
  return true;
}

function rejectItem(item, opts = {}) {
  if (!item || item.ghost || !canReviewNow()) return false;
  const members = itemMembers(item);
  const anchors = computeRowAnchors(state.alignedRows);
  pushUndoSnapshot();
  for (const m of members) {
    const row = m.row;
    delete state.reviews[row.reviewKey];
    state.reviews[row.reviewKey] = {
      status: 'rejected',
      type: row.type,
      leftText: row.leftBlock ? row.leftBlock.text : '',
      rightText: row.rightBlock ? row.rightBlock.text : '',
      leftAnchor: anchors.left.get(row.id) || '',
      prevAnchor: anchors.prev.get(row.id) || '',
      pageNum: row.pageNum || 1,
      refCode: getDisplayRef(row),
    };
    if (isHeaderFooterItem(m)) state.reviews[row.reviewKey].hf = true;
  }
  // After the new comparison: on to the next open change (or stay on this one).
  pendingSelectAfterReject = { key: item.key, idx: item.index, stay: Boolean(opts.stay), focus: opts.fromList ? 'list' : 'bar' };
  if (members.length > 1) {
    state.rightText = rebuildRightTextReplacingRows(new Map(members.map(m => [m.row.id, m.row.leftBlock ? m.row.leftBlock.text : ''])));
  } else {
    state.rightText = rebuildRightTextFromRows(item.row.id, item.row.leftBlock ? item.row.leftBlock.text : '');
  }
  runComparison();
  return true;
}

// Takes a review back: accepted -> open; rejected -> the new wording is restored.
function reopenItem(item) {
  if (!item || item.status === 'open' || !canReviewNow()) return false;
  const idx = item.index;
  const n = state.listItems.length;
  const members = itemMembers(item);
  if (item.status === 'accepted') {
    pushUndoSnapshot();
    for (const m of members) delete state.reviews[m.row.reviewKey];
    refreshReviewState();
  } else {
    pushUndoSnapshot();
    for (const m of members) {
      const key = Object.keys(state.reviews).find(k => state.reviews[k] === m.ghost);
      if (key) delete state.reviews[key];
    }
    const g = item.ghost;
    if (members.length > 1) {
      state.rightText = rebuildRightTextReplacingRows(new Map(members.map(m => [m.row.id, m.ghost.rightText])));
    } else if (g.type === 'inserted') {
      const anchorRow = item.row;
      const base = anchorRow.rightBlock ? anchorRow.rightBlock.text : '';
      state.rightText = rebuildRightTextFromRows(anchorRow.id, base ? `${base}\n${g.rightText}` : g.rightText);
    } else {
      state.rightText = rebuildRightTextFromRows(item.row.id, g.type === 'deleted' ? '' : g.rightText);
    }
    runComparison();
  }
  announce(formatMsg('announceReopened', { i: idx, n }));
  return true;
}

let pendingSelectAfterReject = null;

// After a new comparison that followed "reject": select the next open change and announce.
function consumePendingReject() {
  const req = pendingSelectAfterReject;
  pendingSelectAfterReject = null;
  if (!req) return false;
  const own = state.listItems.find(it => itemHasKey(it, req.key));
  const next = req.stay ? null : nextOpenItemAfter(req.key);
  const target = next || own;
  if (target) state.activeRowId = target.rowId;
  if (next) reviewFocusRequest = req.focus;
  announce(reviewAnnouncement('rejected', req.idx, next));
  return Boolean(next);
}

// After a review-only change (no new comparison): decorations, list, counters.
function refreshReviewState() {
  rebuildReviewIndex();
  decorateReviewedRows();
  renderSidebarList(true);
  updateStepper();
  placeReviewBar();
  scheduleRulerDraw();
}

/* ── Status mark of a reviewed change ───────────────────────────────────────
 *
 * Every reviewed paragraph of the new version carries a quiet mark in its right margin, where
 * the review actions sit: ✓ (accepted) or ✗ (rejected), with an undo button below it that
 * shows on the current paragraph and on hover. It is absolutely positioned in the margin every
 * paragraph keeps free, so reviewing never moves text or changes a height.
 */

const ICON_UNDO = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';

function reviewStatusHtml(row) {
  const accepted = row.reviewStatus === 'accepted';
  if (!accepted && !row.ghostNote) return '';
  const active = row.id === state.activeRowId;
  const note = t(accepted ? 'acceptedNote' : row.ghostNote === 'rejected' ? 'rejectedNote' : 'rejectedInsNote');
  return (
    `<span class="review-status ${accepted ? 'is-accepted' : 'is-rejected'}" data-status-row="${row.id}">` +
    `<span class="rs-mark" data-tooltip="${escapeHtml(note)}">${accepted ? ICON_CHECK : ICON_X}<span class="sr-only">${escapeHtml(note)}</span></span>` +
    `<button type="button" class="ra-undo" data-review-action="reopen" aria-label="${escapeHtml(t('reopenBtn'))}" data-tooltip="${escapeHtml(t('reopenTitle'))}" tabindex="${active ? 0 : -1}">${ICON_UNDO}</button>` +
    `</span>`
  );
}

// Brings the status lines and review classes of the rendered clauses up to date without
// re-rendering the paragraphs.
function decorateReviewedRows() {
  for (const row of state.alignedRows) {
    const els = getRowElements(row.id);
    if (!els) continue;
    if (els.l) els.l.classList.toggle('is-accepted', row.reviewStatus === 'accepted');
    const html = reviewStatusHtml(row);
    for (const el of [els.r, els.u]) {
      if (!el) continue;
      el.classList.toggle('is-accepted', row.reviewStatus === 'accepted');
      const current = el.querySelector(':scope > .review-status');
      if (!html) {
        if (current) current.remove();
        continue;
      }
      if (current && current.outerHTML === html) continue;
      const hadFocus = current && current.contains(document.activeElement);
      if (current) current.remove();
      el.insertBefore(htmlToElement(html), el.firstChild);
      if (hadFocus) el.querySelector(':scope > .review-status .ra-undo').focus({ preventScroll: true });
    }
  }
}

function htmlToElement(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content.firstChild;
}

// Only the status line of the current paragraph is in the tab order.
function syncStatusTabStops() {
  for (const btn of document.querySelectorAll('.review-status .ra-undo')) {
    btn.tabIndex = btn.closest('[data-status-row]').getAttribute('data-status-row') === state.activeRowId ? 0 : -1;
  }
}

/* ── Review actions at the current paragraph ─────────────────────────────
 *
 * One place only: a compact column of three icon buttons (accept, reject, edit) in the right
 * margin of the current paragraph of the new version (or of the stacked view). Every
 * paragraph there keeps that margin free, so selecting a paragraph never moves any text.
 * On phones the margin would cost too much of the narrow text column: the buttons sit in a
 * row just above the bottom bar instead, within reach of the thumb.
 */

// Created on first use (the module is also loaded without a DOM by the export tests).
let reviewBar = null;
function getReviewBar() {
  if (reviewBar) return reviewBar;
  reviewBar = document.createElement('div');
  reviewBar.className = 'review-bar';
  reviewBar.setAttribute('role', 'toolbar');
  reviewBar.setAttribute('aria-orientation', 'vertical');
  reviewBar.addEventListener('mousedown', e => e.stopPropagation());
  reviewBar.addEventListener('dblclick', e => e.stopPropagation());
  // Roving focus inside the group: one tab stop, arrow keys move between the buttons.
  reviewBar.addEventListener('keydown', e => handleRovingKeys(e, reviewBar));
  // In the panes, clicks are handled by the pane; above the bottom bar, here.
  reviewBar.addEventListener('click', e => {
    const btn = e.target.closest('[data-review-action]');
    if (!btn || !reviewBar.closest('.bottom-bar')) return;
    e.stopPropagation();
    runReviewAction(btn.getAttribute('data-review-action'), false);
  });
  return reviewBar;
}

function removeReviewBar() {
  if (reviewBar && reviewBar.isConnected) reviewBar.remove();
}

const ICON_CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_X = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const ICON_EDIT = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

// Icon buttons: accept / reject for an open change, edit for any paragraph of the new version;
// with `withUndo` (phones, where the margin has no undo button) also undo for a reviewed one.
function reviewActionsHtml(item, withUndo = false) {
  const btn = (action, icon, label, title, key, cls) =>
    `<button type="button" class="ra-btn ${cls}" data-review-action="${action}" aria-label="${escapeHtml(label)}" ${key ? `aria-keyshortcuts="${key}" ` : ''}data-tooltip="${escapeHtml(title)}" tabindex="-1">${icon}<span class="ra-label" aria-hidden="true">${escapeHtml(label)}</span></button>`;
  const edit = btn('edit', ICON_EDIT, t('editBtn'), t('editTitle'), 'E', 'ra-edit');
  if (withUndo && item && item.status !== 'open') {
    return rovingFirst(btn('reopen', ICON_UNDO, t('reopenBtn'), t('reopenTitle'), '', 'ra-reopen') + edit);
  }
  if (item && item.status === 'open') {
    return rovingFirst(
      btn('accept', ICON_CHECK, t('acceptBtn'), t('acceptTitle'), 'A', 'ra-accept') +
      btn('reject', ICON_X, t('rejectBtn'), t('rejectTitle'), 'R', 'ra-reject') +
      edit
    );
  }
  return rovingFirst(edit);
}

// A group of action buttons is one tab stop; the arrow keys move inside it.
function rovingFirst(html) {
  return html.replace(' tabindex="-1"', ' tabindex="0"');
}

function handleRovingKeys(e, container) {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return false;
  const buttons = Array.from(container.querySelectorAll('button'));
  const i = buttons.indexOf(document.activeElement);
  if (i < 0) return false;
  e.preventDefault();
  e.stopPropagation();
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + step + buttons.length) % buttons.length;
  buttons.forEach((b, k) => (b.tabIndex = k === next ? 0 : -1));
  buttons[next].focus();
  return true;
}

// The clause that carries the actions of a row in the visible view.
function reviewHostFor(rowId) {
  const els = getRowElements(rowId);
  return els ? (state.viewMode === 'inline' ? els.u : els.r) : null;
}

function placeReviewBar() {
  const row = state.activeRowId && state.alignedRows.find(r => r.id === state.activeRowId);
  const host = row ? reviewHostFor(row.id) : null;
  syncStatusTabStops();
  if (!row || !host || host.classList.contains('is-editing') || !document.body.classList.contains('is-comparing')) {
    removeReviewBar();
    reviewFocusRequest = null;
    return;
  }
  const bar = getReviewBar();
  const item = getActiveItem();
  const phone = document.body.classList.contains('tier-phone');
  const barHost = phone ? document.getElementById('mobile-bottom-bar') : host;
  const hadFocus = bar.contains(document.activeElement);
  const focusedAction = hadFocus ? document.activeElement.getAttribute('data-review-action') : null;
  bar.innerHTML = reviewActionsHtml(item, phone);
  bar.setAttribute('aria-orientation', phone ? 'horizontal' : 'vertical');
  bar.setAttribute(
    'aria-label',
    item ? formatMsg('reviewBarLabel', { i: item.index, n: state.listItems.length }) : t('paraActionsLabel')
  );
  const buttons = bar.querySelectorAll('button');
  if (bar.parentElement !== barHost) barHost.appendChild(bar);
  const request = reviewFocusRequest;
  reviewFocusRequest = null;
  let target = null;
  if (request === 'bar') target = bar.querySelector('[data-review-action="accept"]') || buttons[0];
  else if (hadFocus) target = bar.querySelector(`[data-review-action="${focusedAction}"]`) || buttons[0];
  if (target) {
    buttons.forEach(b => (b.tabIndex = b === target ? 0 : -1));
    target.focus({ preventScroll: true });
  } else if (request === 'list') {
    requestAnimationFrame(() => {
      const card = sidebarList.querySelector('.nav-item.is-active .nav-item-main');
      if (card && card.getClientRects().length) card.focus({ preventScroll: true });
    });
  }
}

// Runs a review action for the active row ('accept' | 'reject' | 'edit' | 'reopen').
function runReviewAction(action, fromList) {
  const row = state.activeRowId && state.alignedRows.find(r => r.id === state.activeRowId);
  if (!row) return false;
  const item = getActiveItem();
  hideTooltip();
  requestRowFocus(row.id, fromList);
  let done = false;
  if (action === 'accept') done = acceptItem(item, { fromList });
  else if (action === 'reject') done = rejectItem(item, { fromList });
  else if (action === 'reopen') {
    done = reopenItem(item);
    // Back on the reopened change, ready for a new decision.
    if (done) requestRowFocus(state.activeRowId, fromList);
  } else if (action === 'edit') {
    pendingRowFocus = null;
    const host = reviewHostFor(row.id);
    if (host) startInlineClauseEdit(host, row.id);
    return true;
  }
  applyPendingRowFocusIfIdle();
  return done;
}

// All open list entries in this comparison, including hidden/filtered entries and every
// member of a grouped header/footer change. Revalidate after the confirmation dialog.
async function acceptAllOpenChanges() {
  if (!canReviewNow()) return false;
  const items = state.listItems.filter(item => item.status === 'open' && !item.ghost);
  if (!items.length) return false;
  const leftText = state.leftText, rightText = state.rightText;
  const signature = JSON.stringify(items.map(item => itemMembers(item).map(m => m.row.reviewKey)));
  const de = state.lang === 'de';
  const choice = await showSessionDialog({
    title: de ? 'Alle offenen Änderungen annehmen?' : 'Accept all open changes?',
    body: de
      ? `Alle ${items.length} offenen Einträge im gesamten Vergleich annehmen, einschließlich ausgeblendeter und gefilterter Einträge sowie aller Seiten gruppierter Kopf-/Fußzeilen? Dies ist mit einem Rückgängig-Schritt umkehrbar.`
      : `Accept all ${items.length} open entries in the entire comparison, including hidden and filtered entries and every page of grouped headers/footers? This can be undone in one step.`,
    confirmLabel: de ? 'Alle annehmen' : 'Accept all',
    cancelLabel: de ? 'Abbrechen' : 'Cancel',
  });
  if (choice !== 'confirm' || !canReviewNow() || state.leftText !== leftText || state.rightText !== rightText) return false;
  const current = state.listItems.filter(item => item.status === 'open' && !item.ghost);
  if (JSON.stringify(current.map(item => itemMembers(item).map(m => m.row.reviewKey))) !== signature) return false;
  pushUndoSnapshot();
  for (const item of current) {
    for (const m of itemMembers(item)) state.reviews[m.row.reviewKey] = { status: 'accepted', type: m.row.type };
  }
  refreshReviewState();
  announce(de ? `${items.length} Einträge angenommen.` : `Accepted ${items.length} entries.`);
  return true;
}
