#!/usr/bin/env node
/**
 * PMTiles (v3) in MBTiles umwandeln -- ohne zweiten planetiler-Lauf.
 *
 *   node pmtiles-zu-mbtiles.mjs <eingabe.pmtiles> <ausgabe.mbtiles>
 *
 * `pmtiles convert` kann nur MBTiles -> PMTiles, planetiler hat dafür keinen
 * Befehl. Die Kacheln werden unverändert übernommen (planetiler schreibt sie
 * gzip-gepackt, wie MBTiles es für pbf erwartet). Gleiche Kacheln (Meer,
 * Wald -- in PMTiles ein Lauf) liegen nur einmal in der Datei: Schema
 * `map` + `images` mit der Sicht `tiles`, wie planetiler es für MBTiles
 * schreibt. Metadaten: name, format, bounds, center, minzoom, maxzoom,
 * attribution, json (vector_layers).
 */

import { closeSync, openSync, readSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const [eingabe, ausgabe] = process.argv.slice(2);
if (!eingabe || !ausgabe) {
  console.error('Aufruf: pmtiles-zu-mbtiles.mjs <eingabe.pmtiles> <ausgabe.mbtiles>');
  process.exit(1);
}

const fd = openSync(eingabe, 'r');
function lesen(offset, laenge) {
  const b = Buffer.alloc(laenge);
  let gelesen = 0;
  while (gelesen < laenge) {
    const n = readSync(fd, b, gelesen, laenge - gelesen, offset + gelesen);
    if (n === 0) throw new Error(`${eingabe}: Datei endet vorzeitig`);
    gelesen += n;
  }
  return b;
}

// --- Kopf (127 Byte) ---------------------------------------------------------
const k = lesen(0, 127);
if (k.toString('latin1', 0, 7) !== 'PMTiles' || k[7] !== 3) throw new Error(`${eingabe} ist keine PMTiles-v3-Datei`);
const u64 = (o) => Number(k.readBigUInt64LE(o));
const kopf = {
  rootOffset: u64(8), rootLaenge: u64(16),
  metaOffset: u64(24), metaLaenge: u64(32),
  leafOffset: u64(40),
  datenOffset: u64(56),
  innen: k[97], kachel: k[98], typ: k[99],
  minZoom: k[100], maxZoom: k[101],
  bounds: [102, 106, 110, 114].map((o) => k.readInt32LE(o) / 1e7),
  centerZoom: k[118], center: [k.readInt32LE(119) / 1e7, k.readInt32LE(123) / 1e7],
};
if (kopf.typ !== 1) throw new Error('nur Vektorkacheln (MVT) werden unterstützt');
const entpacken = (b, art) => {
  if (art === 1 || art === 0) return b;
  if (art === 2) return gunzipSync(b);
  throw new Error(`Komprimierung ${art} wird nicht unterstützt`);
};
// MBTiles erwartet pbf gzip-gepackt
const alsGzip = (b) => (kopf.kachel === 2 ? b : gzipSync(entpacken(b, kopf.kachel)));

// --- Verzeichnisse -----------------------------------------------------------
function verzeichnis(b) {
  let pos = 0;
  const varint = () => {
    let wert = 0, faktor = 1, byte;
    do {
      byte = b[pos++];
      wert += (byte & 0x7f) * faktor;
      faktor *= 128;
    } while (byte & 0x80);
    return wert;
  };
  const n = varint();
  const e = Array.from({ length: n }, () => ({ id: 0, lauf: 0, laenge: 0, offset: 0 }));
  let id = 0;
  for (const x of e) { id += varint(); x.id = id; }
  for (const x of e) x.lauf = varint();
  for (const x of e) x.laenge = varint();
  e.forEach((x, i) => {
    const o = varint();
    x.offset = o === 0 && i > 0 ? e[i - 1].offset + e[i - 1].laenge : o - 1;
  });
  return e;
}

// Hilbert-Kachelnummer -> z/x/y (PMTiles-Spezifikation)
function zxy(id) {
  let start = 0;
  for (let z = 0; z < 32; z++) {
    const anzahl = 4 ** z;
    if (start + anzahl > id) {
      let t = id - start, x = 0, y = 0;
      for (let s = 1; s < 2 ** z; s *= 2) {
        const rx = 1 & Math.floor(t / 2);
        const ry = 1 & (t ^ rx);
        if (ry === 0) {
          if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
          [x, y] = [y, x];
        }
        x += s * rx;
        y += s * ry;
        t = Math.floor(t / 4);
      }
      return [z, x, y];
    }
    start += anzahl;
  }
  throw new Error(`Kachelnummer ${id} zu groß`);
}

// --- MBTiles schreiben -------------------------------------------------------
rmSync(ausgabe, { force: true });
const db = new DatabaseSync(ausgabe);
db.exec(`
  PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
  CREATE TABLE metadata (name TEXT, value TEXT);
  CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id INTEGER);
  CREATE TABLE images (tile_id INTEGER PRIMARY KEY, tile_data BLOB);
  CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column,
    map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id;
`);

const meta = JSON.parse(entpacken(lesen(kopf.metaOffset, kopf.metaLaenge), kopf.innen).toString('utf-8') || '{}');
const metaZeile = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
const metadaten = {
  name: meta.name ?? 'OpenMapTiles',
  format: 'pbf',
  type: meta.type ?? 'baselayer',
  bounds: kopf.bounds.join(','),
  center: [...kopf.center, kopf.centerZoom].join(','),
  minzoom: String(kopf.minZoom),
  maxzoom: String(kopf.maxZoom),
  ...(meta.attribution ? { attribution: meta.attribution } : {}),
  ...(meta.description ? { description: meta.description } : {}),
  ...(meta.version ? { version: String(meta.version) } : {}),
  json: JSON.stringify({ vector_layers: meta.vector_layers ?? [], ...(meta.tilestats ? { tilestats: meta.tilestats } : {}) }),
};
for (const [n, w] of Object.entries(metadaten)) metaZeile.run(n, w);

const mapZeile = db.prepare('INSERT INTO map VALUES (?, ?, ?, ?)');
const bildZeile = db.prepare('INSERT INTO images VALUES (?, ?)');
const schonDa = new Set(); // Daten-Offsets = Kachel-IDs in images
let kacheln = 0, inhalte = 0;

db.exec('BEGIN');
function durchlaufen(offset, laenge) {
  for (const e of verzeichnis(entpacken(lesen(offset, laenge), kopf.innen))) {
    if (e.lauf === 0) {
      durchlaufen(kopf.leafOffset + e.offset, e.laenge);
      continue;
    }
    if (!schonDa.has(e.offset)) {
      bildZeile.run(e.offset, alsGzip(lesen(kopf.datenOffset + e.offset, e.laenge)));
      schonDa.add(e.offset);
      inhalte++;
    }
    for (let i = 0; i < e.lauf; i++) {
      const [z, x, y] = zxy(e.id + i);
      mapZeile.run(z, x, 2 ** z - 1 - y, e.offset); // MBTiles zählt y von unten (TMS)
      kacheln++;
    }
    if (kacheln % 1_000_000 < e.lauf) console.log(`${kacheln} Kacheln …`);
  }
}
durchlaufen(kopf.rootOffset, kopf.rootLaenge);
db.exec('COMMIT');
db.exec('CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row)');
db.close();
closeSync(fd);
console.log(`Fertig: ${ausgabe} -- ${kacheln} Kacheln, ${inhalte} verschiedene Inhalte`);
