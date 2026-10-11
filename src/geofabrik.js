/**
 * Der Katalog von Geofabrik: welche OSM-Extrakte es gibt.
 *
 * Geofabrik veroeffentlicht ihn als GeoJSON (`index-v1-nogeom.json`, ohne
 * Umrisse, ein paar hundert KB). Er wird einen Tag lang zwischengespeichert --
 * er aendert sich selten, und der Server soll Geofabrik nicht bei jedem
 * Seitenaufruf fragen.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CACHE_MS = 24 * 60 * 60 * 1000;

/** Die Eintraege aus dem GeoJSON, die einen PBF-Download haben. */
export function eintraegeAus(index) {
  const features = Array.isArray(index?.features) ? index.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const pbf = p.urls?.pbf;
    if (typeof p.id !== 'string' || typeof pbf !== 'string' || !/^https:\/\//.test(pbf)) continue;
    out.push({ id: p.id, name: String(p.name || p.id), eltern: typeof p.parent === 'string' ? p.parent : null, pbf });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return out;
}

export class Geofabrik {
  constructor({ url, cachePfad, fetchImpl = globalThis.fetch, jetzt = () => Date.now() }) {
    this.url = url;
    this.cachePfad = cachePfad;
    this.fetch = fetchImpl;
    this.jetzt = jetzt;
    this.eintraege = null;
  }

  _ausCache(auchAlt) {
    try {
      const alter = this.jetzt() - statSync(this.cachePfad).mtimeMs;
      if (!auchAlt && alter > CACHE_MS) return null;
      return eintraegeAus(JSON.parse(readFileSync(this.cachePfad, 'utf-8')));
    } catch {
      return null;
    }
  }

  /** Alle Extrakte; bei einem Fehler von Geofabrik der letzte bekannte Stand. */
  async liste() {
    if (this.eintraege) return this.eintraege;
    const frisch = this._ausCache(false);
    if (frisch?.length) return (this.eintraege = frisch);
    try {
      const r = await this.fetch(this.url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const eintraege = eintraegeAus(JSON.parse(text));
      if (!eintraege.length) throw new Error('leerer Katalog');
      mkdirSync(dirname(this.cachePfad), { recursive: true });
      writeFileSync(this.cachePfad, text);
      this.eintraege = eintraege;
      setTimeout(() => {
        this.eintraege = null;
      }, CACHE_MS).unref?.();
      return eintraege;
    } catch (err) {
      const alt = this._ausCache(true);
      if (alt?.length) return alt;
      throw new Error(`Geofabrik-Katalog nicht erreichbar: ${err.message}`);
    }
  }

  async finde(id) {
    return (await this.liste()).find((e) => e.id === id) ?? null;
  }
}
