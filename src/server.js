/**
 * HTTP: die Oberflaeche zum Verwalten (Passwort) und die Schnittstelle, ueber
 * die Yapaia Go die fertigen Pakete laedt (Token).
 *
 *   /                      Oberflaeche              Benutzer `admin` + ADMIN_PASSWORT
 *   /api/...               ihre Schnittstelle       dto.
 *   /v1/katalog            Pakete fuer Go           Authorization: Bearer <Token> (oder ?token=)
 *   /v1/pakete/<id>/<datei> Herunterladen, mit Range dto.
 *   /gesund                Lebenszeichen            offen
 */

import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { rm, stat, statfs } from 'node:fs/promises';
import { createServer } from 'node:http';
import { totalmem, freemem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kopfdaten } from './download.js';
import { TEILE, platzBedarf } from './bau.js';
import { ID_MUSTER, idAusName } from './zustand.js';
import { uebernehmen as uebernehmenStandard, vorgebauteListe } from './vorgebaut.js';

const OEFFENTLICH = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DATEITYPEN = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function gleich(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Ob die Anfrage als `admin` mit dem Passwort angemeldet ist (HTTP Basic). */
export function istAdmin(kopf, passwort) {
  if (!passwort || typeof kopf !== 'string' || !kopf.startsWith('Basic ')) return false;
  const [benutzer, ...rest] = Buffer.from(kopf.slice(6), 'base64').toString('utf-8').split(':');
  return benutzer === 'admin' && gleich(rest.join(':'), passwort);
}

/** `bytes=100-199`, `bytes=100-`, `bytes=-50` → {start, ende} oder null (ungueltig) / undefined (keiner). */
export function bereichAus(kopf, groesse) {
  if (!kopf) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(kopf.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let ende;
  if (m[1] === '') {
    start = Math.max(0, groesse - Number(m[2]));
    ende = groesse - 1;
  } else {
    start = Number(m[1]);
    ende = m[2] === '' ? groesse - 1 : Math.min(Number(m[2]), groesse - 1);
  }
  return start <= ende && start < groesse ? { start, ende } : null;
}

function json(res, status, daten) {
  const text = JSON.stringify(daten);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function fehler(res, status, text) {
  json(res, status, { fehler: text });
}

async function koerper(req) {
  let text = '';
  for await (const stueck of req) {
    text += stueck;
    if (text.length > 64 * 1024) throw new Error('Anfrage zu groß');
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Kein gültiges JSON');
  }
}

function basisUrl(req, konfig) {
  if (konfig.oeffentlicheUrl) return konfig.oeffentlicheUrl;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${konfig.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Ein fertiges Paket als Katalogeintrag, wie Yapaia Go ihn liest. */
export function katalogEintrag(manifest, basis) {
  const url = (datei) => `${basis}/v1/pakete/${manifest.id}/${encodeURIComponent(datei)}`;
  const teil = (t) => {
    const a = manifest.artefakte?.[t];
    if (!a) return undefined;
    // komprimiert: Go (ab 0.64.0) entpackt nach dem Laden; ältere Go-Versionen
    // kennen das Feld nicht -- deshalb trägt der Dateiname die Endung .zst.
    return {
      url: url(a.datei),
      sizeBytes: a.bytes,
      sha256: a.sha256,
      ...(a.komprimiert ? { komprimiert: a.komprimiert, entpacktBytes: a.bytesEntpackt } : {}),
    };
  };
  const karte = manifest.artefakte?.karte;
  return {
    id: manifest.id,
    name: manifest.name,
    // Dieselben Felder wie Gos regions-catalog.json (apps/core/src/map/regions/catalog.ts)
    ...(karte ? { url: url(karte.datei), sizeBytes: karte.bytes, sha256: karte.sha256 } : { sizeBytes: 0 }),
    bounds: manifest.bounds,
    gebaut: manifest.gebaut,
    regionen: manifest.regionen,
    ...(teil('suche') ? { suche: teil('suche') } : {}),
    ...(teil('routing') ? { routing: teil('routing') } : {}),
  };
}

export function erstelleServer({ konfig, zustand, geofabrik, auftraege, fetchImpl, uebernehmen = uebernehmenStandard }) {
  const token = () => zustand.token(konfig.downloadToken);

  const datei = async (req, res, pfad, typ, download) => {
    let info;
    try {
      info = await stat(pfad);
    } catch {
      return fehler(res, 404, 'Nicht gefunden');
    }
    const kopf = {
      'Content-Type': typ,
      'Accept-Ranges': 'bytes',
      'Last-Modified': info.mtime.toUTCString(),
      ...(download ? { 'Content-Disposition': `attachment; filename="${download}"` } : {}),
    };
    const bereich = bereichAus(req.headers.range, info.size);
    if (bereich === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    if (bereich) {
      res.writeHead(206, { ...kopf, 'Content-Range': `bytes ${bereich.start}-${bereich.ende}/${info.size}`, 'Content-Length': bereich.ende - bereich.start + 1 });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(pfad, { start: bereich.start, end: bereich.ende }).pipe(res);
    }
    res.writeHead(200, { ...kopf, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(pfad).pipe(res);
  };

  const fuerGo = async (req, res, url) => {
    const vorgelegt = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('token');
    if (!gleich(vorgelegt, token())) return fehler(res, 401, 'Token fehlt oder falsch');
    if (url.pathname === '/v1/katalog' && req.method === 'GET') {
      const basis = basisUrl(req, konfig);
      return json(res, 200, Object.values(zustand.pakete).filter((p) => p.manifest).map((p) => katalogEintrag(p.manifest, basis)));
    }
    const m = /^\/v1\/pakete\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const [id, name] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const manifest = zustand.pakete[id]?.manifest;
      // Nur, was das Manifest nennt -- nie ein beliebiger Pfad.
      const erlaubt = manifest && (name === 'manifest.json' || Object.values(manifest.artefakte).some((a) => a.datei === name));
      if (!erlaubt) return fehler(res, 404, 'Nicht gefunden');
      return datei(req, res, join(konfig.pfade.pakete, id, name), name.endsWith('.json') ? 'application/json' : 'application/octet-stream', name);
    }
    return fehler(res, 404, 'Nicht gefunden');
  };

  const verwaltung = async (req, res, url) => {
    const pfad = url.pathname;
    const methode = req.method;
    if (pfad === '/api/status' && methode === 'GET') {
      const platte = await statfs(konfig.pfade.pakete).catch(() => statfs(konfig.daten).catch(() => null));
      return json(res, 200, {
        token: token(),
        katalogUrl: `${basisUrl(req, konfig)}/v1/katalog`,
        system: {
          ramGesamt: totalmem(),
          ramFrei: freemem(),
          platteGesamt: platte ? platte.blocks * platte.bsize : null,
          platteFrei: platte ? platte.bavail * platte.bsize : null,
        },
        laufend: auftraege.laufend?.auftrag ?? null,
      });
    }
    if (pfad === '/api/katalog' && methode === 'GET') return json(res, 200, await geofabrik.liste());
    if (pfad === '/api/katalog/groesse' && methode === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
      const eintraege = await Promise.all(
        ids.map(async (id) => {
          const e = await geofabrik.finde(id);
          const k = e ? await kopfdaten(e.pbf, { fetchImpl }) : null;
          return { id, bytes: k?.bytes ?? null };
        }),
      );
      const summe = eintraege.reduce((s, e) => s + (e.bytes ?? 0), 0);
      return json(res, 200, { eintraege, summe, platzBedarf: platzBedarf(summe) });
    }
    if (pfad === '/api/pakete' && methode === 'GET') return json(res, 200, Object.values(zustand.pakete));
    if (pfad === '/api/pakete' && methode === 'POST') {
      const k = await koerper(req);
      const name = String(k.name || '').trim();
      const id = k.id ? String(k.id) : idAusName(name);
      const regionen = Array.isArray(k.regionen) ? [...new Set(k.regionen.map(String))] : [];
      const teile = Array.isArray(k.teile) ? k.teile.filter((t) => TEILE.includes(t)) : [...TEILE];
      if (!name || !ID_MUSTER.test(id)) return fehler(res, 400, 'Bitte einen Namen angeben (Buchstaben oder Ziffern)');
      if (zustand.pakete[id]) return fehler(res, 409, `Ein Paket „${id}" gibt es schon`);
      if (!regionen.length) return fehler(res, 400, 'Bitte mindestens eine Region wählen');
      if (!teile.length) return fehler(res, 400, 'Bitte mindestens Karte, Suche oder Routing wählen');
      for (const r of regionen) if (!(await geofabrik.finde(r))) return fehler(res, 400, `Unbekannte Region „${r}"`);
      zustand.pakete[id] = { id, name, regionen, teile, status: 'neu', erstellt: new Date().toISOString() };
      zustand.speichern();
      return json(res, 201, zustand.pakete[id]);
    }
    let m = /^\/api\/pakete\/([^/]+)(\/bauen)?$/.exec(pfad);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const paket = zustand.pakete[id];
      if (!paket) return fehler(res, 404, 'Unbekanntes Paket');
      if (m[2] && methode === 'POST') {
        const k = await koerper(req);
        try {
          return json(res, 202, auftraege.einreihen(id, { aktualisieren: k.aktualisieren === true }));
        } catch (err) {
          return fehler(res, 409, err.message);
        }
      }
      if (!m[2] && methode === 'DELETE') {
        if (paket.status === 'baut' || paket.status === 'wartet') return fehler(res, 409, 'Erst den Auftrag abbrechen');
        if (paket.status === 'prueft') return fehler(res, 409, 'Das Paket wird gerade geprüft');
        delete zustand.pakete[id];
        zustand.speichern();
        await rm(join(konfig.pfade.pakete, id), { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
    }
    if (pfad === '/api/vorgebaut' && methode === 'GET') return json(res, 200, await vorgebauteListe(konfig));
    m = /^\/api\/vorgebaut\/([^/]+)$/.exec(pfad);
    if (m && methode === 'POST') {
      const id = decodeURIComponent(m[1]);
      if (!ID_MUSTER.test(id)) return fehler(res, 400, 'Ungültige Paket-ID');
      const vorher = zustand.pakete[id];
      if (vorher && ['baut', 'wartet', 'prueft'].includes(vorher.status)) return fehler(res, 409, 'Für dieses Paket läuft gerade etwas');
      if (vorher && !vorher.vorgebaut && vorher.manifest) return fehler(res, 409, `„${id}" ist ein hier gebautes Paket – erst löschen`);
      const eintrag = (zustand.pakete[id] = {
        id,
        name: vorher?.name ?? id,
        regionen: vorher?.regionen ?? [],
        teile: vorher?.teile ?? [],
        vorgebaut: true,
        erstellt: vorher?.erstellt ?? new Date().toISOString(),
        ...(vorher?.manifest ? { manifest: vorher.manifest } : {}),
        status: 'prueft',
      });
      zustand.speichern();
      // Das Prüfen (sha256 über viele GB) dauert -- im Hintergrund.
      uebernehmen({ konfig, id }).then(
        (manifest) => {
          Object.assign(eintrag, {
            name: manifest.name,
            regionen: (manifest.regionen ?? []).map((r) => (typeof r === 'string' ? r : r.id)).filter(Boolean),
            teile: Object.keys(manifest.artefakte),
            manifest,
            status: 'fertig',
          });
          delete eintrag.fehler;
          zustand.speichern();
        },
        (err) => {
          eintrag.status = eintrag.manifest ? 'fertig' : 'fehler';
          eintrag.fehler = err.message;
          zustand.speichern();
        },
      );
      return json(res, 202, eintrag);
    }
    if (pfad === '/api/auftraege' && methode === 'GET') return json(res, 200, auftraege.liste());
    m = /^\/api\/auftraege\/([^/]+)\/(protokoll|abbrechen)$/.exec(pfad);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!/^[\w-]+$/.test(id)) return fehler(res, 404, 'Unbekannter Auftrag');
      if (m[2] === 'protokoll' && methode === 'GET') return json(res, 200, auftraege.protokoll(id, Number(url.searchParams.get('ab') || 0)));
      if (m[2] === 'abbrechen' && methode === 'POST') {
        try {
          return json(res, 200, auftraege.abbrechen(id));
        } catch (err) {
          return fehler(res, 409, err.message);
        }
      }
    }
    if (pfad === '/api/extrakte' && methode === 'GET') {
      return json(
        res,
        200,
        Object.entries(zustand.extrakte).map(([id, e]) => ({ id, ...e, vorhanden: existsSync(join(konfig.pfade.extrakte, `${id}.osm.pbf`)) })),
      );
    }
    m = /^\/api\/extrakte\/([^/]+)$/.exec(pfad);
    if (m && methode === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      if (!/^[\w/-]+$/.test(id) || id.includes('..')) return fehler(res, 400, 'Ungültige Region');
      if (auftraege.laufend) return fehler(res, 409, 'Während eines Baus wird nichts gelöscht');
      await rm(join(konfig.pfade.extrakte, `${id}.osm.pbf`), { force: true });
      await rm(join(konfig.pfade.extrakte, `${id}.osm.pbf.part`), { force: true });
      delete zustand.extrakte[id];
      zustand.speichern();
      return json(res, 200, { ok: true });
    }
    return fehler(res, 404, 'Nicht gefunden');
  };

  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/gesund') return json(res, 200, { ok: true });
      if (url.pathname.startsWith('/v1/')) return await fuerGo(req, res, url);
      if (!konfig.adminPasswort) {
        return fehler(res, 503, 'ADMIN_PASSWORT ist nicht gesetzt – bitte in docker-compose.yml eintragen und neu starten');
      }
      if (!istAdmin(req.headers.authorization, konfig.adminPasswort)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Yapaia Kartenserver", charset="UTF-8"' });
        return res.end('Anmeldung nötig');
      }
      if (url.pathname.startsWith('/api/')) return await verwaltung(req, res, url);
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(name) || !existsSync(join(OEFFENTLICH, name))) return fehler(res, 404, 'Nicht gefunden');
      const endung = name.slice(name.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': DATEITYPEN[endung] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(readFileSync(join(OEFFENTLICH, name)));
    } catch (err) {
      if (!res.headersSent) fehler(res, 500, err.message);
      else res.end();
    }
  });
}
