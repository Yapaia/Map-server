/**
 * Bauauftraege: einer nach dem anderen.
 *
 * Ein VPS mit 8 GB RAM baut genau EIN Paket auf einmal -- planetiler und
 * Valhalla nebeneinander liefen sich gegenseitig in den Speicher. Weitere
 * Auftraege warten in der Reihe. Jeder Auftrag schreibt ein Protokoll, das
 * die Oberflaeche live mitliest.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bauePaket } from './bau.js';

export class Auftraege {
  constructor({ konfig, zustand, geofabrik, bauen = bauePaket, run, fetchImpl, jetzt = () => new Date() }) {
    this.konfig = konfig;
    this.zustand = zustand;
    this.geofabrik = geofabrik;
    this.bauen = bauen;
    this.run = run;
    this.fetchImpl = fetchImpl;
    this.jetzt = jetzt;
    this.laufend = null; // { auftrag, controller }
    this.fertig = Promise.resolve();
    mkdirSync(konfig.pfade.protokolle, { recursive: true });
    // Ein Neustart unterbricht, was lief oder wartete.
    let geaendert = false;
    for (const a of zustand.auftraege) {
      if (a.status === 'laeuft' || a.status === 'wartet') {
        a.status = 'abgebrochen';
        a.fehler = 'Server wurde neu gestartet';
        a.ende = this.jetzt().toISOString();
        const paket = zustand.pakete[a.paket];
        if (paket && (paket.status === 'baut' || paket.status === 'wartet')) paket.status = paket.manifest ? 'fertig' : 'neu';
        geaendert = true;
      }
    }
    if (geaendert) zustand.speichern();
  }

  protokollPfad(id) {
    return join(this.konfig.pfade.protokolle, `${id}.log`);
  }

  /** Protokoll ab Byte `ab` -- fuer das Mitlesen in der Oberflaeche. */
  protokoll(id, ab = 0) {
    try {
      const groesse = statSync(this.protokollPfad(id)).size;
      if (ab >= groesse) return { text: '', bis: groesse };
      const text = readFileSync(this.protokollPfad(id)).subarray(ab).toString('utf-8');
      return { text, bis: groesse };
    } catch {
      return { text: '', bis: 0 };
    }
  }

  liste() {
    return [...this.zustand.auftraege].reverse();
  }

  /** Neuen Auftrag einreihen. */
  einreihen(paketId, { aktualisieren = false } = {}) {
    const paket = this.zustand.pakete[paketId];
    if (!paket) throw new Error('Unbekanntes Paket');
    if (this.zustand.auftraege.some((a) => a.paket === paketId && (a.status === 'wartet' || a.status === 'laeuft'))) {
      throw new Error('Für dieses Paket läuft oder wartet schon ein Auftrag');
    }
    const auftrag = {
      id: `${this.jetzt().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`,
      paket: paketId,
      status: 'wartet',
      aktualisieren,
      erstellt: this.jetzt().toISOString(),
      schritt: null,
    };
    this.zustand.auftraege.push(auftrag);
    paket.status = 'wartet';
    this.zustand.speichern();
    this.fertig = this.fertig.then(() => this._abarbeiten(auftrag));
    return auftrag;
  }

  abbrechen(id) {
    const a = this.zustand.auftraege.find((x) => x.id === id);
    if (!a) throw new Error('Unbekannter Auftrag');
    if (a.status === 'wartet') {
      a.status = 'abgebrochen';
      a.ende = this.jetzt().toISOString();
      const paket = this.zustand.pakete[a.paket];
      if (paket) paket.status = paket.manifest ? 'fertig' : 'neu';
      this.zustand.speichern();
      return a;
    }
    if (a.status === 'laeuft' && this.laufend?.auftrag.id === id) {
      this.laufend.controller.abort();
      return a;
    }
    throw new Error('Der Auftrag läuft nicht mehr');
  }

  async _abarbeiten(auftrag) {
    if (auftrag.status !== 'wartet') return; // inzwischen abgebrochen
    const paket = this.zustand.pakete[auftrag.paket];
    if (!paket) {
      auftrag.status = 'fehler';
      auftrag.fehler = 'Paket wurde gelöscht';
      this.zustand.speichern();
      return;
    }
    const controller = new AbortController();
    this.laufend = { auftrag, controller };
    const pfad = this.protokollPfad(auftrag.id);
    const protokoll = (text) => appendFileSync(pfad, `${this.jetzt().toISOString().slice(11, 19)} ${text}\n`);
    auftrag.status = 'laeuft';
    auftrag.start = this.jetzt().toISOString();
    paket.status = 'baut';
    this.zustand.speichern();
    protokoll(`Bau von „${paket.name}" (${paket.regionen.join(', ')})`);
    try {
      const manifest = await this.bauen({
        konfig: this.konfig,
        zustand: this.zustand,
        geofabrik: this.geofabrik,
        paket,
        protokoll,
        schritt: (name) => {
          auftrag.schritt = name;
          protokoll(`== ${name} ==`);
          this.zustand.speichern();
        },
        signal: controller.signal,
        run: this.run,
        fetchImpl: this.fetchImpl,
        aktualisieren: auftrag.aktualisieren,
      });
      paket.manifest = manifest;
      paket.status = 'fertig';
      delete paket.fehler;
      auftrag.status = 'fertig';
    } catch (err) {
      const abgebrochen = controller.signal.aborted;
      auftrag.status = abgebrochen ? 'abgebrochen' : 'fehler';
      auftrag.fehler = abgebrochen ? 'abgebrochen' : err.message;
      paket.status = paket.manifest ? 'fertig' : abgebrochen ? 'neu' : 'fehler';
      if (!abgebrochen) paket.fehler = err.message;
      protokoll(abgebrochen ? 'Abgebrochen.' : `FEHLER: ${err.message}`);
    } finally {
      auftrag.ende = this.jetzt().toISOString();
      this.laufend = null;
      this.zustand.speichern();
    }
  }
}
