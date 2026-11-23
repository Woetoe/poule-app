// Test van web/poule.js tegen de nep-Firebase (met de echte databaseregels).
// Draaien: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('../tools/nepfirebase.js');
const Poule = require('../web/poule.js');

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
let db;
const devices = {};
function as(name) {
  if (!devices[name]) devices[name] = memStorage();
  Poule.setEnv({ storage: devices[name] });
  devices[name].setItem('poule-db', JSON.stringify(db.url));
}
const HOUR = 3600000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  db = await start();
  Poule.setEnv({ fetch: (u, o) => fetch(u, o), crypto: globalThis.crypto, now: () => Date.now() });
});
test.after(() => db.stop());

test('NL-tijd klopt, ook in de zomer', () => {
  assert.strictEqual(Poule.amsToEpoch(2026, 12, 11, 20, 0), Date.UTC(2026, 11, 11, 19, 0));
  assert.strictEqual(Poule.amsToEpoch(2028, 6, 9, 21, 0), Date.UTC(2028, 5, 9, 19, 0));
});

test('setstanden en code', () => {
  assert.deepStrictEqual(Poule.scoreOptions(5), [[3, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 3]]);
  assert.deepStrictEqual(Poule.parseScore('3-1', 5), [3, 1]);
  assert.strictEqual(Poule.parseScore('3-3', 5), null);
  assert.strictEqual(Poule.parseScore('4-1', 5), null);
  assert.deepStrictEqual(Poule.parseScore('7 - 6', 13), [7, 6]);
  assert.strictEqual(Poule.cleanCode('Doe mee! Code: ABCD-EFGH'), 'ABCDEFGH');
  assert.strictEqual(Poule.cleanCode('https://x/darts.html?join=WXYZ2345'), 'WXYZ2345');
  assert.ok(Poule.textMatch('littler', 'Luke Littler'));
  assert.ok(!Poule.textMatch('lit', 'Luke Littler'));
});

test('hele poule: maken, meedoen, voorspellen, punten, valsspelen', async () => {
  // Wouter maakt de poule
  as('wouter');
  const code = await Poule.create({ name: 'Darts met de jongens', inleg: 10 }, 'Wouter');
  let { P, M } = await Poule.load(code);
  assert.strictEqual(M.cfg.name, 'Darts met de jongens');
  assert.strictEqual(Object.keys(M.cfg.members).length, 1);
  assert.strictEqual(M.questions.length, 2);
  const wouter = (await Poule.me()).pid;

  // Bart doet mee
  as('bart');
  await Poule.join(code, 'Bart');
  const bart = (await Poule.me()).pid;
  ({ M } = await Poule.load(code));
  assert.ok(!M.cfg.members[bart], 'nog niet toegelaten');

  // Wouter ziet het verzoek en laat Bart toe
  as('wouter');
  ({ P, M } = await Poule.load(code));
  assert.strictEqual(M.requests.length, 1);
  assert.strictEqual(M.requests[0].name, 'Bart');
  const cfg = Object.assign({}, M.cfg, { members: Object.assign({}, M.cfg.members, { [bart]: { name: 'Bart', pub: M.requests[0].pub } }) });
  await Poule.put(P, 'cfg/main', cfg);

  // Partijen van ronde 1 (start over een uur)
  const now = Date.now();
  const m1 = await Poule.matchId(1, 'Luke Littler', 'Ryan Joyce');
  const m2 = await Poule.matchId(1, 'Gian van Veen', 'Ricky Evans');
  const rd = { n: 1, name: 'Ronde 1', bo: 5, matches: [
    { id: m1, a: 'Luke Littler', b: 'Ryan Joyce', start: now + HOUR, res: null },
    { id: m2, a: 'Gian van Veen', b: 'Ricky Evans', start: now + 2 * HOUR, res: null }] };
  await Poule.put(P, 'rnd/1', rd);
  await Poule.put(P, 'vsp/' + wouter + '-' + m1, { s: [3, 0] });

  // Bart voorspelt en zet zijn joker; bonusvraag
  as('bart');
  ({ P, M } = await Poule.load(code));
  assert.ok(M.cfg.members[bart], 'Bart is lid');
  await Poule.put(P, 'vsp/' + bart + '-' + m1, { s: [3, 1] });
  await Poule.put(P, 'jok/' + bart + '-1', { m: m1 });
  await Poule.put(P, 'bon/' + bart + '-kampioen', { a: 'littler' });

  // Indringer zonder lidmaatschap probeert te schrijven
  as('indringer');
  const Pi = await Poule.derive(code);
  await Poule.put(Pi, 'vsp/' + bart + '-' + m2, { s: [0, 3] });           // namens Bart: andere sleutel
  await Poule.put(Pi, 'rnd/1', Object.assign({}, rd, { name: 'gehackt' })); // als beheerder: geweigerd

  // Partij 1 is begonnen en gespeeld: 3-1. Bart voorspelt daarna nog partij 1 opnieuw (te laat)
  as('wouter');
  ({ P, M } = await Poule.load(code));
  assert.strictEqual(M.rounds['1'], undefined, 'gehackte ronde telt niet en overschreef de echte');
  await sleep(5);
  const started = Date.now();
  rd.matches[0].start = started;
  rd.matches[0].res = [3, 1];
  await Poule.put(P, 'rnd/1', rd);
  await Poule.put(P, 'vrg/main', { list: M.questions.map(q => (q.id === 'kampioen' ? Object.assign({}, q, { out: 'Luke Littler' }) : q)) });

  as('bart');
  ({ P } = await Poule.load(code));
  await Poule.put(P, 'jok/' + bart + '-1', { m: m2 }); // joker verzetten na de start: telt niet

  ({ P, M } = await Poule.load(code));
  assert.ok(M.rejected >= 1, 'record van de indringer geweigerd');
  assert.strictEqual(Poule.jokerOf(M, bart, M.rounds['1']), null, 'te laat verzette joker telt niet');
  const st = Poule.standings(M);
  const rb = st.rows.find(r => r.pid === bart), rw = st.rows.find(r => r.pid === wouter);
  // Bart: winnaar 2 + exact 3 = 5 (joker te laat verzet → geen ×2) + bonus 15
  assert.strictEqual(rb.w, 5);
  assert.strictEqual(rb.b, 15);
  assert.strictEqual(rb.t, 20);
  // Wouter: goede winnaar 2
  assert.strictEqual(rw.t, 2);
  assert.strictEqual(st.pot, 20);
  assert.strictEqual(rb.prize, 12);
  assert.strictEqual(rw.prize, 6);
  assert.strictEqual(rb.pos, 1);
});

test('joker op tijd telt dubbel', async () => {
  as('anne');
  const code = await Poule.create({ name: 'Joker' }, 'Anne');
  let { P } = await Poule.load(code);
  const anne = (await Poule.me()).pid;
  const id = await Poule.matchId(5, 'A', 'B');
  const rd = { n: 5, name: 'Kwartfinale', bo: 9, matches: [{ id, a: 'A', b: 'B', start: Date.now() + HOUR, res: null }] };
  await Poule.put(P, 'rnd/5', rd);
  await Poule.put(P, 'vsp/' + anne + '-' + id, { s: [5, 4] });
  await Poule.put(P, 'jok/' + anne + '-5', { m: id });
  await sleep(5);
  rd.matches[0].start = Date.now();
  rd.matches[0].res = [5, 4];
  await Poule.put(P, 'rnd/5', rd);
  let M;
  ({ M } = await Poule.load(code));
  // (2 + 3) × factor kwartfinale 2 × joker 2 = 20
  assert.strictEqual(Poule.standings(M).rows[0].w, 20);
});

test('inlogcode: zelfde account op een ander toestel', async () => {
  as('wouter');
  const lc = await Poule.loginCode();
  const pid = (await Poule.me()).pid;
  const codes = Poule.myPoules().map(p => p.code);
  as('nieuwe-telefoon');
  await Poule.useLoginCode('Mijn code: ' + lc);
  assert.strictEqual((await Poule.me()).pid, pid);
  assert.deepStrictEqual(Poule.myPoules().map(p => p.code).sort(), codes.sort());
  await assert.rejects(Poule.useLoginCode('onzin'));
});

test('beheerder vervangen wordt opgemerkt', async () => {
  as('wouter');
  const code = await Poule.create({ name: 'TOFU' }, 'Wouter');
  as('indringer');
  const Pi = await Poule.derive(code);
  const me = await Poule.me();
  await Poule.put(Pi, 'cfg/main', Object.assign(Poule.defaultCfg(), { name: 'Overgenomen', admin: { pid: me.pid, pub: me.pub }, members: {} }));
  as('wouter');
  const { M } = await Poule.load(code);
  assert.strictEqual(M.cfg, null);
  assert.ok(M.adminChanged);
});

test('volgende ronde vanzelf', async () => {
  const mk = async (n, pos, a, b, res) => ({ id: await Poule.matchId(n, a, b), a, b, start: 1, res, pos });
  const rounds = { 1: { n: 1, name: 'Ronde 1', bo: 5, matches: [
    await mk(1, 1, 'A', 'B', [3, 1]), await mk(1, 2, 'C', 'D', [0, 3]),
    await mk(1, 3, 'E', 'F', [3, 2]), await mk(1, 4, 'G', 'H', null)] } };
  let r = await Poule.advance(rounds);
  assert.deepStrictEqual(r.changed, [2]);
  assert.strictEqual(r.rounds[2].matches.length, 1, 'alleen plek 1: plek 3-4 is nog niet klaar');
  const m = r.rounds[2].matches[0];
  assert.deepStrictEqual([m.a, m.b, m.pos, m.start, m.res], ['A', 'D', 1, null, null]);
  assert.strictEqual(m.id, await Poule.matchId(2, 'A', 'D'), 'zelfde id als bij Excel-import');
  assert.strictEqual(r.rounds[2].bo, 5);

  // opnieuw draaien verandert niets
  assert.deepStrictEqual((await Poule.advance(r.rounds)).changed, []);

  // uitslag verbeterd (C won toch): nog niet gespeelde partij in ronde 2 wordt bijgewerkt
  r.rounds[1].matches[1].res = [3, 2];
  r = await Poule.advance(r.rounds);
  assert.deepStrictEqual([r.rounds[2].matches[0].a, r.rounds[2].matches[0].b], ['A', 'C']);

  // gespeelde partij wordt niet meer aangepast
  r.rounds[2].matches[0].res = [3, 0];
  r.rounds[1].matches[0].res = [1, 3];
  r = await Poule.advance(r.rounds);
  assert.deepStrictEqual([r.rounds[2].matches[0].a, r.rounds[2].matches[0].res], ['A', [3, 0]]);

  // tot en met de finale (bo13)
  const r6 = { 6: { n: 6, name: 'Halve finale', bo: 11, matches: [await mk(6, 1, 'P', 'Q', [6, 2]), await mk(6, 2, 'R', 'S', [4, 6])] } };
  const f = (await Poule.advance(r6)).rounds[7];
  assert.deepStrictEqual([f.name, f.bo, f.matches[0].a, f.matches[0].b], ['Finale', 13, 'P', 'S']);
});

test('NL-tijd heen en terug', () => {
  const t = Poule.amsToEpoch(2026, 12, 20, 13, 30);
  assert.strictEqual(Poule.amsLocal(t), '2026-12-20T13:30');
  assert.strictEqual(Poule.fromAmsLocal('2026-12-20T13:30'), t);
  assert.strictEqual(Poule.fromAmsLocal(''), null);
});
