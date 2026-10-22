import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Auftraege } from '../src/auftraege.js';
import { erstelleServer } from '../src/server.js';
import { manifestFehler, uebernehmen, vorgebauteListe } from '../src/vorgebaut.js';
import { Zustand } from '../src/zustand.js';
import { fakeFetch, fakeGeofabrik, tempKonfig } from './helfer.js';

const hash = (b) => createHash('sha256').update(b).digest('hex');

/** Ein Paket in den Import-Ordner legen; `aendern` verdirbt es gezielt. */
function ablegen(konfig, id, aendern = (m) => m) {
  const ordner = join(konfig.pfade.import, id);
  mkdirSync(ordner, { recursive: true });
  const karte = Buffer.from('PMTiles-Inhalt');
  const routing = Buffer.from('tar-Inhalt');
  writeFileSync(join(ordner, `${id}.pmtiles`), karte);
  writeFileSync(join(ordner, `${id}-routing.tar`), routing);
  const manifest = aendern({
    id,
    name: 'Deutschland',
    regionen: [{ id: 'germany', name: 'germany', stand: null }],
    bounds: [5.8, 47.2, 15.1, 55.1],
    gebaut: '2026-10-14T08:23:01.000Z',
    artefakte: {
      karte: { datei: `${id}.pmtiles`, bytes: karte.length, sha256: hash(karte) },
      routing: { datei: `${id}-routing.tar`, bytes: routing.length, sha256: hash(routing) },
    },
  });
  writeFileSync(join(ordner, 'manifest.json'), JSON.stringify(manifest));
  return ordner;
}

test('manifestFehler: nur bekannte Teile mit den erwarteten Dateinamen', () => {
  const gut = { id: 'x', name: 'X', bounds: [0, 0, 1, 1], artefakte: { karte: { datei: 'x.pmtiles', bytes: 1, sha256: 'a'.repeat(64) } } };
  assert.equal(manifestFehler(gut, 'x'), null);
  assert.match(manifestFehler(gut, 'y'), /gehört zu/);
  assert.match(manifestFehler({ ...gut, artefakte: { karte: { ...gut.artefakte.karte, datei: '../x.pmtiles' } } }, 'x'), /muss/);
  assert.match(manifestFehler({ ...gut, artefakte: { sonst: gut.artefakte.karte } }, 'x'), /unbekannter Teil/);
  assert.match(manifestFehler({ ...gut, bounds: [0, 0] }, 'x'), /bounds/);
  assert.match(manifestFehler(null, 'x'), /fehlt/);
});

test('uebernehmen prüft Größe und sha256 und verschiebt den Ordner', async () => {
  const t = tempKonfig();
  try {
    ablegen(t.konfig, 'germany');
    ablegen(t.konfig, 'kaputt', (m) => ({ ...m, id: 'kaputt', artefakte: { karte: { ...m.artefakte.karte, datei: 'kaputt.pmtiles', sha256: 'b'.repeat(64) } } }));
    const liste = await vorgebauteListe(t.konfig);
    assert.deepEqual(liste.map((v) => [v.id, v.fehler]), [['germany', null], ['kaputt', null]]);

    await assert.rejects(uebernehmen({ konfig: t.konfig, id: 'kaputt' }), /sha256 stimmt nicht/);
    assert.ok(existsSync(join(t.konfig.pfade.import, 'kaputt')), 'bleibt bei Fehler liegen');

    const manifest = await uebernehmen({ konfig: t.konfig, id: 'germany' });
    assert.equal(manifest.name, 'Deutschland');
    assert.ok(manifest.importiert);
    assert.ok(existsSync(join(t.konfig.pfade.pakete, 'germany', 'germany-routing.tar')));
    assert.ok(!existsSync(join(t.konfig.pfade.import, 'germany')));
  } finally {
    t.aufraeumen();
  }
});

test('uebernehmen erkennt unvollständige Übertragung', async () => {
  const t = tempKonfig();
  try {
    const ordner = ablegen(t.konfig, 'germany');
    writeFileSync(join(ordner, 'germany.pmtiles'), 'kurz');
    await assert.rejects(uebernehmen({ konfig: t.konfig, id: 'germany' }), /unvollständig/);
  } finally {
    t.aufraeumen();
  }
});

test('API: übernehmen, im Katalog für Go, nicht baubar', async () => {
  const t = tempKonfig();
  const zustand = new Zustand(t.konfig.pfade.zustand);
  const geofabrik = fakeGeofabrik();
  const auftraege = new Auftraege({ konfig: t.konfig, zustand, geofabrik, bauen: async () => ({}) });
  const server = erstelleServer({ konfig: t.konfig, zustand, geofabrik, auftraege, fetchImpl: fakeFetch() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const basis = `http://127.0.0.1:${server.address().port}`;
  const admin = { Authorization: `Basic ${Buffer.from('admin:geheim').toString('base64')}` };
  try {
    ablegen(t.konfig, 'germany');
    const liste = await (await fetch(`${basis}/api/vorgebaut`, { headers: admin })).json();
    assert.equal(liste[0].id, 'germany');

    const r = await fetch(`${basis}/api/vorgebaut/germany`, { method: 'POST', headers: admin });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).status, 'prueft');
    for (let i = 0; i < 50 && zustand.pakete.germany.status === 'prueft'; i++) await new Promise((x) => setTimeout(x, 20));
    assert.equal(zustand.pakete.germany.status, 'fertig');
    assert.deepEqual(zustand.pakete.germany.regionen, ['germany']);

    const token = zustand.token();
    const katalog = await (await fetch(`${basis}/v1/katalog`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(katalog[0].id, 'germany');
    assert.ok(katalog[0].routing.url.endsWith('/v1/pakete/germany/germany-routing.tar'));
    const tar = await fetch(katalog[0].routing.url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(await tar.text(), 'tar-Inhalt');

    const bauen = await fetch(`${basis}/api/pakete/germany/bauen`, { method: 'POST', headers: admin, body: '{}' });
    assert.equal(bauen.status, 409);
  } finally {
    await new Promise((r) => server.close(r));
    t.aufraeumen();
  }
});
