#!/bin/bash
# Vergleichsmodus: einen Rechner für den Kartenbau vermessen (~30–60 min).
#   MODUS=vergleich docker compose run --rm bau
# 1. System (CPU, Kerne, RAM, Platte, read_ahead)
# 2. Platte mit fio: am Stück schreiben/lesen, zufällig lesen (4 KB, 1/3/8 parallel)
# 3. Schweiz komplett: Routing (Valhalla, Stufe für Stufe), Karte, Suche -- mit Zeiten
# Ergebnis: $BAU/vergleich/<rechner>-<zeit>.txt und eine Zeile in vergleich.csv
set -uo pipefail
BAU=${BAU:-/bau}; W=/opt/europa-bau
V=$BAU/vergleich/arbeit; rm -rf "$V"; mkdir -p "$V" "$BAU/vergleich" "$BAU/quellen/laender"
NAME=$(cat /etc/hostname 2>/dev/null || echo rechner)-$(date -u +%Y%m%dT%H%M)
OUT=$BAU/vergleich/$NAME.txt
say() { echo "$*" | tee -a "$OUT"; }
dauer() { local t0=$(date +%s); "$@" > "$V/log.txt" 2>&1; local rc=$?; echo $(( $(date +%s) - t0 )); return $rc; }

quelle=$(df -P "$BAU" | awk 'NR==2 { print $1 }'); dev=$(basename "$quelle" | sed -E 's/p?[0-9]+$//')
say "Vergleich $NAME"
say "CPU: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs), Kerne: $(nproc), RAM: $(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo) GB"
say "Platte: $quelle (read_ahead_kb $(cat /sys/block/$dev/queue/read_ahead_kb 2>/dev/null || echo ?)), frei: $(df -Ph "$BAU" | awk 'NR==2{print $4}')"

f() { fio --name=t --filename="$V/fio.test" --size=2G --direct=1 --ioengine=libaio --output-format=terse --terse-version=3 "$@" 2>/dev/null; }
sw=$(f --rw=write --bs=1M --iodepth=4 | awk -F';' '{printf "%.0f", $48/1024}')
sr=$(f --rw=read --bs=1M --iodepth=4 | awk -F';' '{printf "%.0f", $7/1024}')
r1=$(f --rw=randread --bs=4k --iodepth=1 --runtime=15 --time_based | awk -F';' '{print $8}')
r3=$(f --rw=randread --bs=4k --iodepth=3 --runtime=15 --time_based | awk -F';' '{print $8}')
r8=$(f --rw=randread --bs=4k --iodepth=8 --runtime=15 --time_based | awk -F';' '{print $8}')
rm -f "$V/fio.test"
say "Platte: schreiben ${sw} MB/s, lesen ${sr} MB/s, zufaellig lesen 4k: QD1 ${r1} / QD3 ${r3} / QD8 ${r8} IOPS"

PBF=$BAU/quellen/laender/switzerland.osm.pbf
[ -s "$PBF" ] || curl -sSfL -o "$PBF" https://download.geofabrik.de/europe/switzerland-latest.osm.pbf
T=${THREADS:-$(nproc)}
mkdir -p "$V/r/admin_data"
valhalla_build_config --mjolnir-tile-dir "$V/r/valhalla_tiles" --mjolnir-tile-extract "$V/r/t.tar" \
  --mjolnir-admin "$V/r/admin_data/admins.sqlite" --mjolnir-timezone "$V/r/tz.sqlite" --mjolnir-concurrency "$T" > "$V/r/valhalla.json"
zeiten="admins=$(dauer valhalla_build_admins -c "$V/r/valhalla.json" "$PBF")"
for s in initialize parseways parserelations parsenodes constructedges build enhance filter transit bss hierarchy shortcuts restrictions elevation validate cleanup; do
  zeiten="$zeiten $s=$(dauer valhalla_build_tiles -c "$V/r/valhalla.json" -s $s -e $s "$PBF")"
done
routing=0; for z in $zeiten; do routing=$((routing + ${z#*=})); done
say "Routing Schweiz ($T Threads): ${routing} s  [$zeiten]"

# Karte und Suche über bau.sh-Funktionen wäre zu verschachtelt -- hier direkt.
JAR=$BAU/werkzeuge/planetiler-v0.10.2.jar; mkdir -p "$BAU/werkzeuge" "$BAU/planetiler-quellen"
[ -s "$JAR" ] || curl -sSfL -o "$JAR" https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar
# Die Hilfsdaten (Küsten, Natural Earth) einmal vorab, damit ihr Download nicht mitzählt
xmx=$(awk '/^MemTotal:/ { m = int($2 / 1024 * 0.4); if (m < 2048) m = 2048; if (m > 8192) m = 8192; print m "m" }' /proc/meminfo)
java -Xmx$xmx -jar "$JAR" --osm-path="$PBF" --only_download=true --download --download_dir="$BAU/planetiler-quellen" > /dev/null 2>&1
karte=$(dauer java -Xmx$xmx -jar "$JAR" --osm-path="$PBF" --output="$V/ch.pmtiles" --force --nodemap-type=sortedtable \
  --download --download_dir="$BAU/planetiler-quellen" --tmpdir="$V/pt")
say "Karte Schweiz (planetiler, Heap $xmx): ${karte} s"

suche_lauf() {
  local w=$V/s CLI=/app/apps/core/dist/lite-index.js lz4=(-f pbf,pbf_compression=lz4) ort="n/place=city,town,village,suburb,quarter,borough,hamlet"
  mkdir -p "$w"; set -e
  mapfile -t poi < <(node $CLI --print-osmium-filters); mapfile -t named < <(node $CLI --print-named-filters)
  osmium tags-filter --overwrite "${lz4[@]}" -o $w/v.pbf "$PBF" "$ort" w/highway "${poi[@]}" nwr/name nwr/addr:housenumber
  osmium tags-filter --overwrite "${lz4[@]}" -o $w/places.pbf $w/v.pbf "$ort"
  osmium tags-filter --overwrite "${lz4[@]}" -o $w/streets.pbf $w/v.pbf w/highway
  osmium tags-filter --overwrite "${lz4[@]}" -o $w/pois.pbf $w/v.pbf "${poi[@]}"
  osmium tags-filter --overwrite "${lz4[@]}" -o $w/na.pbf $w/v.pbf nwr/name
  osmium tags-filter --overwrite "${lz4[@]}" -o $w/named.pbf $w/na.pbf "${named[@]}"
  osmium tags-filter --overwrite "${lz4[@]}" -o $w/addresses.pbf $w/v.pbf nwr/addr:housenumber
  osmium export --overwrite --geometry-types=point -f geojsonseq -o $w/places.geojsonseq $w/places.pbf
  osmium export --overwrite --geometry-types=linestring,polygon -f geojsonseq -o $w/streets.geojsonseq $w/streets.pbf
  for x in pois named addresses; do osmium export --overwrite --geometry-types=point,linestring,polygon -f geojsonseq -o $w/$x.geojsonseq $w/$x.pbf; done
  cd /app && node $CLI --places $w/places.geojsonseq --streets $w/streets.geojsonseq --pois $w/pois.geojsonseq \
    --named $w/named.geojsonseq --addresses $w/addresses.geojsonseq --out $w/lite_search.db --region ch
}
suche=$(dauer suche_lauf)
say "Suche Schweiz: ${suche} s"
say "Gesamt (ohne Downloads): $((routing + karte + suche)) s"

[ -s "$BAU/vergleich/vergleich.csv" ] || echo "rechner,cpu,kerne,ram_gb,schreiben_mbs,lesen_mbs,iops_qd1,iops_qd3,iops_qd8,routing_s,karte_s,suche_s,gesamt_s" > "$BAU/vergleich/vergleich.csv"
echo "$NAME,\"$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)\",$(nproc),$(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo),$sw,$sr,$r1,$r3,$r8,$routing,$karte,$suche,$((routing + karte + suche))" >> "$BAU/vergleich/vergleich.csv"
rm -rf "$V"
say "Fertig: $OUT"
