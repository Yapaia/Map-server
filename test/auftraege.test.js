import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auftraege } from '../src/auftraege.js';
import { Zustand } from '../src/zustand.js';
import { fakeGeofabrik, tempKonfig } from './helfer.js';

function aufbau(bauen) {
  const t = tempKonfig();
  const zustand = new Zustand(t.konfig.pfade.zustand);
  zustand.pakete.a = { id: 'a', name: 'A', regionen: ['liechtenstein'], status: 'neu' };
  zustand.pakete.b = { id: 'b', name: 'B', regionen: ['austria'], status: 'neu' };
  const auftraege = new Auftraege({ konfig: t.konfig, zustand, geofabrik: fakeGeofabrik(), bauen });
  return { ...t, zustand, auftraege };
}

test('baut nacheinander, nie zwei gleichzeitig; Protokoll zum Mitlesen', async () => {
  let gleichzeitig = 0;
  let hoechstens = 0;
  const a = aufbau(async ({ paket, schritt, protokoll }) => {
    gleichzeitig++;
    hoechstens = Math.max(hoechstens, gleichzeitig);
    schritt('Karte bauen');
    protokoll(`baue ${paket.id}`);
    await new Promise((r) => setTimeout(r, 30));
    gleichzeitig--;
    return { id: paket.id, artefakte: {} };
  });
  try {
    const x = a.auftraege.einreihen('a');
    const y = a.auftraege.einreihen('b');
    assert.throws(() => a.auftraege.einreihen('a'), /schon ein Auftrag/);
    assert.equal(a.zustand.pakete.b.status, 'wartet');
    await a.auftraege.fertig;
    assert.equal(hoechstens, 1);
    assert.equal(x.status, 'fertig');
    assert.equal(y.status, 'fertig');
    assert.equal(a.zustand.pakete.a.status, 'fertig');
    assert.deepEqual(a.zustand.pakete.a.manifest, { id: 'a', artefakte: {} });
    const p = a.auftraege.protokoll(x.id);
    assert.match(p.text, /== Karte bauen ==/);
    assert.match(p.text, /baue a/);
    assert.equal(a.auftraege.protokoll(x.id, p.bis).text, '');
    assert.deepEqual(a.auftraege.liste().map((z) => z.id), [y.id, x.id]);
  } finally {
    a.aufraeumen();
  }
});

test('abbrechen: wartend sofort, laufend über das Signal; Fehler landen beim Paket', async () => {
  const a = aufbau(async ({ paket, signal }) => {
    if (paket.id === 'b') throw new Error('kaputt');
    await new Promise((_, nein) => signal.addEventListener('abort', () => nein(new Error('abgebrochen'))));
  });
  try {
    const x = a.auftraege.einreihen('a');
    const y = a.auftraege.einreihen('b');
    a.auftraege.abbrechen(y.id);
    assert.equal(y.status, 'abgebrochen');
    assert.equal(a.zustand.pakete.b.status, 'neu');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(x.status, 'laeuft');
    a.auftraege.abbrechen(x.id);
    await a.auftraege.fertig;
    assert.equal(x.status, 'abgebrochen');
    assert.equal(a.zustand.pakete.a.status, 'neu');

    const z = a.auftraege.einreihen('b');
    await a.auftraege.fertig;
    assert.equal(z.status, 'fehler');
    assert.equal(a.zustand.pakete.b.fehler, 'kaputt');
    assert.throws(() => a.auftraege.abbrechen(z.id), /läuft nicht mehr/);
  } finally {
    a.aufraeumen();
  }
});

test('nach einem Neustart gilt Laufendes als abgebrochen', () => {
  const a = aufbau(async () => ({}));
  try {
    a.zustand.auftraege.push({ id: 'x', paket: 'a', status: 'laeuft' });
    a.zustand.pakete.a.status = 'baut';
    a.zustand.speichern();
    const neu = new Zustand(a.konfig.pfade.zustand);
    new Auftraege({ konfig: a.konfig, zustand: neu, geofabrik: fakeGeofabrik() });
    assert.equal(neu.auftraege[0].status, 'abgebrochen');
    assert.equal(neu.pakete.a.status, 'neu');
  } finally {
    a.aufraeumen();
  }
});
