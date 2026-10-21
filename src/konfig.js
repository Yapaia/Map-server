/**
 * Einstellungen aus der Umgebung (docker-compose.yml / `docker run -e`).
 *
 * Alles, was der Kartenserver ablegt, liegt unter EINEM Verzeichnis
 * (`YAPAIA_DATEN`, im Container `/share/yapaia`). Das ist mit Absicht derselbe
 * Pfad wie im Go-Add-on: die Bauskripte aus dem Go-Image (yapaia-build-*)
 * setzen ihn voraus -- vor allem der Routing-Bau, dessen Arbeitsverzeichnis
 * `/custom_files` im Image fest auf `/share/yapaia/valhalla/tiles` zeigt.
 */

import { join } from 'node:path';

export function konfigAus(env = process.env) {
  const daten = env.YAPAIA_DATEN || '/share/yapaia';
  const wurzel = join(daten, 'kartenserver');
  return {
    port: Number(env.PORT || 8080),
    daten,
    wurzel,
    pfade: {
      zustand: join(wurzel, 'zustand.json'),
      extrakte: join(wurzel, 'extrakte'),
      quellen: join(wurzel, 'quellen'),
      bau: join(wurzel, 'bau'),
      pakete: join(wurzel, 'pakete'),
      protokolle: join(wurzel, 'protokolle'),
      tmp: join(wurzel, 'tmp'),
      katalogCache: join(wurzel, 'geofabrik-index.json'),
    },
    // Anmeldung an der Oberflaeche: Benutzer `admin`, dieses Passwort.
    adminPasswort: env.ADMIN_PASSWORT || '',
    // Fuer Go: Herunterladen nur mit diesem Token. Leer = beim ersten Start
    // erzeugen und in zustand.json merken (in der Oberflaeche sichtbar).
    downloadToken: env.DOWNLOAD_TOKEN || '',
    // Wie Go diesen Server von aussen erreicht -- fuer die URLs im Katalog.
    // Leer = aus der Anfrage ableiten (Host-Kopf, X-Forwarded-Proto).
    oeffentlicheUrl: (env.OEFFENTLICHE_URL || '').replace(/\/+$/, ''),
    geofabrikIndex: env.GEOFABRIK_INDEX || 'https://download.geofabrik.de/index-v1-nogeom.json',
    // Die Bauskripte aus dem Go-Image. Sie werden mit `bash` gestartet: ihre
    // erste Zeile (`#!/command/with-contenv bash`) setzt die s6-Umgebung des
    // Add-ons voraus, die hier nicht laeuft -- und nicht gebraucht wird, weil
    // der Kartenserver ihnen alle Pfade selbst uebergibt.
    befehle: {
      shell: env.BEFEHL_SHELL || 'bash',
      karte: env.BEFEHL_KARTE || '/usr/bin/yapaia-build-pmtiles',
      suche: env.BEFEHL_SUCHE || '/usr/bin/yapaia-build-lite-index',
      routing: env.BEFEHL_ROUTING || '/usr/bin/yapaia-build-graph',
      osmium: env.BEFEHL_OSMIUM || 'osmium',
      tar: env.BEFEHL_TAR || 'tar',
    },
    // Quellen, die planetiler sonst selbst laedt -- vorab und geduldig, mit
    // Wiederholungen. planetiler fragt den Server mit kurzer Frist nach der
    // Groesse und bricht den ganzen Bau ab, wenn er nicht sofort antwortet
    // (gesehen bei osmdata.openstreetmap.de). Liegt die Datei schon da, laedt
    // planetiler sie nicht noch einmal. QUELLEN_VORAB=0 schaltet das ab.
    quellenVorab:
      env.QUELLEN_VORAB === '0'
        ? []
        : [
            {
              name: 'Wasserflächen',
              datei: 'water-polygons-split-3857.zip',
              url: env.WASSER_URL || 'https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip',
            },
          ],
    // Valhalla baut mit mehreren Threads schneller, braucht aber mehr RAM.
    // 2 passt zu einem VPS mit 8 GB, der nichts anderes tut.
    routingThreads: Number(env.VALHALLA_BUILD_THREADS || 2),
  };
}
