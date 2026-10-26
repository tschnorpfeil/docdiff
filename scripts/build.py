#!/usr/bin/env python3
"""
Builds the self-contained single-file HTML bundle from `src/template.html`, `src/styles.css`,
`src/js/*.js` and `vendor/`:

- `site/index.html` and `DocDiff.html`: German page (default), identical files
- `site/en/index.html`: the same app as an English page for https://docdiff.app/en/

The page language only decides the static HTML (head metadata, structured data and the landing
text crawlers and no-JS visitors see); every page contains both languages and the DE / EN toggle.
Static text is rendered from `src/js/01-i18n.js`, the single source of truth (read with Node).
"""
import base64
import html
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "vendor", "fonts")
LIB_DIR = os.path.join(ROOT, "vendor", "libs")
TEMPLATE_PATH = os.path.join(ROOT, "src", "template.html")
CSS_PATH = os.path.join(ROOT, "src", "styles.css")
JS_DIR = os.path.join(ROOT, "src", "js")
WORKER_DIR = os.path.join(ROOT, "src", "worker")

# Pure diff code shared verbatim between the page and the comparison Web Worker.
WORKER_SHARED_JS = ["04-core.js", "04a-align.js"]
WORKER_SOURCE_PLACEHOLDER = '"__DIFF_WORKER_SOURCE__"'

SITE_URL = "https://docdiff.app/"
REPO_URL = "https://github.com/tschnorpfeil/docdiff"
OFFLINE_URL = REPO_URL + "/raw/main/DocDiff.html"

PAGES = {
    "de": {
        "url": SITE_URL,
        # The hosted root page stays German (search engines render with an English browser
        # language and would otherwise see a copy of /en/). The offline file follows the browser.
        "html_attrs": 'lang="de" data-page-lang="de"',
        "output_html_attrs": {"DocDiff.html": 'lang="de"'},
        # Files that only exist on the website; the offline file keeps the inline SVG icon.
        "output_strip_lines": {
            "DocDiff.html": [
                '  <link rel="icon" href="favicon.ico" sizes="any" />\n',
                '  <link rel="apple-touch-icon" href="apple-touch-icon.png" />\n',
                '  <link rel="manifest" href="manifest.webmanifest" />\n',
            ]
        },
        "asset_base": "",
        "og_locale": "de_DE",
        "og_locale_alt": "en_US",
        "og_image": SITE_URL + "og-image.png?v=3",
        "outputs": [os.path.join("site", "index.html"), "DocDiff.html"],
    },
    "en": {
        "url": SITE_URL + "en/",
        "html_attrs": 'lang="en" data-page-lang="en"',
        "asset_base": "../",
        "og_locale": "en_US",
        "og_locale_alt": "de_DE",
        "og_image": SITE_URL + "og-image-en.png?v=1",
        "outputs": [os.path.join("site", "en", "index.html")],
    },
}

# Elements whose content the app replaces at runtime (textContent or innerHTML) by an i18n key.
I18N_ELEMENT_RE = re.compile(
    r'<(?P<tag>[a-z][a-z0-9]*)(?P<attrs>[^>]*?\sdata-i18n(?P<html>-html)?="(?P<key>\w+)"[^>]*)>'
    r"(?P<body>.*?)</(?P=tag)>",
    re.S,
)
I18N_LABEL_RE = re.compile(r'<[a-z][a-z0-9]*[^>]*\sdata-i18n-label="(?P<key>\w+)"[^>]*>')


def b64_file(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def app_js_files() -> list:
    """App scripts, concatenated in file-name order into one classic <script>."""
    return sorted(
        os.path.join(JS_DIR, name) for name in os.listdir(JS_DIR) if name.endswith(".js")
    )


def worker_source(diff_js: str) -> str:
    """Classic worker script: jsdiff + the shared pure core + the worker runtime."""
    parts = ["self.window = self;", diff_js]
    parts += [read_text(os.path.join(JS_DIR, name)) for name in WORKER_SHARED_JS]
    parts.append(read_text(os.path.join(WORKER_DIR, "compare-worker.js")))
    return "\n;\n".join(parts)


def js_string_literal(text: str) -> str:
    """JSON string literal that is also safe inside an inline <script> element."""
    return json.dumps(text).replace("<", "\\u003c").replace(">", "\\u003e")


def load_i18n() -> dict:
    """Evaluates src/js/01-i18n.js with Node and returns the I18N dictionaries."""
    code = read_text(os.path.join(JS_DIR, "01-i18n.js")) + "\nprocess.stdout.write(JSON.stringify(I18N));"
    try:
        out = subprocess.run(
            ["node", "-"], input=code, capture_output=True, text=True, encoding="utf-8", check=True
        )
    except (OSError, subprocess.CalledProcessError) as err:
        sys.exit(f"Could not read src/js/01-i18n.js with Node: {err}")
    return json.loads(out.stdout)


def plain_text(fragment: str) -> str:
    """Visible text of a small HTML fragment, whitespace collapsed (paragraphs joined by a space)."""
    text = re.sub(r"</p>\s*<p>", " ", fragment)
    text = re.sub(r"<[^>]+>", "", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def render_static_text(template: str, strings: dict) -> str:
    """Fills data-i18n / data-i18n-html elements and data-i18n-label attributes for one language."""

    def element(m: re.Match) -> str:
        tag, key, body = m.group("tag"), m.group("key"), m.group("body")
        if re.search(rf"<{tag}\b", body):
            sys.exit(f"Nested <{tag}> inside data-i18n element '{key}' is not supported by build.py")
        if key not in strings:
            sys.exit(f"Unknown i18n key in template: {key}")
        value = strings[key] if m.group("html") else html.escape(strings[key], quote=False)
        return f"<{tag}{m.group('attrs')}>{value}</{tag}>"

    def label(m: re.Match) -> str:
        tag_html, key = m.group(0), m.group("key")
        if key not in strings:
            sys.exit(f"Unknown i18n key in template: {key}")
        value = html.escape(strings[key], quote=True)
        if ' aria-label="' in tag_html:
            return re.sub(r' aria-label="[^"]*"', f' aria-label="{value}"', tag_html, count=1)
        return tag_html.replace(" data-i18n-label=", f' aria-label="{value}" data-i18n-label=', 1)

    return I18N_LABEL_RE.sub(label, I18N_ELEMENT_RE.sub(element, template))


def json_ld(template: str, lang: str, strings: dict, version: str) -> str:
    """schema.org data for the app and the visible FAQ (same order and wording as the page)."""
    page = PAGES[lang]
    license_url = REPO_URL + "/blob/main/LICENSE"
    author = {
        "@type": "Person",
        "name": "Tobias Schnorpfeil",
        "url": "https://github.com/tschnorpfeil",
    }
    features = re.findall(r'data-i18n="(local\dTitle|scopeCan\d+)"', template)
    faq_keys = re.findall(r'<summary data-i18n="(faq\w+)Q"', template)
    app = {
        "@type": "WebApplication",
        "@id": SITE_URL + "#app",
        "name": "Doc Diff",
        "url": page["url"],
        "description": strings["metaDescription"],
        "applicationCategory": "BusinessApplication",
        "applicationSubCategory": "Document comparison",
        "operatingSystem": "Any (web browser)",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"},
        "isAccessibleForFree": True,
        "license": license_url,
        "inLanguage": ["de", "en"],
        "featureList": [strings[key] for key in features],
        "downloadUrl": OFFLINE_URL,
        "softwareHelp": {"@type": "CreativeWork", "url": REPO_URL + "#readme"},
        "image": page["og_image"],
        "author": author,
        "sameAs": [REPO_URL],
    }
    if version:
        app["softwareVersion"] = version
    graph = [
        app,
        {
            "@type": "SoftwareSourceCode",
            "@id": REPO_URL + "#code",
            "name": "Doc Diff",
            "codeRepository": REPO_URL,
            "programmingLanguage": ["JavaScript", "HTML", "CSS"],
            "license": license_url,
            "author": author,
            "targetProduct": {"@id": SITE_URL + "#app"},
        },
        {
            "@type": "FAQPage",
            "@id": page["url"] + "#faq",
            "inLanguage": lang,
            "mainEntity": [
                {
                    "@type": "Question",
                    "name": strings[key + "Q"],
                    "acceptedAnswer": {"@type": "Answer", "text": plain_text(strings[key + "A"])},
                }
                for key in faq_keys
            ],
        },
    ]
    data = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=2)
    return data.replace("</", "<\\/")


def render_page(template: str, lang: str, i18n: dict, version: str) -> str:
    """Language-specific static parts of the page; runs on the template only, never on bundled code."""
    page, strings = PAGES[lang], i18n[lang]
    out = render_static_text(template, strings)
    out = re.sub(
        r"__I18N:(\w+)__",
        lambda m: html.escape(strings[m.group(1)], quote=True),
        out,
    )
    alt_lang = "en" if lang == "de" else "de"
    alt_href = (SITE_URL + "en/") if lang == "de" else SITE_URL
    out = (
        out.replace("__HTML_ATTRS__", page["html_attrs"])
        .replace("__PAGE_URL__", page["url"])
        .replace("__ASSET_BASE__", page["asset_base"])
        .replace("__OG_LOCALE__", page["og_locale"])
        .replace("__OG_LOCALE_ALT__", page["og_locale_alt"])
        .replace("__OG_IMAGE__", page["og_image"])
        .replace("__LANG_LABEL__", "English" if lang == "de" else "Deutsch")
        .replace("__ALT_LANG__", alt_lang)
        .replace("__ALT_LANG_HREF__", alt_href)
        .replace("__JSON_LD__", json_ld(template, lang, strings, version))
    )
    return out


def build_pages() -> dict:
    template = read_text(TEMPLATE_PATH)
    app_css = read_text(CSS_PATH)
    diff_js = read_text(os.path.join(LIB_DIR, "diff.min.js"))
    app_js = "\n".join(read_text(path) for path in app_js_files())
    if app_js.count(WORKER_SOURCE_PLACEHOLDER) != 1:
        sys.exit(f"Expected exactly one {WORKER_SOURCE_PLACEHOLDER} placeholder in src/js")
    app_js = app_js.replace(WORKER_SOURCE_PLACEHOLDER, js_string_literal(worker_source(diff_js)))
    version_match = re.search(r"DOCDIFF_APP_VERSION = '([\d.]+)'", app_js)
    version = version_match.group(1) if version_match else ""
    i18n = load_i18n()

    geist_b64 = b64_file(os.path.join(FONT_DIR, "Geist-Variable.woff2"))
    geist_greek_b64 = b64_file(os.path.join(FONT_DIR, "Geist-Greek-Fallback.woff2"))
    geist_mono_b64 = b64_file(os.path.join(FONT_DIR, "GeistMono-Variable.woff2"))

    pdf_js = read_text(os.path.join(LIB_DIR, "pdf.min.js"))
    pdf_worker_js = read_text(os.path.join(LIB_DIR, "pdf.worker.min.js"))
    mammoth_js = read_text(os.path.join(LIB_DIR, "mammoth.browser.min.js"))

    pages = {}
    for lang in PAGES:
        page_template = render_page(template, lang, i18n, version)
        leftover = set(re.findall(r"__(?:HTML_ATTRS|PAGE_URL|ASSET_BASE|OG_LOCALE\w*|LANG_LABEL|ALT_LANG\w*|JSON_LD|I18N:\w+)__", page_template))
        if leftover:
            sys.exit(f"Unreplaced page placeholders: {sorted(leftover)}")
        # App sources go in first so vendor code can never be scanned for placeholders.
        pages[lang] = (
            page_template.replace("__APP_CSS__", app_css)
            .replace("__APP_JS__", app_js)
            .replace("__GEIST_B64__", geist_b64)
            .replace("__GEIST_GREEK_B64__", geist_greek_b64)
            .replace("__GEIST_MONO_B64__", geist_mono_b64)
            .replace("__PDF_JS__", pdf_js)
            .replace("__PDF_WORKER_JS__", pdf_worker_js)
            .replace("__MAMMOTH_JS__", mammoth_js)
            .replace("__DIFF_JS__", diff_js)
        )
    return pages


def main() -> None:
    pages = build_pages()
    for lang, page in PAGES.items():
        for rel in page["outputs"]:
            path = os.path.join(ROOT, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            html = pages[lang]
            override = page.get("output_html_attrs", {}).get(rel)
            if override:
                tag = f'<html {page["html_attrs"]}>'
                if html.count(tag) != 1:
                    sys.exit(f"Expected exactly one {tag} in {rel}")
                html = html.replace(tag, f"<html {override}>")
            for line in page.get("output_strip_lines", {}).get(rel, []):
                if html.count(line) != 1:
                    sys.exit(f"Expected exactly one {line.strip()} in {rel}")
                html = html.replace(line, "")
            with open(path, "w", encoding="utf-8") as f:
                f.write(html)
            print(f"Wrote {rel} ({len(html):,} bytes, {lang})")


if __name__ == "__main__":
    main()
