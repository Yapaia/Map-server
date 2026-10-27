#!/usr/bin/env python3
"""Auswertung eines Europa-Baus: Dauer je Schritt und was dabei gebremst hat.

  python3 auswertung.py <BAU-Ordner> [messung.csv] [> auswertung.md]

Liest bau.log (START/OK/FEHLER je Schritt) und messung.csv (alle 5 min:
Plattenzugriffe, CPU, RAM) und schreibt eine Markdown-Tabelle: je Schritt
Dauer und die Mittelwerte der Messung in dieser Zeit. Daran sieht man, ob
ein Schritt auf die CPU (user/nice hoch), die Platte (iowait hoch) oder den
Speicher wartet.
"""
import csv
import re
import sys
from datetime import datetime, timezone

bau = sys.argv[1]
messdatei = sys.argv[2] if len(sys.argv) > 2 else f'{bau}/messung.csv'
zeile = re.compile(r'^(\S+) (START|OK|FEHLER) (\S+)')


def t(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


laeufe = []  # (schritt, start, ende, ergebnis)
offen = {}
for z in open(f'{bau}/bau.log', encoding='utf-8'):
    # Ein (Neu-)Start des Baus beendet alles, was noch offen war: abgebrochen.
    if 'Bau gestartet/fortgesetzt' in z:
        neu = t(z.split()[0])
        for schritt, start in offen.items():
            laeufe.append((schritt, start, neu, 'abgebrochen'))
        offen = {}
        continue
    m = zeile.match(z)
    if not m:
        continue
    zeit, art, schritt = t(m.group(1)), m.group(2), m.group(3)
    if art == 'START':
        offen[schritt] = zeit
    elif schritt in offen:
        laeufe.append((schritt, offen.pop(schritt), zeit, art))
jetzt = datetime.now(timezone.utc)
for schritt, start in offen.items():
    laeufe.append((schritt, start, jetzt, 'läuft'))

try:
    messung = [dict(r) | {'zeit': t(r['zeit'])} for r in csv.DictReader(open(messdatei))]
except FileNotFoundError:
    messung = []

FELDER = [('lesen_mbs', 'Lesen MB/s'), ('lesen_iops', 'Lese-IOPS'), ('schreiben_mbs', 'Schreiben MB/s'),
          ('cpu_user', 'CPU user %'), ('cpu_nice', 'CPU nice %'), ('cpu_iowait', 'iowait %'), ('ram_frei_mb', 'RAM frei MB')]


def dauer(s):
    s = int(s)
    return f'{s // 3600} h {s % 3600 // 60:02d} min' if s >= 3600 else f'{s // 60} min {s % 60:02d} s'


print(f'# Auswertung Europa-Bau ({bau})\n')
print('| Schritt | Ergebnis | Dauer | ' + ' | '.join(n for _, n in FELDER) + ' | Engpass |')
print('|---|---|---|' + '---|' * (len(FELDER) + 1))
summe = 0
for schritt, start, ende, ergebnis in laeufe:
    sek = (ende - start).total_seconds()
    summe += sek
    teil = [m for m in messung if start <= m['zeit'] <= ende]
    werte = {}
    for f, _ in FELDER:
        zahlen = [float(m[f]) for m in teil if m.get(f) not in (None, '')]
        werte[f] = sum(zahlen) / len(zahlen) if zahlen else None
    zelle = lambda f: '–' if werte[f] is None else f'{werte[f]:.0f}'
    eng = '–'
    if werte['cpu_iowait'] is not None:
        cpu = (werte['cpu_user'] or 0) + (werte['cpu_nice'] or 0)
        eng = 'Platte' if werte['cpu_iowait'] >= 30 else ('CPU' if cpu >= 70 else 'gemischt')
    print(f'| {schritt} | {ergebnis} | {dauer(sek)} | ' + ' | '.join(zelle(f) for f, _ in FELDER) + f' | {eng} |')
print(f'\nSumme aller Läufe: {dauer(summe)}')
