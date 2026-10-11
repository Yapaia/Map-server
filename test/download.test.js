import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { herunterladen, istOsmPbf, kopfdaten } from '../src/download.js';
import { fakeFetch, pbfBytes, tempKonfig } from './helfer.js';

test('lädt herunter, setzt einen abgebrochenen Download fort und prüft die Kennung', async () => {
  const { dir, aufraeumen } = tempKonfig();
  try {
    const ziel = join(dir, 'li.osm.pbf');
    const voll = pbfBytes(8192, 2);
    writeFileSync(`${ziel}.part`, voll.subarray(0, 3000));
    const aufrufe = [];
    let zuletzt = 0;
    const erg = await herunterladen('https://x/li.osm.pbf', ziel, { fetchImpl: fakeFetch({ aufrufe }), fortschritt: (g) => (zuletzt = g) });
    assert.equal(erg.bytes, 8192);
    assert.equal(erg.letzteAenderung, 'Mon, 05 Oct 2026 20:00:00 GMT');
    assert.deepEqual(readFileSync(ziel), voll);
    assert.equal(zuletzt, 8192);
    assert.equal(existsSync(`${ziel}.part`), false);
    assert.equal(await istOsmPbf(ziel), true);
  } finally {
    aufraeumen();
  }
});

test('eine HTML-Seite statt PBF wird verworfen', async () => {
  const { dir, aufraeumen } = tempKonfig();
  try {
    const ziel = join(dir, 'x.osm.pbf');
    const html = async () => new Response('<html>Fehler</html>', { headers: { 'content-length': '19' } });
    await assert.rejects(herunterladen('https://x', ziel, { fetchImpl: html }), /keine OSM-PBF/);
    assert.equal(existsSync(ziel) || existsSync(`${ziel}.part`), false);
    await assert.rejects(herunterladen('https://x', ziel, { fetchImpl: async () => new Response('', { status: 404 }) }), /HTTP 404/);
  } finally {
    aufraeumen();
  }
});

test('Kopfdaten ohne Download', async () => {
  assert.deepEqual(await kopfdaten('https://x', { fetchImpl: fakeFetch() }), { bytes: 8192, letzteAenderung: 'Mon, 05 Oct 2026 20:00:00 GMT' });
  assert.equal(await kopfdaten('https://x', { fetchImpl: async () => { throw new Error('weg'); } }), null);
});
