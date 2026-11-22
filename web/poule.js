/* Poule — gedeelde data voor de poule-app (Android-app en webversie).

   Hoe het werkt
   - Een poule heeft een code van 8 tekens. Uit de code komen via HKDF-SHA256 een ruimte-id (pad in de database)
     en een AES-GCM-sleutel. Alles in de database is versleuteld; de code zelf gaat nooit mee.
   - Database: dezelfde Firebase als W2 Apps, onder /r/<ruimte>/<soort>/<id> = {v, t}. v is versleuteld,
     t is de servertijd van het schrijven (die kan een telefoon niet vervalsen).
   - Elk toestel heeft een eigen sleutelpaar (ECDSA P-256). Alles wat je schrijft is ondertekend.
     De beheerder (wie de poule maakt) laat spelers toe; alleen hun sleutels tellen. Wat niet klopt wordt genegeerd.
   - Soorten:  cfg/main          instellingen + leden (beheerder)
               rnd/<n>           ronde n met partijen en uitslagen (beheerder)
               vrg/main          bonusvragen met uitkomsten (beheerder)
               spe/<pid>         aanmelding: naam + publieke sleutel (speler zelf)
               vsp/<pid>-<mid>   voorspelling van één partij (speler)
               jok/<pid>-<n>     joker voor ronde n (speler)
               bon/<pid>-<qid>   antwoord op een bonusvraag (speler)
   - Een voorspelling telt alleen als de servertijd van het schrijven vóór de start van de partij ligt;
     een joker vóór de eerste partij van de ronde; een bonusantwoord vóór de sluittijd van de vraag.

   In Node (tests) werkt alles ook: geef fetch/storage mee via Poule.setEnv(). */
(function (root) {
  'use strict';

  const DEFAULT_DB = 'https://w2-samen-default-rtdb.europe-west1.firebasedatabase.app';
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // geen I, O, 0, 1
  const LOWER = 'abcdefghijklmnopqrstuvwxyz234567';
  const CODE_LEN = 8;

  const env = {
    fetch: (u, o) => root.fetch(u, o),
    crypto: root.crypto,
    storage: (() => { try { const s = root.localStorage; s.getItem('x'); return s; } catch (e) { return null; } })(),
    now: () => Date.now()
  };
  const te = new TextEncoder(), td = new TextDecoder();
  const subtle = () => env.crypto.subtle;

  // ---------------------------------------------------------------- hulpjes
  const b64 = buf => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  function rnd(n, alphabet) {
    const a = new Uint8Array(n);
    env.crypto.getRandomValues(a);
    return Array.from(a, b => alphabet[b % alphabet.length]).join('');
  }
  const sget = k => { try { return env.storage ? JSON.parse(env.storage.getItem(k) || 'null') : null; } catch (e) { return null; } };
  const sset = (k, v) => { try { if (env.storage) { if (v == null) env.storage.removeItem(k); else env.storage.setItem(k, JSON.stringify(v)); } } catch (e) {} };
  const dbUrl = () => String(sget('poule-db') || DEFAULT_DB).replace(/\/+$/, '');

  function cleanCode(text) {
    const t = String(text || '').toUpperCase();
    const m = /(?:CODE|JOIN|P)\s*[:=]?\s*([A-Z0-9][A-Z0-9 -]{6,12})/.exec(t);
    for (const cand of [m && m[1], t]) {
      if (!cand) continue;
      const x = cand.replace(/[^A-Z0-9]/g, '');
      if (x.length === CODE_LEN && [...x].every(ch => ALPHA.includes(ch))) return x;
    }
    return '';
  }

  // ---------------------------------------------------------------- sleutels
  async function derive(code) {
    const base = await subtle().importKey('raw', te.encode('poule:' + code), 'HKDF', false, ['deriveBits', 'deriveKey']);
    const salt = te.encode('poule-v1');
    const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('ruimte') }, base, 128);
    const key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode('sleutel') }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { code, room: hex(bits), key };
  }
  async function seal(key, obj) {
    const iv = env.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
    const o = new Uint8Array(12 + ct.byteLength);
    o.set(iv); o.set(new Uint8Array(ct), 12);
    return b64(o);
  }
  async function unseal(key, v) {
    const raw = unb64(v);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(td.decode(pt));
  }

  const pubOf = jwk => ({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  const samePub = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;

  /** Mijn identiteit op dit toestel (maakt hem aan als hij er nog niet is). */
  async function me() {
    let id = sget('poule-ik');
    if (id && id.pid && id.priv && id.priv.d) return id;
    const kp = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const priv = await subtle().exportKey('jwk', kp.privateKey);
    id = { pid: rnd(10, LOWER), priv: { kty: 'EC', crv: 'P-256', x: priv.x, y: priv.y, d: priv.d }, pub: pubOf(priv) };
    sset('poule-ik', id);
    return id;
  }
  /** Inlogcode om hetzelfde account op een ander toestel te gebruiken. */
  async function loginCode() {
    const id = await me();
    const poules = myPoules().map(p => ({ c: p.code, a: p.admin }));
    return 'POULE1.' + btoa(JSON.stringify({ p: id.pid, x: id.priv.x, y: id.priv.y, d: id.priv.d, l: poules }));
  }
  async function useLoginCode(text) {
    const m = /POULE1\.([A-Za-z0-9+/=]+)/.exec(String(text || '').replace(/\s/g, ''));
    if (!m) throw new Error('Dit is geen inlogcode.');
    const o = JSON.parse(atob(m[1]));
    const priv = { kty: 'EC', crv: 'P-256', x: o.x, y: o.y, d: o.d };
    // controleren dat de sleutel werkt
    const k = await subtle().importKey('jwk', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k, te.encode('test'));
    sset('poule-ik', { pid: o.p, priv, pub: pubOf(priv) });
    const list = myPoules();
    for (const p of o.l || []) if (!list.some(q => q.code === p.c)) list.push({ code: p.c, admin: p.a || null, name: '' });
    sset('poule-lijst', list);
    return o.p;
  }
  async function sign(priv, msg) {
    const k = await subtle().importKey('jwk', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return b64(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k, te.encode(msg)));
  }
  async function verify(pub, msg, sig) {
    try {
      const k = await subtle().importKey('jwk', pubOf(pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, k, unb64(sig), te.encode(msg));
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------- mijn poules (op dit toestel)
  const myPoules = () => sget('poule-lijst') || [];
  function remember(p) {
    const list = myPoules().filter(q => q.code !== p.code);
    list.unshift(p);
    sset('poule-lijst', list);
  }
  function forget(code) { sset('poule-lijst', myPoules().filter(q => q.code !== code)); }
  const known = code => myPoules().find(q => q.code === code) || null;

  // ---------------------------------------------------------------- database
  async function put(P, path, data) {
    const id = await me();
    const j = JSON.stringify(data);
    const s = await sign(id.priv, path + '\n' + j);
    const v = await seal(P.key, { j, by: id.pid, s });
    const r = await env.fetch(dbUrl() + '/r/' + P.room + '/' + path + '.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v, t: { '.sv': 'timestamp' } })
    });
    if (!r.ok) throw new Error('Opslaan lukte niet (' + r.status + ').');
    const out = await r.json();
    return out && out.t;
  }
  async function del(P, path) {
    const r = await env.fetch(dbUrl() + '/r/' + P.room + '/' + path + '.json', { method: 'DELETE' });
    if (!r.ok) throw new Error('Verwijderen lukte niet (' + r.status + ').');
  }
  /** Alles van de poule ophalen en ontsleutelen (nog niet gecontroleerd). */
  async function fetchAll(P) {
    const r = await env.fetch(dbUrl() + '/r/' + P.room + '.json?t=' + env.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Ophalen lukte niet (' + r.status + ').');
    const tree = (await r.json()) || {};
    const out = [];
    for (const soort of Object.keys(tree)) {
      const group = tree[soort] || {};
      for (const id of Object.keys(group)) {
        const node = group[id];
        if (!node || typeof node.v !== 'string') continue;
        try {
          const o = await unseal(P.key, node.v);
          out.push({ path: soort + '/' + id, soort, id, j: o.j, by: o.by, s: o.s, t: node.t });
        } catch (e) { /* niet te ontsleutelen: overslaan */ }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- model bouwen (met controle)
  /** Bouwt uit de records het beeld van de poule. Alleen ondertekend en toegestaan telt. */
  async function build(P, recs) {
    const M = { cfg: null, rounds: {}, questions: [], preds: {}, jokers: {}, bonus: {}, requests: [], rejected: 0, adminChanged: false };
    const cfgRec = recs.find(r => r.path === 'cfg/main');
    if (!cfgRec) return M;
    let cfg;
    try { cfg = JSON.parse(cfgRec.j); } catch (e) { M.rejected++; return M; }
    const adminPub = (P.admin && P.admin.pub) || (cfg.admin && cfg.admin.pub);
    const adminPid = (P.admin && P.admin.pid) || (cfg.admin && cfg.admin.pid);
    if (!cfg.admin || cfg.admin.pid !== adminPid || !samePub(cfg.admin.pub, adminPub) || cfgRec.by !== adminPid ||
        !(await verify(adminPub, cfgRec.path + '\n' + cfgRec.j, cfgRec.s))) {
      M.rejected++;
      M.adminChanged = !!P.admin;
      return M;
    }
    M.cfg = cfg;
    const members = cfg.members || {};
    for (const r of recs) {
      if (r.path === 'cfg/main') continue;
      let d;
      try { d = JSON.parse(r.j); } catch (e) { M.rejected++; continue; }
      const msg = r.path + '\n' + r.j;
      if (r.soort === 'rnd' || r.soort === 'vrg') {
        if (r.by !== adminPid || !(await verify(adminPub, msg, r.s))) { M.rejected++; continue; }
        if (r.soort === 'rnd') M.rounds[r.id] = d;
        else M.questions = d.list || [];
        continue;
      }
      if (r.soort === 'spe') {
        if (r.id !== r.by || !d.pub || !(await verify(d.pub, msg, r.s))) { M.rejected++; continue; }
        if (!members[r.by]) M.requests.push({ pid: r.by, name: String(d.name || '').slice(0, 30), pub: pubOf(d.pub), t: r.t });
        continue;
      }
      const mem = members[r.by];
      if (!mem || !r.id.startsWith(r.by + '-') || !(await verify(mem.pub, msg, r.s))) { M.rejected++; continue; }
      const key = r.id.slice(r.by.length + 1);
      if (r.soort === 'vsp') (M.preds[r.by] = M.preds[r.by] || {})[key] = { s: d.s, t: r.t };
      else if (r.soort === 'jok') (M.jokers[r.by] = M.jokers[r.by] || {})[key] = { m: d.m, t: r.t };
      else if (r.soort === 'bon') (M.bonus[r.by] = M.bonus[r.by] || {})[key] = { a: d.a, t: r.t };
      else M.rejected++;
    }
    M.requests.sort((a, b) => (a.t || 0) - (b.t || 0));
    return M;
  }

  /** Openen: code → ruimte, ophalen, controleren. Bij de eerste keer wordt de beheerder onthouden. */
  async function load(code) {
    const P = await derive(code);
    const k = known(code);
    P.admin = k && k.admin || null;
    const recs = await fetchAll(P);
    const M = await build(P, recs);
    if (M.cfg && !P.admin) {
      P.admin = M.cfg.admin;
      remember({ code, admin: M.cfg.admin, name: M.cfg.name, kind: M.cfg.kind });
    } else if (M.cfg && k && k.name !== M.cfg.name) {
      remember(Object.assign({}, k, { name: M.cfg.name, kind: M.cfg.kind }));
    }
    return { P, M };
  }

  // ---------------------------------------------------------------- acties
  const ROUNDS = [
    { n: 1, name: 'Ronde 1', bo: 5 }, { n: 2, name: 'Ronde 2', bo: 5 }, { n: 3, name: 'Ronde 3', bo: 7 },
    { n: 4, name: 'Achtste finale', bo: 7 }, { n: 5, name: 'Kwartfinale', bo: 9 }, { n: 6, name: 'Halve finale', bo: 11 },
    { n: 7, name: 'Finale', bo: 13 }
  ];

  function defaultCfg() {
    return {
      kind: 'darts', name: 'WK Darts 2026/27', inleg: 10, prizes: [60, 30, 10],
      pts: { win: 2, exact: 3 }, factors: [1, 1, 1.5, 1.5, 2, 2, 3], joker: true,
      showOthers: 'start', tiebreak: 'exact'
    };
  }
  function defaultQuestions(closeAt) {
    return [
      { id: 'kampioen', q: 'Wie wordt wereldkampioen?', type: 'Tekst', opts: [], max: 15, rule: 'Vast', close: closeAt, out: '', note: 'Achternaam is genoeg' },
      { id: 'meeste180', q: "Wie gooit de meeste 180's van het toernooi?", type: 'Tekst', opts: [], max: 10, rule: 'Vast', close: closeAt, out: '', note: 'Achternaam is genoeg' }
    ];
  }

  async function create(settings, myName) {
    const id = await me();
    const code = rnd(CODE_LEN, ALPHA);
    const P = await derive(code);
    const cfg = Object.assign(defaultCfg(), settings || {});
    cfg.admin = { pid: id.pid, pub: id.pub };
    cfg.members = { [id.pid]: { name: String(myName || 'Beheerder').slice(0, 30), pub: id.pub } };
    cfg.created = env.now();
    P.admin = cfg.admin;
    await put(P, 'cfg/main', cfg);
    // Bonusvragen sluiten standaard bij de start van het toernooi (vr 11 dec 2026, 20:00 NL-tijd).
    await put(P, 'vrg/main', { list: defaultQuestions(cfg.bonusClose || amsToEpoch(2026, 12, 11, 20, 0)) });
    remember({ code, admin: cfg.admin, name: cfg.name, kind: cfg.kind });
    return code;
  }
  async function join(code, name) {
    const id = await me();
    const { P, M } = await load(code);
    if (!M.cfg) throw new Error('Geen poule gevonden met deze code.');
    if (!(M.cfg.members || {})[id.pid]) await put(P, 'spe/' + id.pid, { name: String(name || '').slice(0, 30), pub: id.pub });
    return { P, M };
  }

  // ---------------------------------------------------------------- tijd (NL-tijd, ook als de telefoon in een andere tijdzone staat)
  function amsOffset(t) {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
    } catch (e) {
      return 3600000;
    }
  }
  function amsToEpoch(y, mo, d, h, mi) {
    const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
    let t = guess - amsOffset(guess);
    t = guess - amsOffset(t);
    return t;
  }
  function fmtTime(t, opts) {
    if (!t) return '';
    try {
      return new Date(t).toLocaleString('nl-NL', Object.assign({ timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, opts || {}));
    } catch (e) {
      return new Date(t).toLocaleString('nl-NL');
    }
  }

  // ---------------------------------------------------------------- punten
  const sgn = x => Math.sign(x[0] - x[1]);
  const factorOf = (cfg, n) => Number((cfg.factors || [])[n - 1] || 1);
  const roundStart = rd => Math.min(...(rd.matches || []).map(m => m.start || Infinity));

  /** Punten voor één voorspelling. Telt alleen als hij vóór de start is opgeslagen. */
  function matchPoints(cfg, rd, m, pred, joker) {
    if (!m.res || !pred || !pred.s || !(pred.t < m.start)) return { pts: 0, win: false, exact: false };
    const win = sgn(pred.s) === sgn(m.res);
    if (!win) return { pts: 0, win: false, exact: false };
    const exact = pred.s[0] === m.res[0] && pred.s[1] === m.res[1];
    let pts = cfg.pts.win + (exact ? cfg.pts.exact : 0);
    pts *= factorOf(cfg, rd.n);
    if (joker && cfg.joker) pts *= 2;
    return { pts: Math.round(pts * 100) / 100, win, exact };
  }
  /** De geldige joker van een speler in een ronde (vóór de eerste partij van die ronde gezet). */
  function jokerOf(M, pid, rd) {
    const j = (M.jokers[pid] || {})[String(rd.n)];
    if (!j || !M.cfg.joker || !(j.t < roundStart(rd))) return null;
    return (rd.matches || []).some(m => m.id === j.m) ? j.m : null;
  }
  const norm = s => String(s == null ? '' : s).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const numv = x => parseFloat(String(x == null ? '' : x).replace(',', '.'));
  function textMatch(a, out) {
    const A = norm(a), O = norm(out);
    if (!A || !O) return false;
    if (A === O) return true;
    // achternaam is genoeg: "littler" telt voor "Luke Littler", ook andersom
    return A.length > 2 && (O.endsWith(' ' + A) || A.endsWith(' ' + O));
  }
  function bonusPoints(M, q, pid) {
    if (q.out === '' || q.out == null) return null;
    const ans = (M.bonus[pid] || {})[q.id];
    if (!ans || ans.a === '' || ans.a == null || !(ans.t < q.close)) return 0;
    if (q.rule === 'Dichtstbij') {
      const o = numv(q.out);
      const dist = p => { const a = (M.bonus[p] || {})[q.id]; return a && a.t < q.close ? Math.abs(numv(a.a) - o) : NaN; };
      const ds = Object.keys(M.cfg.members || {}).map(dist).filter(Number.isFinite);
      const mine = dist(pid);
      return Number.isFinite(mine) && Math.abs(mine - Math.min(...ds)) < 1e-9 ? q.max : 0;
    }
    if (q.type === 'Tekst') return textMatch(ans.a, q.out) ? q.max : 0;
    return norm(ans.a) === norm(q.out) ? q.max : 0;
  }
  function standings(M) {
    const cfg = M.cfg;
    const rows = Object.keys(cfg.members || {}).map(pid => {
      let w = 0, exact = 0, wins = 0, b = 0;
      for (const rd of Object.values(M.rounds)) {
        const jm = jokerOf(M, pid, rd);
        for (const m of rd.matches || []) {
          const r = matchPoints(cfg, rd, m, (M.preds[pid] || {})[m.id], jm === m.id);
          w += r.pts; if (r.exact) exact++; if (r.win) wins++;
        }
      }
      for (const q of M.questions) b += bonusPoints(M, q, pid) || 0;
      w = Math.round(w * 100) / 100;
      return { pid, name: cfg.members[pid].name, w, b, t: Math.round((w + b) * 100) / 100, exact, wins };
    });
    rows.sort((a, b) => b.t - a.t || (cfg.tiebreak === 'exact' ? b.exact - a.exact : 0) || a.name.localeCompare(b.name));
    // plaatsen: gelijke stand (ook na tiebreak) = gedeelde plaats
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      r.pos = prev && prev.t === r.t && (cfg.tiebreak !== 'exact' || prev.exact === r.exact) ? prev.pos : i + 1;
    });
    // prijzen: gedeelde plaatsen delen het prijzengeld van die plaatsen
    const pot = (cfg.inleg || 0) * rows.length;
    const pr = cfg.prizes || [];
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].pos === rows[i].pos) j++;
      let sum = 0;
      for (let k = i; k <= j; k++) sum += (pr[k] || 0);
      for (let k = i; k <= j; k++) rows[k].prize = Math.round(pot * sum / 100 / (j - i + 1) * 100) / 100;
      i = j + 1;
    }
    return { rows, pot };
  }

  // ---------------------------------------------------------------- partijen
  async function matchId(n, a, b) {
    const d = await subtle().digest('SHA-256', te.encode(n + '|' + norm(a) + '|' + norm(b)));
    return 'm' + hex(d).slice(0, 10);
  }
  function parseScore(s, bo) {
    const m = /^\s*(\d{1,2})\s*[-–:]\s*(\d{1,2})\s*$/.exec(String(s == null ? '' : s));
    if (!m) return null;
    const a = +m[1], b = +m[2], need = (bo + 1) / 2;
    if (Math.max(a, b) !== need || Math.min(a, b) >= need) return null;
    return [a, b];
  }
  function scoreOptions(bo) {
    const n = (bo + 1) / 2, o = [];
    for (let i = 0; i < n; i++) o.push([n, i]);
    for (let i = n - 1; i >= 0; i--) o.push([i, n]);
    return o;
  }

  const api = {
    DEFAULT_DB, ROUNDS, setEnv: e => Object.assign(env, e), cleanCode, derive, me, loginCode, useLoginCode,
    myPoules, remember, forget, known, put, del, fetchAll, build, load, create, join, defaultCfg, defaultQuestions,
    amsToEpoch, fmtTime, matchPoints, jokerOf, bonusPoints, standings, roundStart, factorOf, matchId, parseScore,
    scoreOptions, norm, numv, textMatch, samePub, pubOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Poule = api;
})(typeof window !== 'undefined' ? window : globalThis);
