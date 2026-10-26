#!/usr/bin/env node
/**
 * Automated security, privacy (GDPR), and build integrity checks for Doc Diff.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const siteHtmlPath = path.join(root, 'site', 'index.html');
const rootHtmlPath = path.join(root, 'DocDiff.html');
const jsDir = path.join(root, 'src', 'js');

assert.ok(fs.existsSync(siteHtmlPath), 'site/index.html must exist');
assert.ok(fs.existsSync(rootHtmlPath), 'DocDiff.html must exist');

const siteHtml = fs.readFileSync(siteHtmlPath, 'utf8');
const rootHtml = fs.readFileSync(rootHtmlPath, 'utf8');

// 1. The offline file equals the hosted German page, except that it follows the browser language
assert.ok(siteHtml.includes('<html lang="de" data-page-lang="de">'), 'site/index.html must pin its language to German');
assert.ok(rootHtml.includes('<html lang="de">'), 'DocDiff.html must follow the browser language (no data-page-lang)');
const websiteOnlyLinks = [
  '  <link rel="icon" href="favicon.ico" sizes="any" />\n',
  '  <link rel="apple-touch-icon" href="apple-touch-icon.png" />\n',
  '  <link rel="manifest" href="manifest.webmanifest" />\n',
];
assert.equal(
  websiteOnlyLinks.reduce(
    (html, line) => html.replace(line, ''),
    siteHtml.replace('<html lang="de" data-page-lang="de">', '<html lang="de">')
  ),
  rootHtml,
  'DocDiff.html must equal site/index.html apart from data-page-lang and website-only icon/manifest links'
);

// 2. Unreplaced template placeholders must not exist
for (const placeholder of [
  '__GEIST_B64__',
  '__GEIST_GREEK_B64__',
  '__GEIST_MONO_B64__',
  '__PDF_JS__',
  '__PDF_WORKER_JS__',
  '__MAMMOTH_JS__',
  '__DIFF_JS__',
  '__DIFF_WORKER_SOURCE__',
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

// Audit our own application code (src/js/*.js, concatenated in build order)
const appJsFiles = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();
const appJsCode = appJsFiles.map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n');
const appScript = appJsCode;

// Compile JS syntax check via node:vm
new vm.Script(appJsCode, { filename: 'src/js/*.js' });

for (const requiredFn of [
  'function revertRowToOriginal(',
  'function startInlineClauseEdit(',
  'function performUndo(',
  'function copyFinalTextToClipboard(',
]) {
  assert.ok(appJsCode.includes(requiredFn), `Missing required function: ${requiredFn}`);
}

// Match any mention (dot, bracket or bare access), not just `localStorage.`
for (const forbiddenStorage of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'caches.open', 'openDatabase']) {
  const pattern = new RegExp(`\\b${forbiddenStorage.replace('.', '\\.')}\\b`);
  assert.ok(
    !pattern.test(appScript),
    `App script must never use ${forbiddenStorage} (strict zero-persistence requirement)`
  );
}

// 4. Verify bilingual i18n parity (de vs en)
const i18nSandbox = {};
vm.runInNewContext(
  fs.readFileSync(path.join(jsDir, '01-i18n.js'), 'utf8') + '\nthis.I18N = I18N;',
  i18nSandbox
);
const { I18N } = i18nSandbox;
assert.ok(I18N && I18N.de && I18N.en, 'Both de and en i18n dictionaries must exist');

const deKeys = Object.keys(I18N.de).sort();
const enKeys = Object.keys(I18N.en).sort();
for (const lang of ['de', 'en']) {
  for (const [key, value] of Object.entries(I18N[lang])) {
    assert.ok(typeof value === 'string' && value.trim(), `i18n ${lang}.${key} must be a non-empty string`);
  }
}
assert.deepEqual(deKeys, enKeys, 'German and English i18n keys must match 1:1');

// The CSP quoted in the docs must match the one that actually ships
const shippedCsp = siteHtml.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
for (const doc of ['README.md', 'SECURITY.md']) {
  const quoted = fs.readFileSync(path.join(root, doc), 'utf8').match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  assert.ok(quoted && quoted[1] === shippedCsp, `${doc} must quote the shipped Content-Security-Policy verbatim`);
}

// PDF.js must never compile fonts via eval / new Function (CVE-2024-4367 hardening)
assert.ok(appJsCode.includes('isEvalSupported: false'), 'PDF.js getDocument() must pass isEvalSupported: false');

// 5. Verify site legal and domain files for docdiff.app
// Side by side, both versions must have exactly the same text width, or unchanged paragraphs
// wrap differently: same right gutter for clauses, same scrollbar gutter, no space-taking divider.
{
  const css = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');
  const rule = sel => (css.match(new RegExp(`(^|\\n)${sel.replace(/[.#]/g, '\\$&')} \\{([^}]*)\\}`)) || [])[2] || '';
  assert.match(css, /#sheet-left \.clause,\s*#sheet-right \.clause,\s*#sheet-unified \.clause \{\s*padding-right: var\(--rv-gutter\);/, 'left and right clauses share the review gutter');
  assert.match(css, /\.doc-pane-left,\s*\.doc-pane-right \{\s*scrollbar-gutter: stable;/, 'both panes reserve the same scrollbar gutter');
  assert.ok(!/scrollbar-width: none|border-(left|right)/.test(rule('.doc-pane-left') + rule('.doc-pane-right')), 'no hidden scrollbar or border that narrows one pane');
}

for (const siteFile of ['CNAME', 'og-image.png', 'og-image-en.png', 'impressum.html', 'datenschutz.html', 'legal.css', 'robots.txt', 'sitemap.xml', '.nojekyll']) {
  const p = path.join(root, 'site', siteFile);
  assert.ok(fs.existsSync(p), `Missing required site file: site/${siteFile}`);
}
assert.equal(fs.readFileSync(path.join(root, 'site', 'CNAME'), 'utf8').trim(), 'docdiff.app', 'CNAME must be docdiff.app');

// 7. Search engines and assistants: both language pages, head metadata, structured data, crawl files
for (const siteFile of ['en/index.html', 'llms.txt', 'llms-full.txt', 'manifest.webmanifest', 'favicon.ico', 'apple-touch-icon.png']) {
  assert.ok(fs.existsSync(path.join(root, 'site', siteFile)), `Missing required site file: site/${siteFile}`);
}
const enHtmlPath = path.join(root, 'site', 'en', 'index.html');
const enHtml = fs.readFileSync(enHtmlPath, 'utf8');
const SITE = 'https://docdiff.app/';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' };
const decodeEntities = s => s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (_, e) => ENTITIES[e]);
// Visible text of a small HTML fragment; mirrors plain_text() in scripts/build.py.
const plainText = s => decodeEntities(s.replace(/<\/p>\s*<p>/g, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const metaContent = (head, attr, name) => {
  const all = [...head.matchAll(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`, 'g'))];
  assert.equal(all.length, 1, `Expected exactly one <meta ${attr}="${name}">`);
  return decodeEntities(all[0][1]);
};

for (const page of [
  { lang: 'de', file: siteHtmlPath, html: siteHtml, url: SITE, assetBase: '' },
  { lang: 'en', file: enHtmlPath, html: enHtml, url: `${SITE}en/`, assetBase: '../' },
]) {
  const { lang, html, url } = page;
  const where = path.relative(root, page.file);
  const strings = I18N[lang];
  const bodyStart = html.indexOf('<body');
  const head = html.slice(0, bodyStart);
  const firstScript = html.indexOf('<script>', bodyStart);
  const staticMarkup = html.slice(bodyStart, firstScript);

  // Security invariants hold for every page, with the same CSP.
  assert.equal(html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)[1], shippedCsp, `${where}: CSP must match`);
  assert.ok(html.includes('<meta name="referrer" content="no-referrer" />'), `${where}: no-referrer meta missing`);
  assert.ok(!html.includes('<script src='), `${where}: must not load external scripts`);
  assert.ok(!/__[A-Z][A-Z0-9_]*(?::\w+)?__/.test(head + staticMarkup), `${where}: unreplaced placeholder in page markup`);

  // Language, canonical and alternates
  const htmlTag = html.match(/<html [^>]*>/)[0];
  assert.ok(htmlTag.includes(`lang="${lang}"`), `${where}: <html lang="${lang}"> expected`);
  assert.equal(htmlTag.includes('data-page-lang="en"'), lang === 'en', `${where}: only /en/ fixes the start language`);
  const canonicals = [...head.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(canonicals, [url], `${where}: canonical must be ${url}`);
  const alternates = Object.fromEntries([...head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(alternates, { de: SITE, en: `${SITE}en/`, 'x-default': SITE }, `${where}: hreflang alternates`);
  assert.ok(head.includes('<link rel="alternate" type="text/plain" href="https://docdiff.app/llms.txt"'), `${where}: llms.txt alternate link missing`);
  assert.ok(head.includes('<link rel="alternate" type="text/plain" href="https://docdiff.app/llms-full.txt"'), `${where}: llms-full.txt alternate link missing`);
  assert.equal(metaContent(head, 'property', 'og:url'), url, `${where}: og:url`);
  // Each language has its own link preview image.
  const ogImage = lang === 'en' ? `${SITE}og-image-en.png?v=1` : `${SITE}og-image.png?v=3`;
  assert.equal(metaContent(head, 'property', 'og:image'), ogImage, `${where}: og:image`);
  assert.equal(metaContent(head, 'name', 'twitter:image'), ogImage, `${where}: twitter:image`);

  // Title and description: from i18n, sensible lengths
  const title = decodeEntities(head.match(/<title>([^<]*)<\/title>/)[1]);
  assert.equal(title, strings.metaTitle, `${where}: <title> must be i18n metaTitle`);
  assert.ok(title.length >= 20 && title.length <= 65, `${where}: title length ${title.length} (20–65)`);
  const description = metaContent(head, 'name', 'description');
  assert.equal(description, strings.metaDescription, `${where}: meta description must be i18n metaDescription`);
  assert.ok(description.length >= 70 && description.length <= 160, `${where}: description length ${description.length} (70–160)`);
  assert.equal(metaContent(head, 'name', 'application-name'), 'Doc Diff');
  assert.ok(head.includes('<meta name="theme-color"'), `${where}: theme-color missing`);

  // Same-site assets resolve from the page's folder (e.g. ../favicon.ico from /en/)
  for (const asset of ['favicon.ico', 'apple-touch-icon.png', 'manifest.webmanifest']) {
    const href = head.match(new RegExp(`href="([^"]*${asset.replace('.', '\\.')})"`))[1];
    assert.equal(href, page.assetBase + asset, `${where}: ${asset} href`);
    assert.ok(fs.existsSync(path.resolve(path.dirname(page.file), href)), `${where}: ${href} does not exist`);
  }

  // Performance: the landing markup comes before the ~2.5 MB of inline scripts
  // The one exception is the tiny theme switch that sets dark mode before the first paint.
  const headScripts = head.match(/<script>[\s\S]*?<\/script>/g) || [];
  assert.ok(headScripts.length <= 1 && headScripts.every(s => s.length < 300), `${where}: only the small theme script may sit in <head>`);
  assert.ok(!/<style[\s>]/.test(staticMarkup), `${where}: <style> elements must stay inside <head> (valid HTML5 and zero FOUT)`);
  assert.ok(firstScript > html.indexOf('id="faq-title"'), `${where}: scripts must follow the landing content`);
  assert.ok(html.indexOf('id="pdfjs-worker-source"') > bodyStart, `${where}: PDF.js worker source must be present`);
  // PDF.js and Mammoth are embedded but only started when a PDF or Word file is first read.
  for (const id of ['lib-pdfjs', 'lib-mammoth']) {
    assert.ok(new RegExp(`<script type="text/plain" id="${id}">`).test(html) && html.indexOf(`id="${id}"`) > bodyStart, `${where}: ${id} must be embedded as non-executed text`);
  }

  // Static landing text is rendered in the page language from i18n (what crawlers and no-JS visitors see)
  let rendered = 0;
  for (const m of staticMarkup.matchAll(/<(\w+)[^>]*?\sdata-i18n(-html)?="(\w+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const [, , isHtml, key, inner] = m;
    assert.ok(key in strings, `${where}: unknown i18n key ${key}`);
    if (isHtml) assert.equal(inner, strings[key], `${where}: data-i18n-html="${key}" not rendered for ${lang}`);
    else assert.equal(decodeEntities(inner), strings[key], `${where}: data-i18n="${key}" not rendered for ${lang}`);
    rendered++;
  }
  assert.ok(rendered > 40, `${where}: expected the landing text to be rendered (${rendered} elements)`);
  const h1s = [...staticMarkup.matchAll(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/g)].filter(m => !m[1].includes('compare-only'));
  assert.equal(h1s.length, 1, `${where}: exactly one landing <h1>`);
  assert.equal(plainText(h1s[0][2]), plainText(strings.heroTitle), `${where}: landing <h1> text`);
  assert.ok(!/<img(?![^>]*\balt=)[^>]*>/.test(staticMarkup), `${where}: every <img> needs alt text`);

  // Structured data: valid JSON-LD, app facts, and an FAQPage that matches the visible FAQ word for word
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(ldBlocks.length, 1, `${where}: exactly one JSON-LD block`);
  assert.ok(ldBlocks[0].index < head.indexOf('<style>'), `${where}: JSON-LD and head metadata must come before inline <style>`);
  assert.ok(head.indexOf('<style>') < 16000, `${where}: head metadata and JSON-LD must fit within the first 16 KB`);
  const ld = JSON.parse(ldBlocks[0][1]);
  const node = type => ld['@graph'].find(n => n['@type'] === type);
  const app = node('WebApplication');
  assert.ok(app, `${where}: WebApplication missing`);
  assert.equal(app.url, url);
  assert.equal(app.offers.price, '0');
  assert.equal(app.isAccessibleForFree, true);
  assert.equal(app.operatingSystem, 'Any (web browser)');
  assert.ok(app.featureList.includes(strings.scopeCan6), `${where}: WebApplication.featureList must include review and Word/PDF export`);
  assert.ok(/LICENSE$/.test(app.license) && app.sameAs.includes('https://github.com/tschnorpfeil/docdiff'));
  assert.ok(node('SoftwareSourceCode')?.codeRepository === 'https://github.com/tschnorpfeil/docdiff', `${where}: codeRepository`);
  const visibleFaq = [...staticMarkup.matchAll(/<details class="faq-item">\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*<div class="faq-answer"[^>]*>([\s\S]*?)<\/div>\s*<\/details>/g)]
    .map(m => ({ q: plainText(m[1]), a: plainText(m[2]) }));
  const ldFaq = node('FAQPage').mainEntity.map(e => ({ q: e.name, a: e.acceptedAnswer.text }));
  assert.ok(visibleFaq.length >= 6, `${where}: visible FAQ count (${visibleFaq.length})`);
  assert.deepEqual(ldFaq, visibleFaq, `${where}: FAQPage JSON-LD must match the visible FAQ exactly`);
  const altLang = lang === 'de' ? 'en' : 'de';
  const altHref = lang === 'de' ? `${SITE}en/` : SITE;
  assert.ok(
    staticMarkup.includes(`id="footer-lang-link" href="${altHref}" hreflang="${altLang}"`),
    `${where}: crawlable language link missing in footer`
  );
  assert.ok(
    staticMarkup.includes('href="https://docdiff.app/impressum.html"') &&
      staticMarkup.includes('href="https://docdiff.app/datenschutz.html"'),
    `${where}: static HTML must include pre-rendered legal & privacy notice links`
  );
}

// Crawl files
const robotsTxt = fs.readFileSync(path.join(root, 'site', 'robots.txt'), 'utf8');
assert.ok(robotsTxt.includes(`Sitemap: ${SITE}sitemap.xml`), 'robots.txt must reference the sitemap');
assert.ok(!/^Disallow:\s*\S/m.test(robotsTxt), 'robots.txt must not block crawlers (including AI crawlers)');
const sitemapXml = fs.readFileSync(path.join(root, 'site', 'sitemap.xml'), 'utf8');
assert.deepEqual([...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]), [SITE, `${SITE}en/`], 'sitemap.xml must list / and /en/');
for (const m of sitemapXml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(m[1]) && !Number.isNaN(Date.parse(m[1])), `sitemap.xml: invalid lastmod ${m[1]}`);
}
assert.equal((sitemapXml.match(/hreflang="/g) || []).length, 6, 'sitemap.xml: hreflang alternates for both pages');
const llmsTxt = fs.readFileSync(path.join(root, 'site', 'llms.txt'), 'utf8');
assert.ok(/^# Doc Diff\n\n> \S/.test(llmsTxt), 'llms.txt must start with "# Doc Diff" and a "> " summary');
for (const file of ['llms.txt', 'llms-full.txt']) {
  const text = fs.readFileSync(path.join(root, 'site', file), 'utf8');
  for (const m of text.matchAll(/https:\/\/docdiff\.app\/([^\s)]*)/g)) {
    const target = path.join(root, 'site', m[1] === '' || m[1].endsWith('/') ? `${m[1]}index.html` : m[1]);
    assert.ok(fs.existsSync(target), `${file}: link ${m[0]} has no file in site/`);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'site', 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons) {
  assert.ok(fs.existsSync(path.join(root, 'site', icon.src)), `manifest icon ${icon.src} missing`);
}
console.log('✓ SEO checks passed (de + en pages, metadata, JSON-LD FAQ, robots, sitemap, llms.txt).');

// 6. The comparison Web Worker must produce exactly the main-thread results
await import('./check-diff-worker.mjs');

console.log(`✓ All security, privacy, legal, standalone, and i18n checks passed (${deKeys.length} i18n keys verified).`);

// 6. Unit tests for the pure export builders (docx, HTML, Markdown, file names); fast and dependency-free.
await import('./test-export.mjs');
// 6. Diff core unit tests (word-diff invariant, alignment, header/footer, PDF intake helpers)
execFileSync(process.execPath, [path.join(__dirname, 'test-core.mjs')], { stdio: 'inherit' });

// 6. App state guards (edits/exports during a running comparison, dirty flag after copy/print)
execFileSync(process.execPath, [path.join(__dirname, 'test-app-state.mjs')], { stdio: 'inherit' });
