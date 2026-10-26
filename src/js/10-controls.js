/* ── Stepper: "‹ 2 von 22 ›" follows the active list filter ─────────────── */

function updateStepper() {
  const items = getFilteredListItems();
  const total = items.length;
  const active = getActiveItem();
  const idx = active ? items.indexOf(active) : -1;
  // With a filter the count says what it counts: "1 von 1 entfernten".
  const filterKey = state.sidebarFilter !== 'all' ? state.sidebarFilter : state.statusFilter !== 'all' ? state.statusFilter : '';
  const pos = { i: total ? (idx >= 0 ? idx + 1 : '–') : 0, n: total };
  const text = filterKey ? formatMsg('stepPosFiltered', { ...pos, label: t(`stepLabel_${filterKey}`) }) : formatMsg('stepPos', pos);
  document.getElementById('step-pos').textContent = text;
  document.getElementById('mob-step-count').textContent = text;
  document.getElementById('mob-step').setAttribute('aria-label', formatMsg('mobStepLabel', { i: idx >= 0 ? idx + 1 : '–', n: total }));
  for (const id of ['btn-prev', 'btn-next', 'mob-btn-prev', 'mob-btn-next']) {
    document.getElementById(id).disabled = total === 0;
  }
}

// J / K and the arrows: next / previous OPEN change while there is one, otherwise every change.
function stepChange(direction) {
  const pool = getFilteredListItems();
  if (!pool.length) return;
  const open = pool.filter(item => item.status === 'open');
  const rows = open.length ? open : pool;
  const active = getActiveItem();
  const curPos = active ? pool.indexOf(active) : -1;
  let next = null;
  if (curPos < 0) {
    next = direction > 0 ? rows[0] : rows[rows.length - 1];
  } else if (direction > 0) {
    next = rows.find(item => pool.indexOf(item) > curPos) || rows[0];
  } else {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (pool.indexOf(rows[i]) < curPos) {
        next = rows[i];
        break;
      }
    }
    if (!next) next = rows[rows.length - 1];
  }
  selectAndScrollToRow(next.rowId, true, true, { itemId: next.id });
  announceActiveChange();
}

// "Änderung 3 von 22: S. 1, § 1 (2), geändert, angenommen" – read out after J / K or the arrows.
function announceActiveChange() {
  const item = getActiveItem();
  if (!item) return;
  const ref = [`${t('pageShort')} ${getItemPage(item)}`, getItemRef(item)].filter(Boolean).join(', ');
  announce(
    formatMsg('announceStep', {
      i: item.index,
      n: state.listItems.length,
      ref,
      type: getChangeTypeLabel(item),
      status: item.status === 'open' ? '' : `, ${getStatusLabel(item.status)}`,
    })
  );
}

document.getElementById('btn-prev').addEventListener('click', () => stepChange(-1));
document.getElementById('btn-next').addEventListener('click', () => stepChange(1));
document.getElementById('mob-btn-prev').addEventListener('click', () => stepChange(-1));
document.getElementById('mob-btn-next').addEventListener('click', () => stepChange(1));

/* ── Menus (menu button pattern) and the documents popover ──────────────── */

const MENU_TRIGGERS = { 'view-menu': 'btn-view-menu', 'export-menu': 'btn-export-menu', 'more-menu': 'btn-more' };
// `var`: also read by 08-export.js while the scripts are still loading.
var openMenuState = null; // { id, trigger }

function menuItems(menu) {
  return Array.from(menu.querySelectorAll('[role^="menuitem"]')).filter(el => !el.disabled && el.getClientRects().length);
}

function openMenu(id, trigger, focus = 'first') {
  const menu = document.getElementById(id);
  if (!menu || (trigger && trigger.disabled)) return;
  closeAllMenus(false);
  closeFilesPop(false);
  hideTooltip();
  menu.hidden = false;
  menu.classList.add('is-open');
  trigger = trigger || document.getElementById(MENU_TRIGGERS[id]);
  trigger.setAttribute('aria-expanded', 'true');
  openMenuState = { id, trigger };
  if (id === 'export-menu') updateExportMenuTexts();
  document.body.classList.toggle('menu-sheet-open', isPhoneWidth());
  menuItems(menu).forEach(item => (item.tabIndex = -1));
  if (focus) {
    const items = menuItems(menu);
    const target = focus === 'last' ? items[items.length - 1] : items[0];
    if (target) target.focus();
  }
}

function closeMenu(id, returnFocus) {
  if (id === 'export-menu') setMoreFormats(false);
  if (!openMenuState || openMenuState.id !== id) {
    const menu = document.getElementById(id);
    if (menu) {
      menu.hidden = true;
      menu.classList.remove('is-open');
    }
    return;
  }
  const { trigger } = openMenuState;
  const menu = document.getElementById(id);
  menu.hidden = true;
  menu.classList.remove('is-open');
  for (const t of [trigger, document.getElementById(MENU_TRIGGERS[id])]) if (t) t.setAttribute('aria-expanded', 'false');
  openMenuState = null;
  document.body.classList.remove('menu-sheet-open');
  if (returnFocus) {
    // A menu opened from inside another menu (the view options in ⋯ on phones) returns to ⋯.
    const target = [trigger, document.getElementById(MENU_TRIGGERS[id]), document.getElementById('btn-more')].find(t => t && t.getClientRects().length);
    if (target) target.focus();
  }
}

function closeAllMenus(returnFocus) {
  if (openMenuState) closeMenu(openMenuState.id, returnFocus);
}

// Where focus should go back to after an action started from a closed menu.
function menuReturnTarget() {
  return openMenuState ? openMenuState.trigger : null;
}

for (const [id, triggerId] of Object.entries(MENU_TRIGGERS)) {
  const trigger = document.getElementById(triggerId);
  const menu = document.getElementById(id);
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    if (openMenuState && openMenuState.id === id) closeMenu(id, false);
    else openMenu(id, trigger, e.detail === 0 ? 'first' : 'first');
  });
  trigger.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    openMenu(id, trigger, e.key === 'ArrowUp' ? 'last' : 'first');
  });
  menu.addEventListener('keydown', e => {
    const items = menuItems(menu);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    let next = null;
    // Inside a segmented row the left/right arrows move like down/up.
    const inSeg = document.activeElement && document.activeElement.closest('.menu-seg');
    if (e.key === 'ArrowDown' || (inSeg && e.key === 'ArrowRight')) next = items[(idx + 1) % items.length];
    else if (e.key === 'ArrowUp' || (inSeg && e.key === 'ArrowLeft')) next = items[(idx - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(id, true);
      return;
    } else if (e.key === 'Tab') {
      closeMenu(id, false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    next.focus();
  });
}
document.getElementById('mob-btn-export').addEventListener('click', e => {
  e.stopPropagation();
  if (openMenuState && openMenuState.id === 'export-menu') closeMenu('export-menu', false);
  else {
    closeListSheet(false);
    openMenu('export-menu', e.currentTarget);
  }
});

// A click on a menu item runs it and closes the menu (focus back to the menu button).
// "Weitere Formate": opens the less common formats inside the menu.
function setMoreFormats(open, focusFirst) {
  const btn = document.getElementById('btn-more-formats');
  const sub = document.getElementById('more-formats');
  btn.setAttribute('aria-expanded', String(open));
  sub.hidden = !open;
  if (open && focusFirst) {
    const first = sub.querySelector('[role="menuitem"]');
    if (first) {
      first.tabIndex = -1;
      first.focus();
    }
  }
}
document.getElementById('btn-more-formats').addEventListener('click', e => {
  e.stopPropagation();
  setMoreFormats(document.getElementById('more-formats').hidden, true);
});
document.getElementById('btn-more-formats').addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    e.stopPropagation();
    setMoreFormats(true, true);
  }
});
document.getElementById('more-formats').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    e.stopPropagation();
    setMoreFormats(false);
    document.getElementById('btn-more-formats').focus();
  }
});

document.getElementById('export-menu').addEventListener('click', e => {
  const item = e.target.closest('[data-export]');
  if (!item) return;
  const returnFocus = document.getElementById('export-menu').contains(document.activeElement);
  closeMenu('export-menu', returnFocus);
  handleExportAction(item.getAttribute('data-export'));
});

document.getElementById('view-menu').addEventListener('click', e => {
  const item = e.target.closest('[role^="menuitem"]');
  if (!item) return;
  const returnFocus = document.getElementById('view-menu').contains(document.activeElement);
  const id = item.id;
  closeMenu('view-menu', returnFocus);
  if (id === 'btn-mode-split') setViewMode('split', { user: true });
  else if (id === 'btn-mode-inline') setViewMode('inline', { user: true });
  else if (id === 'btn-page-breaks') togglePageBreaks();
  else if (id === 'btn-only-changes') toggleOnlyChanges();
  else if (id === 'btn-filter-hf') toggleHeaderFooterFilter();
  else if (id === 'btn-toggle-sidebar') toggleSidebar();
  else if (item.hasAttribute('data-theme-pref')) setThemePref(item.getAttribute('data-theme-pref'));
});

document.getElementById('more-menu').addEventListener('click', e => {
  const item = e.target.closest('[role="menuitem"]');
  if (!item || item.disabled) return;
  const returnFocus = document.getElementById('more-menu').contains(document.activeElement);
  const trigger = openMenuState ? openMenuState.trigger : document.getElementById('btn-more');
  if (item.id === 'menu-view') {
    e.stopPropagation();
    closeMenu('more-menu', false);
    openMenu('view-menu', trigger);
    return;
  }
  closeMenu('more-menu', returnFocus);
  switch (item.id) {
    case 'btn-clear':
      clearComparison();
      break;
    case 'btn-paste-modal':
      openPasteModal();
      break;
    case 'menu-help':
      openHelp();
      break;
    case 'menu-lang':
      toggleLanguage();
      break;
    case 'btn-privacy-info':
      privacyModal.showModal();
      break;
    default:
      break;
  }
});

function announceHistory(key) {
  announce(t(key));
}

window.addEventListener('click', e => {
  if (openMenuState) {
    const menu = document.getElementById(openMenuState.id);
    if (!menu.contains(e.target) && !openMenuState.trigger.contains(e.target)) closeMenu(openMenuState.id, false);
  }
  const wrap = document.getElementById('files-wrap');
  if (!filesPop.hidden && !wrap.contains(e.target)) closeFilesPop(false);
});

const filesPop = document.getElementById('files-pop');
const btnFiles = document.getElementById('btn-files');
function openFilesPop() {
  closeAllMenus(false);
  hideTooltip();
  filesPop.hidden = false;
  btnFiles.setAttribute('aria-expanded', 'true');
  const first = filesPop.querySelector('button:not([hidden])');
  if (first) first.focus();
}
function closeFilesPop(returnFocus) {
  if (filesPop.hidden) return;
  filesPop.hidden = true;
  btnFiles.setAttribute('aria-expanded', 'false');
  if (returnFocus) btnFiles.focus();
}
btnFiles.addEventListener('click', e => {
  e.stopPropagation();
  if (filesPop.hidden) openFilesPop();
  else closeFilesPop(false);
});
filesPop.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFilesPop(true);
  }
});
document.getElementById('files-wrap').addEventListener('focusout', e => {
  if (!filesPop.hidden && e.relatedTarget && !document.getElementById('files-wrap').contains(e.relatedTarget)) closeFilesPop(false);
});
// Choosing a file or swapping closes the popover first.
filesPop.addEventListener('click', e => {
  if (e.target.closest('button')) closeFilesPop(filesPop.contains(document.activeElement));
});

/* ── View options ───────────────────────────────────────────────────────── */

function togglePageBreaks() {
  state.pageBreaks = !pageBreaksShown();
  applyPageBreaks();
  scheduleRulerDraw();
}

function toggleOnlyChanges() {
  state.onlyChanges = !state.onlyChanges;
  document.body.classList.toggle('only-changes', state.onlyChanges);
  setMenuChecked('btn-only-changes', state.onlyChanges);
  requestAnimationFrame(() => {
    scheduleRulerDraw();
    const el = state.activeRowId && getRowElements(state.activeRowId)[state.viewMode === 'inline' ? 'u' : 'r'];
    if (el && el.getClientRects().length) selectAndScrollToRow(state.activeRowId, false, true, { flash: false, keepIfVisible: true });
  });
}

function toggleHeaderFooterFilter() {
  state.ignoreHeadersFooters = !state.ignoreHeadersFooters;
  setMenuChecked('btn-filter-hf', state.ignoreHeadersFooters);
  runComparison();
}

/* ── Layout tiers: docked list (desktop), drawer (tablet), sheet (phone) ── */

let currentTier = null;
function layoutTier() {
  return isPhoneWidth() ? 'phone' : isTabletOrSmaller() ? 'tablet' : 'desktop';
}

function applyLayoutTier(initial) {
  const tier = layoutTier();
  if (tier === currentTier) return;
  const prev = currentTier;
  currentTier = tier;
  document.body.classList.toggle('tier-phone', tier === 'phone');
  document.body.classList.toggle('tier-tablet', tier === 'tablet');
  document.body.classList.toggle('tier-desktop', tier === 'desktop');
  closeListSheet(false);
  const sidebar = document.getElementById('sidebar');
  if (tier === 'desktop') {
    sidebar.setAttribute('role', 'region');
    sidebar.removeAttribute('aria-modal');
  } else {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
  }
  // Phones show one column only.
  if (tier === 'phone' && state.viewMode !== 'inline') setViewMode('inline');
  else if (!initial && prev === 'phone' && !state.viewModeChosen) setViewMode(initialInline && tier !== 'desktop' ? 'inline' : 'split');
  applySidebarState();  // The review buttons sit in the paragraph margin, or above the bottom bar on phones.
  if (!initial && typeof placeReviewBar === 'function') placeReviewBar();
}

function applySidebarState() {
  const docked = currentTier === 'desktop';
  document.body.classList.toggle('sidebar-collapsed', docked && !state.sidebarOpen);
  setMenuChecked('btn-toggle-sidebar', state.sidebarOpen);
  // On the desktop the sidebar button at the right end of the top bar shows and hides the list.
  document.getElementById('btn-rail').setAttribute('aria-expanded', String(docked && state.sidebarOpen));
  scheduleRulerDraw();
}

function toggleSidebar() {
  if (currentTier !== 'desktop') {
    openListSheet();
    return;
  }
  state.sidebarOpen = !state.sidebarOpen;
  applySidebarState();
}

const LIST_SHEET_INERT = ['topbar', 'pane-left', 'pane-right', 'pane-unified', 'mobile-bottom-bar', 'ruler'];
let listSheetReturn = null;
function openListSheet() {
  if (currentTier === 'desktop' || document.body.classList.contains('list-open')) return;
  closeAllMenus(false);
  listSheetReturn = document.activeElement;
  document.body.classList.add('list-open');
  document.getElementById('btn-list').setAttribute('aria-expanded', 'true');
  document.getElementById('mob-step').setAttribute('aria-expanded', 'true');
  for (const id of LIST_SHEET_INERT) document.getElementById(id).inert = true;
  const target = sidebarList.querySelector('.nav-item.is-active .nav-item-main') || sidebarList.querySelector('.nav-item-main');
  requestAnimationFrame(() => {
    (target || document.getElementById('btn-close-sidebar-sheet')).focus({ preventScroll: false });
    const active = sidebarList.querySelector('.nav-item.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  });
}
function closeListSheet(returnFocus = true) {
  if (!document.body.classList.contains('list-open')) return;
  document.body.classList.remove('list-open');
  document.getElementById('btn-list').setAttribute('aria-expanded', 'false');
  document.getElementById('mob-step').setAttribute('aria-expanded', 'false');
  for (const id of LIST_SHEET_INERT) document.getElementById(id).inert = false;
  if (returnFocus) {
    const target = listSheetReturn && listSheetReturn.isConnected && listSheetReturn.getClientRects().length ? listSheetReturn : activeDocPane();
    target.focus({ preventScroll: true });
  } else if (sidebarList.contains(document.activeElement)) {
    activeDocPane().focus({ preventScroll: true });
  }
  listSheetReturn = null;
}
document.getElementById('btn-list').addEventListener('click', e => {
  e.stopPropagation();
  if (document.body.classList.contains('list-open')) closeListSheet();
  else openListSheet();
});
document.getElementById('mob-step').addEventListener('click', e => {
  e.stopPropagation();
  openListSheet();
});
document.getElementById('btn-close-sidebar-sheet').addEventListener('click', () => closeListSheet());
document.getElementById('btn-rail').addEventListener('click', () => toggleSidebar());
document.getElementById('mobile-sheet-backdrop').addEventListener('click', () => {
  if (openMenuState) closeMenu(openMenuState.id, true);
  else closeListSheet();
});

/* ── Keyboard ───────────────────────────────────────────────────────────── */

function isTextEntryElement(el) {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'];
  return !nonText.includes((el.type || '').toLowerCase());
}

// Single-letter shortcuts act only while reading: focus on the page itself, in a document
// pane or in the change list – never on a toolbar control, in a dialog or anything editable.
function isShortcutFocusContext(el) {
  if (!el || el === document.body || el === document.documentElement) return true;
  if (isTextEntryElement(el) || (el.closest && el.closest('[contenteditable], .clause-inline-editor, dialog'))) {
    return false;
  }
  return Boolean(el.closest && el.closest('#pane-left, #pane-right, #pane-unified, #sidebar-list'));
}

window.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  const activeEl = document.activeElement;
  const key = (e.key || '').toLowerCase();
  const comparing = document.body.classList.contains('is-comparing');
  const dialogOpen = Boolean(document.querySelector('dialog[open]'));

  // Ctrl/Cmd+F opens the find-in-document bar instead of the browser's.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'f' && comparing && !dialogOpen) {
    e.preventDefault();
    openSearch();
    return;
  }
  if (isTextEntryElement(activeEl)) return;
  // Never act behind an open dialog.
  if (dialogOpen) return;

  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    // Only the explicit undo / redo combos are ours; Ctrl/Cmd+C, +K, +J, +H … stay with the browser.
    if (key === 'z' && !e.shiftKey) {
      if (state.undoStack.length > 0) {
        e.preventDefault();
        performUndo();
        announceHistory('toastUndone');
      }
    } else if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)) {
      if (state.redoStack.length > 0) {
        e.preventDefault();
        performRedo();
        announceHistory('toastRedone');
      }
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (openMenuState) closeAllMenus(true);
    else if (!filesPop.hidden) closeFilesPop(true);
    else if (document.body.classList.contains('list-open')) closeListSheet();
    else if (!searchPanel.hidden) closeSearch(true);
    return;
  }
  // Single-character shortcuts (WCAG 2.1.4): can be switched off in the help dialog and
  // only apply while a comparison is shown and the document or the list has focus.
  if (!state.singleKeyShortcuts || !comparing) return;
  if (!isShortcutFocusContext(activeEl)) return;
  if (key === 'j') {
    e.preventDefault();
    stepChange(1);
  } else if (key === 'k') {
    e.preventDefault();
    stepChange(-1);
  } else if (key === 'a') {
    e.preventDefault();
    runReviewAction('accept', Boolean(activeEl && activeEl.closest && activeEl.closest('#sidebar-list')));
  } else if (key === 'r') {
    e.preventDefault();
    runReviewAction('reject', Boolean(activeEl && activeEl.closest && activeEl.closest('#sidebar-list')));
  } else if (key === 'e') {
    e.preventDefault();
    if (isTabletOrSmaller()) closeListSheet(false);
    runReviewAction('edit', false);
  } else if (e.key === '/') {
    e.preventDefault();
    openSearch();
  }
});

/* ── Starting over, languages, theme ───────────────────────────────────── */

function clearComparison() {
  cancelPendingUploads();
  closeSearch(false);
  state.leftText = '';
  state.rightText = '';
  state.leftName = '';
  state.rightName = '';
  state.leftFormat = '';
  state.rightFormat = '';
  state.docSources = { left: null, right: null };
  state.activeRowId = null;
  state.hoveredRowId = null;
  state.sidebarFilter = 'all';
  state.statusFilter = 'all';
  state.searchQuery = '';
  state.pageBreaks = null;
  resetEditHistory();
  searchInput.value = '';
  fileInputLeft.value = '';
  fileInputRight.value = '';
  runComparison();
}

// A hosted page pinned to one language points browsers set to the other language to their page.
(function showOtherLanguagePageHint() {
  const hint = document.getElementById('lang-hint');
  const link = document.getElementById('lang-hint-link');
  if (!hint || !link || !pageLang || !/^https?:$/.test(location.protocol)) return;
  const browserLang = (navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'en';
  if (browserLang === pageLang) return;
  link.textContent = I18N[browserLang].otherPageHint;
  link.lang = browserLang;
  link.href = pageLang === 'de' ? 'en/' : '../';
  hint.hidden = false;
})();

function toggleLanguage() {
  const langHint = document.getElementById('lang-hint');
  if (langHint) langHint.hidden = true;
  state.lang = state.lang === 'de' ? 'en' : 'de';
  if (state.leftFormat === 'DEMO' && state.rightFormat === 'DEMO') {
    const sample = SAMPLES[state.lang] || SAMPLES.de;
    state.leftName = t('sampleLeftName');
    state.leftText = sample.v1;
    state.rightName = t('sampleRightName');
    state.rightText = sample.v2;
    resetEditHistory();
  }
  applyTranslationsToStaticDom();
  runComparison();
}
document.getElementById('btn-lang').addEventListener('click', toggleLanguage);
const footerLangLink = document.getElementById('footer-lang-link');
if (footerLangLink) {
  footerLangLink.addEventListener('click', e => {
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      toggleLanguage();
    }
  });
}

function applyTheme() {
  const systemDark = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  state.dark = state.themePref === 'dark' || (state.themePref === 'system' && systemDark);
  document.documentElement.classList.toggle('dark', state.dark);
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.innerHTML = state.dark
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'
      : '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
  }
  document.querySelectorAll('[data-theme-pref]').forEach(el => setMenuChecked(el, el.getAttribute('data-theme-pref') === state.themePref));
}

function setThemePref(pref) {
  state.themePref = pref;
  applyTheme();
}

document.getElementById('btn-theme').addEventListener('click', () => setThemePref(state.dark ? 'light' : 'dark'));

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.themePref === 'system') applyTheme();
  });
}

document.getElementById('btn-swap-docs').addEventListener('click', () => {
  [state.leftText, state.rightText] = [state.rightText, state.leftText];
  [state.leftName, state.rightName] = [state.rightName, state.leftName];
  [state.leftFormat, state.rightFormat] = [state.rightFormat, state.leftFormat];
  state.docSources = { left: state.docSources.right, right: state.docSources.left };
  resetEditHistory();
  runComparison();
  btnFiles.focus();
});

/* ── Dialogs: paste text, help, legal ──────────────────────────────────── */

const pasteModal = document.getElementById('paste-modal');
const textareaLeft = document.getElementById('textarea-left');
const textareaRight = document.getElementById('textarea-right');

// The dialog shows plain text only: page breaks and header/footer metadata of loaded
// documents are removed for display. If a side is applied unchanged, the loaded document
// (with its metadata) is kept; edited or new text is sanitized, so typed text can never be
// interpreted as metadata.
const pasteModalShown = { left: '', right: '' };

function openPasteModal() {
  pasteModalShown.left = docTextToPlainText(state.leftText);
  pasteModalShown.right = docTextToPlainText(state.rightText);
  textareaLeft.value = pasteModalShown.left;
  textareaRight.value = pasteModalShown.right;
  pasteModal.showModal();
}

document.getElementById('btn-close-modal').addEventListener('click', () => pasteModal.close());
document.getElementById('btn-cancel-modal').addEventListener('click', () => pasteModal.close());
document.getElementById('btn-apply-modal').addEventListener('click', () => {
  const leftChanged = textareaLeft.value !== pasteModalShown.left;
  const rightChanged = textareaRight.value !== pasteModalShown.right;
  if (leftChanged) {
    state.leftText = sanitizeExternalText(textareaLeft.value);
    state.leftName = '';
    state.leftFormat = '';
    state.docSources.left = null;
  }
  if (rightChanged) {
    state.rightText = sanitizeExternalText(textareaRight.value);
    state.rightName = '';
    state.rightFormat = '';
    state.docSources.right = null;
  }
  if (leftChanged || rightChanged) resetEditHistory();
  if (state.leftText.trim() && !state.leftName) {
    state.leftName = t('manualLeft');
    state.leftFormat = 'TEXT';
  }
  if (state.rightText.trim() && !state.rightName) {
    state.rightName = t('manualRight');
    state.rightFormat = 'TEXT';
  }
  pasteModal.close();
  runComparison();
});

const helpModal = document.getElementById('help-modal');
const chkSingleKeyShortcuts = document.getElementById('chk-single-key-shortcuts');
function openHelp() {
  chkSingleKeyShortcuts.checked = state.singleKeyShortcuts;
  helpModal.showModal();
}
document.getElementById('btn-help').addEventListener('click', openHelp);
chkSingleKeyShortcuts.addEventListener('change', () => {
  state.singleKeyShortcuts = chkSingleKeyShortcuts.checked;
});
document.getElementById('btn-close-help').addEventListener('click', () => helpModal.close());
document.getElementById('btn-ok-help').addEventListener('click', () => helpModal.close());
document.getElementById('btn-help-sample').addEventListener('click', () => {
  helpModal.close();
  loadSampleComparison();
});

const privacyModal = document.getElementById('privacy-modal');
document.getElementById('btn-close-privacy').addEventListener('click', () => privacyModal.close());
document.getElementById('btn-ok-privacy').addEventListener('click', () => privacyModal.close());

if (!('closedBy' in HTMLDialogElement.prototype)) {
  [pasteModal, helpModal, privacyModal].forEach(dlg => {
    dlg.addEventListener('click', event => {
      if (event.target !== dlg) return;
      const rect = dlg.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      dlg.close();
    });
  });
}

// An action started from a menu item that opens a dialog: focus returns to the menu button
// (the item itself is hidden once the menu closes).
[pasteModal, helpModal, privacyModal].forEach(dlg => {
  dlg.addEventListener('close', () => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.getClientRects().length) {
      const fallback = document.body.classList.contains('is-comparing') ? document.getElementById('btn-more') : null;
      if (fallback && fallback.getClientRects().length) fallback.focus();
    }
  });
});

/* ── Toast: a short confirmation, with "Rückgängig" for reviews and edits ─ */

const toastEl = document.getElementById('toast');
const toastMsg = document.getElementById('toast-msg');
const toastAction = document.getElementById('toast-action');
let toastTimer = null;
let toastRun = null;
const TOAST_MS = 6000;

// Screen readers hear the message through the shared live region; the toast itself is visual.
function showToast(message, action) {
  clearTimeout(toastTimer);
  toastMsg.textContent = message;
  toastRun = action ? action.run : null;
  toastAction.hidden = !action;
  toastAction.textContent = action ? action.label : '';
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('is-visible'));
  if (!action) announce(message);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  clearTimeout(toastTimer);
  const hadFocus = toastEl.contains(document.activeElement);
  toastEl.classList.remove('is-visible');
  toastEl.hidden = true;
  toastRun = null;
  if (hadFocus) focusPageFallback();
}

// Focus somewhere sensible on the visible page: the document, or the landing heading.
function focusPageFallback() {
  const pane = activeDocPane();
  const target = document.body.classList.contains('is-comparing') && pane.getClientRects().length ? pane : document.getElementById('landing-title');
  if (target && target.getClientRects().length) target.focus({ preventScroll: true });
}

function showUndoToast(key) {
  showToast(t(key), {
    label: t('toastUndo'),
    run: () => {
      performUndo();
      announceHistory('toastUndone');
    },
  });
}

toastAction.addEventListener('click', () => {
  const run = toastRun;
  hideToast();
  if (run) run();
  // The action can switch views (undoing a cleared comparison); keep focus on the page.
  const active = document.activeElement;
  if (!active || active === document.body || !active.getClientRects().length) focusPageFallback();
});
// Hovering or focusing the toast keeps it.
toastEl.addEventListener('pointerenter', () => clearTimeout(toastTimer));
toastEl.addEventListener('pointerleave', () => (toastTimer = setTimeout(hideToast, 2500)));
toastEl.addEventListener('focusin', () => clearTimeout(toastTimer));

/* ── Scan error wording: "„scan.pdf“ ist ein Scan ohne Text. …" ─────────── */

(function wrapImportNotice() {
  const original = window.showImportNotice;
  if (typeof original !== 'function') return;
  window.showImportNotice = function showImportNoticeWithScanWording(message, kind) {
    const m = typeof message === 'string' && message.match(/^.*?[„“"]([^“”"]+)[“”"]: (.*)$/);
    // A scanned PDF and an image (also one renamed to .pdf) get the same message.
    if (m && (m[2] === t('errScannedPdf') || m[2] === t('errImage'))) message = formatMsg('errScannedPdfFile', { name: m[1] });
    // English text uses English quotation marks.
    else if (m && state.lang === 'en') message = message.replace(`„${m[1]}“`, `“${m[1]}”`);
    const result = original.call(this, message, kind);
    placeImportNotice();
    return result;
  };
})();

// Errors on the start page appear in the flow under the two file slots (the affected one gets
// an error border), never floating over the page.
let lastImportSide = null;
(function trackImportSide() {
  const upload = window.handleFileUpload;
  if (typeof upload === 'function') {
    window.handleFileUpload = function trackedFileUpload(file, side) {
      lastImportSide = side === 'left' || side === 'right' ? side : null;
      return upload.apply(this, arguments);
    };
  }
  const drop = window.handleDropFiles;
  if (typeof drop === 'function') {
    window.handleDropFiles = function trackedDropFiles(files, side) {
      lastImportSide = files && files.length === 1 && (side === 'left' || side === 'right') ? side : null;
      return drop.apply(this, arguments);
    };
  }
  const clear = window.clearImportNotice;
  if (typeof clear === 'function') {
    window.clearImportNotice = function clearImportNoticeAndSlots() {
      document.querySelectorAll('.drop-slot.has-error').forEach(el => el.classList.remove('has-error'));
      return clear.apply(this, arguments);
    };
  }
})();

function placeImportNotice() {
  const el = document.getElementById('import-notice');
  if (!el) return;
  const slots = document.querySelector('.drop-slots');
  const onLanding = !document.body.classList.contains('is-comparing') && slots && slots.getClientRects().length;
  document.querySelectorAll('.drop-slot.has-error').forEach(s => s.classList.remove('has-error'));
  if (onLanding) {
    if (el.previousElementSibling !== slots) slots.after(el);
    el.classList.add('is-inline');
    const slot = lastImportSide && document.getElementById(`lp-slot-${lastImportSide}`);
    if (slot && !el.classList.contains('is-warning')) slot.classList.add('has-error');
  } else {
    if (el.parentElement !== document.body) document.body.appendChild(el);
    el.classList.remove('is-inline');
  }
}
(function () {
})();

/* ── Tooltip (mouse hover and keyboard focus only; never after a tap) ──── */

const uiTooltip = document.getElementById('ui-tooltip');
let tooltipTimer = null;
let activeTooltipTarget = null;

function showTooltipFor(target) {
  const text = target && target.getAttribute('data-tooltip');
  if (!text || !uiTooltip) return;
  activeTooltipTarget = target;
  uiTooltip.textContent = text;
  uiTooltip.classList.add('is-visible');

  const rect = target.getBoundingClientRect();
  const ttRect = uiTooltip.getBoundingClientRect();
  let top = rect.bottom + 8;
  if (top + ttRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - ttRect.height - 8);
  let left = rect.left + rect.width / 2 - ttRect.width / 2;
  if (target.closest('#ruler')) {
    left = rect.left - ttRect.width - 10;
    top = rect.top + rect.height / 2 - ttRect.height / 2;
  }
  left = Math.max(8, Math.min(window.innerWidth - ttRect.width - 8, left));
  uiTooltip.style.top = `${Math.round(top)}px`;
  uiTooltip.style.left = `${Math.round(left)}px`;
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  activeTooltipTarget = null;
  if (!uiTooltip) return;
  uiTooltip.classList.remove('is-visible');
}

document.addEventListener('pointerover', e => {
  if (e.pointerType !== 'mouse') return;
  const target = e.target.closest && e.target.closest('[data-tooltip]');
  if (target === activeTooltipTarget) return;
  clearTimeout(tooltipTimer);
  if (!target) {
    hideTooltip();
    return;
  }
  tooltipTimer = setTimeout(() => showTooltipFor(target), target.closest('#ruler') ? 60 : 350);
});

document.addEventListener('focusin', e => {
  const target = e.target.closest && e.target.closest('[data-tooltip]');
  // Keyboard aid only: on touch screens a focus tooltip would cover what was just tapped.
  if (target && target.matches(':focus-visible') && !matchMedia('(pointer: coarse)').matches) showTooltipFor(target);
});

document.addEventListener('focusout', () => hideTooltip());
document.addEventListener('pointerdown', () => hideTooltip());
window.addEventListener('scroll', () => hideTooltip(), { capture: true, passive: true });

window.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  applyLayoutTier(true);
  setViewMode(state.viewMode);
  applyTranslationsToStaticDom();
  runComparison();
});
