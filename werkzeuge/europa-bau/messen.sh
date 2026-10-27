#!/bin/bash
# Mess-Dienst: alle 5 Minuten eine Zeile nach $BAU/messung.csv. Nur lesend --
# beruehrt den Bau nicht. Grundlage fuer die Auswertung (auswertung.py).
BAU=${BAU:-/bau}; CSV=$BAU/messung.csv
# Die Platte, auf der $BAU liegt (/proc/diskstats sieht der Container vom Host).
quelle=$(df -P "$BAU" | awk 'NR==2 { print $1 }'); dev=$(basename "$quelle" | sed -E 's/p?[0-9]+$//')
[ -e "/sys/block/$dev" ] || dev=$(lsblk -no PKNAME "$quelle" 2>/dev/null | head -1)
[ -s "$CSV" ] || echo "zeit,schritt,kacheln,lesen_iops,lesen_mbs,schreiben_mbs,cpu_user,cpu_nice,cpu_sys,cpu_idle,cpu_iowait,ram_frei_mb,platte_frei_gb,read_ahead_kb" > "$CSV"
disk() { awk -v d="$dev" '$3==d{print $4, $6, $10}' /proc/diskstats; }
cpu() { awk '/^cpu /{print $2, $3, $4, $5, $6}' /proc/stat; }
while true; do
  read -r r1 rs1 ws1 <<< "$(disk)"; read -r u1 n1 s1 i1 w1 <<< "$(cpu)"
  sleep 300
  read -r r2 rs2 ws2 <<< "$(disk)"; read -r u2 n2 s2 i2 w2 <<< "$(cpu)"
  t=$(( (u2-u1)+(n2-n1)+(s2-s1)+(i2-i1)+(w2-w1) )); [ "$t" -gt 0 ] || t=1
  schritt=$(tail -1 "$BAU/STATUS.txt" 2>/dev/null | sed -E 's/^[A-Z]+: ([^ ]+).*/\1/')
  kacheln=$(find "$BAU/routing/valhalla_tiles" -name '*.gph' 2>/dev/null | wc -l)
  echo "$(date -u +%FT%TZ),$schritt,$kacheln,$(( (r2-r1)/300 )),$(( (rs2-rs1)*512/300/1000000 )),$(( (ws2-ws1)*512/300/1000000 )),$(( 100*(u2-u1)/t )),$(( 100*(n2-n1)/t )),$(( 100*(s2-s1)/t )),$(( 100*(i2-i1)/t )),$(( 100*(w2-w1)/t )),$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo),$(df -Pk "$BAU" | awk 'NR==2{print int($4/1048576)}'),$(cat "/sys/block/$dev/queue/read_ahead_kb" 2>/dev/null)" >> "$CSV"
done
