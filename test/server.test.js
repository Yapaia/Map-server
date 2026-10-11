import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Auftraege } from '../src/auftraege.js';
import { bereichAus, erstelleServer, istAdmin, katalogEintrag } from '../src/server.js';
import { Zustand, idAusName } from '../src/zustand.js';
import { fakeFetch, fakeGeofabrik, tempKonfig } from './helfer.js';

async function starten(extra = {}) {
  const t = tempKonfig(extra);
  const zustand = new Zustand(t.konfig.pfade.zustand);
  const geofabrik = fakeGeofabrik();
  const auftraege = new Auftraege({ konfig: t.konfig, zustand, geofabrik, bauen: async ({ paket }) => ({ id: paket.id, artefakte: {} }) });
  const server = erstelleServer({ konfig: t.konfig, zustand, geofabrik, auftraege, fetchImpl: fakeFetch() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: `Basic ${Buffer.from('admin:geheim').toString('base64')}` };
  return {
    ...t, zustand, auftraege, basis, admin,
    holen: (pfad, init = {}) => fetch(basis + pfad, init),
    ende: async () => {
      await new Promise((r) => server.close(r));
      t.aufraeumen();
    },
  };
}

test('Oberfläche nur mit Passwort, ohne Passwort gar nicht', async () => {
  const s = await starten();
  try {
    assert.equal((await s.holen('/gesund')).status, 200);
    const ohne = await s.holen('/');
    assert.equal(ohne.status, 401);
    assert.match(ohne.headers.get('www-authenticate'), /Basic/);
    const falsch = await s.holen('/api/pakete', { headers: { Authorization: `Basic ${Buffer.from('admin:nein').toString('base64')}` } });
    assert.equal(falsch.status, 401);
    const seite = await s.holen('/', { headers: s.admin });
    assert.equal(seite.status, 200);
    assert.match(await seite.text(), /Yapaia Kartenserver/);
    assert.equal((await s.holen('/app.js', { headers: s.admin })).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await s.holen('/..%2Fpackage.json', { headers: s.admin })).status, 404);
  } finally {
    await s.ende();
  }
  const ohnePw = await starten({ ADMIN_PASSWORT: '' });
  try {
    assert.equal((await ohnePw.holen('/', { headers: ohnePw.admin })).status, 503);
  } finally {
    await ohnePw.ende();
  }
});

test('Pakete anlegen, prüfen, bauen, löschen', async () => {
  const s = await starten();
  const post = (pfad, body) => s.holen(pfad, { method: 'POST', headers: { ...s.admin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/pakete', { name: '', regionen: ['austria'] })).status, 400);
    assert.equal((await post('/api/pakete', { name: 'X', regionen: [] })).status, 400);
    const unbekannt = await post('/api/pakete', { name: 'X', regionen: ['mars'] });
    assert.equal(unbekannt.status, 400);
    assert.match((await unbekannt.json()).fehler, /mars/);
    const neu = await post('/api/pakete', { name: 'Österreich & Liechtenstein', regionen: ['austria', 'liechtenstein', 'austria'] });
    assert.equal(neu.status, 201);
    const paket = await neu.json();
    assert.equal(paket.id, 'oesterreich-liechtenstein');
    assert.deepEqual(paket.regionen, ['austria', 'liechtenstein']);
    assert.deepEqual(paket.teile, ['karte', 'suche', 'routing']);
    assert.equal((await post('/api/pakete', { name: 'Österreich & Liechtenstein', regionen: ['austria'] })).status, 409);

    const auftrag = await (await post(`/api/pakete/${paket.id}/bauen`, {})).json();
    assert.equal(auftrag.paket, paket.id);
    await s.auftraege.fertig;
    const liste = await (await s.holen('/api/auftraege', { headers: s.admin })).json();
    assert.equal(liste[0].status, 'fertig');
    const protokoll = await (await s.holen(`/api/auftraege/${auftrag.id}/protokoll`, { headers: s.admin })).json();
    assert.match(protokoll.text, /Bau von/);

    const groesse = await (await s.holen('/api/katalog/groesse?ids=austria,liechtenstein', { headers: s.admin })).json();
    assert.equal(groesse.summe, 16384);
    assert.ok(groesse.platzBedarf > groesse.summe);

    assert.equal((await s.holen(`/api/pakete/${paket.id}`, { method: 'DELETE', headers: s.admin })).status, 200);
    assert.deepEqual(await (await s.holen('/api/pakete', { headers: s.admin })).json(), []);
  } finally {
    await s.ende();
  }
});

test('für Go: Katalog und Downloads nur mit Token, mit Range, nur was das Manifest nennt', async () => {
  const s = await starten({ DOWNLOAD_TOKEN: 'go-token' });
  try {
    const ordner = join(s.konfig.pfade.pakete, 'li');
    mkdirSync(ordner, { recursive: true });
    writeFileSync(join(ordner, 'li.pmtiles'), '0123456789');
    writeFileSync(join(ordner, 'geheim.txt'), 'nein');
    s.zustand.pakete.li = {
      id: 'li', name: 'Liechtenstein', regionen: ['liechtenstein'], status: 'fertig',
      manifest: { id: 'li', name: 'Liechtenstein', bounds: [9.47, 47.04, 9.64, 47.27], gebaut: '2026-10-11T00:00:00Z', regionen: [], artefakte: { karte: { datei: 'li.pmtiles', bytes: 10, sha256: 'abc' } } },
    };
    s.zustand.pakete.neu = { id: 'neu', name: 'Neu', regionen: [], status: 'neu' };

    assert.equal((await s.holen('/v1/katalog')).status, 401);
    assert.equal((await s.holen('/v1/katalog', { headers: { Authorization: 'Bearer falsch' } })).status, 401);
    const katalog = await (await s.holen('/v1/katalog', { headers: { Authorization: 'Bearer go-token', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'karten.example.org' } })).json();
    assert.equal(katalog.length, 1, 'nur fertige Pakete');
    assert.equal(katalog[0].url, 'https://karten.example.org/v1/pakete/li/li.pmtiles');
    assert.equal(katalog[0].sizeBytes, 10);

    const voll = await s.holen('/v1/pakete/li/li.pmtiles?token=go-token');
    assert.equal(voll.status, 200);
    assert.equal(await voll.text(), '0123456789');
    const teil = await s.holen('/v1/pakete/li/li.pmtiles', { headers: { Authorization: 'Bearer go-token', Range: 'bytes=4-' } });
    assert.equal(teil.status, 206);
    assert.equal(teil.headers.get('content-range'), 'bytes 4-9/10');
    assert.equal(await teil.text(), '456789');
    const kopf = await s.holen('/v1/pakete/li/li.pmtiles?token=go-token', { method: 'HEAD' });
    assert.equal(kopf.headers.get('content-length'), '10');
    assert.equal((await s.holen('/v1/pakete/li/li.pmtiles?token=go-token', { headers: { Range: 'bytes=50-' } })).status, 416);
    assert.equal((await s.holen('/v1/pakete/li/geheim.txt?token=go-token')).status, 404);
    assert.equal((await s.holen('/v1/pakete/li/..%2F..%2Fzustand.json?token=go-token')).status, 404);
    assert.equal((await s.holen('/v1/pakete/neu/neu.pmtiles?token=go-token')).status, 404);
  } finally {
    await s.ende();
  }
});

test('ohne vorgegebenes Token wird eines erzeugt und gemerkt', async () => {
  const s = await starten();
  try {
    const status = await (await s.holen('/api/status', { headers: s.admin })).json();
    assert.ok(status.token.length >= 30);
    assert.equal(new Zustand(s.konfig.pfade.zustand).downloadToken, status.token);
    assert.match(status.katalogUrl, /\/v1\/katalog$/);
    assert.equal((await s.holen(`/v1/katalog?token=${status.token}`)).status, 200);
  } finally {
    await s.ende();
  }
});

test('Hilfen', () => {
  assert.deepEqual(bereichAus('bytes=0-3', 10), { start: 0, ende: 3 });
  assert.deepEqual(bereichAus('bytes=-4', 10), { start: 6, ende: 9 });
  assert.equal(bereichAus('bytes=12-', 10), null);
  assert.equal(bereichAus(undefined, 10), undefined);
  assert.equal(istAdmin(`Basic ${Buffer.from('admin:a:b').toString('base64')}`, 'a:b'), true);
  assert.equal(istAdmin(`Basic ${Buffer.from('root:x').toString('base64')}`, 'x'), false);
  assert.equal(istAdmin('Basic xyz', ''), false);
  assert.equal(idAusName('Alpen & Adria 2026'), 'alpen-adria-2026');
  assert.equal(idAusName('!!!'), '');
  const e = katalogEintrag({ id: 'x', name: 'X', bounds: [0, 0, 1, 1], artefakte: { routing: { datei: 'x-routing.tar', bytes: 5, sha256: 's' } } }, 'https://h');
  assert.equal(e.sizeBytes, 0);
  assert.deepEqual(e.routing, { url: 'https://h/v1/pakete/x/x-routing.tar', sizeBytes: 5, sha256: 's' });
});
