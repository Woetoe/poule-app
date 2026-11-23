/* Nep-Firebase voor tests: een Realtime Database die zich via REST gedraagt zoals de echte.

   - GET / PUT / PATCH / DELETE op /<pad>.json, met {".sv":"timestamp"} als servertijd;
   - meelezen met Accept: text/event-stream (put- en patch-gebeurtenissen, keep-alive);
   - de database-regels uit tools/firebase/regels.json worden echt uitgevoerd (.read, .write, .validate),
     zodat een test ook faalt als de regels een nieuw onderdeel niet toelaten.

   Los te starten:  node tools/nepfirebase.js [poort]
   In een test:      const { start } = require('../tools/nepfirebase.js'); const db = await start();
                     db.url, db.data, db.cut() (alle streams verbreken), db.down = true (niets bereikbaar), db.stop() */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, 'firebase', 'regels.json');

// ---------------------------------------------------------------- regels uitvoeren
function snapshot(val) {
  return {
    val: () => (val === undefined ? null : val),
    exists: () => val !== undefined && val !== null,
    isString: () => typeof val === 'string',
    isNumber: () => typeof val === 'number',
    isBoolean: () => typeof val === 'boolean',
    hasChildren: () => !!val && typeof val === 'object',
    child: p => snapshot(String(p).split('/').filter(Boolean).reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), val))
  };
}
function evalRule(expr, vars, newData, data, now) {
  if (expr === true || expr === false) return expr;
  const names = Object.keys(vars);
  // $x.matches(/re/) uit de regeltaal → gewone JavaScript
  const js = String(expr).replace(/(\$[a-zA-Z_]+)\.matches\(/g, '__m($1, ');
  const fn = new Function('newData', 'data', 'now', '__m', ...names, 'return (' + js + ');');
  return !!fn(newData, data, now === undefined ? Date.now() : now, (s, re) => re.test(s), ...names.map(n => vars[n]));
}
/** Loopt de regels af langs een pad; geeft per niveau de regel-knoop en de gevonden $-variabelen. */
function walkRules(rules, segs) {
  const out = [{ node: rules, vars: {}, depth: 0 }];
  let node = rules, vars = {};
  for (let i = 0; i < segs.length; i++) {
    if (!node || typeof node !== 'object') break;
    let next = node[segs[i]];
    if (next === undefined) {
      const wild = Object.keys(node).find(k => k[0] === '$');
      if (wild) { next = node[wild]; vars = Object.assign({}, vars, { [wild]: segs[i] }); }
    }
    if (next === undefined) break;
    node = next;
    out.push({ node, vars, depth: i + 1 });
  }
  return out;
}
const get = (root, segs) => segs.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), root);

function allowed(rules, kind, segs, oldRoot, newRoot, now) {
  for (const { node, vars, depth } of walkRules(rules, segs)) {
    if (node && typeof node === 'object' && kind in node) {
      const at = segs.slice(0, depth);
      if (evalRule(node[kind], vars, snapshot(get(newRoot, at)), snapshot(get(oldRoot, at)), now)) return true;
    }
  }
  return false;
}
/** .validate: op elk niveau van het pad en in alles wat eronder geschreven is, voor zover er nieuwe gegevens staan. */
function valid(rules, segs, oldRoot, newRoot, now) {
  for (const { node, vars, depth } of walkRules(rules, segs)) {
    if (!node || typeof node !== 'object' || !('.validate' in node)) continue;
    const at = segs.slice(0, depth), nv = get(newRoot, at);
    if (nv === undefined || nv === null) continue;
    if (!evalRule(node['.validate'], vars, snapshot(nv), snapshot(get(oldRoot, at)), now)) return false;
  }
  const below = (node, vars, at) => {
    const nv = get(newRoot, at);
    if (!nv || typeof nv !== 'object' || !node || typeof node !== 'object') return true;
    for (const k of Object.keys(nv)) {
      let next = node[k], v2 = vars;
      if (next === undefined) {
        const wild = Object.keys(node).find(x => x[0] === '$');
        if (wild) { next = node[wild]; v2 = Object.assign({}, vars, { [wild]: k }); }
      }
      if (next === undefined || typeof next !== 'object') continue;
      const p = at.concat(k);
      if ('.validate' in next && !evalRule(next['.validate'], v2, snapshot(get(newRoot, p)), snapshot(get(oldRoot, p)), now)) return false;
      if (!below(next, v2, p)) return false;
    }
    return true;
  };
  const w = walkRules(rules, segs);
  const last = w[w.length - 1];
  if (last.depth === segs.length) return below(last.node, last.vars, segs);
  return true;
}

// ---------------------------------------------------------------- gegevens
function resolve(v, now) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return now;
    const o = Array.isArray(v) ? [] : {};
    for (const k of Object.keys(v)) { const r = resolve(v[k], now); if (r !== null && r !== undefined) o[k] = r; }
    return Object.keys(o).length ? o : null;
  }
  return v === undefined ? null : v;
}
function setAt(root, segs, val) {
  if (!segs.length) return val === null ? {} : val;
  const copy = Object.assign({}, root && typeof root === 'object' ? root : {});
  if (segs.length === 1) { if (val === null) delete copy[segs[0]]; else copy[segs[0]] = val; }
  else {
    const child = setAt(copy[segs[0]], segs.slice(1), val);
    if (child === null || (typeof child === 'object' && !Object.keys(child).length)) delete copy[segs[0]];
    else copy[segs[0]] = child;
  }
  return copy;
}
const isPrefix = (a, b) => a.length <= b.length && a.every((s, i) => s === b[i]);

function start(opts) {
  opts = opts || {};
  const rules = (opts.rules || JSON.parse(fs.readFileSync(opts.rulesFile || RULES_FILE, 'utf8'))).rules;
  const db = { data: {}, streams: new Set(), down: false, delay: 0, log: [], writes: 0, clock: () => Date.now() };

  function notify(writes) {
    // writes: [{segs, val}] die samen één wijziging vormen (PATCH) of één los pad
    for (const st of db.streams) {
      const P = st.segs;
      const inside = writes.filter(w => isPrefix(P, w.segs));
      const above = writes.some(w => !isPrefix(P, w.segs) && isPrefix(w.segs, P));
      if (above) { st.send('put', { path: '/', data: get(db.data, P) === undefined ? null : get(db.data, P) }); continue; }
      if (!inside.length) continue;
      if (inside.length === 1 && !inside[0].patch) {
        st.send('put', { path: '/' + inside[0].segs.slice(P.length).join('/'), data: inside[0].val });
      } else {
        // meerdere paden in één keer: één patch vanaf het gezamenlijke punt (zoals de echte database)
        const baseSegs = inside[0].base || P;
        const b = isPrefix(P, baseSegs) ? baseSegs : P;
        const data = {};
        inside.forEach(w => { data[w.segs.slice(b.length).join('/')] = w.val; });
        st.send('patch', { path: '/' + b.slice(P.length).join('/'), data });
      }
    }
  }

  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,PATCH,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Accept,Cache-Control,Last-Event-ID' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const u = new URL(req.url, 'http://x');
    if (db.down) { req.socket.destroy(); return; }
    if (!u.pathname.endsWith('.json')) { res.writeHead(404, cors); res.end('{"error":"not found"}'); return; }
    const segs = decodeURIComponent(u.pathname.slice(0, -5)).split('/').filter(Boolean);
    const json = (code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(obj === undefined ? null : obj)); };
    const later = fn => (db.delay ? setTimeout(fn, db.delay) : fn());

    if (req.method === 'GET') {
      if (!allowed(rules, '.read', segs, db.data, db.data)) { json(401, { error: 'Permission denied' }); return; }
      if ((req.headers.accept || '').includes('text/event-stream')) {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }, cors));
        const st = { segs, res, send: (ev, data) => { try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* stream al dicht */ } } };
        const v = get(db.data, segs);
        st.send('put', { path: '/', data: v === undefined ? null : v });
        db.streams.add(st);
        const ka = setInterval(() => st.send('keep-alive', null), opts.keepAlive || 30000);
        req.on('close', () => { clearInterval(ka); db.streams.delete(st); });
        return;
      }
      const v = get(db.data, segs);
      later(() => json(200, v === undefined ? null : v));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => later(() => {
      if (db.down) { req.socket.destroy(); return; }
      let val = null;
      if (req.method !== 'DELETE') { try { val = JSON.parse(body); } catch (e) { json(400, { error: 'Invalid data; couldn\'t parse JSON object.' }); return; } }
      const now = db.clock();
      let writes;
      if (req.method === 'PATCH') {
        if (!val || typeof val !== 'object' || Array.isArray(val)) { json(400, { error: 'Invalid data' }); return; }
        writes = Object.keys(val).map(k => ({ segs: segs.concat(k.split('/').filter(Boolean)), val: resolve(val[k], now), patch: true, base: segs }));
      } else if (req.method === 'PUT' || req.method === 'DELETE') {
        writes = [{ segs, val: req.method === 'DELETE' ? null : resolve(val, now) }];
      } else { json(405, { error: 'method' }); return; }
      let next = db.data;
      for (const w of writes) next = setAt(next, w.segs, w.val) || {};
      for (const w of writes) {
        if (!allowed(rules, '.write', w.segs, db.data, next, now) || !valid(rules, w.segs, db.data, next, now)) {
          db.log.push({ denied: req.method, path: '/' + w.segs.join('/') });
          json(401, { error: 'Permission denied' });
          return;
        }
      }
      db.data = next; db.writes++;
      notify(writes);
      if (req.method === 'DELETE') json(200, null);
      else if (req.method === 'PATCH') json(200, Object.fromEntries(writes.map(w => [w.segs.slice(segs.length).join('/'), w.val])));
      else json(200, writes[0].val);
    }));
  });

  return new Promise(res => {
    server.listen(opts.port || 0, opts.host || '127.0.0.1', () => {
      db.port = server.address().port;
      db.url = 'http://127.0.0.1:' + db.port;
      /** Alle meelees-verbindingen verbreken (alsof het netwerk even wegviel). */
      db.cut = () => { for (const st of [...db.streams]) { try { st.res.destroy(); } catch (e) { /* al dicht */ } } db.streams.clear(); };
      db.stop = () => new Promise(r => { db.cut(); server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); });
      res(db);
    });
  });
}

/** Kleine EventSource voor Node (tests): genoeg voor de stream van de database. */
class EventSource {
  constructor(url) {
    this.url = url; this.readyState = 0; this._l = {}; this.onerror = null; this._closed = false;
    this._open();
  }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  _emit(t, data) { (this._l[t] || []).forEach(fn => { try { fn({ type: t, data }); } catch (e) { console.error(e); } }); }
  _open() {
    const req = (this.url.startsWith('https:') ? require('https') : http).get(this.url, { headers: { Accept: 'text/event-stream' } }, res => {
      if (res.statusCode !== 200) { res.resume(); this.readyState = 2; this.onerror && this.onerror({}); return; }
      this.readyState = 1;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          block.split('\n').forEach(line => { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); });
          if (!this._closed) this._emit(ev, data);
        }
      });
      let ended = false;
      const end = () => { if (this._closed || ended) return; ended = true; this.readyState = 2; this.onerror && this.onerror({}); };
      res.on('end', end); res.on('error', end); res.on('close', end);
    });
    req.on('error', () => { if (this._closed) return; this.readyState = 2; this.onerror && this.onerror({}); });
    this._req = req;
  }
  close() { this._closed = true; this.readyState = 2; try { this._req.destroy(); } catch (e) { /* al dicht */ } }
}

module.exports = { start, EventSource };

if (require.main === module) {
  start({ port: +process.argv[2] || 9000, host: '0.0.0.0' }).then(db => console.log('nep-Firebase op poort', db.port));
}
