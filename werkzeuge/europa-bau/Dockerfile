# Europa-Bau: setzt wie der Kartenserver auf dem Image von Yapaia Go auf --
# darin sind planetiler/Java, Valhalla, osmium und der Suchindex-Bau in genau
# der Version, die Go erwartet. Ab Go 0.62.0 legt Go Routing-Länderpakete
# desselben Baus zusammen, ab 0.63.0 mit Valhalla 3.9.1 (3.5.1 stürzte beim
# Europa-Bau in der build-Stufe ab).
ARG GO_VERSION=0.63.0
ARG ARCH=amd64
FROM ghcr.io/yapaia/yapaia-go-${ARCH}:${GO_VERSION}
RUN apt-get update && apt-get install -y --no-install-recommends fio zstd && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/europa-bau
COPY europa-bau/bau.sh europa-bau/vergleich.sh europa-bau/messen.sh europa-bau/laender.py europa-bau/schneide_routing.py europa-bau/auswertung.py ./
COPY vorbereiten.mjs ./
RUN chmod +x *.sh
ENV BAU=/bau
# Das Go-Image startet s6 als Add-on-Init; hier läuft nur das Skript.
ENTRYPOINT []
CMD ["bash", "/opt/europa-bau/bau.sh"]
