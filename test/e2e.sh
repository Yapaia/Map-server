#!/usr/bin/env bash
# Ende-zu-Ende im fertigen Image: ein echtes Paket (Liechtenstein) von
# Geofabrik bis zum Download -- mit den echten Werkzeugen aus dem Go-Image.
set -euo pipefail

IMAGE="${1:?Image angeben}"
PW=ci-passwort
TOKEN=ci-token
docker run -d --name kartenserver -p 8080:8080 \
  -e ADMIN_PASSWORT="$PW" -e DOWNLOAD_TOKEN="$TOKEN" -e VALHALLA_BUILD_THREADS=2 \
  "$IMAGE"
trap 'docker logs kartenserver | tail -50; docker rm -f kartenserver >/dev/null' EXIT

api() { curl -fsS -u "admin:$PW" -H 'Content-Type: application/json' "$@"; }

for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/gesund >/dev/null 2>&1 && break; sleep 1; done
api http://127.0.0.1:8080/api/katalog | jq -e 'map(select(.id == "liechtenstein")) | length == 1' >/dev/null
echo "Geofabrik-Katalog geladen"

api -X POST http://127.0.0.1:8080/api/pakete -d '{"name":"Liechtenstein CI","regionen":["liechtenstein"]}' | jq .
AUFTRAG="$(api -X POST http://127.0.0.1:8080/api/pakete/liechtenstein-ci/bauen -d '{}' | jq -r .id)"
echo "Auftrag $AUFTRAG"

AB=0
for _ in $(seq 1 360); do
  PROT="$(api "http://127.0.0.1:8080/api/auftraege/$AUFTRAG/protokoll?ab=$AB")"
  printf '%s' "$(jq -r .text <<<"$PROT")"
  AB="$(jq -r .bis <<<"$PROT")"
  STATUS="$(api http://127.0.0.1:8080/api/auftraege | jq -r --arg id "$AUFTRAG" '.[] | select(.id == $id) | .status')"
  case "$STATUS" in
    fertig) break ;;
    fehler|abgebrochen) echo "Bau endete mit: $STATUS"; exit 1 ;;
  esac
  sleep 5
done
[ "$STATUS" = fertig ] || { echo "Zeit überschritten"; exit 1; }

KATALOG="$(curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/katalog)"
jq . <<<"$KATALOG"
jq -e '.[0].bounds | length == 4' <<<"$KATALOG" >/dev/null

hole() { curl -fsS -H "Authorization: Bearer $TOKEN" -o "$2" "$1"; }
hole "$(jq -r '.[0].url' <<<"$KATALOG")" /tmp/karte.pmtiles
hole "$(jq -r '.[0].suche.url' <<<"$KATALOG")" /tmp/suche.db
hole "$(jq -r '.[0].routing.url' <<<"$KATALOG")" /tmp/routing.tar

head -c 7 /tmp/karte.pmtiles | grep -q PMTiles && echo "Karte: PMTiles ($(stat -c %s /tmp/karte.pmtiles) Bytes)"
head -c 15 /tmp/suche.db | grep -q 'SQLite format 3' && echo "Suche: SQLite ($(stat -c %s /tmp/suche.db) Bytes)"
tar -tf /tmp/routing.tar | grep -q '^tiles/valhalla.json$' && echo "Routing: valhalla.json im Archiv"
tar -tf /tmp/routing.tar | grep -q '^build-info.json$'
tar -tf /tmp/routing.tar | grep -q '^tiles/valhalla_tiles/' && echo "Routing: Kacheln im Archiv ($(tar -tf /tmp/routing.tar | wc -l) Einträge)"
! tar -tf /tmp/routing.tar | grep -q '\.osm\.pbf$'
[ "$(sha256sum /tmp/karte.pmtiles | cut -d' ' -f1)" = "$(jq -r '.[0].sha256' <<<"$KATALOG")" ] && echo "Prüfsumme stimmt"
echo "Ende-zu-Ende: alles da."
