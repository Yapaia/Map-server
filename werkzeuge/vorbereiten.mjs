#!/usr/bin/env node
/**
 * Ein vorgebautes Paket für den Kartenserver vorbereiten -- auf dem Rechner,
 * der die Kartendaten schon hat (z. B. Yapaia Go auf Home Assistant).
 *
 *   node vorbereiten.mjs --ziel /share/kartenserver-export --id germany --name Deutschland \
 *     --karte /share/yapaia/tiles/germany.pmtiles --suche /share/yapaia/lite-search/lite_search-germany.db
 *
 *   node vorbereiten.mjs --ziel /share/kartenserver-export --id routing-dach --name "Routing DE, CH, LI" \
 *     --routing /share/yapaia/valhalla --bounds 5.8,45.8,15.1,55.1
 *
 * Legt `<ziel>/<id>/` an: die Dateien unter den Namen, die der Kartenserver
 * und Go erwarten (Karte und Suche als harter Link, wenn möglich -- kein
 * zusätzlicher Platz), das Routing als tar (`tiles/` + `build-info.json`) und
 * `manifest.json` mit Größe und sha256. Diesen Ordner dann in den
 * Import-Ordner des Kartenservers kopieren (siehe README).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ID_MUSTER = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const { values: a } = parseArgs({
  options: {
    ziel: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    karte: { type: 'string' },
    suche: { type: 'string' },
    routing: { type: 'string' },
    bounds: { type: 'string' },
    regionen: { type: 'string' },
    // Suche und Routing mit zstd packen (Karte nicht: PMTiles ist schon
    // komprimiert). Gemessen an der Schweiz: Suche auf 25 %, Routing auf 33 %
    // -- halbiert Speicher und Datenvolumen. Go entpackt ab 0.64.0.
    // Stufe 6: Suche 27 %, Routing 38 % bei ~45 MB/s. Stufe 19 spart nur noch
    // 4 Prozentpunkte, ist aber ~40-mal langsamer (gemessen 2026-10-27).
    zstd: { type: 'boolean', default: false },
    'zstd-stufe': { type: 'string', default: '6' },
  },
});

function abbruch(text) {
  console.error(`Fehler: ${text}`);
  process.exit(1);
}

if (!a.ziel || !a.id || !a.name) abbruch('--ziel, --id und --name sind nötig');
if (!ID_MUSTER.test(a.id)) abbruch('--id: nur a-z, 0-9, - und _');
if (!a.karte && !a.suche && !a.routing) abbruch('mindestens --karte, --suche oder --routing angeben');

/** bounds aus dem Kopf einer PMTiles-v3-Datei: [W, S, O, N]. */
function pmtilesBounds(pfad) {
  const kopf = Buffer.alloc(127);
  const fd = openSync(pfad, 'r');
  readSync(fd, kopf, 0, 127, 0);
  closeSync(fd);
  if (kopf.toString('latin1', 0, 7) !== 'PMTiles' || kopf[7] !== 3) abbruch(`${pfad} ist keine PMTiles-v3-Datei`);
  return [102, 106, 110, 114].map((o) => kopf.readInt32LE(o) / 1e7);
}

async function sha256(pfad) {
  const h = createHash('sha256');
  for await (const stueck of createReadStream(pfad)) h.update(stueck);
  return h.digest('hex');
}

function verlinken(quelle, ziel) {
  if (!existsSync(quelle)) abbruch(`${quelle} fehlt`);
  rmSync(ziel, { force: true });
  try {
    linkSync(quelle, ziel);
  } catch {
    copyFileSync(quelle, ziel);
  }
}

const ordner = join(a.ziel, a.id);
mkdirSync(ordner, { recursive: true });
const dateien = {};
let bounds = a.bounds ? a.bounds.split(',').map(Number) : null;
const staende = [];
let regionen = a.regionen ? a.regionen.split(',').map((s) => s.trim()).filter(Boolean) : null;

if (a.karte) {
  dateien.karte = `${a.id}.pmtiles`;
  verlinken(a.karte, join(ordner, dateien.karte));
  bounds ??= pmtilesBounds(a.karte);
  staende.push(statSync(a.karte).mtimeMs);
}
if (a.suche) {
  dateien.suche = `lite_search-${a.id}.db`;
  verlinken(a.suche, join(ordner, dateien.suche));
  staende.push(statSync(a.suche).mtimeMs);
}
if (a.routing) {
  if (!existsSync(join(a.routing, 'tiles', 'valhalla.json'))) abbruch(`${a.routing}/tiles/valhalla.json fehlt – --routing ist der Ordner mit tiles/ und build-info.json`);
  dateien.routing = `${a.id}-routing.tar`;
  console.log(`Packe ${dateien.routing} …`);
  const teile = ['tiles', ...(existsSync(join(a.routing, 'build-info.json')) ? ['build-info.json'] : [])];
  const r = spawnSync('tar', ['-C', a.routing, '--exclude=*.osm.pbf', '-cf', join(ordner, dateien.routing), ...teile], { stdio: 'inherit' });
  if (r.status !== 0) abbruch('tar ist fehlgeschlagen');
  if (teile.includes('build-info.json')) {
    const info = JSON.parse(readFileSync(join(a.routing, 'build-info.json'), 'utf-8'));
    regionen ??= info.regions ?? null;
    if (info.built_at) staende.push(Date.parse(info.built_at));
  }
}

if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite)) abbruch('bounds unbekannt – bitte --bounds W,S,O,N angeben');

const entpackt = {};
if (a.zstd) {
  for (const teil of ['suche', 'routing']) {
    if (!dateien[teil]) continue;
    const pfad = join(ordner, dateien[teil]);
    entpackt[teil] = statSync(pfad).size;
    console.log(`Packe ${dateien[teil]} mit zstd -${a['zstd-stufe']} …`);
    // --rm entfernt nur den Eintrag im Paketordner (bei der Suche ein harter
    // Link) -- die Quelle bleibt.
    const r = spawnSync('zstd', ['-q', '-T0', `-${a['zstd-stufe']}`, '--rm', '-f', '-o', `${pfad}.zst`, pfad], { stdio: 'inherit' });
    if (r.status !== 0) abbruch(`zstd ist fehlgeschlagen (${dateien[teil]}) – ist zstd installiert?`);
    dateien[teil] = `${dateien[teil]}.zst`;
  }
}

const artefakte = {};
for (const [teil, datei] of Object.entries(dateien)) {
  const pfad = join(ordner, datei);
  console.log(`sha256 ${datei} …`);
  artefakte[teil] = {
    datei,
    bytes: statSync(pfad).size,
    sha256: await sha256(pfad),
    ...(entpackt[teil] ? { komprimiert: 'zstd', bytesEntpackt: entpackt[teil] } : {}),
  };
}
const manifest = {
  id: a.id,
  name: a.name,
  regionen: (regionen ?? [a.id]).map((id) => ({ id, name: id, stand: null })),
  bounds,
  // Wann die Daten entstanden sind, nicht wann sie verpackt wurden
  gebaut: new Date(Math.max(...staende.filter(Number.isFinite), 0) || Date.now()).toISOString(),
  artefakte,
};
writeFileSync(join(ordner, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Fertig: ${ordner}`);
for (const x of Object.values(artefakte)) console.log(`  ${x.datei}  ${(x.bytes / 1024 ** 2).toFixed(0)} MB`);
