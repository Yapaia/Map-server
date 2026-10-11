/**
 * Ein Kartenpaket bauen: Extrakte laden, zusammenfuehren, Karte, Suchindex
 * und Routing bauen, veroeffentlichen.
 *
 * Gebaut wird mit DENSELBEN Skripten wie in Yapaia Go (yapaia-build-pmtiles,
 * yapaia-build-lite-index, yapaia-build-graph) -- dieses Image setzt auf dem
 * Go-Image auf. Was hier herauskommt, kann Go also unveraendert benutzen:
 *
 *   <paket>.pmtiles            -> /share/yapaia/tiles/
 *   lite_search-<paket>.db     -> /share/yapaia/lite-search/
 *   <paket>-routing.tar        -> /share/yapaia/valhalla/  (tiles/ + build-info.json)
 *
 * Ein Paket mit mehreren Regionen wird VOR dem Bau zu einer einzigen PBF
 * zusammengefuehrt (`osmium merge`): eine Karte, ein Index, ein Routinggraph,
 * der ueber Grenzen hinweg routet.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { herunterladen, kopfdaten } from './download.js';

export const TEILE = ['karte', 'suche', 'routing'];

/** Ein Befehl als Kindprozess; Ausgabe zeilenweise ins Protokoll. Abbrechbar. */
export function ausfuehren(befehl, argumente, { env = {}, protokoll = () => {}, signal, ausgabeSammeln = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('abgebrochen'));
    const kind = spawn(befehl, argumente, {
      env: { ...process.env, ...env },
      // Eigene Prozessgruppe: beim Abbrechen gehen auch Java, Valhalla und
      // osmium mit, die die Skripte starten.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let gesammelt = '';
    const zeilen = (puffer) => {
      const text = puffer.toString();
      if (ausgabeSammeln) gesammelt += text;
      for (const zeile of text.split(/\r?\n/)) if (zeile.trim()) protokoll(zeile);
    };
    kind.stdout.on('data', zeilen);
    kind.stderr.on('data', zeilen);
    const abbrechen = () => {
      try {
        process.kill(-kind.pid, 'SIGTERM');
      } catch {
        // schon weg
      }
    };
    signal?.addEventListener('abort', abbrechen, { once: true });
    kind.on('error', (err) => reject(new Error(`${befehl}: ${err.message}`)));
    kind.on('close', (code) => {
      signal?.removeEventListener('abort', abbrechen);
      if (signal?.aborted) return reject(new Error('abgebrochen'));
      if (code === 0) resolve(gesammelt);
      else reject(new Error(`${befehl.split('/').pop()} endete mit Code ${code}`));
    });
  });
}

export async function sha256(pfad) {
  const h = createHash('sha256');
  for await (const stueck of createReadStream(pfad)) h.update(stueck);
  return h.digest('hex');
}

/** `(5.9,45.8,10.5,47.8)` oder `5.9,45.8,10.5,47.8` → [minLon, minLat, maxLon, maxLat]. */
export function boxAus(text) {
  const zahlen = String(text || '').match(/-?\d+(?:\.\d+)?/g);
  if (!zahlen || zahlen.length < 4) return null;
  const [a, b, c, d] = zahlen.slice(0, 4).map(Number);
  const box = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  return box.every(Number.isFinite) && box[0] >= -180 && box[2] <= 180 && box[1] >= -90 && box[3] <= 90 ? box : null;
}

/** Grobe Schaetzung, wie viel freier Platz ein Bau braucht. */
export function platzBedarf(pbfBytes) {
  return pbfBytes * 12 + 3 * 1024 ** 3;
}

async function existiert(pfad) {
  try {
    await stat(pfad);
    return true;
  } catch {
    return false;
  }
}

/**
 * Baut ein Paket. `ctx`:
 *  konfig, zustand, geofabrik, paket, protokoll(text), schritt(name),
 *  signal, run (statt `ausfuehren`, fuer Tests), fetchImpl, aktualisieren
 */
export async function bauePaket(ctx) {
  const { konfig, zustand, geofabrik, paket, protokoll, schritt, signal } = ctx;
  const run = ctx.run ?? ausfuehren;
  const p = konfig.pfade;
  const id = paket.id;
  const teile = (paket.teile?.length ? paket.teile : TEILE).filter((t) => TEILE.includes(t));
  const bau = join(p.bau, id);
  const quellPbf = join(p.quellen, `${id}.osm.pbf`);
  const lauf = (befehl, args, env = {}, extra = {}) =>
    run(befehl, args, { env: { TMPDIR: join(bau, 'tmp'), ...env }, protokoll, signal, ...extra });

  await rm(bau, { recursive: true, force: true });
  for (const d of [p.extrakte, p.quellen, bau, join(bau, 'tmp'), p.pakete, join(konfig.daten, 'valhalla', 'tiles')]) {
    await mkdir(d, { recursive: true });
  }

  // ─── 1. Extrakte ─────────────────────────────────────────────────────────
  schritt('Extrakte laden');
  const extrakte = [];
  for (const rid of paket.regionen) {
    const eintrag = await geofabrik.finde(rid);
    if (!eintrag) throw new Error(`Unbekannte Region „${rid}" im Geofabrik-Katalog`);
    const ziel = join(p.extrakte, `${rid}.osm.pbf`);
    const bekannt = zustand.extrakte[rid];
    let laden = !(await existiert(ziel));
    if (!laden && ctx.aktualisieren) {
      const kopf = await kopfdaten(eintrag.pbf, { fetchImpl: ctx.fetchImpl });
      laden = Boolean(kopf?.letzteAenderung && kopf.letzteAenderung !== bekannt?.stand);
      if (!laden) protokoll(`${eintrag.name}: Extrakt ist aktuell (${bekannt?.stand ?? 'Stand unbekannt'})`);
    }
    if (laden) {
      protokoll(`Lade ${eintrag.name}: ${eintrag.pbf}`);
      let zuletzt = 0;
      const erg = await herunterladen(eintrag.pbf, ziel, {
        fetchImpl: ctx.fetchImpl,
        signal,
        fortschritt: (geladen, gesamt) => {
          if (geladen - zuletzt >= 256 * 1024 ** 2 || (gesamt && geladen === gesamt)) {
            zuletzt = geladen;
            protokoll(`  ${(geladen / 1024 ** 2).toFixed(0)} MB${gesamt ? ` von ${(gesamt / 1024 ** 2).toFixed(0)} MB` : ''}`);
          }
        },
      });
      zustand.extrakte[rid] = { name: eintrag.name, stand: erg.letzteAenderung, bytes: erg.bytes, geladen: new Date().toISOString() };
      zustand.speichern();
    } else if (!ctx.aktualisieren) {
      protokoll(`${eintrag.name}: vorhandener Extrakt wird benutzt`);
    }
    extrakte.push({ id: rid, pfad: ziel, name: eintrag.name, stand: zustand.extrakte[rid]?.stand ?? null });
  }

  // ─── 2. Zusammenfuehren ──────────────────────────────────────────────────
  schritt('Zusammenführen');
  await rm(quellPbf, { force: true });
  if (extrakte.length === 1) {
    await symlink(extrakte[0].pfad, quellPbf);
  } else {
    protokoll(`Führe ${extrakte.length} Extrakte zusammen …`);
    await lauf(konfig.befehle.osmium, ['merge', '--overwrite', '-o', quellPbf, ...extrakte.map((e) => e.pfad)]);
  }
  const pbfBytes = (await stat(quellPbf)).size;
  const frei = await statfs(p.bau).then((s) => s.bavail * s.bsize).catch(() => null);
  if (frei !== null && frei < platzBedarf(pbfBytes)) {
    throw new Error(
      `Zu wenig Speicherplatz: frei ${(frei / 1024 ** 3).toFixed(1)} GB, geschätzt nötig ${(platzBedarf(pbfBytes) / 1024 ** 3).toFixed(1)} GB. ` +
        'Alte Pakete oder nicht mehr gebrauchte Extrakte löschen.',
    );
  }
  let box = boxAus(await lauf(konfig.befehle.osmium, ['fileinfo', '-g', 'header.boxes', quellPbf], {}, { ausgabeSammeln: true }).catch(() => ''));
  if (!box) box = boxAus(await lauf(konfig.befehle.osmium, ['fileinfo', '-e', '-g', 'data.bbox', quellPbf], {}, { ausgabeSammeln: true }));
  if (!box) throw new Error('Die Ausdehnung der Karte ließ sich nicht bestimmen');

  // Fuer Suche und Routing: ein eigenes Zwischenlager NUR mit dieser PBF.
  // Der Routing-Bau baut ueber ALLES, was dort liegt.
  const lager = join(bau, 'planetiler-sources');
  await mkdir(lager, { recursive: true });
  const lagerPbf = join(lager, `${id}.osm.pbf`);
  await symlink(quellPbf, lagerPbf);

  const neu = join(p.pakete, `.${id}.neu`);
  await rm(neu, { recursive: true, force: true });
  await mkdir(neu, { recursive: true });
  const dateien = {};

  // ─── 3. Karte ────────────────────────────────────────────────────────────
  if (teile.includes('karte')) {
    schritt('Karte bauen');
    const kacheln = join(bau, 'karte');
    await lauf(konfig.befehle.karte, [quellPbf, id], { TILES_DIR: kacheln, PLANETILER_SOURCES_DIR: p.quellen, YAPAIA_TOOLS_DIR: join(konfig.daten, 'tools') });
    await rename(join(kacheln, `${id}.pmtiles`), join(neu, `${id}.pmtiles`));
    dateien.karte = `${id}.pmtiles`;
  }

  // ─── 4. Suchindex ────────────────────────────────────────────────────────
  if (teile.includes('suche')) {
    schritt('Suchindex bauen');
    const suche = join(bau, 'suche');
    await lauf(konfig.befehle.suche, [lagerPbf, id], { LITE_SEARCH_DB_PATH: join(suche, 'lite_search.db') });
    await copyFile(join(suche, `lite_search-${id}.db`), join(neu, `lite_search-${id}.db`));
    dateien.suche = `lite_search-${id}.db`;
  }

  // ─── 5. Routing ──────────────────────────────────────────────────────────
  if (teile.includes('routing')) {
    schritt('Routing bauen');
    const routing = join(bau, 'routing');
    await lauf(konfig.befehle.routing, [lagerPbf, id], {
      VALHALLA_TILES_DIR: join(routing, 'tiles'),
      VALHALLA_BUILD_THREADS: String(konfig.routingThreads),
    });
    const tarName = `${id}-routing.tar`;
    await lauf(konfig.befehle.tar, ['-C', routing, '--exclude=*.osm.pbf', '-cf', join(neu, tarName), 'tiles', 'build-info.json']);
    dateien.routing = tarName;
  }

  // ─── 6. Veroeffentlichen ─────────────────────────────────────────────────
  schritt('Veröffentlichen');
  const artefakte = {};
  for (const [teil, datei] of Object.entries(dateien)) {
    const pfad = join(neu, datei);
    artefakte[teil] = { datei, bytes: (await stat(pfad)).size, sha256: await sha256(pfad) };
  }
  const manifest = {
    id,
    name: paket.name,
    regionen: extrakte.map((e) => ({ id: e.id, name: e.name, stand: e.stand })),
    bounds: box,
    gebaut: new Date().toISOString(),
    artefakte,
  };
  await writeFile(join(neu, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const ziel = join(p.pakete, id);
  const alt = join(p.pakete, `.${id}.alt`);
  await rm(alt, { recursive: true, force: true });
  if (await existiert(ziel)) await rename(ziel, alt);
  await rename(neu, ziel);
  await rm(alt, { recursive: true, force: true });

  // Aufraeumen: Zwischenstaende und die zusammengefuehrte PBF. Die Extrakte
  // bleiben fuer den naechsten Bau.
  await rm(bau, { recursive: true, force: true });
  await rm(quellPbf, { force: true });
  protokoll(`Fertig: ${Object.values(artefakte).map((a) => `${a.datei} (${(a.bytes / 1024 ** 2).toFixed(0)} MB)`).join(', ')}`);
  return manifest;
}
