/**
 * Yapaia Kartenserver: Start.
 */

import { mkdirSync } from 'node:fs';
import { Auftraege } from './auftraege.js';
import { Geofabrik } from './geofabrik.js';
import { konfigAus } from './konfig.js';
import { erstelleServer } from './server.js';
import { Zustand } from './zustand.js';

const konfig = konfigAus();
for (const p of Object.values(konfig.pfade)) if (!p.endsWith('.json')) mkdirSync(p, { recursive: true });
const zustand = new Zustand(konfig.pfade.zustand);
const geofabrik = new Geofabrik({ url: konfig.geofabrikIndex, cachePfad: konfig.pfade.katalogCache });
const auftraege = new Auftraege({ konfig, zustand, geofabrik });
const server = erstelleServer({ konfig, zustand, geofabrik, auftraege });

server.listen(konfig.port, () => {
  console.log(`Yapaia Kartenserver läuft auf Port ${konfig.port}, Daten unter ${konfig.daten}`);
  if (!konfig.adminPasswort) console.warn('ACHTUNG: ADMIN_PASSWORT fehlt – die Oberfläche bleibt gesperrt.');
});

const ende = () => server.close(() => process.exit(0));
process.on('SIGTERM', ende);
process.on('SIGINT', ende);
