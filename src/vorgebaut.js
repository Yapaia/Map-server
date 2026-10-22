/**
 * Vorgebaute Pakete übernehmen -- statt sie hier zu bauen.
 *
 * Wer die Kartendaten schon hat (z. B. Yapaia Go im Wohnmobil), legt ein
 * Paket fertig in `<daten>/kartenserver/import/<id>/` ab: die Dateien und ein
 * `manifest.json` im selben Format, wie es der Bau schreibt. Das Skript
 * `werkzeuge/vorbereiten.mjs` erzeugt beides. „Übernehmen" prüft Größe und
 * sha256 jeder Datei und verschiebt den Ordner dann nach `pakete/<id>` --
 * ohne Kopie, beides liegt im selben Volume.
 */

import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 as sha256Datei } from './bau.js';
import { ID_MUSTER } from './zustand.js';

/** Welche Datei zu welchem Teil gehört -- dieselben Namen, die der Bau vergibt und Go erwartet. */
export const DATEINAMEN = {
  karte: (id) => `${id}.pmtiles`,
  suche: (id) => `lite_search-${id}.db`,
  routing: (id) => `${id}-routing.tar`,
};

function gueltigeBox(b) {
  return Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x)) && b[0] <= b[2] && b[1] <= b[3];
}

/** Ein Manifest auf Form prüfen; gibt einen Fehlertext oder null. */
export function manifestFehler(manifest, id) {
  if (!manifest || typeof manifest !== 'object') return 'manifest.json fehlt oder ist kein JSON';
  if (manifest.id !== id) return `manifest.json gehört zu „${manifest.id}", nicht zu „${id}"`;
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) return 'manifest.json: name fehlt';
  if (!gueltigeBox(manifest.bounds)) return 'manifest.json: bounds fehlt oder ist ungültig';
  const artefakte = manifest.artefakte && typeof manifest.artefakte === 'object' ? Object.entries(manifest.artefakte) : [];
  if (!artefakte.length) return 'manifest.json: keine Dateien (artefakte)';
  for (const [teil, a] of artefakte) {
    if (!DATEINAMEN[teil]) return `manifest.json: unbekannter Teil „${teil}"`;
    if (a?.datei !== DATEINAMEN[teil](id)) return `manifest.json: ${teil} muss „${DATEINAMEN[teil](id)}" heißen`;
    if (!Number.isInteger(a.bytes) || a.bytes <= 0) return `manifest.json: ${teil} ohne Größe`;
    if (typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)) return `manifest.json: ${teil} ohne sha256`;
  }
  return null;
}

async function manifestLesen(ordner) {
  try {
    return JSON.parse(await readFile(join(ordner, 'manifest.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** Was im Import-Ordner liegt und übernommen werden kann. */
export async function vorgebauteListe(konfig) {
  let namen = [];
  try {
    namen = await readdir(konfig.pfade.import, { withFileTypes: true });
  } catch {
    return [];
  }
  const liste = [];
  for (const e of namen) {
    if (!e.isDirectory() || !ID_MUSTER.test(e.name)) continue;
    const manifest = await manifestLesen(join(konfig.pfade.import, e.name));
    liste.push({
      id: e.name,
      name: manifest?.name ?? e.name,
      artefakte: manifest?.artefakte ?? {},
      fehler: manifestFehler(manifest, e.name),
    });
  }
  return liste;
}

/**
 * Ein Paket aus dem Import-Ordner prüfen und veröffentlichen. Wirft mit einer
 * lesbaren Meldung, wenn etwas nicht stimmt; der Import-Ordner bleibt dann liegen.
 */
export async function uebernehmen({ konfig, id, sha256 = sha256Datei }) {
  if (!ID_MUSTER.test(id)) throw new Error('Ungültige Paket-ID');
  const ordner = join(konfig.pfade.import, id);
  const manifest = await manifestLesen(ordner);
  const fehler = manifestFehler(manifest, id);
  if (fehler) throw new Error(fehler);
  for (const [teil, a] of Object.entries(manifest.artefakte)) {
    const pfad = join(ordner, a.datei);
    let info;
    try {
      info = await stat(pfad);
    } catch {
      throw new Error(`${a.datei} fehlt`);
    }
    if (info.size !== a.bytes) throw new Error(`${a.datei}: ${info.size} statt ${a.bytes} Bytes – Übertragung unvollständig?`);
    if ((await sha256(pfad)) !== a.sha256) throw new Error(`${a.datei}: sha256 stimmt nicht – Datei beschädigt (${teil})`);
  }
  const ziel = join(konfig.pfade.pakete, id);
  await mkdir(konfig.pfade.pakete, { recursive: true });
  const alt = join(konfig.pfade.pakete, `.${id}.alt`);
  await rm(alt, { recursive: true, force: true });
  if (await stat(ziel).then(() => true, () => false)) await rename(ziel, alt);
  await rename(ordner, ziel);
  await rm(alt, { recursive: true, force: true });
  return { ...manifest, importiert: new Date().toISOString() };
}
