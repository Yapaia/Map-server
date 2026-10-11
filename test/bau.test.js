import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ausfuehren, bauePaket, boxAus, platzBedarf } from '../src/bau.js';
import { Zustand } from '../src/zustand.js';
import { fakeFetch, fakeGeofabrik, pbfBytes, tempKonfig } from './helfer.js';

/** Baut die Skripte des Go-Images nach: legen an, was die echten anlegen. */
function fakeRun(konfig, aufrufe) {
  return async (befehl, args, { env = {}, protokoll }) => {
    aufrufe.push({ befehl, args, env });
    protokoll(`lauf ${befehl.split('/').pop()}`);
    const id = args[1];
    if (befehl === konfig.befehle.osmium && args[0] === 'merge') {
      writeFileSync(args[args.indexOf('-o') + 1], pbfBytes(9000, 3));
      return '';
    }
    if (befehl === konfig.befehle.osmium && args[0] === 'fileinfo') return '(9.47,47.04,9.64,47.27)\n';
    if (befehl === konfig.befehle.karte) {
      assert.equal(env.PLANETILER_SOURCES_DIR, konfig.pfade.quellen);
      assert.ok(readFileSync(args[0]).includes('OSMHeader'), 'die zusammengeführte PBF liegt vor');
      mkdirSync(env.TILES_DIR, { recursive: true });
      writeFileSync(join(env.TILES_DIR, `${id}.pmtiles`), 'PMTiles-Inhalt');
      return '';
    }
    if (befehl === konfig.befehle.suche) {
      // Das Skript sucht die PBF im Zwischenlager neben dem Ziel -- und nur dort
      assert.ok(existsSync(join(dirname(dirname(env.LITE_SEARCH_DB_PATH)), 'planetiler-sources', `${id}.osm.pbf`)));
      mkdirSync(dirname(env.LITE_SEARCH_DB_PATH), { recursive: true });
      writeFileSync(join(dirname(env.LITE_SEARCH_DB_PATH), `lite_search-${id}.db`), 'SQLite format 3');
      return '';
    }
    if (befehl === konfig.befehle.routing) {
      const lager = join(dirname(dirname(env.VALHALLA_TILES_DIR)), 'planetiler-sources');
      assert.deepEqual(readdirSync(lager), [`${id}.osm.pbf`], 'der Routinggraph baut nur über dieses Paket');
      mkdirSync(env.VALHALLA_TILES_DIR, { recursive: true });
      writeFileSync(join(env.VALHALLA_TILES_DIR, 'valhalla.json'), '{}');
      writeFileSync(join(dirname(env.VALHALLA_TILES_DIR), 'build-info.json'), '{}');
      return '';
    }
    if (befehl === konfig.befehle.tar) {
      writeFileSync(args[args.indexOf('-cf') + 1], 'tar-inhalt');
      return '';
    }
    throw new Error(`unerwartet: ${befehl} ${args.join(' ')}`);
  };
}

function aufbau(paket, extra = {}) {
  const t = tempKonfig();
  const zustand = new Zustand(t.konfig.pfade.zustand);
  const aufrufe = [];
  const protokoll = [];
  const schritte = [];
  const ctx = {
    konfig: t.konfig,
    zustand,
    geofabrik: fakeGeofabrik(),
    paket,
    protokoll: (z) => protokoll.push(z),
    schritt: (s) => schritte.push(s),
    run: fakeRun(t.konfig, aufrufe),
    fetchImpl: fakeFetch(),
    ...extra,
  };
  return { ...t, zustand, aufrufe, protokoll, schritte, ctx };
}

test('ein Paket aus zwei Regionen: zusammenführen, bauen, veröffentlichen', async () => {
  const a = aufbau({ id: 'alpen', name: 'Alpen', regionen: ['liechtenstein', 'austria'] });
  try {
    const manifest = await bauePaket(a.ctx);
    assert.deepEqual(a.schritte, ['Extrakte laden', 'Zusammenführen', 'Karte bauen', 'Suchindex bauen', 'Routing bauen', 'Veröffentlichen']);
    const merge = a.aufrufe.find((x) => x.args[0] === 'merge');
    assert.deepEqual(merge.args.slice(-2), [join(a.konfig.pfade.extrakte, 'liechtenstein.osm.pbf'), join(a.konfig.pfade.extrakte, 'austria.osm.pbf')]);
    assert.deepEqual(manifest.bounds, [9.47, 47.04, 9.64, 47.27]);
    assert.deepEqual(Object.keys(manifest.artefakte), ['karte', 'suche', 'routing']);

    const ordner = join(a.konfig.pfade.pakete, 'alpen');
    assert.deepEqual(readdirSync(ordner).sort(), ['alpen-routing.tar', 'alpen.pmtiles', 'lite_search-alpen.db', 'manifest.json']);
    const pm = manifest.artefakte.karte;
    assert.equal(pm.sha256, createHash('sha256').update('PMTiles-Inhalt').digest('hex'));
    assert.equal(pm.bytes, 'PMTiles-Inhalt'.length);
    assert.deepEqual(JSON.parse(readFileSync(join(ordner, 'manifest.json'))), manifest);

    // Routing-Archiv: tiles/ und build-info.json, ohne die PBF
    const tar = a.aufrufe.find((x) => x.befehl === a.konfig.befehle.tar);
    assert.ok(tar.args.includes('--exclude=*.osm.pbf') && tar.args.includes('tiles') && tar.args.includes('build-info.json'));
    // Threads für Valhalla aus der Konfiguration
    assert.equal(a.aufrufe.find((x) => x.befehl === a.konfig.befehle.routing).env.VALHALLA_BUILD_THREADS, '2');

    // Aufgeräumt: Zwischenstände weg, Extrakte bleiben, Stand gemerkt
    assert.equal(existsSync(join(a.konfig.pfade.bau, 'alpen')), false);
    assert.equal(existsSync(join(a.konfig.pfade.quellen, 'alpen.osm.pbf')), false);
    assert.ok(existsSync(join(a.konfig.pfade.extrakte, 'austria.osm.pbf')));
    assert.equal(a.zustand.extrakte.austria.stand, 'Mon, 05 Oct 2026 20:00:00 GMT');
  } finally {
    a.aufraeumen();
  }
});

test('eine Region: kein Zusammenführen; nur gewählte Teile; vorhandener Extrakt wird benutzt', async () => {
  const a = aufbau({ id: 'li', name: 'LI', regionen: ['liechtenstein'], teile: ['karte'] });
  try {
    mkdirSync(a.konfig.pfade.extrakte, { recursive: true });
    writeFileSync(join(a.konfig.pfade.extrakte, 'liechtenstein.osm.pbf'), pbfBytes());
    const aufrufe = [];
    a.ctx.fetchImpl = fakeFetch({ aufrufe });
    const m = await bauePaket(a.ctx);
    assert.equal(aufrufe.length, 0, 'nichts heruntergeladen');
    assert.ok(!a.aufrufe.some((x) => x.args[0] === 'merge'));
    assert.deepEqual(Object.keys(m.artefakte), ['karte']);
    assert.deepEqual(a.schritte.slice(2), ['Karte bauen', 'Veröffentlichen']);
  } finally {
    a.aufraeumen();
  }
});

test('„mit neuen Daten": lädt nur, wenn Geofabrik einen neueren Stand hat', async () => {
  const a = aufbau({ id: 'li', name: 'LI', regionen: ['liechtenstein'], teile: ['karte'] }, { aktualisieren: true });
  try {
    mkdirSync(a.konfig.pfade.extrakte, { recursive: true });
    writeFileSync(join(a.konfig.pfade.extrakte, 'liechtenstein.osm.pbf'), pbfBytes());
    a.zustand.extrakte.liechtenstein = { stand: 'Mon, 05 Oct 2026 20:00:00 GMT' };
    let aufrufe = [];
    a.ctx.fetchImpl = fakeFetch({ aufrufe });
    await bauePaket(a.ctx);
    assert.deepEqual(aufrufe.map((x) => x.methode), ['HEAD']);

    aufrufe = [];
    a.ctx.fetchImpl = fakeFetch({ aufrufe, stand: 'Tue, 06 Oct 2026 20:00:00 GMT' });
    await bauePaket(a.ctx);
    assert.deepEqual(aufrufe.map((x) => x.methode), ['HEAD', 'GET']);
    assert.equal(a.zustand.extrakte.liechtenstein.stand, 'Tue, 06 Oct 2026 20:00:00 GMT');
  } finally {
    a.aufraeumen();
  }
});

test('ein Fehler lässt das alte Paket stehen', async () => {
  const a = aufbau({ id: 'li', name: 'LI', regionen: ['liechtenstein'], teile: ['karte'] });
  try {
    await bauePaket(a.ctx);
    const vorher = readFileSync(join(a.konfig.pfade.pakete, 'li', 'manifest.json'), 'utf-8');
    const normal = a.ctx.run;
    a.ctx.run = async (befehl, args, o) => {
      if (befehl === a.konfig.befehle.karte) throw new Error('planetiler kaputt');
      return normal(befehl, args, o);
    };
    await assert.rejects(bauePaket(a.ctx), /planetiler kaputt/);
    assert.equal(readFileSync(join(a.konfig.pfade.pakete, 'li', 'manifest.json'), 'utf-8'), vorher);
    await assert.rejects(bauePaket({ ...a.ctx, paket: { id: 'x', name: 'X', regionen: ['gibts-nicht'] } }), /Unbekannte Region/);
  } finally {
    a.aufraeumen();
  }
});

test('Hilfen: Ausdehnung, Platzbedarf', () => {
  assert.deepEqual(boxAus('(9.47,47.04,9.64,47.27)'), [9.47, 47.04, 9.64, 47.27]);
  assert.deepEqual(boxAus('9.64 47.27 9.47 47.04'), [9.47, 47.04, 9.64, 47.27]);
  assert.equal(boxAus(''), null);
  assert.equal(boxAus('(500,1,2,3)'), null);
  assert.equal(platzBedarf(1024 ** 3), 15 * 1024 ** 3);
});

test('ausfuehren: Protokoll, Fehlercode, Abbrechen der ganzen Prozessgruppe', async () => {
  const zeilen = [];
  await assert.rejects(ausfuehren('sh', ['-c', 'echo hallo; echo welt >&2; exit 3'], { protokoll: (z) => zeilen.push(z) }), /Code 3/);
  assert.deepEqual(zeilen.sort(), ['hallo', 'welt']);
  assert.equal(await ausfuehren('sh', ['-c', 'echo "(1,2,3,4)"'], { ausgabeSammeln: true }), '(1,2,3,4)\n');
  const c = new AbortController();
  const lauf = ausfuehren('sh', ['-c', 'sleep 30 & wait'], { signal: c.signal });
  setTimeout(() => c.abort(), 100);
  const start = Date.now();
  await assert.rejects(lauf, /abgebrochen/);
  assert.ok(Date.now() - start < 5000);
});
