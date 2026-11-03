/* ── Word export in the original format ────────────────────────────────────────────────────
 * When the new version was loaded from a .docx, the Word exports start from that very file
 * instead of a newly typeset document. Every paragraph whose text is unchanged is copied byte
 * for byte, so styles, numbering, tables, images, headers, footers and the page layout stay as
 * they were. Only paragraphs whose text differs are rewritten, run by run: words that stay keep
 * their character formatting, new words take the formatting of their neighbours.
 *
 * Two kinds:
 *   'final'   – the new version with every review decision and edit applied, no marks
 *   'tracked' – the same, plus every open change as a Word tracked change (old → new)
 *
 * The result is read back and compared with the expected text before it is offered. If
 * anything does not match (an unusual document structure, a change inside a text box), the
 * caller falls back to the newly typeset document. Pure string processing, no DOM, so it can be
 * unit-tested in Node.
 */

/* ── ZIP reading (all entries, as bytes) ─────────────────────────────────── */

async function inflateRaw(bytes, limit) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('zip: decompression limit exceeded');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Reads every entry of a ZIP archive: [{ name, data: Uint8Array }] in archive order. */
async function readZipEntries(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no central directory');
  const count = dv.getUint16(eocd + 10, true);
  if (count > 4096) throw new Error('zip: entry count limit exceeded');
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const out = [];
  const entryLimit = 64 * 1024 * 1024, totalLimit = 256 * 1024 * 1024;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const dataStart = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    const limit = Math.min(entryLimit, totalLimit - total);
    let data;
    if (method === 0) {
      if (raw.length > limit) throw new Error('zip: decompression limit exceeded');
      data = raw.slice();
    }
    else if (method === 8) data = await inflateRaw(raw, limit);
    else throw new Error(`zip: unsupported method ${method}`);
    total += data.length;
    out.push({ name, data });
  }
  return out;
}

/* ── A minimal XML reader that keeps source offsets ─────────────────────────
 * Elements: { name, start, openEnd, closeStart, end, selfClosing, children }; text between
 * elements is not needed (Word keeps text inside w:t, read from the source slice). Offsets let
 * untouched parts be copied verbatim.
 */
function parseXmlTree(xml) {
  const root = { name: '#root', start: 0, openEnd: 0, closeStart: xml.length, end: xml.length, children: [] };
  const stack = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('xml: unterminated comment');
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      if (e < 0) throw new Error('xml: unterminated CDATA');
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) throw new Error('xml: unterminated declaration');
      i = e + 1;
      continue;
    }
    // Find the end of the tag, honouring quoted attribute values (they may contain '>').
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= n) throw new Error('xml: unterminated tag');
    const tagEnd = j + 1;
    if (xml[lt + 1] === '/') {
      const name = xml.slice(lt + 2, j).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`xml: mismatched </${name}>`);
      node.closeStart = lt;
      node.end = tagEnd;
    } else {
      const m = /^[^\s/>]+/.exec(xml.slice(lt + 1, j));
      if (!m) throw new Error('xml: bad tag');
      const selfClosing = xml[j - 1] === '/';
      const node = { name: m[0], start: lt, openEnd: tagEnd, closeStart: tagEnd, end: tagEnd, selfClosing, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    i = tagEnd;
  }
  if (stack.length !== 1) throw new Error('xml: unclosed element');
  return root;
}

function xmlLocalName(node) {
  const k = node.name.indexOf(':');
  return k < 0 ? node.name : node.name.slice(k + 1);
}

function decodeXmlText(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch (err) {
      return '';
    }
  });
}

/* ── Paragraph content as "pieces" ─────────────────────────────────────────
 * A paragraph is flattened into pieces in reading order:
 *   atom   – one character of text (or a tab / line break / non-breaking hyphen element) with
 *            the run properties and the wrappers (hyperlink, content control, …) it sits in
 *   opaque – anything without text (bookmarks, images, field characters, comments, …); kept
 *            in place, never dropped
 * `cmp` is the comparable text of a piece (whitespace as one space, soft hyphens as nothing).
 */

const DOCX_WRAPPERS = new Set(['hyperlink', 'smartTag', 'customXml', 'fldSimple', 'dir', 'bdo']);
const DOCX_TEXT_LIKE = { tab: ' ', ptab: ' ', br: ' ', cr: ' ', noBreakHyphen: '-', softHyphen: '' };

function docxCmpChar(ch) {
  if (/^\s$/u.test(ch) || /[  -   　]/.test(ch)) return ' ';
  if (/[­​⁠﻿]/.test(ch)) return '';
  if (typeof LATIN_LIGATURES !== 'undefined' && LATIN_LIGATURES[ch]) return LATIN_LIGATURES[ch];
  return ch;
}

function flattenParagraph(p, xml, ctx) {
  const pieces = [];
  let pPr = '';
  const chainIds = new Map();
  const chainFor = (parent, wrapper) => {
    const ids = parent.map(w => w.id).concat(wrapper.id);
    const key = ids.join('/');
    if (!chainIds.has(key)) chainIds.set(key, parent.concat(wrapper));
    return chainIds.get(key);
  };
  const outer = node => xml.slice(node.start, node.end);

  const handleRun = (r, chain) => {
    const rPrNode = r.children.find(c => xmlLocalName(c) === 'rPr');
    const rPr = rPrNode ? outer(rPrNode) : '';
    for (const c of r.children) {
      const name = xmlLocalName(c);
      if (name === 'rPr') continue;
      if (name === 't') {
        const text = c.selfClosing ? '' : decodeXmlText(xml.slice(c.openEnd, c.closeStart));
        for (const ch of text) pieces.push({ type: 'atom', ch, rPr, chain, cmp: docxCmpChar(ch) });
      } else if (name in DOCX_TEXT_LIKE) {
        pieces.push({ type: 'atom', elem: outer(c), rPr, chain, cmp: DOCX_TEXT_LIKE[name] });
      } else if (name === 'footnoteReference' || name === 'endnoteReference') {
        pieces.push({ type: 'atom', elem: outer(c), rPr, chain, cmp: ctx.noteLabels.get(c.start) || '' });
      } else {
        // Field characters, field codes, drawings, comment references, …: kept as they are.
        pieces.push({ type: 'opaque', runChild: outer(c), rPr, chain, cmp: '' });
      }
    }
  };

  const walk = (node, chain) => {
    for (const c of node.children) {
      const name = xmlLocalName(c);
      if (node === p && name === 'pPr') {
        pPr = outer(c);
        continue;
      }
      if (name === 'r') handleRun(c, chain);
      else if (DOCX_WRAPPERS.has(name) && !c.selfClosing) {
        walk(c, chainFor(chain, { id: `w${c.start}`, open: xml.slice(c.start, c.openEnd), close: xml.slice(c.closeStart, c.end) }));
      } else if (name === 'sdt') {
        const content = c.children.find(x => xmlLocalName(x) === 'sdtContent');
        if (!content || content.selfClosing) pieces.push({ type: 'opaque', raw: outer(c), chain, cmp: '' });
        else walk(content, chainFor(chain, { id: `s${c.start}`, open: xml.slice(c.start, content.openEnd), close: xml.slice(content.closeStart, c.end) }));
      } else if ((name === 'ins' || name === 'moveTo') && !c.selfClosing) {
        // Text inserted by an earlier tracked change counts as text (as when it is read in).
        walk(c, chain);
      } else {
        pieces.push({ type: 'opaque', raw: outer(c), chain, cmp: '' });
      }
    }
  };
  walk(p, []);

  // One comparable space per whitespace run; none at the edges.
  let prevWs = true;
  for (const piece of pieces) {
    if (!piece.cmp) continue;
    if (piece.cmp === ' ') {
      if (prevWs) piece.cmp = '';
      prevWs = true;
    } else {
      prevWs = false;
    }
  }
  for (let k = pieces.length - 1; k >= 0; k--) {
    if (!pieces[k].cmp) continue;
    if (pieces[k].cmp === ' ') pieces[k].cmp = '';
    else break;
  }
  return { pPr, pieces, text: pieces.map(x => x.cmp).join('') };
}

/* ── Units: what the reader turned into one block ───────────────────────────
 * A paragraph outside tables is one unit; a table row is one unit (its cells joined with
 * " · ", as when the file is read in). Paragraphs nested in text boxes and rows of nested tables
 * are "locked": they are matched, but never rewritten.
 */
function collectDocxUnits(xml, tree) {
  const noteLabels = new Map();
  let fn = 0;
  let en = 0;
  const noteRe = /<([A-Za-z0-9_]+:)?(footnoteReference|endnoteReference)\b/g;
  let m;
  while ((m = noteRe.exec(xml))) {
    noteLabels.set(m.index, `[${m[2] === 'footnoteReference' ? ++fn : ++en}]`);
  }
  const ctx = { noteLabels };
  const units = [];
  const paraText = p => flattenParagraph(p, xml, ctx).text;

  const cellParas = (node, out, state) => {
    for (const c of node.children) {
      const name = xmlLocalName(c);
      if (name === 'p') out.push(c);
      else if (name === 'tbl') state.nested = true;
      else if (name === 'sdt' || name === 'sdtContent' || name === 'customXml') cellParas(c, out, state);
    }
    return out;
  };

  const walk = (node, locked) => {
    for (const c of node.children) {
      const name = xmlLocalName(c);
      if (name === 'AlternateContent') {
        const fallback = c.children.find(x => xmlLocalName(x) === 'Fallback');
        if (fallback) walk(fallback, true);
        continue;
      }
      if (name === 'p') {
        units.push({ kind: 'p', node: c, locked, text: paraText(c) });
        walk(c, true);
        continue;
      }
      if (name === 'tbl') {
        walkTable(c, locked);
        continue;
      }
      walk(c, locked);
    }
  };

  const walkTable = (tbl, locked) => {
    const rows = [];
    const collectRows = node => {
      for (const c of node.children) {
        const name = xmlLocalName(c);
        if (name === 'tr') rows.push(c);
        else if (name === 'sdt' || name === 'sdtContent' || name === 'customXml') collectRows(c);
      }
    };
    collectRows(tbl);
    const tableInfo = { node: tbl, rows: rows.length };
    for (const tr of rows) {
      const cells = [];
      const state = { nested: false };
      const collectCells = node => {
        for (const c of node.children) {
          const name = xmlLocalName(c);
          if (name === 'tc') cells.push({ node: c, paras: cellParas(c, [], state) });
          else if (name === 'sdt' || name === 'sdtContent' || name === 'customXml') collectCells(c);
        }
      };
      collectCells(tr);
      for (const cell of cells) {
        cell.texts = cell.paras.map(paraText);
        // As read in: the paragraphs of a cell run together.
        cell.text = cell.texts.join('');
      }
      units.push({
        kind: 'row',
        node: tr,
        table: tableInfo,
        cells,
        locked: locked || state.nested,
        text: cells.map(c => c.text).filter(Boolean).join(' · '),
      });
      // Nested tables and text boxes inside the cells (read in after their row).
      for (const cell of cells) {
        for (const c of cell.node.children) {
          if (xmlLocalName(c) === 'tbl') walkTable(c, true);
        }
        for (const p of cell.paras) walk(p, true);
      }
    }
  };

  const body = (function find(node) {
    for (const c of node.children) {
      if (xmlLocalName(c) === 'body') return c;
      const r = find(c);
      if (r) return r;
    }
    return null;
  })(tree);
  if (!body) throw new Error('docx: no body');
  walk(body, false);
  return { units, ctx };
}

/* ── Matching blocks to units ───────────────────────────────────────────── */

function docxKey(text) {
  return normalizeComparableText(sanitizeExternalText(String(text || '')))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How a block's text relates to a unit's text: { prefix } when it is the same text, possibly
 * after a generated list number or heading number ("(1) ", "§ 1 ") that the file does not
 * contain as text; null otherwise.
 */
function docxMatchBlock(blockKey, unitText) {
  if (!unitText) return null;
  if (blockKey === unitText) return { prefix: 0 };
  if (blockKey.length > unitText.length && blockKey.endsWith(unitText)) {
    const prefix = blockKey.slice(0, blockKey.length - unitText.length);
    if (prefix.length <= 24 && / $/.test(prefix)) return { prefix: prefix.length };
  }
  return null;
}

/** Pairs blocks (in order) with non-empty units (in order). Returns Map(blockIndex -> { unit, prefix }). */
function mapBlocksToUnits(blocks, units) {
  const LOOK = 40;
  const keys = blocks.map(b => docxKey(b.text));
  const list = units.filter(u => u.text);
  const out = new Map();
  let i = 0;
  let j = 0;
  while (i < keys.length && j < list.length) {
    const hit = docxMatchBlock(keys[i], list[j].text);
    if (hit) {
      out.set(i, { unit: list[j], prefix: hit.prefix });
      i++;
      j++;
      continue;
    }
    let step = null;
    for (let d = 1; d <= LOOK && !step; d++) {
      if (j + d < list.length && docxMatchBlock(keys[i], list[j + d].text)) step = { di: 0, dj: d };
      else if (i + d < keys.length && docxMatchBlock(keys[i + d], list[j].text)) step = { di: d, dj: 0 };
    }
    if (step) {
      i += step.di;
      j += step.dj;
    } else {
      i++;
      j++;
    }
  }
  return out;
}

/* ── Rewriting one paragraph ────────────────────────────────────────────── */

/**
 * The target text of a paragraph as characters with revision flags:
 * { chars: [{ ch, added, dels: [deleted text before this char] }], tail: [deleted text at the end] }.
 * `prefix` characters of the new wording (a generated list number) are dropped.
 */
function docxTargetFromTokens(tokens, prefix) {
  let chars = [];
  let pending = [];
  for (const tok of tokens) {
    if (tok.removed) {
      if (tok.value) pending.push(tok.value);
      continue;
    }
    for (const ch of tok.value) {
      chars.push({ ch, added: Boolean(tok.added), dels: pending });
      pending = [];
    }
  }
  let tail = pending;
  if (prefix) {
    // The generated number is not text in the file: drop it with whatever was deleted before it.
    const rest = chars.slice(prefix);
    chars = rest;
  }
  // Whitespace as in the file's reading: one space between words, none at the edges.
  const out = [];
  let carry = [];
  for (const c of chars) {
    const ws = /\s/.test(c.ch);
    const dels = carry.concat(c.dels);
    carry = [];
    if (ws && (!out.length || /\s/.test(out[out.length - 1].ch))) {
      carry = dels;
      continue;
    }
    out.push({ ch: ws ? ' ' : c.ch, added: c.added, dels });
  }
  while (out.length && out[out.length - 1].ch === ' ') {
    const last = out.pop();
    carry = last.dels.concat(carry);
  }
  tail = carry.concat(tail);
  return { chars: out, tail };
}

function docxStripHyperlinkStyle(rPr) {
  return rPr.replace(/<w:rStyle\b[^>]*\/>/g, '').replace(/<w:rPr>\s*<\/w:rPr>/, '');
}

/**
 * Returns the new XML of paragraph `p` whose text becomes the target described by `tokens`
 * (diff tokens of the new wording, see getExportDiffTokens). `rev(kind)` returns the attributes
 * of a new revision. `markPara` ('ins' | 'del' | '') marks the paragraph mark as inserted/deleted.
 */
function rewriteDocxParagraph(p, xml, ctx, tokens, prefix, rev, markPara = '', defaultRPr = '') {
  const { pPr, pieces } = flattenParagraph(p, xml, ctx);
  const target = docxTargetFromTokens(tokens, prefix);
  const tText = target.chars.map(c => c.ch).join('');

  // Comparable text of the file with a map back to the pieces.
  let xText = '';
  const xPiece = [];
  pieces.forEach((piece, idx) => {
    for (const ch of piece.cmp) {
      xText += ch;
      xPiece.push(idx);
    }
  });

  const diffLib = getDiffLibrary();
  let parts;
  if (xText === tText) parts = [{ value: xText }];
  else if (diffLib && xText.length + tText.length < 400000) parts = diffLib.diffWordsWithSpace(xText, tText);
  else parts = [{ value: xText, removed: true }, { value: tText, added: true }].filter(x => x.value);

  const items = []; // { kind: 'text'|'elem'|'raw', text?, xml?, rPr, chain, rev }
  const lastAtom = { piece: null };
  let nextPiece = 0;
  let keptBefore = true;

  const atomAfter = idx => {
    for (let k = idx; k < pieces.length; k++) if (pieces[k].type === 'atom' && pieces[k].cmp) return pieces[k];
    return null;
  };
  const contextFor = () => {
    const prev = lastAtom.piece;
    const next = atomAfter(nextPiece);
    const base = prev || next;
    if (!base) return { rPr: defaultRPr, chain: [] };
    const shared = prev && next && prev.chain === next.chain;
    if (shared) return { rPr: base.rPr, chain: base.chain };
    return { rPr: base.chain.length ? docxStripHyperlinkStyle(base.rPr) : base.rPr, chain: [] };
  };
  const emitPiece = (piece, revKind) => {
    if (piece.type === 'opaque') {
      if (piece.raw) items.push({ kind: 'raw', xml: piece.raw, chain: piece.chain });
      else items.push({ kind: 'elem', xml: piece.runChild, rPr: piece.rPr, chain: piece.chain, rev: '' });
      return;
    }
    if (piece.elem) items.push({ kind: 'elem', xml: piece.elem, rPr: piece.rPr, chain: piece.chain, rev: revKind });
    else items.push({ kind: 'text', text: piece.ch, rPr: piece.rPr, chain: piece.chain, rev: revKind });
    lastAtom.piece = piece;
  };
  // Pieces without comparable text up to `limit`: opaque ones always stay; empty atoms (extra
  // spaces, soft hyphens) stay where the text around them stays.
  const passThrough = limit => {
    while (nextPiece < limit) {
      const piece = pieces[nextPiece++];
      if (piece.type === 'opaque' || keptBefore) emitPiece(piece, '');
    }
  };
  const emitDeleted = texts => {
    if (!texts.length) return;
    const c = contextFor();
    for (const text of texts) items.push({ kind: 'text', text, rPr: c.rPr, chain: c.chain, rev: 'del' });
  };

  let xi = 0;
  let ti = 0;
  for (const part of parts) {
    const len = part.value.length;
    if (part.added) {
      for (let k = 0; k < len; k++, ti++) {
        const tc = target.chars[ti];
        emitDeleted(tc.dels);
        const c = contextFor();
        items.push({ kind: 'text', text: tc.ch, rPr: c.rPr, chain: c.chain, rev: tc.added ? 'ins' : '' });
      }
    } else if (part.removed) {
      for (let k = 0; k < len; k++, xi++) {
        const idx = xPiece[xi];
        if (idx >= nextPiece) {
          passThrough(idx);
          nextPiece = idx + 1;
          keptBefore = false;
        }
      }
    } else {
      for (let k = 0; k < len; k++, xi++, ti++) {
        const idx = xPiece[xi];
        const tc = target.chars[ti];
        if (idx >= nextPiece) {
          passThrough(idx);
          keptBefore = true;
          emitDeleted(tc.dels);
          emitPiece(pieces[idx], tc.added ? 'ins' : '');
          nextPiece = idx + 1;
        } else {
          emitDeleted(tc.dels);
        }
      }
    }
  }
  // Deleted text at the very end goes before trailing spaces / bookmarks.
  emitDeleted(target.tail);
  keptBefore = true;
  passThrough(pieces.length);

  return assembleDocxParagraph(p, xml, pPr, items, rev, markPara);
}

/** Serialises pieces into runs, grouped by wrapper chain and revision. */
function assembleDocxParagraph(p, xml, pPr, items, rev, markPara) {
  let body = '';
  let chain = [];
  let revOpen = '';
  let run = null; // { rPr, rev, content }

  const flushRun = () => {
    if (!run) return;
    body += `<w:r>${run.rPr}${run.content}</w:r>`;
    run = null;
  };
  const setRev = kind => {
    if (revOpen === kind) return;
    flushRun();
    if (revOpen) body += revOpen === 'ins' ? '</w:ins>' : '</w:del>';
    revOpen = kind;
    if (kind) body += kind === 'ins' ? `<w:ins ${rev()}>` : `<w:del ${rev()}>`;
  };
  const setChain = next => {
    if (next === chain) return;
    let common = 0;
    while (common < chain.length && common < next.length && chain[common] === next[common]) common++;
    if (common === chain.length && common === next.length) return;
    flushRun();
    setRev('');
    for (let k = chain.length - 1; k >= common; k--) body += chain[k].close;
    for (let k = common; k < next.length; k++) body += next[k].open;
    chain = next;
  };

  for (const item of items) {
    setChain(item.chain);
    if (item.kind === 'raw') {
      setRev('');
      body += item.xml;
      continue;
    }
    setRev(item.rev);
    const content =
      item.kind === 'text'
        ? item.rev === 'del'
          ? `<w:delText xml:space="preserve">${escapeXml(item.text)}</w:delText>`
          : `<w:t xml:space="preserve">${escapeXml(item.text)}</w:t>`
        : item.xml;
    if (run && run.rPr === item.rPr && run.rev === item.rev) {
      // Adjacent text joins one w:t.
      if (item.kind === 'text' && /<\/w:(t|delText)>$/.test(run.content) && run.lastText) {
        const tag = item.rev === 'del' ? 'w:delText' : 'w:t';
        run.content = run.content.slice(0, run.content.length - `</${tag}>`.length) + escapeXml(item.text) + `</${tag}>`;
      } else {
        run.content += content;
      }
    } else {
      flushRun();
      run = { rPr: item.rPr, rev: item.rev, content };
    }
    run.lastText = item.kind === 'text';
  }
  setChain([]);
  setRev('');
  flushRun();

  const openTag = xml.slice(p.start, p.openEnd).replace(/\/>$/, '>');
  return `${openTag}${docxMarkParagraph(pPr, markPara, rev)}${body}</w:p>`;
}

/** Adds an inserted/deleted mark to the paragraph mark (the pilcrow) in w:pPr. */
function docxMarkParagraph(pPr, markPara, rev) {
  if (!markPara) return pPr;
  const mark = markPara === 'ins' ? `<w:ins ${rev()}/>` : `<w:del ${rev()}/>`;
  if (!pPr) return `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
  if (/^<w:pPr\s*\/>$/.test(pPr)) return `<w:pPr><w:rPr>${mark}</w:rPr></w:pPr>`;
  if (/<w:rPr\s*\/>/.test(pPr)) return pPr.replace(/<w:rPr\s*\/>/, `<w:rPr>${mark}</w:rPr>`);
  if (/<w:rPr>/.test(pPr)) return pPr.replace(/<w:rPr>/, `<w:rPr>${mark}`);
  const before = pPr.search(/<w:sectPr\b|<w:pPrChange\b|<\/w:pPr>/);
  return `${pPr.slice(0, before)}<w:rPr>${mark}</w:rPr>${pPr.slice(before)}`;
}

/** A new paragraph modelled on `template` (a unit paragraph) or a plain one. */
function buildNewDocxParagraph(xml, ctx, template, tokens, prefix, rev, markPara) {
  let pPr = '';
  let rPr = '';
  if (template) {
    const tpl = flattenParagraph(template, xml, ctx);
    pPr = tpl.pPr
      .replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/, '')
      .replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/, '')
      .replace(/<w:rPr>[\s\S]*?<\/w:rPr>|<w:rPr\s*\/>/, '');
    const firstAtom = tpl.pieces.find(x => x.type === 'atom' && x.cmp && !x.chain.length);
    rPr = firstAtom ? firstAtom.rPr : '';
  }
  // Rewriting an empty paragraph with the model's properties emits all text in its run format.
  const fakeXml = `<w:p>${pPr}</w:p>`;
  const fake = parseXmlTree(fakeXml).children[0];
  return rewriteDocxParagraph(fake, fakeXml, ctx, tokens, prefix, rev, markPara, rPr);
}

/* ── The whole document ─────────────────────────────────────────────────── */

/**
 * plan: [{ block (final block; null for an open deletion), oldBlock, r0 (the block as read in from
 * the file, or null), tokens, open, markPara }] in document order. Returns the new document.xml.
 */
function patchDocxDocumentXml(xml, r0Blocks, plan, opts) {
  const tree = parseXmlTree(xml);
  const { units, ctx } = collectDocxUnits(xml, tree);
  const r0Map = mapBlocksToUnits(r0Blocks, units);
  const unitOfR0 = new Map();
  r0Blocks.forEach((b, i) => {
    if (r0Map.has(i)) unitOfR0.set(b, r0Map.get(i));
  });

  let maxId = 0;
  for (const mm of xml.matchAll(/\bw:id="(\d+)"/g)) maxId = Math.max(maxId, parseInt(mm[1], 10));
  let revId = maxId + 1000;
  const date = toWordDate(opts.date || new Date());
  const rev = () => `w:id="${revId++}" w:author="${escapeXml(DOCX_AUTHOR)}" w:date="${date}"`;

  const edits = []; // { start, end, text, seq }
  let seq = 0;
  const edit = (start, end, text) => edits.push({ start, end, text, seq: seq++ });

  // What the result must read like: every unit of the file with its new text (null = removed),
  // plus the new paragraphs at their insertion points.
  const unitText = new Map(units.map(u => [u, u.text]));
  const inserted = []; // { pos, seq, text }

  const firstUnit = units[0];
  if (!firstUnit) throw new Error('docx: empty body');
  const unitStart = u => (u.kind === 'row' ? u.table.node.start : u.node.start);
  const unitEnd = u => (u.kind === 'row' ? u.table.node.end : u.node.end);
  let anchor = unitStart(firstUnit);

  const planUnits = plan.map(step => {
    const hit = step.r0 ? unitOfR0.get(step.r0) : null;
    return { unit: hit ? hit.unit : null, prefix: hit ? hit.prefix : 0, kind: (step.block || step.oldBlock || {}).kind };
  });
  const usedUnits = new Set(planUnits.filter(pu => pu.unit).map(pu => pu.unit));
  const templateFor = (kind, from) => {
    const usable = entry => entry && entry.unit && entry.unit.kind === 'p' && !entry.unit.locked;
    for (let d = 0; d < 60; d++) {
      for (const k of [from - d, from + d]) if (usable(planUnits[k]) && planUnits[k].kind === kind) return planUnits[k].unit.node;
    }
    for (let d = 0; d < 60; d++) {
      for (const k of [from - d, from + d]) if (usable(planUnits[k])) return planUnits[k].unit.node;
    }
    return null;
  };
  const targetText = (tokens, prefix) =>
    docxTargetFromTokens(tokens.filter(x => !x.removed), prefix).chars.map(c => c.ch).join('');
  const insertAt = (text, expectedText) => {
    edit(anchor, anchor, text);
    inserted.push({ pos: anchor - 0.5, seq: seq, text: expectedText });
  };

  plan.forEach((step, k) => {
    const pu = planUnits[k];
    const unit = pu.unit;
    if (!step.block) {
      // An open deletion: the old paragraph, struck through, paragraph mark included.
      const tpl = templateFor(step.oldBlock.kind, k);
      insertAt(buildNewDocxParagraph(xml, ctx, tpl, [{ value: step.oldBlock.text, removed: true }], 0, rev, 'del'), '');
      return;
    }
    const finalKey = docxKey(step.block.text);
    const changed = step.open || !step.r0 || docxKey(step.r0.text) !== finalKey;
    if (!unit) {
      if (step.r0 && changed) {
        // A change in something that is not body text of the file (e.g. a footnote).
        throw new Error('docx: change outside the body');
      }
      if (step.r0) return; // unchanged and not in the body: nothing to do
      // A paragraph that the file does not have (a restored deletion): a new paragraph.
      const tpl = templateFor(step.block.kind, k);
      const marker = step.block.numberingMarker;
      const tplNumbered = tpl && /<w:numPr\b/.test(xml.slice(tpl.start, tpl.end));
      const prefix = tplNumbered && marker && finalKey.startsWith(`${marker} `) ? marker.length + 1 : 0;
      insertAt(buildNewDocxParagraph(xml, ctx, tpl, step.tokens, prefix, rev, step.markPara || ''), targetText(step.tokens, prefix));
      return;
    }
    if (changed) {
      if (unit.locked) throw new Error('docx: change in a locked unit');
      if (unit.kind === 'p') {
        edit(unit.node.start, unit.node.end, rewriteDocxParagraph(unit.node, xml, ctx, step.tokens, pu.prefix, rev, step.markPara || ''));
        unitText.set(unit, targetText(step.tokens, pu.prefix));
      } else {
        unitText.set(unit, rewriteDocxRow(unit, xml, ctx, step, rev, edit));
      }
    }
    anchor = unitEnd(unit);
  });

  // Units read in that are not part of the result anymore (a rejected insertion, a paragraph
  // emptied by an edit) are removed, with anything nested in them.
  const removed = [];
  const removedRows = new Map();
  for (const hit of r0Map.values()) {
    const unit = hit.unit;
    if (usedUnits.has(unit)) continue;
    if (unit.locked) throw new Error('docx: removal in a locked unit');
    if (unit.kind === 'row') {
      removedRows.set(unit.table, (removedRows.get(unit.table) || 0) + 1);
      edit(unit.node.start, unit.node.end, '');
      removed.push([unit.node.start, unit.node.end]);
    } else if (/<w:sectPr\b/.test(xml.slice(unit.node.start, unit.node.end))) {
      // It carries the section layout: keep the paragraph, drop its text.
      edit(unit.node.start, unit.node.end, rewriteDocxParagraph(unit.node, xml, ctx, [], 0, rev, ''));
      unitText.set(unit, '');
    } else {
      edit(unit.node.start, unit.node.end, '');
      removed.push([unit.node.start, unit.node.end]);
    }
  }
  for (const [table, n] of removedRows) {
    if (n < table.rows) continue;
    // Every row is gone: remove the table (a table needs at least one row).
    for (let k = edits.length - 1; k >= 0; k--) {
      if (edits[k].start >= table.node.start && edits[k].end <= table.node.end) edits.splice(k, 1);
    }
    edit(table.node.start, table.node.end, '');
    removed.push([table.node.start, table.node.end]);
  }
  for (const u of units) {
    if (removed.some(([s, e]) => u.node.start >= s && u.node.end <= e)) unitText.set(u, null);
  }

  // Apply from the end; edits never overlap (each unit is touched once).
  edits.sort((a, b) => b.start - a.start || b.seq - a.seq);
  let out = xml;
  let limit = Infinity;
  for (const e of edits) {
    if (e.end > limit) throw new Error('docx: overlapping edits');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }

  // Read the result back: the accepted text of every unit must be exactly what we expect.
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  const want = units
    .map(u => ({ pos: u.node.start, seq: -1, text: unitText.get(u) }))
    .concat(inserted)
    .sort((a, b) => a.pos - b.pos || a.seq - b.seq)
    .map(x => norm(x.text))
    .filter(Boolean);
  const got = collectDocxUnits(out, parseXmlTree(out))
    .units.map(u => norm(u.text))
    .filter(Boolean);
  const at = Math.max(got.length, want.length) === 0 ? -1 : got.findIndex((text, i) => text !== want[i]);
  if (got.length !== want.length || at >= 0) {
    const i = at >= 0 ? at : Math.min(got.length, want.length);
    throw new Error(`docx: verification failed at unit ${i}: ${JSON.stringify(got[i])} vs ${JSON.stringify(want[i])}`);
  }
  return out;
}

/** Rewrites the changed cells of a table row; returns the expected row text. */
function rewriteDocxRow(unit, xml, ctx, step, rev, edit) {
  const newCells = docxKey(step.block.text).split(' · ');
  const oldCells = step.oldBlock ? docxKey(step.oldBlock.text).split(' · ') : null;
  const filled = unit.cells.filter(c => c.text);
  const cellTokens = (oldText, newText) =>
    step.open ? (oldText === null ? [{ value: newText, added: true }] : computeCleanWordDiff(oldText, newText)) : [{ value: newText }];
  const writeCell = (cell, tokens) => {
    const paras = cell.paras.filter((p, i) => cell.texts[i]);
    if (paras.length > 1) throw new Error('docx: cannot safely rewrite a multi-paragraph cell');
    const first = paras[0] || cell.paras[0];
    if (!first) throw new Error('docx: cell without paragraph');
    edit(first.start, first.end, rewriteDocxParagraph(first, xml, ctx, tokens, 0, rev, ''));
    for (const other of paras.slice(1)) edit(other.start, other.end, rewriteDocxParagraph(other, xml, ctx, [], 0, rev, ''));
  };
  if (filled.some(c => c.text.includes(' · ')) ||
      (oldCells && oldCells.length !== filled.length) ||
      newCells.length !== filled.length) throw new Error('docx: ambiguous table row');
  if (newCells.length === filled.length) {
    newCells.forEach((text, i) => {
      const cell = filled[i];
      const oldText = oldCells && oldCells.length === newCells.length ? oldCells[i] : null;
      if (cell.text === text && (!step.open || oldText === text)) return;
      writeCell(cell, cellTokens(oldText, text));
    });
    return newCells.join(' · ');
  }
  throw new Error('docx: ambiguous table row');
}

/* ── Entry point ────────────────────────────────────────────────────────── */

/**
 * Builds the export from the original .docx of the new version.
 * source: { bytes, importedText }; finalBlocks: blocks of the current new version (all of them);
 * rows: state.alignedRows (old ↔ new); kind: 'final' | 'tracked'.
 * Returns a Uint8Array (.docx) or throws when the result cannot be verified.
 */
async function buildDocxFromSource(source, finalBlocks, rows, kind, date = new Date()) {
  const entries = await readZipEntries(source.bytes);
  const docEntry = entries.find(e => e.name === 'word/document.xml');
  if (!docEntry) throw new Error('docx: no word/document.xml');
  const xml = new TextDecoder('utf-8').decode(docEntry.data);
  const r0Blocks = parseIntoBlocks(source.importedText);

  // Old ↔ new rows by the position of the new block; final blocks ↔ blocks as read in.
  const rowOfFinal = new Map();
  for (const row of rows) {
    if (!row.rightBlock) continue;
    const block = finalBlocks[row.rightBlock.index - 1];
    if (!block || block.text !== row.rightBlock.text) throw new Error('docx: comparison is not current');
    rowOfFinal.set(row.rightBlock.index, row);
  }
  const r0Rows = alignDocumentBlocks(r0Blocks, finalBlocks);
  const r0OfFinal = new Map();
  for (const r of r0Rows) if (r.leftBlock && r.rightBlock) r0OfFinal.set(r.rightBlock, r.leftBlock);

  const plan = [];
  const pushDeleted = row => {
    if (kind !== 'tracked' || !row || row.type !== 'deleted' || row.reviewStatus === 'accepted' || !row.leftBlock) return;
    if (row.leftBlock.isHeaderFooter) return;
    plan.push({ block: null, oldBlock: row.leftBlock, r0: null, open: true });
  };
  let rowCursor = 0;
  for (const block of finalBlocks) {
    const row = rowOfFinal.get(block.index);
    if (row) {
      // Open deletions that sit before this row in the comparison.
      const at = rows.indexOf(row);
      for (; rowCursor < at; rowCursor++) pushDeleted(rows[rowCursor]);
      rowCursor = at + 1;
    }
    const open = kind === 'tracked' && row && row.type !== 'equal' && row.reviewStatus !== 'accepted';
    const tokens = open ? getExportDiffTokens(row) : [{ value: cleanExportText(block.text) }];
    plan.push({
      block,
      oldBlock: row ? row.leftBlock : null,
      r0: r0OfFinal.get(block) || null,
      tokens,
      open,
      markPara: open && row.type === 'inserted' ? 'ins' : '',
    });
  }
  for (; rowCursor < rows.length; rowCursor++) pushDeleted(rows[rowCursor]);

  const outXml = patchDocxDocumentXml(xml, r0Blocks, plan, { date });
  const enc = new TextEncoder();
  const files = entries.map(e => (e.name === 'word/document.xml' ? { name: e.name, data: enc.encode(outXml) } : e));
  return buildZipArchive(files, date);
}
