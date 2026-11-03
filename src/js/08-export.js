/* ── Client-Side Multi-Format Export Engine (copy, .txt, .docx, print/PDF, HTML, Markdown) ── */

function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Simple `{name}` placeholder formatting for translated strings. */
function tf(key, vars) {
  return t(key).replace(/\{(\w+)\}/g, (m, name) => (vars && name in vars ? String(vars[name]) : m));
}

/* ── File names ───────────────────────────────────────────────────────────── */

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Turns an arbitrary document name into a safe file-name fragment: strips the extension,
 * path separators, characters invalid on Windows/macOS/Linux and control characters,
 * avoids reserved device names, and caps the length. Returns `fallback` if nothing remains.
 */
function sanitizeFileNamePart(name, fallback = '', maxLen = 60) {
  let s = String(name || '').normalize('NFC');
  s = s.split(/[\\/]/).pop();
  s = s.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  s = s
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\-]+|[._\-]+$/g, '');
  const chars = Array.from(s);
  if (chars.length > maxLen) s = chars.slice(0, maxLen).join('').replace(/[._\-]+$/, '');
  if (WINDOWS_RESERVED_NAME.test(s.split('.')[0])) s = `_${s}`;
  return s || fallback;
}

/**
 * Short, readable base name that contains both documents, newest first, e.g.
 * "Vertrag_v1.pdf" + "Vertrag_v2.pdf" -> "Vertrag_v2_vs_v1".
 */
function buildExportBaseName(leftName, rightName) {
  const left = sanitizeFileNamePart(leftName);
  const right = sanitizeFileNamePart(rightName);
  if (!left && !right) return 'DocDiff';
  if (!left || !right || left.toLowerCase() === right.toLowerCase()) return right || left;

  let common = 0;
  while (common < left.length && common < right.length && left[common] === right[common]) common++;
  const boundary = Math.max(left.lastIndexOf('_', common - 1), left.lastIndexOf('-', common - 1));
  const leftShort = boundary >= 2 ? left.slice(boundary + 1) : left;
  return `${right}_vs_${leftShort || left}`;
}

function buildExportFileName(suffixKey, ext) {
  const base = buildExportBaseName(state.leftName, state.rightName);
  const suffix = sanitizeFileNamePart(t(suffixKey), 'Export');
  const name = `${base}_${suffix}`;
  const chars = Array.from(name);
  const capped = chars.length > 140 ? chars.slice(0, 140).join('').replace(/[._\-]+$/, '') : name;
  return `${capped}.${ext}`;
}

/* ── Shared export model ──────────────────────────────────────────────────── */

function getDisplayDocName(side) {
  const name = side === 'left' ? state.leftName : state.rightName;
  return name || t(side === 'left' ? 'exportFallbackLeft' : 'exportFallbackRight');
}

function getExportTitle() {
  return tf('exportTitleFmt', { left: getDisplayDocName('left'), right: getDisplayDocName('right') });
}

/**
 * The changes of the comparison with their review status, exactly as the change list shows them
 * (same order, same count: an identical header/footer change on several pages is one change),
 * including rejected changes. Falls back to the change rows while the review index is not current.
 */
function getExportItems() {
  if (
    Array.isArray(state.listItems) &&
    state.listItems.length &&
    state.listItems.every(i => itemMembers(i).every(m => state.alignedRows.includes(m.row)))
  ) {
    return state.listItems.map((item, i) => ({ ...item, index: i + 1 }));
  }
  return state.changeRows.map((row, i) => ({
    id: row.id,
    rowId: row.id,
    row,
    type: row.type,
    status: row.reviewStatus === 'accepted' ? 'accepted' : 'open',
    ghost: null,
    index: i + 1,
  }));
}

function getExportCounts(items = getExportItems()) {
  const counts = { modified: 0, inserted: 0, deleted: 0, total: 0, accepted: 0, rejected: 0 };
  for (const item of items) {
    if (item.type in counts) {
      counts[item.type]++;
      counts.total++;
    }
    if (item.status === 'accepted') counts.accepted++;
    if (item.status === 'rejected') counts.rejected++;
  }
  return counts;
}

/** "3 von 22 geprüft (2 angenommen, 1 abgelehnt)", or '' while nothing has been reviewed. */
function getExportReviewLine(counts = getExportCounts()) {
  const k = counts.accepted + counts.rejected;
  if (!k) return '';
  return tf('exportReviewFmt', { k, n: counts.total, a: counts.accepted, r: counts.rejected });
}

function getExportStatusLabel(status) {
  return status === 'accepted' ? t('statusAccepted') : status === 'rejected' ? t('statusRejected') : t('statusOpen');
}

/** Reference as the change list shows it ("§ 1 (2)", "Kopf-/Fußzeile – auf 3 Seiten …"). */
function getExportItemRef(item) {
  return getItemRef(item);
}

/** "S. 2" or, for a change on several pages, "S. 1–3". */
function getExportItemPages(item) {
  const pages = itemMembers(item).map(m => getItemPage(m));
  const min = Math.min(...pages);
  const max = Math.max(...pages);
  return min === max ? String(min) : `${min}–${max}`;
}
function getExportItemPageLabel(item) {
  return `${t('pageShort')} ${getExportItemPages(item)}`;
}

function formatExportCountsLine(c) {
  return tf(c.total === 1 ? 'exportCountsFmtOne' : 'exportCountsFmt', { total: c.total, mod: c.modified, ins: c.inserted, del: c.deleted });
}

function formatExportDate(date) {
  try {
    return date.toLocaleString(state.lang === 'de' ? 'de-DE' : 'en-GB', {
      dateStyle: 'long',
      timeStyle: 'short',
    });
  } catch (e) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function getRowRefCode(row) {
  const b = row.rightBlock || row.leftBlock;
  return (b && b.refCode) || '';
}

function getRowTypeLabel(row) {
  return row.type === 'modified'
    ? t('typeMod')
    : row.type === 'inserted'
    ? t('typeIns')
    : row.type === 'deleted'
    ? t('typeDel')
    : '';
}

/** Tag of a row in the report body: "Geändert · § 1 (1) · angenommen". */
function getRowReportTag(row) {
  if (row.type === 'equal') {
    return row.ghostNote ? `${t('statusRejected')} · ${t('exportRejectedNote')}` : '';
  }
  const parts = [getRowTypeLabel(row), getDisplayRef(row)].filter(Boolean);
  if (row.reviewStatus === 'accepted') parts.push(t('statusAccepted'));
  return parts.join(' · ');
}

/** Rows that go into a report body: honours the "changes only" filter. */
function getExportBodyRows() {
  return state.onlyChanges ? state.changeRows : state.alignedRows;
}

function getExportScopeText() {
  return state.onlyChanges ? t('exportScopeChanges') : t('exportScopeFull');
}

function getExportHfText() {
  if (!state.ignoreHeadersFooters) return t('exportHfIncluded');
  return state.filteredHfCount > 0
    ? tf('exportHfIgnoredCount', { n: state.filteredHfCount })
    : t('exportHfIgnored');
}

/**
 * Internal intake markers (page separators and the header/footer tag) must never leak into an
 * export, even if a future intake path forgets to strip them.
 */
const INTERNAL_PAGE_MARKER = /^\s*===\s*\[(?:SEITE|PAGE)\s*\d+\]\s*===\s*$/i;
function isInternalMarkerLine(text) {
  return INTERNAL_PAGE_MARKER.test(text || '');
}
function cleanExportText(text) {
  return String(text || '')
    .replace(/===\s*\[(?:SEITE|PAGE)\s*\d+\]\s*===/gi, '')
    .replace(/\[\[HF\]\]\s*/g, '');
}

/**
 * Normalised diff tokens for one row: `{ value, removed?, added? }`. Change runs (including the
 * single spaces that bridge them) are grouped into one deletion followed by one insertion. The
 * tokens are guaranteed to reproduce the old text (all non-added) and the new text (all
 * non-removed) exactly; if the word diff ever disagrees, the row falls back to a whole-paragraph
 * replacement so that "Accept all" / "Reject all" in Word are always correct.
 */
function getExportDiffTokens(row) {
  const leftText = cleanExportText(row.leftBlock ? row.leftBlock.text : '');
  const rightText = cleanExportText(row.rightBlock ? row.rightBlock.text : '');
  if (row.type === 'equal') return [{ value: rightText }];
  if (row.type === 'inserted') return [{ value: rightText, added: true }];
  if (row.type === 'deleted') return [{ value: leftText, removed: true }];

  const diffs = row.wordDiffs || [];
  const isChange = tok => Boolean(tok && (tok.removed || tok.added));
  const isBridge = idx =>
    idx > 0 &&
    idx + 1 < diffs.length &&
    !isChange(diffs[idx]) &&
    /^\s+$/.test(diffs[idx].value) &&
    isChange(diffs[idx - 1]) &&
    isChange(diffs[idx + 1]);

  const out = [];
  let i = 0;
  while (i < diffs.length) {
    if (!isChange(diffs[i])) {
      const last = out[out.length - 1];
      const value = cleanExportText(diffs[i].value);
      if (last && !last.removed && !last.added) last.value += value;
      else out.push({ value });
      i++;
      continue;
    }
    let del = '';
    let ins = '';
    while (i < diffs.length && (isChange(diffs[i]) || isBridge(i))) {
      const value = cleanExportText(diffs[i].value);
      if (!diffs[i].added) del += value;
      if (!diffs[i].removed) ins += value;
      i++;
    }
    if (del) out.push({ value: del, removed: true });
    if (ins) out.push({ value: ins, added: true });
  }

  const oldJoined = out.filter(tok => !tok.added).map(tok => tok.value).join('');
  const newJoined = out.filter(tok => !tok.removed).map(tok => tok.value).join('');
  if (oldJoined !== leftText || newJoined !== rightText) {
    return [
      { value: leftText, removed: true },
      { value: rightText, added: true },
    ];
  }
  return out;
}

/** Short "old → new" summary of a change (a row or a list item), used by the change lists. */
function getRowChangeSummary(rowOrItem, maxLen = 70) {
  const item = rowOrItem.row ? rowOrItem : { row: rowOrItem, type: rowOrItem.type, ghost: null };
  const texts = item.ghost
    ? { left: item.ghost.leftText || '', right: item.ghost.rightText || '' }
    : { left: item.row.leftBlock ? item.row.leftBlock.text : '', right: item.row.rightBlock ? item.row.rightBlock.text : '' };
  if (item.type === 'inserted') return { pairs: [{ del: '', ins: truncateClean(texts.right, maxLen * 2) }], more: 0 };
  if (item.type === 'deleted') return { pairs: [{ del: truncateClean(texts.left, maxLen * 2), ins: '' }], more: 0 };
  const diffs = item.ghost ? computeCleanWordDiff(texts.left, texts.right) : item.row.wordDiffs || [];
  const pairs = extractDeltaPairs(diffs);
  const visible = pairs.slice(0, 3).map(p => ({ del: truncateClean(p.del, maxLen), ins: truncateClean(p.ins, maxLen) }));
  return { pairs: visible, more: Math.max(0, pairs.length - visible.length) };
}

/* ── Final text (copy / .txt) ─────────────────────────────────────────────── */

/**
 * The new version as plain text, including all inline edits. Header/footer lines are page
 * furniture and are always left out, whether or not the header/footer filter is active.
 */
function buildFinalText() {
  return getFinalBlocks()
    .map(b => cleanExportText(b.text).trim())
    .filter(Boolean)
    .join('\n\n');
}

/* ── HTML report ──────────────────────────────────────────────────────────── */

function renderReportTokensHtml(tokens) {
  return tokens
    .map(tok => {
      const content = escapeHtml(tok.value);
      if (tok.removed) {
        return `<del><span class="sr">${escapeHtml(t('a11yRemovedStart'))} </span>${content}<span class="sr"> ${escapeHtml(t('a11yRemovedEnd'))}</span></del>`;
      }
      if (tok.added) {
        return `<ins><span class="sr">${escapeHtml(t('a11yAddedStart'))} </span>${content}<span class="sr"> ${escapeHtml(t('a11yAddedEnd'))}</span></ins>`;
      }
      return content;
    })
    .join('');
}

function renderReportSummaryPairsHtml(row) {
  const { pairs, more } = getRowChangeSummary(row);
  const items = pairs.map(p => {
    if (p.del && p.ins) {
      return `${renderReportTokensHtml([{ value: p.del, removed: true }])} <span aria-hidden="true">→</span> ${renderReportTokensHtml([{ value: p.ins, added: true }])}`;
    }
    if (p.ins) return renderReportTokensHtml([{ value: p.ins, added: true }]);
    return renderReportTokensHtml([{ value: p.del, removed: true }]);
  });
  if (more) items.push(`<span class="more">+${more} ${escapeHtml(moreDeltasText(more))}</span>`);
  return items.map(html => `<div>${html}</div>`).join('');
}

const REPORT_CSS = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1f2937; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb;
  --del-fg:#881337; --del-bg:#ffe4e6; --ins-fg:#14532d; --ins-bg:#dcfce7; --mod:#92400e; --link:#1d4ed8; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#111418; --fg:#e5e7eb; --muted:#9ca3af; --line:#2d333b; --card:#181c21;
    --del-fg:#fda4af; --del-bg:#4c0519; --ins-fg:#86efac; --ins-bg:#052e16; --mod:#fcd34d; --link:#93c5fd; }
}
* { box-sizing: border-box; }
html { background: var(--bg); color: var(--fg); }
body { margin: 0 auto; max-width: 860px; padding: 32px 24px 64px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; overflow-wrap: anywhere; }
a { color: var(--link); }
h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 12px; }
h2 { font-size: 1.15rem; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; font-size: .9rem; }
.meta dt { color: var(--muted); }
.meta dd { margin: 0; }
.counts { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 16px 0 0; }
.counts li { border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 8px 14px; min-width: 120px; }
.counts strong { display: block; font-size: 1.35rem; line-height: 1.2; }
.counts span { color: var(--muted); font-size: .85rem; }
.legend { font-size: .85rem; color: var(--muted); margin: 8px 0 16px; }
del { color: var(--del-fg); background: var(--del-bg); text-decoration: line-through; text-decoration-thickness: 1.5px; border-radius: 2px; padding: 0 2px; }
ins { color: var(--ins-fg); background: var(--ins-bg); text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 2px; border-radius: 2px; padding: 0 2px; }
del + ins { margin-left: .25em; }
.sr { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; }
caption { text-align: left; color: var(--muted); font-size: .85rem; padding-bottom: 6px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; }
td.num { white-space: nowrap; color: var(--muted); }
td.ref { white-space: nowrap; }
.badge { display: inline-block; font-size: .75rem; font-weight: 600; border: 1px solid currentColor; border-radius: 999px; padding: 0 8px; white-space: nowrap; }
.badge.modified { color: var(--mod); } .badge.inserted { color: var(--ins-fg); } .badge.deleted { color: var(--del-fg); }
.status { white-space: nowrap; }
.status.accepted, .status.rejected { font-weight: 600; }
.more { color: var(--muted); font-size: .8rem; }
.empty { padding: 16px; border: 1px dashed var(--line); border-radius: 8px; color: var(--muted); }
.doc { margin-top: 8px; }
.row { margin: 0 0 10px; padding: 2px 0 2px 14px; border-left: 3px solid transparent; }
.row.modified { border-left-color: var(--mod); } .row.inserted { border-left-color: var(--ins-fg); } .row.deleted { border-left-color: var(--del-fg); }
.row.kind-bullet, .row.kind-clause { padding-left: calc(14px + 2.2em); text-indent: -2.2em; }
.row.kind-hf { font-size: .8rem; color: var(--muted); font-style: italic; }
.row h3, .row h4, .row h5 { margin: 18px 0 4px; line-height: 1.35; }
.row h3 { font-size: 1.15rem; } .row h4 { font-size: 1.05rem; } .row h5 { font-size: 1rem; }
.row p { margin: 0; }
.row-tag { display: block; text-indent: 0; font-size: .75rem; color: var(--muted); margin-bottom: 2px; }
.row-tag a { color: inherit; }
.row:target { outline: 2px solid var(--link); outline-offset: 4px; border-radius: 2px; }
footer { margin-top: 48px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: .8rem; }
@media print {
  :root { --bg:#fff; --fg:#000; --muted:#444; --line:#bbb; --card:#fff; --del-fg:#7f1d1d; --del-bg:transparent; --ins-fg:#14532d; --ins-bg:transparent; --mod:#78350f; --link:#000; }
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body { max-width: none; padding: 0; font-size: 10.5pt; }
  a { text-decoration: none; }
  h2 { break-after: avoid; }
  tr, .row, .counts li { break-inside: avoid; }
  thead { display: table-header-group; }
  .row-tag a::after { content: none; }
}
`;

function buildExportHtmlReport(date = new Date()) {
  const items = getExportItems();
  const counts = getExportCounts(items);
  const title = getExportTitle();
  // Anchors: every changed row (all pages of a merged header/footer change), and the row a
  // rejected change was restored to. The first row of a change carries its id.
  const anchorIndex = new Map();
  items.forEach((item, i) => {
    for (const m of itemMembers(item)) {
      if (m.ghost && m.type === 'inserted') continue;
      if (!anchorIndex.has(m.rowId)) anchorIndex.set(m.rowId, i + 1);
    }
  });
  const anchorUsed = new Set();
  const anchorFor = row => {
    const n = anchorIndex.get(row.id);
    if (!n || anchorUsed.has(n)) return '';
    anchorUsed.add(n);
    return ` id="c${n}"`;
  };
  const reviewLine = getExportReviewLine(counts);

  const changeListHtml = items.length
    ? `<table>
<caption>${escapeHtml(t('exportChangeListCaption'))}</caption>
<thead><tr><th scope="col">#</th><th scope="col">${escapeHtml(t('exportColRef'))}</th><th scope="col">${escapeHtml(t('exportColType'))}</th><th scope="col">${escapeHtml(t('exportColStatus'))}</th><th scope="col">${escapeHtml(t('exportColChange'))}</th></tr></thead>
<tbody>
${items
  .map((item, i) => {
    const n = i + 1;
    const ref = getExportItemRef(item) || `#${n}`;
    const target = itemMembers(item).some(m => anchorIndex.get(m.rowId) === n) ? n : 0;
    const refHtml = target ? `<a href="#c${target}">${escapeHtml(ref)}</a>` : escapeHtml(ref);
    return `<tr><td class="num">${n}</td><td class="ref">${refHtml}<div class="more">${escapeHtml(getExportItemPageLabel(item))}</div></td><td><span class="badge ${item.type}">${escapeHtml(getRowTypeLabel(item))}</span></td><td class="status ${item.status}">${escapeHtml(getExportStatusLabel(item.status))}</td><td>${renderReportSummaryPairsHtml(item)}</td></tr>`;
  })
  .join('\n')}
</tbody>
</table>`
    : `<p class="empty">${escapeHtml(t('exportNoChanges'))}</p>`;

  const bodyRows = getExportBodyRows();
  const redlineHtml = bodyRows.length
    ? bodyRows
        .map(row => {
          const block = row.rightBlock || row.leftBlock;
          const kind = (block && block.kind) || 'p';
          const inner = renderReportTokensHtml(getExportDiffTokens(row));
          const tag = kind === 'h1' ? 'h3' : kind === 'h2' ? 'h4' : kind === 'h3' ? 'h5' : 'p';
          const tagText = getRowReportTag(row);
          const idAttr = anchorFor(row);
          const tagHtml = tagText ? `<span class="row-tag"><a href="#changes">${escapeHtml(tagText)}</a></span>` : '';
          return `<div class="row ${row.type} kind-${kind}"${idAttr}>${tagHtml}<${tag}>${inner}</${tag}></div>`;
        })
        .join('\n')
    : `<p class="empty">${escapeHtml(t('exportNoChanges'))}</p>`;

  const csp =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  return `<!DOCTYPE html>
<html lang="${state.lang === 'de' ? 'de' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="Doc Diff">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<dl class="meta">
<dt>${escapeHtml(t('exportLabelOriginal'))}</dt><dd>${escapeHtml(getDisplayDocName('left'))}</dd>
<dt>${escapeHtml(t('exportLabelRevised'))}</dt><dd>${escapeHtml(getDisplayDocName('right'))}</dd>
<dt>${escapeHtml(t('exportLabelCreated'))}</dt><dd><time datetime="${date.toISOString()}">${escapeHtml(formatExportDate(date))}</time></dd>
${reviewLine ? `<dt>${escapeHtml(t('exportLabelReview'))}</dt><dd>${escapeHtml(reviewLine)}</dd>\n` : ''}<dt>${escapeHtml(t('exportLabelScope'))}</dt><dd>${escapeHtml(getExportScopeText())}</dd>
<dt>${escapeHtml(t('exportLabelHf'))}</dt><dd>${escapeHtml(getExportHfText())}</dd>
</dl>
</header>
<main>
<section aria-labelledby="summary">
<h2 id="summary">${escapeHtml(t('exportSummaryHeading'))}</h2>
<ul class="counts">
<li><strong>${counts.total}</strong><span>${escapeHtml(t('exportCountTotal'))}</span></li>
<li><strong>${counts.modified}</strong><span>${escapeHtml(t('typeMod'))}</span></li>
<li><strong>${counts.inserted}</strong><span>${escapeHtml(t('typeIns'))}</span></li>
<li><strong>${counts.deleted}</strong><span>${escapeHtml(t('typeDel'))}</span></li>
</ul>
</section>
<section aria-labelledby="changes">
<h2 id="changes">${escapeHtml(t('exportChangesHeading'))}</h2>
${changeListHtml}
</section>
<section aria-labelledby="redline">
<h2 id="redline">${escapeHtml(t('exportRedlineHeading'))}</h2>
<p class="legend">${escapeHtml(t('exportLegendLabel'))}: <ins>${escapeHtml(t('exportLegendIns'))}</ins> · <del>${escapeHtml(t('exportLegendDel'))}</del>${state.onlyChanges ? ` · ${escapeHtml(t('exportScopeChanges'))}` : ''}</p>
<div class="doc">
${redlineHtml}
</div>
</section>
</main>
<footer>${escapeHtml(t('exportFooterNote'))}</footer>
</body>
</html>
`;
}

/* ── Markdown report ──────────────────────────────────────────────────────── */

/** Escapes inline Markdown syntax so document text can never be parsed as markup. */
function escapeMarkdownInline(text) {
  return String(text)
    .replace(/[\\`*_~[\]<>|]/g, '\\$&')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
}

/** Escapes characters that would start a block construct when they begin a line. */
function escapeMarkdownLineStart(line) {
  return line
    .replace(/^(\s*)([-+=>])/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2');
}

const MD_PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
function mdCharClass(ch) {
  if (!ch || /\s/.test(ch)) return 'space';
  return MD_PUNCT.test(ch) ? 'punct' : 'word';
}

/**
 * Renders diff tokens as Markdown: deletions as ~~strike~~ and insertions as **bold**.
 * Leading/trailing whitespace is moved outside the delimiters, and where CommonMark's
 * flanking rules would make `~~`/`**` fail (e.g. punctuation glued to a word), the
 * equivalent inline HTML <del>/<ins> is used instead.
 */
function renderMarkdownTokens(tokens) {
  const pieces = tokens.map(tok => ({ ...tok, text: escapeMarkdownInline(tok.value) }));
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (!p.removed && !p.added) {
      out += p.text;
      continue;
    }
    const m = p.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const lead = m[1];
    const core = m[2];
    const trail = m[3];
    if (!core) {
      if (p.added) out += p.text;
      continue;
    }
    const prevChar = (out + lead).slice(-1);
    let nextChar = '';
    if (trail) nextChar = ' ';
    else if (i + 1 < pieces.length) {
      const next = pieces[i + 1];
      nextChar = next.removed || next.added ? (/^\s/.test(next.text) ? ' ' : '*') : next.text.charAt(0);
    }
    const first = mdCharClass(core.charAt(0));
    const last = mdCharClass(core.charAt(core.length - 1));
    const opens = first !== 'punct' || mdCharClass(prevChar) !== 'word';
    const closes = last !== 'punct' || mdCharClass(nextChar) !== 'word';
    const wrapped =
      opens && closes
        ? p.removed
          ? `~~${core}~~`
          : `**${core}**`
        : p.removed
        ? `<del>${core}</del>`
        : `<ins>${core}</ins>`;
    // Keep a replaced passage readable: "~~old~~ **new**" rather than "~~old~~**new**".
    const gap = p.added && i > 0 && pieces[i - 1].removed && !lead && !/\s$/.test(out) ? ' ' : '';
    out += gap + lead + wrapped + trail;
  }
  return out;
}

function escapeMarkdownTableCell(text) {
  return String(text).replace(/\s*\n\s*/g, ' ');
}

function buildExportMarkdown(date = new Date()) {
  const items = getExportItems();
  const counts = getExportCounts(items);
  const changeIndex = new Map();
  items.forEach((item, i) => {
    for (const m of itemMembers(item)) if (!m.ghost && !changeIndex.has(m.rowId)) changeIndex.set(m.rowId, i + 1);
  });
  const reviewLine = getExportReviewLine(counts);
  const lines = [
    `# ${escapeMarkdownInline(getExportTitle())}`,
    '',
    `| ${escapeMarkdownInline(t('exportLabelDetail'))} | |`,
    '| --- | --- |',
    `| ${escapeMarkdownInline(t('exportLabelOriginal'))} | ${escapeMarkdownInline(getDisplayDocName('left'))} |`,
    `| ${escapeMarkdownInline(t('exportLabelRevised'))} | ${escapeMarkdownInline(getDisplayDocName('right'))} |`,
    `| ${escapeMarkdownInline(t('exportLabelCreated'))} | ${escapeMarkdownInline(formatExportDate(date))} |`,
    `| ${escapeMarkdownInline(t('exportLabelChanges'))} | ${escapeMarkdownInline(formatExportCountsLine(counts))} |`,
    ...(reviewLine ? [`| ${escapeMarkdownInline(t('exportLabelReview'))} | ${escapeMarkdownInline(reviewLine)} |`] : []),
    `| ${escapeMarkdownInline(t('exportLabelScope'))} | ${escapeMarkdownInline(getExportScopeText())} |`,
    `| ${escapeMarkdownInline(t('exportLabelHf'))} | ${escapeMarkdownInline(getExportHfText())} |`,
    '',
    `## ${escapeMarkdownInline(t('exportChangesHeading'))}`,
    '',
  ];

  if (items.length) {
    lines.push(
      `| # | ${escapeMarkdownInline(t('exportColRef'))} | ${escapeMarkdownInline(t('pageShort'))} | ${escapeMarkdownInline(t('exportColType'))} | ${escapeMarkdownInline(t('exportColStatus'))} | ${escapeMarkdownInline(t('exportColChange'))} |`,
      '| ---: | --- | ---: | --- | --- | --- |'
    );
    for (const [i, item] of items.entries()) {
      const n = i + 1;
      const { pairs, more } = getRowChangeSummary(item, 60);
      const summary = pairs
        .map(p => {
          if (p.del && p.ins) return `${renderMarkdownTokens([{ value: p.del, removed: true }])} → ${renderMarkdownTokens([{ value: p.ins, added: true }])}`;
          if (p.ins) return renderMarkdownTokens([{ value: p.ins, added: true }]);
          return renderMarkdownTokens([{ value: p.del, removed: true }]);
        })
        .concat(more ? [`+${more} ${escapeMarkdownInline(moreDeltasText(more))}`] : [])
        .join('<br>');
      lines.push(
        `| ${n} | ${escapeMarkdownInline(getExportItemRef(item) || `#${n}`)} | ${getExportItemPages(item)} | ${escapeMarkdownInline(getRowTypeLabel(item))} | ${escapeMarkdownInline(getExportStatusLabel(item.status))} | ${escapeMarkdownTableCell(summary)} |`
      );
    }
  } else {
    lines.push(escapeMarkdownInline(t('exportNoChanges')));
  }

  lines.push(
    '',
    `## ${escapeMarkdownInline(t('exportRedlineHeading'))}`,
    '',
    `> ${escapeMarkdownInline(t('exportLegendLabel'))}: **${escapeMarkdownInline(t('exportLegendIns'))}** · ~~${escapeMarkdownInline(t('exportLegendDel'))}~~${state.onlyChanges ? ` · ${escapeMarkdownInline(t('exportScopeChanges'))}` : ''}`,
    ''
  );

  for (const row of getExportBodyRows()) {
    const block = row.rightBlock || row.leftBlock;
    const kind = (block && block.kind) || 'p';
    const body = renderMarkdownTokens(getExportDiffTokens(row));
    if (!body.trim()) continue;
    const prefix = kind === 'h1' ? '### ' : kind === 'h2' ? '#### ' : kind === 'h3' ? '##### ' : '';
    const line = prefix ? prefix + body : escapeMarkdownLineStart(body);
    const tagText = getRowReportTag(row);
    if (tagText) {
      const n = changeIndex.get(row.id);
      lines.push(`<sub>${n ? `[${n}] ` : ''}${escapeMarkdownInline(tagText)}</sub>`, '');
    }
    lines.push(kind === 'hf' ? `<small>${line}</small>` : line, '');
  }

  lines.push('---', '', `*${escapeMarkdownInline(t('exportFooterNote'))}*`, '');
  return lines.join('\n');
}

/* ── Print / PDF ──────────────────────────────────────────────────────────── */

function cssString(str) {
  return `"${String(str).replace(/[\\"]/g, '\\$&').replace(/[\n\r\f]/g, ' ')}"`;
}

function renderPrintCellHtml(html, block) {
  if (!block) return '<td class="pv-cell pv-empty"></td>';
  const kind = block.kind || 'p';
  return `<td class="pv-cell kind-${kind}">${html}</td>`;
}

/**
 * Builds a print-only, paginated rendering. kind: 'split' (old and new side by side, landscape),
 * 'inline' (one column with the marks in the text, portrait) or 'final' (the new version with
 * every decision applied, as a clean document).
 */
function buildPrintViewHtml(date = new Date(), kind = state.viewMode) {
  if (kind === 'final') return buildFinalPrintHtml();
  const rows = getExportBodyRows();
  const counts = getExportCounts();
  const mode = kind === 'inline' ? 'inline' : 'split';
  const head = `
    <header class="pv-head">
      <div class="pv-title">${escapeHtml(getExportTitle())}</div>
      <div class="pv-meta">
        <span><strong>${escapeHtml(t('exportLabelOriginal'))}:</strong> ${escapeHtml(getDisplayDocName('left'))}</span>
        <span><strong>${escapeHtml(t('exportLabelRevised'))}:</strong> ${escapeHtml(getDisplayDocName('right'))}</span>
        <span><strong>${escapeHtml(t('exportLabelCreated'))}:</strong> ${escapeHtml(formatExportDate(date))}</span>
      </div>
      <div class="pv-meta">
        <span>${escapeHtml(formatExportCountsLine(counts))}</span>
        <span>${escapeHtml(getExportReviewLine(counts) || formatMsg('listProgress', { k: 0, n: counts.total }))}</span>
        <span>${escapeHtml(getExportScopeText())}</span>
        <span>${escapeHtml(t('exportLabelHf'))}: ${escapeHtml(getExportHfText())}</span>
      </div>
      <div class="pv-legend">${escapeHtml(t('exportLegendLabel'))}: <ins class="tok-ins">${escapeHtml(t('exportLegendIns'))}</ins> <del class="tok-del">${escapeHtml(t('exportLegendDel'))}</del></div>
    </header>`;

  const rowClass = row => `pv-row pv-${row.type}${row.reviewStatus === 'accepted' ? ' pv-accepted' : ''}`;
  const tagHtml = row =>
    !getRowReportTag(row)
      ? ''
      : `<span class="pv-tag">${escapeHtml(getRowReportTag(row))}</span>`;

  const groups = [];
  if (typeof pageBreaksShown === 'function' ? pageBreaksShown() : mode === 'pages') {
    const byPage = new Map();
    for (const row of rows) {
      const p = row.pageNum || 1;
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(row);
    }
    const totalPages = new Set(state.alignedRows.map(r => r.pageNum || 1)).size || 1;
    for (const [p, list] of byPage) {
      groups.push({ label: `${t('pageLabel')} ${p} ${t('pageOf')} ${totalPages}`, rows: list });
    }
  } else {
    groups.push({ label: '', rows });
  }

  let body;
  if (mode === 'inline') {
    body = groups
      .map(
        g => `<div class="pv-inline">${g.rows
          .map(row => {
            const block = row.rightBlock || row.leftBlock;
            return `<div class="${rowClass(row)} kind-${(block && block.kind) || 'p'}">${tagHtml(row)}${renderUnifiedBlockHtml(row, '', true)}</div>`;
          })
          .join('')}</div>`
      )
      .join('');
  } else {
    const thead = `<thead><tr><th scope="col">${escapeHtml(t('colLeft'))} · ${escapeHtml(getDisplayDocName('left'))}</th><th scope="col">${escapeHtml(t('colRight'))} · ${escapeHtml(getDisplayDocName('right'))}</th></tr></thead>`;
    // One table (the column header repeats on every printed page); in "pages" mode each original
    // page becomes its own <tbody> introduced by a page label that is kept with its first row.
    body = `<table class="pv-table">${thead}${groups
      .map(
        g => `<tbody>${
          g.label ? `<tr class="pv-page-head"><th colspan="2" scope="colgroup">${escapeHtml(g.label)}</th></tr>` : ''
        }${g.rows
          .map(
            row =>
              `<tr class="${rowClass(row)}">${renderPrintCellHtml(
                (row.type === 'deleted' || row.type === 'modified' ? tagHtml(row) : '') + renderLeftBlockHtml(row, ''),
                row.leftBlock
              )}${renderPrintCellHtml(
                (row.type === 'inserted' || row.type === 'modified' ? tagHtml(row) : '') + renderRightBlockHtml(row, ''),
                row.rightBlock
              )}</tr>`
          )
          .join('')}</tbody>`
      )
      .join('')}</table>`;
  }

  const emptyHtml = rows.length ? '' : `<p class="pv-empty-note">${escapeHtml(t('exportNoChanges'))}</p>`;
  return `${head}<main class="pv-body pv-mode-${mode}">${body}${emptyHtml}</main>`;
}

/** The new version as a clean document: every decision and edit applied, no marks. */
function buildFinalPrintHtml() {
  const blocks = getFinalBlocks();
  const html = blocks
    .map(block => {
      const text = cleanExportText(block.text).trim();
      if (!text) return '';
      const kind = block.kind || 'p';
      if (kind === 'h1' || kind === 'h2' || kind === 'h3') {
        const tag = kind === 'h1' ? 'h1' : kind === 'h2' ? 'h2' : 'h3';
        return `<${tag} class="pvf-${kind}">${escapeHtml(text)}</${tag}>`;
      }
      const indent = block.indent > 0 ? ` style="margin-left:${Math.min(block.indent, 6) * 1.6}em"` : '';
      const split = extractListMarker(text, kind);
      if (split) {
        return `<p class="pvf-item pvf-${kind}"${indent}><span class="pvf-marker">${escapeHtml(split.marker)}</span><span class="pvf-body">${escapeHtml(split.body)}</span></p>`;
      }
      return `<p class="pvf-p"${indent}>${escapeHtml(text)}</p>`;
    })
    .join('');
  return `<main class="pv-final" lang="${state.lang === 'de' ? 'de' : 'en'}">${html}</main>`;
}

/** Blocks of the new version as it stands now, without running headers and footers. */
function getFinalBlocks() {
  const blocks = state.alignedRows.length
    ? state.alignedRows.filter(r => r.rightBlock).map(r => r.rightBlock)
    : parseIntoBlocks(state.rightText || '');
  return blocks.filter(b => !b.isHeaderFooter && b.kind !== 'hf' && !isInternalMarkerLine(b.text));
}

// The print view requested from the export menu; Ctrl/Cmd+P prints the current view.
let requestedPrintKind = null;

function preparePrintView() {
  if (typeof ensureComparisonCurrent === 'function') ensureComparisonCurrent();
  if (!state.alignedRows.length) return;
  const kind = requestedPrintKind || (state.viewMode === 'inline' ? 'inline' : 'split');
  const date = new Date();
  let view = document.getElementById('print-view');
  if (!view) {
    view = document.createElement('div');
    view.id = 'print-view';
    view.className = 'print-view';
    view.setAttribute('aria-hidden', 'true');
    document.body.appendChild(view);
  }
  setSafeContainerHtml(view, buildPrintViewHtml(date, kind));

  let pageStyle = document.getElementById('print-page-style');
  if (!pageStyle) {
    pageStyle = document.createElement('style');
    pageStyle.id = 'print-page-style';
    document.head.appendChild(pageStyle);
  }
  const footerLeft =
    kind === 'final' ? getDisplayDocName('right') : `${getDisplayDocName('right')} ${t('exportVs')} ${getDisplayDocName('left')}`;
  const orientation = kind === 'split' ? 'landscape' : 'portrait';
  const margin = kind === 'final' ? '22mm 20mm 20mm 24mm' : '14mm 12mm 16mm';
  pageStyle.textContent = `@media print { @page { size: A4 ${orientation}; margin: ${margin};
    @bottom-left { content: ${cssString(footerLeft)}; font: 7.5pt sans-serif; color: #444; }
    @bottom-right { content: ${cssString(`${t('pageLabel')} `)} counter(page) ${cssString(` ${t('pageOf')} `)} counter(pages); font: 7.5pt sans-serif; color: #444; } } }`;
  document.body.classList.add('has-print-view');
}

function cleanupPrintView() {
  requestedPrintKind = null;
  document.body.classList.remove('has-print-view');
  const view = document.getElementById('print-view');
  if (view) view.remove();
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeprint', preparePrintView);
  window.addEventListener('afterprint', cleanupPrintView);
}

/* ── Copy to clipboard ────────────────────────────────────────────────────── */

function copyFinalTextToClipboard() {
  const finalText = buildFinalText();

  const flashCopied = () => {
    if (typeof showToast === 'function') showToast(t('toastCopied'));
  };

  const legacyCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = finalText;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let copied = false;
    try {
      copied = document.execCommand('copy') === true;
    } catch (e) {
      copied = false;
    } finally {
      document.body.removeChild(ta);
    }
    // Never claim "Copied" when nothing reached the clipboard.
    if (copied) flashCopied();
    else if (typeof showImportNotice === 'function') showImportNotice(t('copyFailed'), 'warning');
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(finalText).then(flashCopied).catch(legacyCopy);
  } else {
    legacyCopy();
  }
}

/* ── Dispatcher ───────────────────────────────────────────────────────────── */

// Downloads a file and confirms it with a short toast ("Word-Datei gespeichert: …").
function downloadWithToast(content, mimeType, filename, toastKey) {
  downloadBlob(content, mimeType, filename);
  if (typeof showToast === 'function') showToast(tf(toastKey, { name: filename }));
}

/** "Vertrag_v2_Endfassung.docx": named after the new version, which it is. */
function buildFinalFileName(ext) {
  const base = sanitizeFileNamePart(state.rightName, 'DocDiff', 100);
  return `${base}_${sanitizeFileNamePart(t('exportFileFinal'), 'Final')}.${ext}`;
}

/** The .docx the new version was read from, if it is still the loaded new version. */
function getRightDocxSource() {
  const src = state.docSources && state.docSources.right;
  if (!src || state.rightFormat !== 'DOCX' || src.name !== state.rightName || !src.bytes) return null;
  return src;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Word export. With a .docx as the new version, the file itself is the base (original format);
 * if that cannot be done reliably, the newly typeset document is used and the user is told.
 */
async function exportWord(kind) {
  const date = new Date();
  const source = getRightDocxSource();
  let bytes = null;
  let fellBack = false;
  if (source) {
    try {
      bytes = await buildDocxFromSource(source, parseIntoBlocks(state.rightText), state.alignedRows, kind, date);
    } catch (err) {
      fellBack = true;
      if (typeof console !== 'undefined') console.warn('Doc Diff: original-format Word export not possible:', err && err.message);
    }
  }
  if (fellBack && !window.confirm(t('confirmWordFallback'))) return false;
  if (!bytes) bytes = buildGeneratedDocx(kind, date);
  let filename = kind === 'final' ? buildFinalFileName('docx') : buildExportFileName('exportFileRedline', 'docx');
  if (fellBack) filename = filename.replace(/\.docx$/, '_Generated.docx');
  downloadBlob(bytes, DOCX_MIME, filename);
  if (fellBack && typeof showImportNotice === 'function') {
    showImportNotice(tf('noticeWordFallback', { name: filename }), 'warning');
  } else if (typeof showToast === 'function') {
    showToast(tf(source ? 'toastWordOriginal' : 'toastWord', { name: filename }));
  }
  return true;
}

function startPrint(kind) {
  if (!state.alignedRows.length) return;
  requestedPrintKind = kind;
  preparePrintView();
  window.print();
}

function handleExportAction(type) {
  // Commit an inline edit that is still open so the export reflects it.
  const openEditor = document.querySelector('.clause-inline-editor');
  if (openEditor) openEditor.blur();
  // A long document may still be re-compared in the worker after an edit or undo: export
  // the current text, not the rows from before.
  ensureComparisonCurrent();

  // Exports need a finished comparison. The menu is disabled until then; never substitute
  // sample content for (or overwrite) a document the user has loaded.
  if (!state.alignedRows.length) return;

  if (type === 'print' || type === 'print-split' || type === 'print-inline' || type === 'print-final') {
    const kind = type === 'print' ? (state.viewMode === 'inline' ? 'inline' : 'split') : type.slice(6);
    startPrint(kind);
  } else if (type === 'copy') {
    copyFinalTextToClipboard();
  } else if (type === 'txt') {
    downloadWithToast(`${buildFinalText()}\n`, 'text/plain;charset=utf-8', buildFinalFileName('txt'), 'toastTxt');
  } else if (type === 'word' || type === 'word-final') {
    exportWord(type === 'word' ? 'tracked' : 'final');
  } else if (type === 'html') {
    downloadWithToast(buildExportHtmlReport(), 'text/html;charset=utf-8', buildExportFileName('exportFileReport', 'html'), 'toastHtml');
  } else if (type === 'md') {
    downloadWithToast(buildExportMarkdown(), 'text/markdown;charset=utf-8', buildExportFileName('exportFileReport', 'md'), 'toastMd');
  }
}

/**
 * The descriptions in the export menu that depend on the documents: whether the Word file keeps
 * the original format, and that open changes are part of the final version.
 */
function updateExportMenuTexts() {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const source = getRightDocxSource();
  set('exp-desc-word-final', source ? tf('expWordFinalDescOriginal', { name: source.name }) : t('expWordFinalDescNew'));
  set('exp-desc-word', source ? tf('expWordDescOriginal', { name: source.name }) : t('expWordDesc'));
  const open = state.listItems.filter(item => item.status === 'open').length;
  set(
    'exp-sec-final-desc',
    open === 0 ? t('expSecFinalDesc') : open === 1 ? t('expSecFinalOpenOne') : tf('expSecFinalOpen', { n: open })
  );
}

/* ── Export availability ─────────────────────────────────────────────────── */

/** Really disables the export triggers (not just visually) while no comparison is available. */
function syncExportAvailability() {
  const available = document.body.classList.contains('is-comparing') && state.alignedRows.length > 0;
  for (const id of ['btn-export-menu', 'mob-btn-export']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = !available;
    btn.setAttribute('aria-disabled', String(!available));
  }
  if (!available && typeof closeMenu === 'function') closeMenu('export-menu', false);
}

if (typeof document !== 'undefined' && document.body && typeof MutationObserver !== 'undefined') {
  syncExportAvailability();
  new MutationObserver(syncExportAvailability).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
}
