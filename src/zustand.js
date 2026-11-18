/**
 * Der dauerhafte Zustand: Pakete, Auftraege, Token, Zugaenge -- eine JSON-Datei.
 *
 * Geschrieben wird atomar (erst `.neu`, dann umbenennen), damit ein Absturz
 * mitten im Schreiben nie eine halbe Datei hinterlaesst.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

/** Benannte Zugänge speichern nur den Hash ihres Tokens. */
export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Wie lange Zählerstände höchstens nur im Speicher stehen. */
const SPEICHERN_NACH_MS = 10_000;

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
    // Benannte Zugänge für externe Projekte (z. B. „CarNine"), einzeln sperrbar.
    this.zugaenge = daten.zugaenge && typeof daten.zugaenge === 'object' ? daten.zugaenge : {};
    this.speicherTimer = null;
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

  /** Neuer Zugang; das Token gibt es nur hier im Klartext. */
  zugangAnlegen(id, name) {
    const token = randomBytes(32).toString('base64url');
    this.zugaenge[id] = {
      id,
      name,
      hash: tokenHash(token),
      aktiv: true,
      erstellt: new Date().toISOString(),
      letzteNutzung: null,
      katalogAbrufe: 0,
      downloads: 0,
      bytes: 0,
    };
    this.speichern();
    return { zugang: this.zugaenge[id], token };
  }

  /** Der aktive Zugang zu diesem Token oder null. Vergleich zeitkonstant über die Hashes. */
  zugangZu(token) {
    if (!token) return null;
    const h = Buffer.from(tokenHash(token));
    let treffer = null;
    for (const z of Object.values(this.zugaenge)) {
      const g = Buffer.from(String(z.hash || ''));
      if (g.length === h.length && timingSafeEqual(g, h)) treffer = z;
    }
    return treffer?.aktiv ? treffer : null;
  }

  /** Nutzung zählen -- gespeichert wird entprellt, nicht bei jedem Abruf. */
  nutzung(zugang, { katalog = 0, downloads = 0, bytes = 0 } = {}) {
    zugang.letzteNutzung = new Date().toISOString();
    zugang.katalogAbrufe = (zugang.katalogAbrufe || 0) + katalog;
    zugang.downloads = (zugang.downloads || 0) + downloads;
    zugang.bytes = (zugang.bytes || 0) + bytes;
    this.spaeterSpeichern();
  }

  spaeterSpeichern() {
    if (this.speicherTimer) return;
    this.speicherTimer = setTimeout(() => {
      this.speicherTimer = null;
      try {
        this.speichern();
      } catch (err) {
        console.error('Zustand speichern:', err.message);
      }
    }, SPEICHERN_NACH_MS);
    this.speicherTimer.unref?.();
  }

  speichern() {
    if (this.speicherTimer) {
      clearTimeout(this.speicherTimer);
      this.speicherTimer = null;
    }
    mkdirSync(dirname(this.pfad), { recursive: true });
    const neu = `${this.pfad}.neu`;
    writeFileSync(
      neu,
      JSON.stringify(
        { pakete: this.pakete, auftraege: this.auftraege.slice(-100), downloadToken: this.downloadToken, extrakte: this.extrakte, zugaenge: this.zugaenge },
        null,
        2,
      ),
    );
    renameSync(neu, this.pfad);
  }
}
