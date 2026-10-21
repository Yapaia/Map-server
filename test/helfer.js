import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { konfigAus } from '../src/konfig.js';

/** Eine OSM-PBF zum Testen: die Kennung „OSMHeader" in den ersten Bytes, dahinter Fuellung. */
export function pbfBytes(laenge = 4096, fuellung = 1) {
  const b = Buffer.alloc(laenge, fuellung);
  Buffer.from('\0\0\0\x0d\x0a\x09OSMHeader').copy(b, 0);
  return b;
}

export function tempKonfig(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kartenserver-'));
  const konfig = konfigAus({ YAPAIA_DATEN: dir, ADMIN_PASSWORT: 'geheim', QUELLEN_VORAB: '0', ...extra });
  return { konfig, dir, aufraeumen: () => rmSync(dir, { recursive: true, force: true }) };
}

export const KATALOG = {
  type: 'FeatureCollection',
  features: [
    { properties: { id: 'liechtenstein', name: 'Liechtenstein', parent: 'europe', urls: { pbf: 'https://example.test/liechtenstein-latest.osm.pbf' } } },
    { properties: { id: 'austria', name: 'Österreich', parent: 'europe', urls: { pbf: 'https://example.test/austria-latest.osm.pbf' } } },
    { properties: { id: 'europe', name: 'Europa', urls: { pbf: 'https://example.test/europe-latest.osm.pbf' } } },
    { properties: { id: 'ohne-pbf', name: 'Ohne', urls: {} } },
  ],
};

export function fakeGeofabrik() {
  const liste = KATALOG.features
    .filter((f) => f.properties.urls.pbf)
    .map((f) => ({ id: f.properties.id, name: f.properties.name, eltern: f.properties.parent ?? null, pbf: f.properties.urls.pbf }));
  return { liste: async () => liste, finde: async (id) => liste.find((e) => e.id === id) ?? null };
}

/** fetch, das PBFs ausliefert (mit Range und HEAD). */
export function fakeFetch({ stand = 'Mon, 05 Oct 2026 20:00:00 GMT', aufrufe = [] } = {}) {
  return async (url, init = {}) => {
    aufrufe.push({ url, methode: init.method ?? 'GET' });
    const daten = pbfBytes(8192, 2);
    const range = init.headers?.Range;
    const start = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    const teil = daten.subarray(start);
    const headers = new Headers({ 'content-length': String(init.method === 'HEAD' ? daten.length : teil.length), 'last-modified': stand });
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(teil, { status: range ? 206 : 200, headers });
  };
}
