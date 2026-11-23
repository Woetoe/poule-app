import { createRequire } from 'module';
// Browsertest: twee 'telefoons' doorlopen de hele poule tegen de nep-Firebase.
// Draaien: PLAYWRIGHT=/pad/naar/playwright XLSX_FILE=partijen.xlsx node tests/browser.mjs
// (XLSX_FILE: het template met in Partijen 3 partijen in ronde 1 die over 2-4 uur beginnen.)
import http from 'http'; import fs from 'fs'; import path from 'path'; import os from 'os'; import { fileURLToPath } from 'url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const XLSX_FILE = process.env.XLSX_FILE;
if (!XLSX_FILE) { console.log('Zet XLSX_FILE (zie bovenaan dit bestand).'); process.exit(1); }
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { start } = require(path.join(ROOT, 'tools/nepfirebase.js'));
const WEB = path.join(ROOT, 'web'), SHOT = process.env.SHOTS || path.join(os.tmpdir(), 'poule-shots');
fs.mkdirSync(SHOT, { recursive: true });
const types = { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png', '.webmanifest': 'application/json' };
const srv = http.createServer((q, s) => { const p = path.join(WEB, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!p.startsWith(WEB) || !fs.existsSync(p)) { s.writeHead(404); return s.end(); } s.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(s); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port;
const db = await start();
const browser = await chromium.launch();
const errors = [];
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, locale: 'nl-NL', timezoneId: 'America/Curacao' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(u => localStorage.setItem('poule-db', JSON.stringify(u)), db.url);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
  return page;
}
const go = (p, u) => p.goto(BASE + u, { waitUntil: 'domcontentloaded' });
const toast = async (p, txt) => p.waitForFunction(t => { const e = document.getElementById('toast'); return e && !e.hidden && e.textContent.includes(t); }, txt, { timeout: 15000 });
const step = s => console.log('✓', s);
try {
  const W = await device('wouter'), B = await device('bart'); globalThis.PAGES = { W, B };
  await go(W, '/index.html'); await W.screenshot({ path: SHOT + '/1-start-leeg.png', fullPage: true }); step('startscherm');
  await W.click('a[href="darts.html?nieuw"]'); await W.waitForSelector('#fMe');
  await W.screenshot({ path: SHOT + '/2-aanmaken.png' });
  await W.fill('#fMe', 'Wouter'); await W.fill('#fName', 'Darts met de jongens');
  await W.click('#fGo'); await W.waitForURL(/\?p=/); await W.waitForSelector('.code');
  const code = (await W.textContent('.code')).trim(); step('poule aangemaakt, code ' + code);
  await W.setInputFiles('#file', XLSX_FILE);
  await W.waitForFunction(() => /partijen toegevoegd/.test(document.getElementById('report')?.textContent || ''), null, { timeout: 15000 });
  console.log('   import:', (await W.textContent('#report')).trim()); step('Excel geïmporteerd');
  await W.screenshot({ path: SHOT + '/3-beheer.png' });

  await go(B, '/index.html'); await B.fill('#code', code.toLowerCase()); await B.click('#joinBtn');
  await B.waitForSelector('#jName'); await B.fill('#jName', 'Bart'); await B.click('#jGo');
  await B.waitForSelector('text=Wachten op toelating'); step('Bart aangemeld, wacht');

  await W.reload({ waitUntil: 'domcontentloaded' }); await W.waitForSelector('[data-acc]'); await W.click('[data-acc]'); await toast(W, 'doet mee'); step('Bart toegelaten');

  await B.reload({ waitUntil: 'domcontentloaded' }); await B.waitForSelector('button[data-s="3-1"]');
  await B.click('button[data-s="3-1"] >> nth=0'); await B.waitForSelector('text=Opgeslagen: 3-1');
  await B.click('button[data-j] >> nth=0'); await toast(B, 'Joker gezet');
  await B.screenshot({ path: SHOT + '/4-voorspellen.png' }); step('Bart voorspelt 3-1 + joker');
  await go(B, '/darts.html?p=' + code + '#bonus'); await B.waitForSelector('#q-kampioen');
  await B.fill('#q-kampioen', 'Littler'); await B.press('#q-kampioen', 'Tab'); await toast(B, 'Antwoord opgeslagen'); step('bonusantwoord');

  // Wouter voorspelt partij 1 op 3-0 en vult uitslag 3-1 in + uitkomst kampioen
  await go(W, '/darts.html?p=' + code + '#voorspel'); await W.waitForSelector('button[data-s="3-0"]');
  await W.click('button[data-s="3-0"] >> nth=0'); await W.waitForSelector('text=Opgeslagen: 3-0');
  await go(W, '/darts.html?p=' + code + '#beheer'); await W.waitForSelector('select[data-res]');
  await W.selectOption('select[data-res] >> nth=0', '3-1'); await toast(W, 'Uitslag opgeslagen');
  await W.fill('input[data-out="kampioen"]', 'Luke Littler'); await W.press('input[data-out="kampioen"]', 'Tab'); await toast(W, 'Uitkomst opgeslagen');
  step('uitslag + uitkomst ingevuld');
  await W.selectOption('select[data-res] >> nth=1', '0-3'); await toast(W, 'volgende ronde bijgewerkt');
  await W.waitForSelector('h3:has-text("Ronde 2")');
  const r2 = await W.$$eval('.res span', els => els.map(e => e.textContent.trim()).filter(t => t.includes('Evans')));
  console.log('   ronde 2:', r2); step('volgende ronde vanzelf');
  await W.fill('input[data-time] >> nth=3', '2026-12-20T20:00'); await W.press('input[data-time] >> nth=3', 'Tab');
  await toast(W, 'Tijd opgeslagen'); console.log('   ', await W.textContent('#toast'));
  await go(W, '/darts.html?p=' + code + '#voorspel'); await W.waitForSelector('h2:has-text("Ronde 2")');
  console.log('   ronde 2 kaart:', (await W.textContent('h2:has-text("Ronde 2") + span')).trim());
  await W.screenshot({ path: SHOT + '/7-ronde2.png', fullPage: false });

  await go(B, '/darts.html?p=' + code + '#stand'); await B.waitForSelector('.rowl');
  const rows = await B.$$eval('.rowl', rs => rs.map(r => r.querySelector('.nm').textContent + ' | ' + r.querySelector('small').textContent + ' | ' + r.querySelector('.val').firstChild.textContent));
  console.log('   stand:', rows);
  console.log('   kpi:', await B.textContent('#kRank'), await B.textContent('#kPts'), await B.textContent('#kPot'));
  await B.screenshot({ path: SHOT + '/5-stand.png', fullPage: true });
  await go(B, '/index.html'); await B.screenshot({ path: SHOT + '/6-start-met-poule.png' });
  await go(B, '/darts.html?p=' + code + '#ik'); await B.waitForFunction(() => (document.getElementById('lc')?.value || '').startsWith('POULE1.'));
  step('inlogcode zichtbaar');
} catch (e) { process.exitCode = 1; console.log('FOUT:', e.message.split('\n')[0]); for (const [n, p] of Object.entries(globalThis.PAGES || {})) { try { console.log(n, (await p.textContent('#main')).slice(0, 400)); } catch (_) {} } }
console.log('paginafouten:', errors.length ? errors : 'geen');
await browser.close(); db.stop(); srv.close();
