// Document probe: opens the source's listing page in a stock headless
// Chromium (no agent override, no plugins, no cookies of its own), reads the
// current listing through that page, then opens the first five documents it
// names and reports what each one answered. Stores nothing. Every host is
// blanked from the report. Exits 0 once the report is printed, 2 when a
// variable is missing.
//
//   SITE_URL             the listing page
//   LISTING_CURRENT_URL  the current listing's JSON address
//   DOCUMENT_BASE        the origin a row's redirectURL is relative to
import { chromium } from 'playwright';

const env = {};
for (const n of ['SITE_URL', 'LISTING_CURRENT_URL', 'DOCUMENT_BASE']) {
  env[n] = (process.env[n] || '').trim();
  if (!env[n]) { console.error(`${n} is not set`); process.exit(2); }
}
const base = env.DOCUMENT_BASE.endsWith('/') ? env.DOCUMENT_BASE : env.DOCUMENT_BASE + '/';
const hosts = [...new Set(Object.values(env).map((u) => { try { return new URL(u).host; } catch { return ''; } }).filter(Boolean))];
const clean = (s) => hosts.reduce((t, h) => t.split(h).join('<source>'), String(s ?? ''));
const collapse = (s, n) => clean(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);
const CHALLENGE = /access denied|reference\s*#|verifying|just a moment|checking your browser|request unsuccessful|captcha/i;
const DOCUMENTS = 5;

// look reads what the page now shows.
async function look(page) {
  return page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    const tables = [...document.querySelectorAll('table')];
    return {
      title: document.title,
      html: document.documentElement ? document.documentElement.outerHTML.length : 0,
      text,
      tables: tables.length,
      productTable: tables.some((t) => /affected|product/i.test(t.innerText.slice(0, 400))),
    };
  }).catch((e) => ({ title: '', html: 0, text: '', tables: 0, productTable: false, err: e.message }));
}

// visit navigates and reports status, final address, elapsed and content.
async function visit(page, label, url, id) {
  const t0 = Date.now();
  let status = 0, err = '';
  try {
    const resp = await page.goto(url, { timeout: 30_000, waitUntil: 'load' });
    status = resp ? resp.status() : 0;
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  } catch (e) {
    err = e.message.split('\n')[0];
  }
  const ms = Date.now() - t0;
  const v = await look(page);
  const final = page.url().replace(/^https?:\/\/[^/]+/, '<base>');
  const challenge = CHALLENGE.test(v.title) || CHALLENGE.test(v.text.slice(0, 2000)) || (!err && v.text.trim().length < 200);
  console.log(`\n${label}`);
  console.log(`   status ${status || 'none'}, ${ms} ms, final ${clean(final)}${err ? `, error: ${clean(err)}` : ''}`);
  console.log(`   html ${v.html} chars, text ${v.text.length} chars, ${v.tables} tables, title: "${collapse(v.title, 120)}"`);
  if (id !== undefined) {
    const affected = v.productTable || /affected products/i.test(v.text);
    console.log(`   title has the bulletin id: ${id ? v.title.includes(id) : 'n/a (row has no id segment)'}; affected products: ${affected}`);
  }
  console.log(`   looks like a challenge or denial: ${challenge}`);
  console.log(`   text starts: "${collapse(v.text, 300)}"`);
  return { status, err, challenge };
}

// listing reads the current listing through the page: its request context
// first, the page's own fetch when that fails.
async function listing(page) {
  const t0 = Date.now();
  try {
    const r = await page.request.get(env.LISTING_CURRENT_URL, { timeout: 30_000 });
    const body = await r.text();
    console.log(`\ncurrent listing via the page's request context: status ${r.status()}, ${Date.now() - t0} ms, ${body.length} chars`);
    if (r.ok()) return JSON.parse(body);
  } catch (e) {
    console.log(`\ncurrent listing via the page's request context: error after ${Date.now() - t0} ms: ${clean(e.message.split('\n')[0])}`);
  }
  const t1 = Date.now();
  try {
    const out = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return { status: r.status, body: await r.text() };
    }, env.LISTING_CURRENT_URL);
    console.log(`current listing via fetch in the page: status ${out.status}, ${Date.now() - t1} ms, ${out.body.length} chars`);
    if (out.status === 200) return JSON.parse(out.body);
  } catch (e) {
    console.log(`current listing via fetch in the page: error after ${Date.now() - t1} ms: ${clean(e.message.split('\n')[0])}`);
  }
  return null;
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
console.log(`document probe at ${new Date().toISOString()}, browser ${browser.version()}`);
await visit(page, 'listing page', env.SITE_URL);
const doc = await listing(page);
const rows = doc && Array.isArray(doc.data) ? doc.data : [];
console.log(`   ${rows.length} rows${doc && doc.code !== undefined ? `, envelope code ${doc.code}` : ''}`);
const tally = { ok: 0, challenge: 0, failed: 0 };
for (const [i, row] of rows.slice(0, DOCUMENTS).entries()) {
  const rel = String(row.redirectURL || '').replace(/^\//, '');
  const last = rel.split('?')[0].split('/').pop() || '';
  const id = last.startsWith('ish_') ? '' : last;
  // A page of its own, so that one navigation's failure does not bleed into
  // the next; the context keeps whatever the listing page set.
  const p = await context.newPage();
  const r = await visit(p, `document #${i + 1}`, base + rel, id);
  await p.close();
  if (r.challenge) tally.challenge++;
  else if (r.err || r.status !== 200) tally.failed++;
  else tally.ok++;
}
if (!rows.length) console.log('\ndocuments: skipped, no listing rows');
console.log(`\nsummary: ${tally.ok} documents answered with a page, ${tally.challenge} with a challenge or denial, ${tally.failed} failed`);
await browser.close();
process.exit(0);
