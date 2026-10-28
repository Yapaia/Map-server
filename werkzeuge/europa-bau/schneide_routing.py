#!/usr/bin/env python3
"""Schneidet aus einem Valhalla-Graphen die Kacheln eines Landes heraus.

  schneide_routing.py <valhalla_tiles> <laender.json> <land-id> <ziel/valhalla_tiles>

Eine Kachel gehoert zum Land, wenn eine Ecke oder ihre Mitte im Landespolygon
liegt oder ein Punkt des Polygons in der Kachel. Die Kacheln werden als harte
Links angelegt (kein zusaetzlicher Platz). Grenzkacheln landen in beiden
Laendern -- mit identischem Inhalt, weil alle aus demselben Bau stammen.
Gibt die Zahl der Kacheln aus.
"""
import json
import os
import sys

GROESSE = {0: 4.0, 1: 1.0, 2: 0.25}


def kachel_rechteck(level, tid):
    s = GROESSE[level]
    spalten = int(360 / s)
    zeile, spalte = divmod(tid, spalten)
    return (-180 + spalte * s, -90 + zeile * s, -180 + (spalte + 1) * s, -90 + (zeile + 1) * s)


def im_ring(x, y, ring):
    drin = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            drin = not drin
        j = i
    return drin


def im_polygon(x, y, polygone):
    for poly in polygone:
        if im_ring(x, y, poly[0]) and not any(im_ring(x, y, loch) for loch in poly[1:]):
            return True
    return False


def main():
    quelle, laender, land, ziel = sys.argv[1:5]
    eintrag = next(l for l in json.load(open(laender)) if l['id'] == land)
    polygone = eintrag['polygon']
    punkte = [p for poly in polygone for ring in poly for p in ring]
    xs = [p[0] for p in punkte]
    ys = [p[1] for p in punkte]
    rahmen = (min(xs), min(ys), max(xs), max(ys))

    # Polygonpunkte je Kachel vorsortieren: Kachel -> hat einen Punkt
    mit_punkt = {lvl: set() for lvl in GROESSE}
    for lvl, s in GROESSE.items():
        spalten = int(360 / s)
        for x, y in punkte:
            mit_punkt[lvl].add(int((y + 90) // s) * spalten + int((x + 180) // s))

    anzahl = 0
    for wurzel, _, dateien in os.walk(quelle):
        for datei in dateien:
            if not datei.endswith('.gph'):
                continue
            rel = os.path.relpath(os.path.join(wurzel, datei), quelle)
            teile = rel[:-4].split(os.sep)
            lvl = int(teile[0])
            tid = int(''.join(teile[1:]))
            x0, y0, x1, y1 = kachel_rechteck(lvl, tid)
            if x1 < rahmen[0] or x0 > rahmen[2] or y1 < rahmen[1] or y0 > rahmen[3]:
                continue
            treffer = tid in mit_punkt[lvl] or any(
                im_polygon(x, y, polygone)
                for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1), ((x0 + x1) / 2, (y0 + y1) / 2))
            )
            if not treffer:
                continue
            ziel_datei = os.path.join(ziel, rel)
            os.makedirs(os.path.dirname(ziel_datei), exist_ok=True)
            if not os.path.exists(ziel_datei):
                os.link(os.path.join(quelle, rel), ziel_datei)
            anzahl += 1
    print(anzahl)
    if anzahl == 0:
        sys.exit(1)


if __name__ == '__main__':
    main()
