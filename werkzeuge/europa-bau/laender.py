#!/usr/bin/env python3
"""Länderliste für den Europa-Bau aus dem Geofabrik-Index.

  laender.py <index-v1.json> <laender.json> [id,id,...]

Nimmt alle Regionen mit parent=europe außer den Sammelregionen (alps, dach,
britain-and-ireland, united-kingdom -- deren Länder sind einzeln dabei).
Optional nur die genannten IDs (zum Testen oder für eine kleinere Auswahl).
Schreibt je Land: id, deutscher Name, Download-URL und Polygon (für das
Schneiden des Routings).
"""
import json
import sys

NAMEN = {
    'albania': 'Albanien', 'andorra': 'Andorra', 'austria': 'Österreich', 'azores': 'Azoren',
    'belarus': 'Belarus', 'belgium': 'Belgien', 'bosnia-herzegovina': 'Bosnien und Herzegowina',
    'bulgaria': 'Bulgarien', 'croatia': 'Kroatien', 'cyprus': 'Zypern', 'czech-republic': 'Tschechien',
    'denmark': 'Dänemark', 'estonia': 'Estland', 'faroe-islands': 'Färöer', 'finland': 'Finnland',
    'france': 'Frankreich', 'georgia': 'Georgien', 'germany': 'Deutschland', 'great-britain': 'Großbritannien',
    'greece': 'Griechenland', 'guernsey-jersey': 'Guernsey und Jersey', 'hungary': 'Ungarn',
    'iceland': 'Island', 'ireland-and-northern-ireland': 'Irland und Nordirland', 'isle-of-man': 'Isle of Man',
    'italy': 'Italien', 'kosovo': 'Kosovo', 'latvia': 'Lettland', 'liechtenstein': 'Liechtenstein',
    'lithuania': 'Litauen', 'luxembourg': 'Luxemburg', 'macedonia': 'Nordmazedonien', 'malta': 'Malta',
    'moldova': 'Moldau', 'monaco': 'Monaco', 'montenegro': 'Montenegro', 'netherlands': 'Niederlande',
    'norway': 'Norwegen', 'poland': 'Polen', 'portugal': 'Portugal', 'romania': 'Rumänien',
    'serbia': 'Serbien', 'slovakia': 'Slowakei', 'slovenia': 'Slowenien', 'spain': 'Spanien',
    'sweden': 'Schweden', 'switzerland': 'Schweiz', 'turkey': 'Türkei', 'ukraine': 'Ukraine',
}
SAMMELREGIONEN = {'alps', 'dach', 'britain-and-ireland', 'united-kingdom'}


def main():
    index, ziel = sys.argv[1:3]
    nur = set(sys.argv[3].split(',')) if len(sys.argv) > 3 and sys.argv[3] else None
    laender = []
    for f in json.load(open(index))['features']:
        p = f['properties']
        if p.get('parent') != 'europe' or p['id'] in SAMMELREGIONEN:
            continue
        if nur and p['id'] not in nur:
            continue
        g = f['geometry']
        polygone = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        laender.append({'id': p['id'], 'name': NAMEN.get(p['id'], p['name']), 'url': p['urls']['pbf'], 'polygon': polygone})
    laender.sort(key=lambda l: l['id'])
    if nur and len(laender) != len(nur):
        fehlt = nur - {l['id'] for l in laender}
        sys.exit(f'Unbekannte Länder: {", ".join(sorted(fehlt))}')
    json.dump(laender, open(ziel, 'w'), ensure_ascii=False)
    print(f'{len(laender)} Länder')


if __name__ == '__main__':
    main()
