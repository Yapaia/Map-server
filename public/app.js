// Yapaia Kartenserver – Oberfläche (ohne Rahmenwerk, damit nichts zu bauen ist)

const $ = (s) => document.querySelector(s);
const MB = 1024 ** 2;
const GB = 1024 ** 3;

function groesse(bytes) {
  if (bytes == null) return '?';
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / MB))} MB`;
}

function zeit(iso) {
  return iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '';
}

function el(tag, attr = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kinder.flat()) if (k != null) e.append(k);
  return e;
}

async function api(pfad, optionen = {}) {
  const r = await fetch(pfad, {
    ...optionen,
    headers: { 'Content-Type': 'application/json', ...(optionen.headers || {}) },
  });
  const daten = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(daten.fehler || `HTTP ${r.status}`);
  return daten;
}

const STATUS = { neu: 'noch nicht gebaut', wartet: 'wartet', baut: 'wird gebaut', fertig: 'fertig', fehler: 'Fehler', prueft: 'wird geprüft' };

// ─── Pakete ────────────────────────────────────────────────────────────────
let katalog = [];
const namen = (id) => katalog.find((k) => k.id === id)?.name ?? id;

let pruefend = false;

async function paketeZeigen() {
  const pakete = await api('/api/pakete');
  pruefend = pakete.some((p) => p.status === 'prueft');
  const ziel = $('#pakete');
  ziel.replaceChildren();
  if (!pakete.length) {
    ziel.append(el('p', { class: 'leise' }, 'Noch kein Paket – unten eines anlegen.'));
    return;
  }
  for (const p of pakete) {
    const m = p.manifest;
    const teile = m ? Object.entries(m.artefakte).map(([t, a]) => `${{ karte: 'Karte', suche: 'Suche', routing: 'Routing' }[t]} ${groesse(a.bytes)}`).join(' · ') : '';
    ziel.append(
      el(
        'div',
        { class: 'karte' },
        el('strong', {}, p.name),
        ' ',
        el('span', { class: p.status === 'fehler' ? 'fehler' : p.status === 'fertig' ? 'gut' : 'leise' }, `(${STATUS[p.status] ?? p.status})`),
        el('div', { class: 'leise' }, p.regionen.map(namen).join(', ')),
        m ? el('div', { class: 'leise' }, `${p.vorgebaut ? 'Vorgebaut' : 'Gebaut'} ${zeit(m.gebaut)} – ${teile}`) : null,
        p.fehler && (p.status === 'fehler' || p.vorgebaut) ? el('div', { class: 'fehler' }, p.fehler) : null,
        el(
          'div',
          { class: 'knoepfe' },
          p.vorgebaut ? null : el('button', { onclick: () => bauen(p.id, false), disabled: p.status === 'baut' || p.status === 'wartet' }, m ? 'Neu bauen' : 'Bauen'),
          m && !p.vorgebaut ? el('button', { class: 'zweit', onclick: () => bauen(p.id, true), disabled: p.status === 'baut' || p.status === 'wartet' }, 'Mit neuen Daten bauen') : null,
          el('button', { class: 'zweit', onclick: () => loeschen(p), disabled: p.status === 'prueft' }, 'Löschen'),
        ),
      ),
    );
  }
}

async function bauen(id, aktualisieren) {
  try {
    await api(`/api/pakete/${encodeURIComponent(id)}/bauen`, { method: 'POST', body: JSON.stringify({ aktualisieren }) });
    await allesZeigen();
  } catch (err) {
    alert(err.message);
  }
}

async function loeschen(p) {
  if (!confirm(`Paket „${p.name}" mit allen gebauten Dateien löschen?`)) return;
  try {
    await api(`/api/pakete/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    await allesZeigen();
  } catch (err) {
    alert(err.message);
  }
}

// ─── Neues Paket ───────────────────────────────────────────────────────────
const gewaehlt = new Set();

function trefferZeigen() {
  const q = $('#neu-suche').value.trim().toLowerCase();
  const liste = $('#treffer');
  liste.replaceChildren();
  if (q.length < 2) return;
  const treffer = katalog.filter((k) => k.name.toLowerCase().includes(q) || k.id.includes(q)).slice(0, 30);
  for (const k of treffer) {
    const eltern = k.eltern ? ` – ${namen(k.eltern)}` : '';
    liste.append(
      el('li', { tabindex: 0, onclick: () => waehlen(k.id), onkeydown: (e) => e.key === 'Enter' && waehlen(k.id) }, `${k.name}${eltern}`),
    );
  }
}

function waehlen(id) {
  gewaehlt.add(id);
  $('#neu-suche').value = '';
  $('#treffer').replaceChildren();
  gewaehltZeigen();
}

let schaetzungNr = 0;
async function gewaehltZeigen() {
  const ziel = $('#gewaehlt');
  ziel.replaceChildren(
    ...[...gewaehlt].map((id) =>
      el('span', { class: 'chip' }, namen(id), el('button', { type: 'button', 'aria-label': 'entfernen', onclick: () => { gewaehlt.delete(id); gewaehltZeigen(); } }, '×')),
    ),
  );
  const nr = ++schaetzungNr;
  $('#schaetzung').textContent = gewaehlt.size ? 'Größe wird ermittelt …' : '';
  if (!gewaehlt.size) return;
  try {
    const s = await api(`/api/katalog/groesse?ids=${[...gewaehlt].map(encodeURIComponent).join(',')}`);
    if (nr !== schaetzungNr) return;
    let text = `Rohdaten zusammen ${groesse(s.summe)}, beim Bau grob ${groesse(s.platzBedarf)} freier Platz nötig.`;
    if (s.summe > 4 * GB) text += ' Achtung: bei mehr als ~4 GB Rohdaten reichen 8 GB RAM für das Routing womöglich nicht.';
    $('#schaetzung').textContent = text;
  } catch {
    $('#schaetzung').textContent = '';
  }
}

$('#neu-suche').addEventListener('input', trefferZeigen);
$('#neu').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#neu-fehler').textContent = '';
  const teile = [...document.querySelectorAll('input[name=teil]:checked')].map((i) => i.value);
  try {
    await api('/api/pakete', { method: 'POST', body: JSON.stringify({ name: $('#neu-name').value, regionen: [...gewaehlt], teile }) });
    $('#neu-name').value = '';
    gewaehlt.clear();
    gewaehltZeigen();
    await allesZeigen();
  } catch (err) {
    $('#neu-fehler').textContent = err.message;
  }
});

// ─── Extrakte, Aufträge, Status ────────────────────────────────────────────
async function vorgebautZeigen() {
  const liste = await api('/api/vorgebaut');
  const ziel = $('#vorgebaut');
  ziel.replaceChildren();
  if (!liste.length) return ziel.append(el('p', { class: 'leise' }, 'Nichts im Import-Ordner.'));
  for (const v of liste) {
    const teile = Object.entries(v.artefakte).map(([t, a]) => `${{ karte: 'Karte', suche: 'Suche', routing: 'Routing' }[t] ?? t} ${groesse(a.bytes)}`).join(' · ');
    ziel.append(
      el(
        'div',
        { class: 'karte' },
        el('strong', {}, v.name),
        ` (${v.id})`,
        el('div', { class: 'leise' }, teile),
        v.fehler ? el('div', { class: 'fehler' }, v.fehler) : null,
        el('div', { class: 'knoepfe' }, el('button', { onclick: () => uebernehmen(v.id), disabled: !!v.fehler }, 'Prüfen und übernehmen')),
      ),
    );
  }
}

async function uebernehmen(id) {
  try {
    await api(`/api/vorgebaut/${encodeURIComponent(id)}`, { method: 'POST' });
    await allesZeigen();
  } catch (err) {
    alert(err.message);
  }
}

async function extrakteZeigen() {
  const liste = await api('/api/extrakte');
  const ziel = $('#extrakte');
  ziel.replaceChildren();
  if (!liste.length) return ziel.append(el('p', { class: 'leise' }, 'Noch nichts geladen.'));
  ziel.append(
    el(
      'table',
      {},
      el('tr', {}, el('th', {}, 'Region'), el('th', {}, 'Größe'), el('th', {}, 'Stand'), el('th', {})),
      liste.map((x) =>
        el(
          'tr',
          {},
          el('td', {}, x.name || x.id),
          el('td', {}, groesse(x.bytes)),
          el('td', {}, x.stand ? new Date(x.stand).toLocaleDateString('de-DE') : ''),
          el('td', {}, el('button', { class: 'klein zweit', onclick: () => extraktLoeschen(x.id) }, 'Löschen')),
        ),
      ),
    ),
  );
}

async function extraktLoeschen(id) {
  try {
    await api(`/api/extrakte/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await extrakteZeigen();
  } catch (err) {
    alert(err.message);
  }
}

async function auftraegeZeigen() {
  const liste = await api('/api/auftraege');
  const ziel = $('#auftraege');
  ziel.replaceChildren();
  if (!liste.length) return ziel.append(el('p', { class: 'leise' }, 'Noch keine.'));
  ziel.append(
    el(
      'table',
      {},
      liste.slice(0, 20).map((a) =>
        el(
          'tr',
          {},
          el('td', {}, zeit(a.erstellt)),
          el('td', {}, a.paket),
          el('td', { class: a.status === 'fehler' ? 'fehler' : a.status === 'fertig' ? 'gut' : '' }, a.status === 'fehler' ? `Fehler: ${a.fehler}` : a.status),
          el('td', {}, el('button', { class: 'klein zweit', onclick: () => protokollOeffnen(a) }, 'Protokoll')),
        ),
      ),
    ),
  );
}

let mitlesen = { id: null, ab: 0 };
async function protokollOeffnen(a) {
  mitlesen = { id: a.id, ab: 0 };
  $('#protokoll').textContent = '';
  $('#laufend-bereich').hidden = false;
  $('#laufend-titel').textContent = a.paket;
  $('#laufend-schritt').textContent = a.status === 'laeuft' ? (a.schritt ?? '') : a.status;
  $('#laufend-abbrechen').hidden = a.status !== 'laeuft' && a.status !== 'wartet';
  await protokollNachladen();
}

async function protokollNachladen() {
  if (!mitlesen.id) return;
  const { text, bis } = await api(`/api/auftraege/${mitlesen.id}/protokoll?ab=${mitlesen.ab}`);
  if (text) {
    const pre = $('#protokoll');
    const unten = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent += text;
    if (unten) pre.scrollTop = pre.scrollHeight;
  }
  mitlesen.ab = bis;
}

$('#laufend-abbrechen').addEventListener('click', async () => {
  if (!mitlesen.id || !confirm('Den Bau abbrechen?')) return;
  try {
    await api(`/api/auftraege/${mitlesen.id}/abbrechen`, { method: 'POST' });
  } catch (err) {
    alert(err.message);
  }
});

let tokenText = '';
$('#token-zeigen').addEventListener('click', () => {
  $('#token').textContent = tokenText;
});

let letzterLaufend = null;
async function statusZeigen() {
  const s = await api('/api/status');
  tokenText = s.token;
  if (!$('#token').textContent) $('#token').textContent = '••••••••';
  $('#katalog-url').textContent = s.katalogUrl;
  const sy = s.system;
  $('#system').textContent =
    `Speicher frei: ${groesse(sy.platteFrei)} von ${groesse(sy.platteGesamt)} · RAM frei: ${groesse(sy.ramFrei)} von ${groesse(sy.ramGesamt)}`;
  if (s.laufend) {
    if (mitlesen.id !== s.laufend.id) await protokollOeffnen(s.laufend);
    $('#laufend-schritt').textContent = s.laufend.schritt ?? '';
    $('#laufend-abbrechen').hidden = false;
  } else if (letzterLaufend) {
    $('#laufend-abbrechen').hidden = true;
    $('#laufend-schritt').textContent = 'beendet';
  }
  const wechsel = (letzterLaufend?.id ?? null) !== (s.laufend?.id ?? null);
  letzterLaufend = s.laufend;
  return wechsel;
}

async function allesZeigen() {
  await Promise.all([statusZeigen(), paketeZeigen(), vorgebautZeigen(), extrakteZeigen(), auftraegeZeigen()]);
}

async function start() {
  try {
    katalog = await api('/api/katalog');
  } catch (err) {
    $('#neu-fehler').textContent = err.message;
  }
  await allesZeigen();
  setInterval(async () => {
    try {
      const wechsel = await statusZeigen();
      await protokollNachladen();
      if (wechsel || letzterLaufend || pruefend) await Promise.all([paketeZeigen(), vorgebautZeigen(), auftraegeZeigen(), extrakteZeigen()]);
    } catch {
      // Server kurz weg -- beim nächsten Takt wieder
    }
  }, 3000);
}

start();
