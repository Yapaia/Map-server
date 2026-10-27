#!/bin/bash
# ==============================================================================
# Europa-Bau: Karte, Suche und Routing für alle europäischen Länder, je Land
# als Paket für den Kartenserver (Import-Ordner, siehe README).
#
#   1. Europa-Extrakt laden (fortsetzbar, md5 geprüft)
#   2. Routing: EIN Valhalla-Graph für Europa, Stufe für Stufe
#   3. je Land: Extrakt laden, Karte (planetiler), Suche (Lite-Index),
#      Routing-Kacheln aus dem Europa-Graphen schneiden, Paket schnüren
#
# Läuft im Container (docker compose, restart: unless-stopped) und setzt nach
# jedem Neustart dort fort, wo er aufgehört hat: jeder fertige Schritt hat eine
# Marke in stand/. Fortschritt: STATUS.txt, Protokoll: bau.log, je Versuch ein
# Log in logs/.
#
# Ein echter Fehler zählt als Versuch (ein Neustart nicht). Nach drei Fehlern:
# Routing -> Bau hält an (STATUS.txt), Land -> wird übersprungen
# (UEBERSPRUNGEN.txt). Weiter nach einem Halt:
#   rm $BAU/stand/<schritt>.versuche && docker compose restart bau
#
# Umgebung (alle optional):
#   BAU                 Arbeitsordner (Default /bau, das Volume)
#   QUELLE_URL          Europa-Extrakt (Default Geofabrik europe-latest)
#   LAENDER             nur diese Länder, z. B. germany,austria (Default alle)
#   THREADS             Threads für Valhalla (Default: alle Kerne)
#   PLANETILER_XMX      Heap für planetiler (Default 40 % RAM, 2–8 GB)
#   MIN_FREI_GB         unter so viel freiem Platz wird gewartet (Default 40)
#   MODUS=vergleich     statt Europa: Rechner vermessen (vergleich.sh)
# ==============================================================================
set -uo pipefail

BAU=${BAU:-/bau}
W=/opt/europa-bau
STAND=$BAU/stand
LOGS=$BAU/logs
QUELLEN=$BAU/quellen
ROUTING=$BAU/routing
ROH=$BAU/roh
PAKETE=$BAU/pakete
LAENDER_JSON=$BAU/laender.json
TOOLS=$BAU/werkzeuge
PLANETILER_VERSION=v0.10.2
PLANETILER_JAR=$TOOLS/planetiler-$PLANETILER_VERSION.jar
PLANETILER_QUELLEN=$BAU/planetiler-quellen
LITE_CLI=/app/apps/core/dist/lite-index.js
QUELLE_URL=${QUELLE_URL:-https://download.geofabrik.de/europe-latest.osm.pbf}
EUROPA_PBF=$QUELLEN/europe-latest.osm.pbf
MIN_FREI_GB=${MIN_FREI_GB:-40}

[ "${MODUS:-}" = vergleich ] && exec "$W/vergleich.sh"

mkdir -p "$STAND" "$LOGS" "$QUELLEN/laender" "$ROUTING" "$ROH" "$PAKETE" "$BAU/tmp" "$TOOLS" "$PLANETILER_QUELLEN"
export TMPDIR=$BAU/tmp

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$BAU/bau.log"; }
status() { printf '%s\n%s\n' "$(date -u +%FT%TZ)" "$*" > "$BAU/STATUS.txt"; }
frei_gb() { df -Pk "$BAU" | awk 'NR==2 { print int($4 / 1048576) }'; }
warte_auf_platz() { # [GB]
  local min=${1:-$MIN_FREI_GB}
  while [ "$(frei_gb)" -lt "$min" ]; do
    status "WARTET auf Plattenplatz: $(frei_gb) GB frei, gebraucht mindestens $min GB"
    sleep 300
  done
}

# schritt <name> <befehl...> -- führt aus, wenn noch keine Marke da ist.
schritt() {
  local name=$1; shift
  [ -f "$STAND/$name.ok" ] && return 0
  local versuche=0
  [ -f "$STAND/$name.versuche" ] && versuche=$(cat "$STAND/$name.versuche")
  if [ "$versuche" -ge 3 ]; then
    if [ "${UEBERSPRINGEN_ERLAUBT:-0}" = 1 ]; then
      log "UEBERSPRUNGEN: $name ist dreimal gescheitert (logs/$name.log)"
      echo "$name" >> "$BAU/UEBERSPRUNGEN.txt"
      return 2
    fi
    status "ANGEHALTEN: $name ist dreimal gescheitert. Log: logs/$name.log"
    log "ANGEHALTEN bei $name"
    sleep infinity
  fi
  warte_auf_platz
  status "LAEUFT: $name (Versuch $((versuche + 1)), $(frei_gb) GB frei)"
  log "START $name"
  local t0; t0=$(date +%s)
  # Jeder Versuch mit eigenem Log -- ein Neuversuch darf die Ursache des
  # vorigen nicht überschreiben. logs/<schritt>.log zeigt auf den letzten.
  local logdatei="$LOGS/$name.$(date -u +%Y%m%dT%H%M%S).log"
  ln -sfn "$(basename "$logdatei")" "$LOGS/$name.log"
  if ( "$@" ) > "$logdatei" 2>&1; then
    touch "$STAND/$name.ok"
    rm -f "$STAND/$name.versuche"
    log "OK $name ($(( $(date +%s) - t0 )) s)"
  else
    local rc=$?
    echo $((versuche + 1)) > "$STAND/$name.versuche"
    log "FEHLER $name (Code $rc, $(( $(date +%s) - t0 )) s) -- siehe logs/$(basename "$logdatei")"
    exit 1   # Container startet neu und versucht es noch einmal
  fi
}

# --- Download (fortsetzbar) mit md5-Prüfung ---------------------------------
lade() { # <url> <ziel>
  local url=$1 ziel=$2
  [ -s "$ziel" ] && return 0
  curl -sSfL -C - --retry 20 --retry-delay 30 -o "$ziel.part" "$url" || return 1
  local soll ist
  soll=$(curl -sSfL "$url.md5" | awk '{ print $1 }')
  ist=$(md5sum "$ziel.part" | awk '{ print $1 }')
  if [ -n "$soll" ] && [ "$soll" != "$ist" ]; then
    echo "md5 passt nicht ($ist statt $soll) -- Datei wird verworfen"
    rm -f "$ziel.part"
    return 1
  fi
  mv "$ziel.part" "$ziel"
}

laenderliste() {
  curl -sSfL -o "$BAU/tmp/index-v1.json" https://download.geofabrik.de/index-v1.json &&
    python3 "$W/laender.py" "$BAU/tmp/index-v1.json" "$LAENDER_JSON" "${LAENDER:-}"
}

# --- Routing -------------------------------------------------------------------
threads() { echo "${THREADS:-$(nproc)}"; }

routing_config() {
  valhalla_build_config \
    --mjolnir-tile-dir "$ROUTING/valhalla_tiles" \
    --mjolnir-tile-extract "$ROUTING/tiles.tar" \
    --mjolnir-admin "$ROUTING/admin_data/admins.sqlite" \
    --mjolnir-timezone "$ROUTING/timezone_data/timezones.sqlite" \
    --mjolnir-concurrency "$(threads)" > "$ROUTING/valhalla.json"
}

routing_admins() {
  mkdir -p "$ROUTING/admin_data"
  routing_config && nice -n 19 valhalla_build_admins -c "$ROUTING/valhalla.json" "$EUROPA_PBF"
}

routing_stufe() { # <stufe>
  local stufe=$1
  routing_config || return 1
  nice -n 19 valhalla_build_tiles -c "$ROUTING/valhalla.json" -s "$stufe" -e "$stufe" "$EUROPA_PBF"
  local rc=$?
  # Ab `build` verändern die Stufen die Zwischendateien und Kacheln an Ort
  # und Stelle (edges.bin wird z. B. umklassifiziert, enhance schreibt in die
  # Kacheln). Ein Neuversuch auf halb veränderten Daten gäbe keinen sauberen
  # Graphen -- deshalb beginnt er wieder bei constructedges. Gelernt am
  # 2026-10-26: ein zweiter build-Lauf klassifizierte 24 statt 453 713 Kanten.
  if [ $rc -ne 0 ]; then
    case $stufe in
      initialize|parseways|parserelations|parsenodes|constructedges|cleanup) ;;
      *)
        rm -f "$STAND/routing-constructedges.ok" "$STAND"/routing-{build,enhance,filter,transit,bss,hierarchy,shortcuts,restrictions,elevation,validate}.ok
        echo "Neuversuch beginnt wieder bei constructedges"
        ;;
    esac
  fi
  return $rc
}

# --- je Land -------------------------------------------------------------------
planetiler_jar() {
  [ -s "$PLANETILER_JAR" ] && return 0
  curl -sSfL -o "$PLANETILER_JAR.part" \
    "https://github.com/onthegomap/planetiler/releases/download/$PLANETILER_VERSION/planetiler.jar" &&
    mv "$PLANETILER_JAR.part" "$PLANETILER_JAR"
}

xmx() {
  if [ -n "${PLANETILER_XMX:-}" ]; then echo "$PLANETILER_XMX"; return; fi
  awk '/^MemTotal:/ { m = int($2 / 1024 * 0.4); if (m < 2048) m = 2048; if (m > 8192) m = 8192; print m "m" }' /proc/meminfo
}

karte() { # <id> <pbf>
  local id=$1 pbf=$2 ziel=$ROH/$1
  mkdir -p "$ziel" "$BAU/tmp/planetiler-$id"
  planetiler_jar || return 1
  nice -n 19 java "-Xmx$(xmx)" -jar "$PLANETILER_JAR" \
    --osm-path="$pbf" --output="$ziel/$id.pmtiles" --force \
    --nodemap-type=sortedtable --download --download_dir="$PLANETILER_QUELLEN" \
    --tmpdir="$BAU/tmp/planetiler-$id" || return 1
  rm -rf "$BAU/tmp/planetiler-$id"
  [ -s "$ziel/$id.pmtiles" ]
}

suche() { # <id> <pbf> -- dieselben Schritte wie yapaia-build-lite-index in Go
  local id=$1 pbf=$2 ziel=$ROH/$1 w=$BAU/tmp/suche-$1
  rm -rf "$w"; mkdir -p "$w" "$ziel"
  local poi named
  mapfile -t poi < <(node "$LITE_CLI" --print-osmium-filters)
  mapfile -t named < <(node "$LITE_CLI" --print-named-filters)
  [ "${#poi[@]}" -gt 0 ] && [ "${#named[@]}" -gt 0 ] || return 1
  local ort="n/place=city,town,village,suburb,quarter,borough,hamlet" lz4=(-f pbf,pbf_compression=lz4)
  set -e
  nice -n 19 osmium tags-filter --overwrite "${lz4[@]}" -o "$w/vorab.osm.pbf" "$pbf" "$ort" w/highway "${poi[@]}" nwr/name nwr/addr:housenumber
  nice -n 19 osmium tags-filter --overwrite "${lz4[@]}" -o "$w/places.osm.pbf" "$w/vorab.osm.pbf" "$ort"
  nice -n 19 osmium tags-filter --overwrite "${lz4[@]}" -o "$w/streets.osm.pbf" "$w/vorab.osm.pbf" w/highway
  nice -n 19 osmium tags-filter --overwrite "${lz4[@]}" -o "$w/pois.osm.pbf" "$w/vorab.osm.pbf" "${poi[@]}"
  nice -n 19 osmium tags-filter --overwrite "${lz4[@]}" -o "$w/named-all.osm.pbf" "$w/vorab.osm.pbf" nwr/name
  nice -n 19 osmium tags-filter --overwrite "${lz4[@]}" -o "$w/named.osm.pbf" "$w/named-all.osm.pbf" "${named[@]}"
  nice -n 19 osmium tags-filter --overwrite "${lz4[@]}" -o "$w/addresses.osm.pbf" "$w/vorab.osm.pbf" nwr/addr:housenumber
  rm -f "$w/vorab.osm.pbf" "$w/named-all.osm.pbf"
  nice -n 19 osmium export --overwrite --geometry-types=point -f geojsonseq -o "$w/places.geojsonseq" "$w/places.osm.pbf"
  nice -n 19 osmium export --overwrite --geometry-types=linestring,polygon -f geojsonseq -o "$w/streets.geojsonseq" "$w/streets.osm.pbf"
  for f in pois named addresses; do
    nice -n 19 osmium export --overwrite --geometry-types=point,linestring,polygon -f geojsonseq -o "$w/$f.geojsonseq" "$w/$f.osm.pbf"
  done
  rm -f "$w"/*.osm.pbf
  (cd /app && nice -n 19 node "$LITE_CLI" --places "$w/places.geojsonseq" --streets "$w/streets.geojsonseq" \
    --pois "$w/pois.geojsonseq" --named "$w/named.geojsonseq" --addresses "$w/addresses.geojsonseq" \
    --out "$ziel/lite_search.db" --region "$id")
  set +e
  rm -rf "$w"
  [ -s "$ziel/lite_search-$id.db" ]
}

routing_land() { # <id>
  local id=$1 ziel=$ROH/$1/routing
  rm -rf "$ziel"; mkdir -p "$ziel/tiles"
  python3 "$W/schneide_routing.py" "$ROUTING/valhalla_tiles" "$LAENDER_JSON" "$id" "$ziel/tiles/valhalla_tiles" || return 1
  # Die Config, wie Go sie für seinen Graphen benutzt (Pfade unter /custom_files)
  jq '.mjolnir.tile_dir = "/custom_files/valhalla_tiles"
      | .mjolnir.admin = "/custom_files/admin_data/admins.sqlite"
      | .mjolnir.timezone = "/custom_files/timezone_data/timezones.sqlite"
      | del(.mjolnir.tile_extract) | del(.mjolnir.traffic_extract)' "$ROUTING/valhalla.json" > "$ziel/tiles/valhalla.json"
  # teilgraph/bau: Go (ab 0.62.0) legt Länder desselben Baus zusammen.
  # valhalla: Go (ab 0.63.0) lehnt Pakete aus einer neueren Version ab.
  jq -n --arg r "$id" --arg b "$(cat "$STAND/bau-id")" --arg t "$(cat "$STAND/datenstand")" \
    --arg v "$(valhalla_service --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)" \
    '{region: $r, regions: [$r], built_at: $t, bau: $b, teilgraph: true, valhalla: $v}' > "$ziel/build-info.json"
}

paket() { # <id> <name>
  local id=$1 name=$2
  rm -rf "${PAKETE:?}/$id"
  # --zstd: Suche und Routing gepackt (etwa halbe Größe, Go entpackt ab 0.64.0)
  node "$W/vorbereiten.mjs" --zstd --ziel "$PAKETE" --id "$id" --name "$name" \
    --karte "$ROH/$id/$id.pmtiles" --suche "$ROH/$id/lite_search-$id.db" --routing "$ROH/$id/routing"
}

# ==============================================================================
# Testmodus: nur die Länder-Kette für TEST_LAND, Routing aus TEST_ROUTING
# (ein vorhandener Graph mit valhalla_tiles/ und valhalla.json).
if [ -n "${TEST_LAND:-}" ]; then
  ROUTING=$TEST_ROUTING
  echo test > "$STAND/bau-id"; date -u +%FT%TZ > "$STAND/datenstand"
  LAENDER=$TEST_LAND schritt laenderliste laenderliste
  id=$TEST_LAND
  name=$(jq -r --arg i "$id" '.[] | select(.id == $i) | .name' "$LAENDER_JSON")
  url=$(jq -r --arg i "$id" '.[] | select(.id == $i) | .url' "$LAENDER_JSON")
  pbf=$QUELLEN/laender/$id.osm.pbf
  schritt "$id-download" lade "$url" "$pbf" && schritt "$id-karte" karte "$id" "$pbf" &&
    schritt "$id-suche" suche "$id" "$pbf" && schritt "$id-routing" routing_land "$id" &&
    schritt "$id-paket" paket "$id" "$name"
  exit $?
fi

log "Bau gestartet/fortgesetzt ($(frei_gb) GB frei, $(nproc) Kerne, $(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo) GB RAM, Threads $(threads))"

schritt laenderliste laenderliste
schritt europa-download lade "$QUELLE_URL" "$EUROPA_PBF"
if [ ! -f "$STAND/datenstand" ]; then
  osmium fileinfo -g header.option.osmosis_replication_timestamp "$EUROPA_PBF" > "$STAND/datenstand" 2>/dev/null
  [ -s "$STAND/datenstand" ] || date -u -r "$EUROPA_PBF" +%FT%TZ > "$STAND/datenstand"
  echo "europa-$(cut -c1-10 "$STAND/datenstand")" > "$STAND/bau-id"
fi

# Der Routing-Bau braucht in der Spitze rund 120 GB Zwischendateien.
[ -f "$STAND/routing-initialize.ok" ] || warte_auf_platz 150
schritt routing-admins routing_admins
for stufe in initialize parseways parserelations parsenodes constructedges build enhance filter \
             transit bss hierarchy shortcuts restrictions elevation validate cleanup; do
  schritt "routing-$stufe" routing_stufe "$stufe"
done

# Ein Land, das dreimal scheitert, wird übersprungen (UEBERSPRUNGEN.txt) --
# die anderen sollen deswegen nicht warten.
UEBERSPRINGEN_ERLAUBT=1
mapfile -t IDS < <(jq -r '.[].id' "$LAENDER_JSON")
for id in "${IDS[@]}"; do
  grep -qx "$id-.*" "$BAU/UEBERSPRUNGEN.txt" 2>/dev/null && continue
  name=$(jq -r --arg i "$id" '.[] | select(.id == $i) | .name' "$LAENDER_JSON")
  url=$(jq -r --arg i "$id" '.[] | select(.id == $i) | .url' "$LAENDER_JSON")
  pbf=$QUELLEN/laender/$id.osm.pbf
  if [ ! -f "$STAND/$id-paket.ok" ]; then
    schritt "$id-download" lade "$url" "$pbf" &&
      schritt "$id-karte" karte "$id" "$pbf" &&
      schritt "$id-suche" suche "$id" "$pbf" &&
      schritt "$id-routing" routing_land "$id" &&
      schritt "$id-paket" paket "$id" "$name"
  fi
  rm -f "$pbf"   # Extrakt wird nicht mehr gebraucht
done

status "FERTIG: $(ls "$PAKETE" | wc -l) Pakete in $PAKETE ($(du -sh "$PAKETE" | cut -f1)), $(frei_gb) GB frei"
log "FERTIG"
sleep infinity
