#!/usr/bin/env node
/**
 * Automated security, privacy (GDPR), and build integrity checks for Doc Diff.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const siteHtmlPath = path.join(root, 'site', 'index.html');
const rootHtmlPath = path.join(root, 'DocDiff.html');
const templatePath = path.join(root, 'src', 'template.html');

assert.ok(fs.existsSync(siteHtmlPath), 'site/index.html must exist');
assert.ok(fs.existsSync(rootHtmlPath), 'DocDiff.html must exist');

const siteHtml = fs.readFileSync(siteHtmlPath, 'utf8');
const rootHtml = fs.readFileSync(rootHtmlPath, 'utf8');
const templateHtml = fs.readFileSync(templatePath, 'utf8');

// 1. Both output files must be identical
assert.equal(siteHtml, rootHtml, 'site/index.html and DocDiff.html must be identical');

// 2. Unreplaced template placeholders must not exist
for (const placeholder of [
  '__GEIST_B64__',
  '__GEIST_GREEK_B64__',
  '__GEIST_MONO_B64__',
  '__PDF_JS__',
  '__PDF_WORKER_JS__',
  '__MAMMOTH_JS__',
  '__DIFF_JS__',
]) {
  assert.ok(!siteHtml.includes(placeholder), `Unreplaced placeholder found: ${placeholder}`);
}

// 3. Security & Privacy (GDPR) invariants
assert.ok(
  siteHtml.includes("connect-src 'none'"),
  "CSP must enforce connect-src 'none' to block outbound network traffic"
);
assert.ok(
  siteHtml.includes("form-action 'none'"),
  "CSP must enforce form-action 'none'"
);
assert.ok(
  siteHtml.includes('<meta name="referrer" content="no-referrer" />'),
  'Must include strict no-referrer meta tag'
);
assert.ok(
  !siteHtml.includes('<script src='),
  'Must not include any external <script src=...> tags'
);
assert.ok(
  !siteHtml.includes('cdnjs.cloudflare.com') && !siteHtml.includes('fonts.googleapis.com'),
  'Must not reference any external CDNs or font servers'
);

// Extract only our application script (last <script> block) to audit app code
const lastScriptIdx = templateHtml.lastIndexOf('<script>');
const lastScriptEndIdx = templateHtml.lastIndexOf('</script>');
const appScript = templateHtml.slice(lastScriptIdx);
const appJsCode = templateHtml.slice(lastScriptIdx + '<script>'.length, lastScriptEndIdx);

// Compile JS syntax check via node:vm
new vm.Script(appJsCode, { filename: 'src/template.html' });

for (const requiredFn of [
  'function revertRowToOriginal(',
  'function startInlineClauseEdit(',
  'function performUndo(',
  'function copyFinalTextToClipboard(',
]) {
  assert.ok(appJsCode.includes(requiredFn), `Missing required function: ${requiredFn}`);
}

for (const forbiddenStorage of ['localStorage.', 'sessionStorage.', 'indexedDB.', 'document.cookie']) {
  assert.ok(
    !appScript.includes(forbiddenStorage),
    `App script must never use ${forbiddenStorage} (strict zero-persistence requirement)`
  );
}

// 4. Verify bilingual i18n parity (de vs en)
const deMatch = appScript.match(/de:\s*\{([\s\S]*?)\n      \},/);
const enMatch = appScript.match(/en:\s*\{([\s\S]*?)\n      \},/);
assert.ok(deMatch && enMatch, 'Both de and en i18n dictionaries must exist');

const extractKeys = block =>
  [...block.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map(m => m[1]).sort();

const deKeys = extractKeys(deMatch[1]);
const enKeys = extractKeys(enMatch[1]);
assert.deepEqual(deKeys, enKeys, 'German and English i18n keys must match 1:1');

// 5. Verify site legal and domain files for docdiff.app
for (const siteFile of ['CNAME', 'og-image.png', 'impressum.html', 'datenschutz.html', 'legal.css', 'robots.txt', 'sitemap.xml', '.nojekyll']) {
  const p = path.join(root, 'site', siteFile);
  assert.ok(fs.existsSync(p), `Missing required site file: site/${siteFile}`);
}
assert.equal(fs.readFileSync(path.join(root, 'site', 'CNAME'), 'utf8').trim(), 'docdiff.app', 'CNAME must be docdiff.app');

console.log(`✓ All security, privacy, legal, standalone, and i18n checks passed (${deKeys.length} i18n keys verified).`);
