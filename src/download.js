/**
 * OSM-Extrakte herunterladen: fortsetzbar, geprueft, atomar.
 *
 * Ein Land ist schnell mehrere GB gross; ein abgebrochener Download soll beim
 * naechsten Versuch weiterlaufen (`Range`), nicht von vorn. Fertig ist eine
 * Datei erst, wenn sie mit der Kennung einer OSM-PBF beginnt -- sonst haette
 * man womoeglich eine HTML-Fehlerseite gespeichert, und jeder Bau danach
 * scheiterte mit einer unverstaendlichen Meldung.
 */

import { createWriteStream } from 'node:fs';
import { open, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Ob die Datei eine OSM-PBF ist (die ersten Bytes enthalten „OSMHeader"). */
export async function istOsmPbf(pfad) {
  let fh;
  try {
    fh = await open(pfad, 'r');
    const puffer = Buffer.alloc(32);
    const { bytesRead } = await fh.read(puffer, 0, 32, 0);
    return puffer.subarray(0, bytesRead).includes('OSMHeader');
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

async function groesse(pfad) {
  try {
    return (await stat(pfad)).size;
  } catch {
    return 0;
  }
}

/**
 * Laedt `url` nach `ziel`. `fortschritt(geladen, gesamt)` wird laufend
 * gerufen. Gibt `{ bytes, letzteAenderung }` zurueck.
 */
export async function herunterladen(url, ziel, { fetchImpl = globalThis.fetch, fortschritt = () => {}, signal } = {}) {
  const teil = `${ziel}.part`;
  let schon = await groesse(teil);
  const kopf = schon > 0 ? { Range: `bytes=${schon}-` } : {};
  const r = await fetchImpl(url, { headers: kopf, signal });
  if (r.status === 416) {
    // Der Teil ist schon vollstaendig (oder kaputt): neu beginnen.
    await rm(teil, { force: true });
    return herunterladen(url, ziel, { fetchImpl, fortschritt, signal });
  }
  if (!r.ok) throw new Error(`Download fehlgeschlagen (HTTP ${r.status}): ${url}`);
  if (r.status !== 206 && schon > 0) {
    // Der Server kann nicht fortsetzen -- von vorn.
    schon = 0;
    await rm(teil, { force: true });
  }
  const laenge = Number(r.headers.get('content-length') || 0);
  const gesamt = laenge ? laenge + schon : 0;
  let geladen = schon;
  const zaehler = new TransformStream({
    transform(stueck, controller) {
      geladen += stueck.byteLength;
      fortschritt(geladen, gesamt);
      controller.enqueue(stueck);
    },
  });
  await pipeline(Readable.fromWeb(r.body.pipeThrough(zaehler)), createWriteStream(teil, { flags: schon > 0 ? 'a' : 'w' }));
  if (gesamt && (await groesse(teil)) !== gesamt) {
    throw new Error(`Download unvollständig (${await groesse(teil)} von ${gesamt} Bytes) – beim nächsten Versuch geht es weiter`);
  }
  if (!(await istOsmPbf(teil))) {
    await rm(teil, { force: true });
    throw new Error(`Das Heruntergeladene ist keine OSM-PBF: ${url}`);
  }
  await rename(teil, ziel);
  return { bytes: await groesse(ziel), letzteAenderung: r.headers.get('last-modified') };
}

/** `Last-Modified` und Groesse der Datei auf dem Server, ohne sie zu laden. */
export async function kopfdaten(url, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const r = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    return { bytes: Number(r.headers.get('content-length') || 0), letzteAenderung: r.headers.get('last-modified') };
  } catch {
    return null;
  }
}
