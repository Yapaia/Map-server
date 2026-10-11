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

Voraussetzung: Docker mit Compose (bei den meisten VPS-Anbietern als fertiges
„Docker“-Image auswählbar).

```bash
git clone https://github.com/Yapaia/map-server.git kartenserver
cd kartenserver
cp .env.beispiel .env
nano .env                 # ADMIN_PASSWORT eintragen
docker compose up -d
```

Dann im Browser `http://<IP-des-VPS>:8080` öffnen, Benutzer **admin**, das
Passwort aus `.env`.

> Das Image kommt fertig von `ghcr.io/yapaia/kartenserver`. Ist es (noch) nicht
> öffentlich, baut `docker compose up -d --build` es direkt auf dem VPS.

### Mit HTTPS (empfohlen)

Mit einer Domain, die auf den VPS zeigt (z. B. `karten.example.org`):

```bash
# in .env:
#   DOMAIN=karten.example.org
#   OEFFENTLICHE_URL=https://karten.example.org
#   BINDEN=127.0.0.1
docker compose --profile https up -d
```

Caddy holt das Zertifikat selbst (Ports 80 und 443 müssen offen sein). Danach
ist die Oberfläche unter `https://karten.example.org` erreichbar, und Port 8080
steht nicht mehr unverschlüsselt im Netz.

### Aktualisieren

```bash
docker compose pull && docker compose up -d
```

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
