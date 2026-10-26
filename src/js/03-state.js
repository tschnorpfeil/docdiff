// Layout tiers: phone < 768 px ≤ tablet < 1200 px ≤ desktop.
const PHONE_MAX = 767;
const TABLET_MAX = 1199;
function isPhoneWidth() {
  return typeof window !== 'undefined' && window.innerWidth <= PHONE_MAX;
}
function isTabletOrSmaller() {
  return typeof window !== 'undefined' && window.innerWidth <= TABLET_MAX;
}
const isMacPlatform =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');

const initialDark =
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;
if (typeof document !== 'undefined') {
  document.documentElement.classList.toggle('dark', initialDark);
}

// Phones and tablets in portrait start in one column.
const initialInline =
  typeof window !== 'undefined' && (isPhoneWidth() || (isTabletOrSmaller() && window.innerHeight > window.innerWidth));

const state = {
  lang: initialLang,
  dark: initialDark,
  themePref: 'system', // 'light' | 'dark' | 'system'
  viewMode: initialInline ? 'inline' : 'split', // 'split' | 'inline'
  viewModeChosen: false,
  // null = automatic (on for documents with real pages: PDF / DOCX / the example)
  pageBreaks: null,
  leftText: '',
  rightText: '',
  leftName: '',
  rightName: '',
  leftFormat: '',
  rightFormat: '',
  // The .docx files as loaded ({ name, bytes, importedText }): the Word export keeps their format.
  docSources: { left: null, right: null },
  alignedRows: [],
  changeRows: [],
  listItems: [],
  hoveredRowId: null,
  activeRowId: null,
  onlyChanges: false,
  ignoreHeadersFooters: true,
  filteredHfCount: 0,
  rightAllBlocks: [],
  sidebarFilter: 'all', // kind: all | modified | inserted | deleted
  statusFilter: 'all', // all | open | reviewed
  sidebarOpen: true,
  searchQuery: '',
  isProgrammaticScroll: false,
  // Review status per change (see 06d-review.js), kept in undo / redo snapshots.
  reviews: {},
  undoStack: [],
  redoStack: [],
  singleKeyShortcuts: true,
};

function t(key) {
  return I18N[state.lang][key] || I18N.de[key] || key;
}

const paneLeft = document.getElementById('pane-left');
const paneRight = document.getElementById('pane-right');
const paneUnified = document.getElementById('pane-unified');
const sheetLeft = document.getElementById('sheet-left');
const sheetRight = document.getElementById('sheet-right');
const sheetUnified = document.getElementById('sheet-unified');
const sidebarList = document.getElementById('sidebar-list');

// Shows `text` in the custom tooltip (mouse hover and keyboard focus only). Icon-only buttons
// also get it as their accessible name; `name` overrides the accessible name.
function setTooltip(el, text, name) {
  if (!el) return;
  el.setAttribute('data-tooltip', text);
  el.removeAttribute('title');
  if (name) {
    el.setAttribute('aria-label', name);
  } else if (el.matches('button, a') && !el.textContent.trim()) {
    el.setAttribute('aria-label', text);
  }
}

// Ctrl / ⌘ according to the platform.
function modKeyLabel() {
  return isMacPlatform ? '⌘' : t('kbdCtrl');
}
function redoKeyLabel() {
  return isMacPlatform ? '⇧⌘Z' : `${t('kbdCtrl')}+Y`;
}
function undoKeyLabel() {
  return isMacPlatform ? '⌘Z' : `${t('kbdCtrl')}+Z`;
}

function formatMsg(key, params = {}) {
  return t(key).replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : ''));
}

// "1 Änderung" / "19 Änderungen"
function changesTitle(n) {
  return n === 1 ? t('listTitleOne') : formatMsg('listTitle', { n });
}

// Polite announcements for screen readers (one shared live region, never chatty).
let srStatusTimer = null;
function announce(message) {
  const el = document.getElementById('sr-status');
  if (!el) return;
  clearTimeout(srStatusTimer);
  el.textContent = '';
  srStatusTimer = setTimeout(() => {
    el.textContent = message;
  }, 60);
}

function applyDataI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  document.querySelectorAll('[data-i18n-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-label')));
  });
}

function applyTranslationsToStaticDom() {
  document.documentElement.lang = state.lang;
  document.title = t('metaTitle');
  applyDataI18n();
  const btnLang = document.getElementById('btn-lang');
  // Named by the language it switches to, in that language.
  const target = state.lang === 'de' ? 'en' : 'de';
  btnLang.textContent = t('langTarget');
  btnLang.setAttribute('lang', target);
  setTooltip(btnLang, t('langTitle'));
  const footerLang = document.getElementById('footer-lang-link');
  if (footerLang) {
    footerLang.textContent = t('langTarget');
    footerLang.setAttribute('lang', target);
    footerLang.setAttribute('hreflang', target);
    footerLang.setAttribute('href', target === 'en' ? 'https://docdiff.app/en/' : 'https://docdiff.app/');
  }
  const menuLang = document.querySelector('#menu-lang [data-i18n="langMenu"]');
  if (menuLang) menuLang.setAttribute('lang', target);
  setTooltip(document.getElementById('btn-theme'), t('themeTitle'));
  setTooltip(document.getElementById('btn-prev'), t('prevTitle'), t('prevLabel'));
  setTooltip(document.getElementById('btn-next'), t('nextTitle'), t('nextLabel'));
  setTooltip(document.getElementById('btn-search'), formatMsg('searchTitle', { mod: modKeyLabel() }), t('searchLabel'));
  setTooltip(document.getElementById('btn-search-prev'), t('searchPrev'));
  setTooltip(document.getElementById('btn-search-next'), t('searchNext'));
  setTooltip(document.getElementById('btn-search-close'), t('searchClose'));
  setTooltip(document.getElementById('btn-more'), t('moreLabel'));
  document.getElementById('search-input').placeholder = t('searchPlaceholder');
  document.getElementById('textarea-left').placeholder = t('modalLeftPh');
  document.getElementById('textarea-right').placeholder = t('modalRightPh');
  document.getElementById('i18n-help-body').innerHTML = formatMsg('helpBodyHtml', {
    mod: modKeyLabel(),
    redo: redoKeyLabel(),
  });
  document.getElementById('i18n-privacy-body').innerHTML = t('privacyBodyHtml');
  updateFileLabels();
}

// One rule for every shortened file name: keep the part that tells the two files apart and
// the extension, cut in the middle. The second name of a pair drops the start both share:
// "werkvertrag_v…1.pdf → …2.pdf".
function truncateFileName(name, other, max, second = false) {
  const chars = Array.from(String(name || ''));
  if (chars.length <= max) return chars.join('');
  const o = Array.from(String(other || ''));
  let d = 0;
  while (d < chars.length && d < o.length && chars[d] === o[d]) d++;
  const tail = chars.slice(d);
  if (d > 4 && tail.length && tail.length + 1 <= max) {
    if (second) return '…' + tail.join('');
    const room = max - 1 - tail.length;
    return (room >= 4 ? chars.slice(0, room).join('') : '') + '…' + tail.join('');
  }
  // Tight space: the start of the distinguishing part plus the extension ("…1_Vor….docx").
  const extTail = (/\.[A-Za-z0-9]{1,5}$/.exec(tail.join('')) || [''])[0];
  if (d > 4 && tail.length > extTail.length + 2 && max >= extTail.length + 5) {
    const stem = tail.slice(0, tail.length - extTail.length);
    return '…' + stem.slice(0, max - 2 - extTail.length).join('') + '…' + extTail;
  }
  // No shared start (or the distinguishing part is too long): keep the start and the end with
  // the extension.
  const ext = (/\.[A-Za-z0-9]{1,5}$/.exec(chars.join('')) || [''])[0];
  const keepEnd = Math.max(ext.length + 3, Math.ceil((max - 1) * 0.45));
  const keepStart = Math.max(1, max - 1 - keepEnd);
  return chars.slice(0, keepStart).join('') + '…' + chars.slice(chars.length - keepEnd).join('');
}

// Narrow screens: only the parts that tell the two files apart, without the shared start (cut at
// a separator) and the shared extension: "Vertrag_v1_Vorher.docx" / "Vertrag_v2_Nachher.docx"
// become "v1_Vorher" / "v2_Nachher". Null when that does not give two short, different names.
function compactFilePair(left, right, max) {
  const a = Array.from(String(left || ''));
  const b = Array.from(String(right || ''));
  const extA = (/\.[A-Za-z0-9]{1,5}$/.exec(left) || [''])[0];
  const extB = (/\.[A-Za-z0-9]{1,5}$/.exec(right) || [''])[0];
  const stemA = a.slice(0, a.length - (extA === extB ? extA.length : 0));
  const stemB = b.slice(0, b.length - (extA === extB ? extB.length : 0));
  let d = 0;
  while (d < stemA.length && d < stemB.length && stemA[d] === stemB[d]) d++;
  while (d > 0 && !/[\s_\-.]/.test(stemA[d - 1])) d--;
  const outA = stemA.slice(d).join('').trim();
  const outB = stemB.slice(d).join('').trim();
  if (!outA || !outB || outA === outB) return null;
  if (Array.from(outA).length > max || Array.from(outB).length > max) return null;
  return [outA, outB];
}

// File names in the top bar button, its popover and the pane captions.
function updateFileLabels() {
  const left = state.leftName || t('noFileLeft');
  const right = state.rightName || t('noFileRight');
  const max = window.innerWidth >= 1440 ? 34 : window.innerWidth >= 1200 ? 26 : 12;
  const filesLeft = document.getElementById('files-left');
  const filesRight = document.getElementById('files-right');
  const compact = max <= 12 && state.leftName && state.rightName ? compactFilePair(left, right, 16) : null;
  filesLeft.textContent = compact ? compact[0] : truncateFileName(left, right, max);
  filesRight.textContent = compact ? compact[1] : truncateFileName(right, left, max, true);
  // Pane names for screen readers: "Alte Fassung: Vertrag_v1.docx".
  document.getElementById('pane-left').setAttribute('aria-label', `${t('colLeft')}: ${left}`);
  document.getElementById('pane-right').setAttribute('aria-label', `${t('colRight')}: ${right}`);
  document.getElementById('pane-unified').setAttribute('aria-label', `${t('paneUnifiedLabel')}: ${left} → ${right}`);
  document.getElementById('files-label').textContent = formatMsg('filesBtnLabel', { left, right });
  document.getElementById('fp-name-left').textContent = left;
  document.getElementById('fp-name-right').textContent = right;
  const unified = document.getElementById('filename-unified');
  if (unified) unified.textContent = `${left} → ${right}`;
  updateColumnMeta('left');
  updateColumnMeta('right');
}

function setViewMode(mode, opts = {}) {
  if (mode !== 'split' && mode !== 'inline') mode = 'split';
  // Phones only show one column.
  if (mode === 'split' && typeof isPhoneWidth === 'function' && isPhoneWidth()) mode = 'inline';
  const changed = state.viewMode !== mode;
  // The change in view before switching stays in view afterwards.
  const keepRowId = changed && document.body.classList.contains('is-comparing') ? state.activeRowId : null;
  state.viewMode = mode;
  if (opts.user) state.viewModeChosen = true;
  document.body.classList.toggle('view-inline', mode === 'inline');
  document.body.classList.toggle('view-split', mode === 'split');
  setMenuChecked('btn-mode-split', mode === 'split');
  setMenuChecked('btn-mode-inline', mode === 'inline');
  if (typeof placeReviewBar === 'function') placeReviewBar();
  requestAnimationFrame(() => {
    if (keepRowId && state.activeRowId === keepRowId) selectAndScrollToRow(keepRowId, false, true, { flash: false });
    if (typeof scheduleRulerDraw === 'function') scheduleRulerDraw();
  });
}

function setMenuChecked(id, on) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (el) el.setAttribute('aria-checked', String(Boolean(on)));
}

// Page breaks are shown by default for documents that have real pages (PDF, DOCX, the example).
function documentsHavePages() {
  return Boolean(lastComparison && lastComparison.result && (lastComparison.result.leftPages > 1 || lastComparison.result.rightPages > 1)) &&
    (state.rightAllBlocks || []).some(b => b.hasExplicitPage);
}
function pageBreaksShown() {
  return state.pageBreaks === null ? documentsHavePages() : state.pageBreaks;
}
function applyPageBreaks() {
  const on = pageBreaksShown();
  document.body.classList.toggle('no-page-breaks', !on);
  setMenuChecked('btn-page-breaks', on);
}
