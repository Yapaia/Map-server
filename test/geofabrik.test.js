import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Geofabrik, eintraegeAus } from '../src/geofabrik.js';
import { KATALOG, tempKonfig } from './helfer.js';

test('liest nur Extrakte mit PBF, sortiert nach Namen', () => {
  const e = eintraegeAus(KATALOG);
  assert.deepEqual(e.map((x) => x.id), ['europe', 'liechtenstein', 'austria']);
  assert.equal(e[1].eltern, 'europe');
  assert.deepEqual(eintraegeAus(null), []);
});

test('fragt Geofabrik einmal, dann aus dem Zwischenspeicher; bei Ausfall der letzte Stand', async () => {
  const { konfig, aufraeumen } = tempKonfig();
  try {
    let aufrufe = 0;
    const ok = async () => {
      aufrufe++;
      return new Response(JSON.stringify(KATALOG));
    };
    const g = new Geofabrik({ url: 'https://x', cachePfad: konfig.pfade.katalogCache, fetchImpl: ok });
    assert.equal((await g.liste()).length, 3);
    assert.equal((await new Geofabrik({ url: 'https://x', cachePfad: konfig.pfade.katalogCache, fetchImpl: ok }).liste()).length, 3);
    assert.equal(aufrufe, 1);

    // Zwischenspeicher veraltet, Geofabrik nicht erreichbar: alter Stand
    const alt = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    utimesSync(konfig.pfade.katalogCache, alt, alt);
    const kaputt = new Geofabrik({ url: 'https://x', cachePfad: konfig.pfade.katalogCache, fetchImpl: async () => { throw new Error('weg'); } });
    assert.equal((await kaputt.finde('austria')).name, 'Österreich');

    // Ohne jeden Stand: klare Meldung
    writeFileSync(konfig.pfade.katalogCache, 'kaputt');
    await assert.rejects(kaputt.liste(), /nicht erreichbar/);
  } finally {
    aufraeumen();
  }
});
