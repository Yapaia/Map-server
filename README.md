# Yapaia Kartenserver

Baut die Kartendaten für **Yapaia Go** auf einem eigenen Server – statt auf dem
Home-Assistant-Rechner im Wohnmobil. Gedacht für einen VPS mit **8 GB RAM und
100 GB Platte**.

1. **Regionen wählen** – aus dem Katalog von [Geofabrik](https://download.geofabrik.de/)
   (Länder, Bundesländer, Regionen).
2. **Zu einem Paket zusammenfassen** – z. B. „Alpen“ aus Bayern, Österreich und
   der Schweiz. Die Regionen werden vor dem Bau zu einer Karte vereint; das
   Routing geht über die Grenzen hinweg.
3. **Bauen** – Karte (PMTiles), Suchindex und Routinggraph (Valhalla), mit
   genau denselben Werkzeugen wie Yapaia Go: Das Image baut auf dem Go-Image auf.
4. **Herunterladen** – Yapaia Go holt sich die fertigen Dateien über eine
   geschützte Schnittstelle.

## Installation auf dem VPS

Voraussetzung: ein VPS mit 8 GB RAM, 100 GB Platte und einer Domain (z. B.
`karten.yapaia.cloud`), deren A-Eintrag auf den VPS zeigt.

```bash
cd /opt
git clone https://github.com/Yapaia/map-server.git kartenserver
cd kartenserver
sudo ./install.sh --domain karten.yapaia.cloud
```

Das Skript installiert bei Bedarf Docker, legt `.env` an, erzeugt ein
Admin-Passwort, lädt das Image und startet den Server. Am Ende zeigt es
Adresse, Benutzer (**admin**) und Passwort. Es ist mehrfach ausführbar;
Passwort, Token und eigene Einträge in `.env` bleiben erhalten.

Die Betriebsart wählt es selbst:

| Betriebsart | Wann | HTTPS macht |
|---|---|---|
| `--hinter-homebase` | Port 443 ist belegt, z. B. von der [Homebase](https://github.com/Yapaia/homebase) | die Homebase; dort `KARTEN_DOMAIN=karten.yapaia.cloud` eintragen und `docker compose up -d` |
| `--eigenes-https` | leerer VPS | ein eigener Caddy auf 80/443 |
| `--nur-http` | zum Ausprobieren ohne Domain | niemand: `http://<IP-des-VPS>:8080` |

In den ersten beiden Fällen lauscht der Kartenserver nur auf `127.0.0.1:8080`;
Port 8080 bleibt von außen zu.

<details>
<summary>Von Hand statt mit dem Skript</summary>

```bash
cp .env.beispiel .env
nano .env    # ADMIN_PASSWORT, DOMAIN, BINDEN=127.0.0.1, OEFFENTLICHE_URL=https://<domain>
docker compose up -d                    # hinter der Homebase
docker compose --profile https up -d    # mit eigenem HTTPS
```

Das Image kommt fertig von `ghcr.io/yapaia/kartenserver`. Ist es nicht
ladbar, baut `docker compose up -d --build` es direkt auf dem VPS.
</details>

### Aktualisieren

```bash
cd /opt/kartenserver && git pull && ./install.sh
```

(oder nur `docker compose pull && docker compose up -d`)

Alle Daten (Extrakte, Pakete, Einstellungen) liegen im Volume `daten` und
bleiben erhalten.

## Bedienung

- **Neues Paket:** Namen vergeben, Regionen suchen und anklicken, „Paket
  anlegen“. Die Oberfläche schätzt aus den Rohdaten, wie viel Platz der Bau
  braucht.
- **Bauen:** Es baut immer nur **ein** Paket auf einmal; weitere warten in der
  Reihe. Das Protokoll läuft live mit, ein Bau lässt sich abbrechen.
- **Mit neuen Daten bauen:** lädt die Rohdaten nur neu, wenn Geofabrik einen
  neueren Stand hat (Geofabrik aktualisiert täglich).
- **Geladene Extrakte** bleiben für den nächsten Bau liegen; löschen spart Platz.

### Was auf 8 GB / 100 GB geht

| Paket | Rohdaten | Bauzeit (grob) |
|---|---|---|
| Ein Bundesland / kleines Land | 0,1–0,8 GB | Minuten bis eine Stunde |
| Deutschland | ~4 GB | mehrere Stunden |
| Alpenländer (DE-Süd, AT, CH, IT-Nord) | ~3–4 GB | mehrere Stunden |
| Ganz Europa | ~30 GB | **zu groß** für 8 GB RAM |

Faustregel: Rohdaten × 12 an freiem Platz während des Baus. Über etwa 4 GB
Rohdaten wird der Routing-Bau mit 8 GB RAM knapp; die Oberfläche warnt.

## Für Yapaia Go

| | |
|---|---|
| Katalog | `GET /v1/katalog` – alle fertigen Pakete |
| Download | `GET /v1/pakete/<paket>/<datei>` – mit `Range` (fortsetzbar) |
| Anmeldung | `Authorization: Bearer <Token>` (oder `?token=`) |

Token und Katalog-Adresse stehen in der Oberfläche unter „Verbindung für Yapaia
Go“. Ein Katalogeintrag hat dieselben Felder wie Gos `regions-catalog.json`
(`id`, `name`, `url`, `sizeBytes`, `bounds`, `sha256`) und zusätzlich `suche`
und `routing` (je `url`, `sizeBytes`, `sha256`):

| Datei | Ziel in Go |
|---|---|
| `<paket>.pmtiles` | `/share/yapaia/tiles/` |
| `lite_search-<paket>.db` | `/share/yapaia/lite-search/` |
| `<paket>-routing.tar` | entpackt nach `/share/yapaia/valhalla/` (`tiles/` + `build-info.json`) |

## Entwicklung

```bash
npm test          # Tests (Node 22, ohne Abhängigkeiten)
```

Die CI baut zusätzlich das Image und darin ein echtes Paket (Liechtenstein) –
von Geofabrik bis zum Download (`test/e2e.sh`).

Die Bauwerkzeuge kommen aus dem Go-Image (`Dockerfile`, `GO_VERSION`). Eine neue
Go-Version mit geänderter Kartenerzeugung heißt hier: `GO_VERSION` anheben.

Kartendaten © OpenStreetMap-Mitwirkende, [ODbL](https://opendatacommons.org/licenses/odbl/).
