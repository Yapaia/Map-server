# Yapaia Kartenserver
#
# Setzt auf dem Image von Yapaia Go auf: darin sind genau die Werkzeuge, mit
# denen Go selbst Karten baut (planetiler/Java, Valhalla, osmium, der
# Suchindex-Bau und die Skripte yapaia-build-*). So baut der Server
# Byte-genau, was Go erwartet -- und eine neue Go-Version bringt den
# Kartenserver mit einem Versions-Bump hier auf denselben Stand.
ARG GO_VERSION=0.45.0
ARG ARCH=amd64
FROM ghcr.io/yapaia/yapaia-go-${ARCH}:${GO_VERSION}

WORKDIR /opt/kartenserver
COPY package.json ./
COPY src ./src
COPY public ./public

ENV YAPAIA_DATEN=/share/yapaia \
    PORT=8080 \
    NODE_ENV=production

VOLUME ["/share/yapaia"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8080/gesund || exit 1

# Das Go-Image startet s6 als Add-on-Init; der Kartenserver braucht nur sich selbst.
ENTRYPOINT []
CMD ["node", "/opt/kartenserver/src/main.js"]
