#!/usr/bin/env bash
# Richtet den Yapaia-Kartenserver auf einem VPS ein (mehrfach ausführbar).
#
#   ./install.sh                          # fragt nach der Domain und wählt die Betriebsart selbst
#   ./install.sh --domain karten.example.org
#   ./install.sh --hinter-homebase        # Homebase macht HTTPS, Kartenserver lauscht nur auf 127.0.0.1:8080
#   ./install.sh --eigenes-https          # eigener Caddy auf 80/443 (VPS ohne Homebase)
#   ./install.sh --nur-http               # ohne Domain, http://<IP>:8080 (zum Ausprobieren)
#   ./install.sh --build                  # Image auf dem VPS bauen statt herunterladen
#
# Ohne Angabe gilt die Betriebsart aus .env; beim ersten Lauf: Port 443 belegt
# (z. B. von der Homebase) -> hinter-homebase, sonst eigenes-https.
# Vorhandene Werte in .env (Passwort, Token, eigene Zeilen) bleiben erhalten.
set -euo pipefail
cd "$(dirname "$0")"

BUILD=0
DOMAIN_ARG=""
MODUS_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --domain) DOMAIN_ARG="${2:-}"; shift ;;
    --domain=*) DOMAIN_ARG="${1#*=}" ;;
    --hinter-homebase) MODUS_ARG=hinter-homebase ;;
    --eigenes-https) MODUS_ARG=eigenes-https ;;
    --nur-http) MODUS_ARG=nur-http ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (Hilfe: ./install.sh --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[31mFehler:\033[0m %s\n' "$*" >&2; exit 1; }
frage() { # frage "Text" -> 0 bei ja
  [ -t 0 ] || return 1
  local a; read -r -p "$1 [j/N] " a; [[ "$a" =~ ^[jJyY] ]]
}

# ------------------------------------------------------------------ Docker
if ! command -v docker >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ] && frage "Docker ist nicht installiert. Jetzt installieren (get.docker.com)?"; then
    curl -fsSL https://get.docker.com | sh
  else
    die "Docker fehlt. Installieren mit: curl -fsSL https://get.docker.com | sh"
  fi
fi
docker info >/dev/null 2>&1 || die "Docker läuft nicht, oder dieser Benutzer darf es nicht benutzen (sudo verwenden)."
docker compose version >/dev/null 2>&1 || die "'docker compose' fehlt (Paket docker-compose-plugin)."

# ------------------------------------------------------------------ .env
[ -f .env ] || cp .env.beispiel .env
chmod 600 .env

env_get() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
env_set() { # ersetzt KEY=… oder hängt es an; andere Zeilen bleiben
  local key="$1" val="$2"
  if grep -qE "^$key=" .env; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > "$tmp"
    cat "$tmp" > .env; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}
zufall() { if command -v openssl >/dev/null 2>&1; then openssl rand -base64 18 | tr -d '/+='; else head -c 18 /dev/urandom | base64 | tr -d '/+='; fi; }

port_belegt() { # lauscht schon etwas auf diesem Port (z. B. die Homebase auf 443)?
  if command -v ss >/dev/null 2>&1; then ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
  else (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi
}
eigenes_https_laeuft() { docker compose --profile https ps --status running -q https 2>/dev/null | grep -q .; }

# Betriebsart
MODUS="${MODUS_ARG:-$(env_get MODUS)}"
if [ -z "$MODUS" ]; then
  if eigenes_https_laeuft; then MODUS=eigenes-https
  elif port_belegt 443; then MODUS=hinter-homebase
  else MODUS=eigenes-https; fi
fi
if [ "$MODUS" = eigenes-https ] && ! eigenes_https_laeuft && { port_belegt 443 || port_belegt 80; }; then
  die "Port 80 oder 443 ist schon belegt (läuft die Homebase?). Dann: ./install.sh --hinter-homebase"
fi

# Domain
DOMAIN="${DOMAIN_ARG:-$(env_get DOMAIN)}"
if [ "$MODUS" != nur-http ] && [ -z "$DOMAIN" ]; then
  [ -t 0 ] || die "Keine Domain angegeben. Aufruf: ./install.sh --domain karten.example.org"
  read -r -p "Domain des Kartenservers (z. B. karten.yapaia.cloud): " DOMAIN
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed -e 's#^https\?://##' -e 's#/.*$##')"
if [ "$MODUS" != nur-http ]; then
  printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$' || die "Ungültige Domain: '$DOMAIN'"
fi

# Passwort: vorhandenes behalten, sonst eines erzeugen
NEUES_PASSWORT=""
if [ -z "$(env_get ADMIN_PASSWORT)" ]; then
  NEUES_PASSWORT="$(zufall)"
  env_set ADMIN_PASSWORT "$NEUES_PASSWORT"
fi

env_set MODUS "$MODUS"
case "$MODUS" in
  hinter-homebase)
    env_set DOMAIN "$DOMAIN"; env_set BINDEN 127.0.0.1
    env_set OEFFENTLICHE_URL "https://$DOMAIN"; env_set COMPOSE_PROFILES "" ;;
  eigenes-https)
    env_set DOMAIN "$DOMAIN"; env_set BINDEN 127.0.0.1
    env_set OEFFENTLICHE_URL "https://$DOMAIN"; env_set COMPOSE_PROFILES https ;;
  nur-http)
    env_set BINDEN 0.0.0.0; env_set OEFFENTLICHE_URL ""; env_set COMPOSE_PROFILES "" ;;
  *) die "Unbekannte Betriebsart in .env: MODUS=$MODUS" ;;
esac

# ------------------------------------------------------------------ Starten
if [ "$BUILD" = 1 ]; then
  say "Baue das Image auf dem VPS (dauert einige Minuten) …"
  docker compose build
elif ! docker compose pull kartenserver; then
  say "Image nicht ladbar – baue es auf dem VPS …"
  docker compose build
fi
if [ "$MODUS" != eigenes-https ] && eigenes_https_laeuft; then
  say "Eigenes HTTPS wird nicht mehr gebraucht – stoppe es …"
  docker compose --profile https rm -sf https >/dev/null
fi
say "Starte den Kartenserver …"
docker compose up -d

for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:8080/" 2>/dev/null || curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080/" 2>/dev/null | grep -q 401; then
    BEREIT=1; break
  fi
  sleep 2
done

echo
say "Fertig."
case "$MODUS" in
  hinter-homebase)
    echo "Der Kartenserver lauscht nur auf 127.0.0.1:8080. Die Homebase macht HTTPS:"
    echo "  In der .env der Homebase:  KARTEN_DOMAIN=$DOMAIN"
    echo "  dann dort:                 docker compose up -d"
    echo "Danach: https://$DOMAIN" ;;
  eigenes-https)
    echo "Erreichbar unter https://$DOMAIN (Zertifikat kommt nach etwa einer Minute)." ;;
  nur-http)
    echo "Erreichbar unter http://<IP-des-VPS>:8080 – ohne Verschlüsselung, nur zum Ausprobieren." ;;
esac
echo "Anmeldung: Benutzer admin"
if [ -n "$NEUES_PASSWORT" ]; then
  echo "           Passwort $NEUES_PASSWORT   (steht auch in .env – gut aufbewahren)"
else
  echo "           Passwort wie bisher (steht in .env)"
fi
[ "${BEREIT:-0}" = 1 ] || echo "Hinweis: Der Server antwortet noch nicht auf 127.0.0.1:8080. Nachsehen mit: docker compose logs -f kartenserver"
echo "Aktualisieren später: ./install.sh  (oder: docker compose pull && docker compose up -d)"
