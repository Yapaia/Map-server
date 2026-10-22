/**
 * Der dauerhafte Zustand: Pakete, Auftraege, Token -- eine JSON-Datei.
 *
 * Geschrieben wird atomar (erst `.neu`, dann umbenennen), damit ein Absturz
 * mitten im Schreiben nie eine halbe Datei hinterlaesst.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const ID_MUSTER = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** „Alpen & Adria 2026" → „alpen-adria-2026". */
export function idAusName(name) {
  const id = String(name || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return ID_MUSTER.test(id) ? id : '';
}

export class Zustand {
  constructor(pfad) {
    this.pfad = pfad;
    let daten = {};
    try {
      daten = JSON.parse(readFileSync(pfad, 'utf-8'));
    } catch {
      // neu
    }
    this.pakete = daten.pakete && typeof daten.pakete === 'object' ? daten.pakete : {};
    this.auftraege = Array.isArray(daten.auftraege) ? daten.auftraege : [];
    this.downloadToken = typeof daten.downloadToken === 'string' && daten.downloadToken ? daten.downloadToken : '';
    this.extrakte = daten.extrakte && typeof daten.extrakte === 'object' ? daten.extrakte : {};
    // Ein Neustart unterbricht auch das Prüfen eines vorgebauten Pakets.
    for (const p of Object.values(this.pakete)) {
      if (p.status === 'prueft') {
        p.status = p.manifest ? 'fertig' : 'fehler';
        p.fehler = 'Prüfen wurde durch einen Neustart unterbrochen';
      }
    }
  }

  /** Das Token fuer Go: aus der Umgebung, sonst gemerkt, sonst neu. */
  token(ausUmgebung) {
    if (ausUmgebung) return ausUmgebung;
    if (!this.downloadToken) {
      this.downloadToken = randomBytes(24).toString('base64url');
      this.speichern();
    }
    return this.downloadToken;
  }

  speichern() {
    mkdirSync(dirname(this.pfad), { recursive: true });
    const neu = `${this.pfad}.neu`;
    writeFileSync(
      neu,
      JSON.stringify(
        { pakete: this.pakete, auftraege: this.auftraege.slice(-100), downloadToken: this.downloadToken, extrakte: this.extrakte },
        null,
        2,
      ),
    );
    renameSync(neu, this.pfad);
  }
}
