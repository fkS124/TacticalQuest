import L from 'leaflet';
import type { MemberPublic, Position } from '@tq/shared/protocol';
import { bus, state } from '../state';
import { cycleCoordFormat, formatCoords, getCoordFormat, setCoordFormat, type CoordFormat } from '../coords';
import { connectForSession, leaveRoom, sendOrder, sendPosition } from '../socket';
import { startGeolocation, type GeoWatcher } from '../geo';
import { createBaseLayers } from '../map/layers';
import { MarkerLayer } from '../map/markers';
import { OrdersLayer } from '../map/orders';
import { PolylineSketch } from '../map/sketch';
import { HOSTILE_SIDC, symbolSvg } from '../map/symbols';
import { escapeHtml, formatDistance, uid } from '../util';
import { showHome } from './home';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let map: L.Map | null = null;
let markers: MarkerLayer | null = null;
let ordersLayer: OrdersLayer | null = null;
let geo: GeoWatcher | null = null;
let staleTimer: ReturnType<typeof setInterval> | null = null;
let follow = true;
let hasCentered = false;
let busWired = false;

type SketchMode = 'measure' | 'line' | 'arrow';
let sketch: PolylineSketch | null = null;
let sketchMode: SketchMode = 'measure';
let sketchColor = '#e8d44d';

export function enterMap(): void {
  const session = state.session;
  if (!session) return showHome();

  document.body.className = session.isLeader ? 'screen-map is-leader' : 'screen-map';
  $('room-code-btn').textContent = session.roomCode;

  if (!map) initLeaflet();
  markers = new MarkerLayer(map!, session.memberId, (id) => {
    if (sketch) return;
    const m = state.members.get(id);
    if (m) openMemberPopup(m);
  });
  markers.sync(state.members);
  ordersLayer?.sync(state.orders);
  renderTopbar();
  renderDrawer();
  updateReadout();

  if (!busWired) {
    wireBus();
    busWired = true;
  }

  connectForSession();
  startGeo();
  void acquireWakeLock();

  staleTimer ??= setInterval(() => {
    markers?.refresh(state.members);
    renderDrawer();
  }, 5_000);
}

function exitToHome(message?: string): void {
  cancelSketch();
  releaseWakeLock();
  ordersLayer?.clear();
  geo?.stop();
  geo = null;
  if (staleTimer) {
    clearInterval(staleTimer);
    staleTimer = null;
  }
  markers?.clear();
  markers = null;
  hasCentered = false;
  follow = true;
  showHome(message);
}

function initLeaflet(): void {
  map = L.map('map', {
    center: [46.5, 2.5], // France, en attendant le premier fix
    zoom: 6,
    zoomControl: true,
  });
  const layers = createBaseLayers();
  layers['Topographique (OpenTopoMap)']!.addTo(map);
  L.control.layers(layers, undefined, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  // Le mode suivi se coupe dès que l'utilisateur déplace la carte.
  map.on('dragstart', () => setFollow(false));
  map.on('move', updateReadout);

  ordersLayer = new OrdersLayer(map, {
    canDelete: (authorId) => state.session?.isLeader === true || authorId === state.session?.memberId,
    onDelete: (orderId) => void deleteOrder(orderId),
    authorName: (authorId) =>
      state.members.get(authorId)?.callsign ??
      (authorId === state.session?.memberId ? state.session.callsign : 'inconnu'),
    isSketching: () => sketch !== null,
  });
}

function wireBus(): void {
  bus.on('members', () => {
    if (!markers) return;
    markers.sync(state.members);
    renderTopbar();
    renderDrawer();
  });

  bus.on('position', (memberId) => {
    const m = state.members.get(memberId as string);
    if (m && markers) markers.upsert(m);
  });

  bus.on('orders', () => ordersLayer?.sync(state.orders));

  bus.on('conn', () => renderConn());

  bus.on('rejoined', () => geo?.resend());

  bus.on('session-lost', (msg) => exitToHome((msg as string) ?? 'Session expirée.'));
}

// --- wake lock : empêcher la mise en veille tant que la carte est ouverte ---
// Une PWA ne reçoit pas le GPS écran éteint (iOS comme Android) : garder
// l'écran allumé est le seul levier disponible côté web.

let wakeLock: WakeLockSentinel | null = null;

async function acquireWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    // Refusé (économie d'énergie, batterie faible…) : on vit sans.
  }
}

function releaseWakeLock(): void {
  void wakeLock?.release();
  wakeLock = null;
}

// --- géolocalisation ---

function startGeo(): void {
  geo?.stop();
  geo = startGeolocation({
    send: (p) => sendPosition(p),
    onFix: (p) => onOwnFix(p),
    onDenied: () => {
      $('geo-overlay').hidden = false;
    },
  });
  if (!geo) $('geo-overlay').hidden = false;
}

function onOwnFix(p: Position): void {
  const session = state.session;
  if (!session) return;
  // Le serveur n'écho pas nos propres positions : mise à jour locale.
  let me = state.members.get(session.memberId);
  if (!me) {
    me = {
      id: session.memberId,
      callsign: session.callsign,
      sidc: session.sidc,
      isLeader: session.isLeader,
      connected: true,
      lastSeen: Date.now(),
      lastPosition: p,
    };
    state.members.set(me.id, me);
  } else {
    me.lastPosition = p;
    me.lastSeen = Date.now();
  }
  markers?.upsert(me);
  if (follow || !hasCentered) {
    map?.setView([p.lat, p.lng], hasCentered ? map.getZoom() : 15);
    hasCentered = true;
  }
}

function setFollow(v: boolean): void {
  follow = v;
  $('btn-locate').classList.toggle('active', v);
}

// --- mesure et tracés (liserés / flèches) ---

function startSketch(mode: SketchMode): void {
  if (!map) return;
  cancelSketch();
  sketchMode = mode;
  setFollow(false);

  const isMeasure = mode === 'measure';
  $('sketch-colors').hidden = isMeasure;
  $('sketch-ok').textContent = isMeasure ? 'Fermer' : 'OK';
  $('sketchbar').hidden = false;
  $(`tool-${mode}`).classList.add('active');

  sketch = new PolylineSketch(map, {
    color: isMeasure ? '#d9a13b' : sketchColor,
    onChange: (_points, previewM) => {
      $('sketch-info').textContent = formatDistance(previewM);
    },
  });
  // Origine sous le réticule : déplacer la carte étire l'aperçu.
  sketch.addVertexAtCenter();
}

function cancelSketch(): void {
  sketch?.destroy();
  sketch = null;
  $('sketchbar').hidden = true;
  document.querySelectorAll('.tool-btn').forEach((el) => el.classList.remove('active'));
}

async function finishSketch(): Promise<void> {
  if (!sketch) return;
  const mode = sketchMode;
  // « OK » prend la position courante du réticule comme dernier sommet.
  const points = mode === 'measure' ? [] : sketch.getFinalPoints();
  cancelSketch();

  if (mode === 'measure') return; // la mesure est purement locale
  if (points.length < 2) return toast('Déplacez la carte pour tracer.');

  const ok = await sendOrder({
    id: uid(),
    authorId: state.session!.memberId,
    ts: Date.now(),
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      geojson: {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: points.map((p) => [p.lng, p.lat]),
        },
      },
      style: { color: sketchColor, weight: 4, arrow: mode === 'arrow' },
    },
  });
  if (!ok) toast('Échec de l’envoi du tracé. Vérifiez la connexion.');
}

async function deleteOrder(orderId: string): Promise<void> {
  const ok = await sendOrder({
    id: uid(),
    authorId: state.session!.memberId,
    ts: Date.now(),
    kind: 'remove',
    payload: { kind: 'remove', orderId },
  });
  if (!ok) toast('Échec de la suppression. Vérifiez la connexion.');
}

// --- plot ennemi (losange rouge, accessible à tous) ---
// Un tap sur l'outil = plot immédiat sous le réticule.

async function plotEniAtCenter(): Promise<void> {
  if (!map || !state.session) return;
  const c = map.getCenter();
  const ok = await sendOrder({
    id: uid(),
    authorId: state.session.memberId,
    ts: Date.now(),
    kind: 'waypoint',
    payload: { kind: 'waypoint', name: 'ENI', lat: c.lat, lng: c.lng, sidc: HOSTILE_SIDC },
  });
  if (!ok) toast('Échec de l’envoi du plot. Vérifiez la connexion.');
}

// --- coordonnées (réticule central + popups) ---

function updateReadout(): void {
  if (!map) return;
  const c = map.getCenter();
  $('coord-readout').textContent = formatCoords(c.lat, c.lng);
}

function renderCoordFormat(): void {
  const fmt = getCoordFormat();
  document.querySelectorAll<HTMLButtonElement>('#coord-format button').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.fmt === fmt);
  });
}

function openMemberPopup(m: MemberPublic): void {
  if (!map || !m.lastPosition) return;
  const p = m.lastPosition;
  const div = document.createElement('div');
  div.className = 'order-popup';
  div.innerHTML =
    `<b>${escapeHtml(m.callsign)}${m.isLeader ? ' ★' : ''}</b>` +
    `<span class="coords">${formatCoords(p.lat, p.lng)}</span>` +
    `<span class="order-author">±${Math.round(p.accuracy)} m · ${memberMeta(m, Date.now())}</span>`;
  L.popup({ className: 'tq-popup' }).setLatLng([p.lat, p.lng]).setContent(div).openOn(map);
}

// --- rendu UI ---

function renderConn(): void {
  const dot = $('conn-dot');
  dot.className = `conn-${state.conn}`;
  dot.title =
    state.conn === 'connected' ? 'Connecté'
    : state.conn === 'reconnecting' ? 'Reconnexion…'
    : 'Hors ligne';
}

function renderTopbar(): void {
  $('member-count').textContent = String(state.members.size);
  renderConn();
}

function renderDrawer(): void {
  const drawer = $('drawer');
  if (drawer.hidden) return;
  const list = $('member-list');
  list.innerHTML = '';
  const now = Date.now();
  const sorted = [...state.members.values()].sort((a, b) =>
    a.isLeader !== b.isLeader ? (a.isLeader ? -1 : 1) : a.callsign.localeCompare(b.callsign),
  );
  for (const m of sorted) {
    const li = document.createElement('li');
    if (!m.connected) li.classList.add('offline');
    const meta = memberMeta(m, now);
    li.innerHTML =
      `<span class="m-symbol">${symbolSvg(m.sidc, 18)}</span>` +
      `<span class="m-callsign">${escapeHtml(m.callsign)}${m.isLeader ? ' ★' : ''}</span>` +
      `<span class="m-meta">${meta}</span>`;
    if (m.lastPosition) {
      const btn = document.createElement('button');
      btn.className = 'btn m-center';
      btn.textContent = 'Centrer';
      btn.addEventListener('click', () => {
        setFollow(false);
        map?.setView([m.lastPosition!.lat, m.lastPosition!.lng], Math.max(map.getZoom(), 14));
        drawer.hidden = true;
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

function memberMeta(m: MemberPublic, now: number): string {
  if (!m.connected) return 'déconnecté';
  if (!m.lastPosition) return 'pas de position';
  const s = Math.floor((now - Math.max(m.lastPosition.ts, m.lastSeen)) / 1000);
  if (s < 15) return 'à jour';
  if (s < 60) return `il y a ${s} s`;
  return `il y a ${Math.floor(s / 60)} min`;
}

export function initMapView(): void {
  for (const mode of ['measure', 'line', 'arrow'] as const) {
    $(`tool-${mode}`).addEventListener('click', () => {
      // Re-taper sur l'outil actif annule l'esquisse en cours.
      if (sketch && sketchMode === mode) cancelSketch();
      else startSketch(mode);
    });
  }
  $('tool-eni').addEventListener('click', () => void plotEniAtCenter());
  $('sketch-add').addEventListener('click', () => sketch?.addVertexAtCenter());

  // Format de coordonnées : tap sur l'affichage = cycle, tiroir = choix direct.
  $('coord-readout').addEventListener('click', cycleCoordFormat);
  document.querySelectorAll<HTMLButtonElement>('#coord-format button').forEach((btn) => {
    btn.addEventListener('click', () => setCoordFormat(btn.dataset.fmt as CoordFormat));
  });
  renderCoordFormat();
  bus.on('coordfmt', () => {
    updateReadout();
    renderCoordFormat();
  });

  // Le wake lock est libéré par l'OS au passage en arrière-plan :
  // le re-demander au retour au premier plan.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.session) {
      void acquireWakeLock();
    }
  });
  $('sketch-ok').addEventListener('click', () => void finishSketch());
  $('sketch-cancel').addEventListener('click', cancelSketch);
  $('sketch-undo').addEventListener('click', () => sketch?.undo());
  document.querySelectorAll<HTMLButtonElement>('.color-dot').forEach((dot, i) => {
    if (i === 0) dot.classList.add('selected');
    dot.addEventListener('click', () => {
      sketchColor = dot.dataset.color!;
      document.querySelectorAll('.color-dot').forEach((el) => el.classList.remove('selected'));
      dot.classList.add('selected');
      sketch?.setColor(sketchColor);
    });
  });

  $('btn-locate').addEventListener('click', () => {
    setFollow(true);
    const fix = geo?.getLastFix();
    if (fix) map?.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 15));
  });

  $('btn-members').addEventListener('click', () => {
    const drawer = $('drawer');
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) renderDrawer();
  });

  $('btn-leave').addEventListener('click', () => {
    if (!confirm('Quitter la salle ?')) return;
    leaveRoom();
    exitToHome();
  });

  $('room-code-btn').addEventListener('click', async () => {
    const code = state.session?.roomCode;
    if (!code) return;
    const text = `Rejoignez ma salle TacticalQuest : ${code} — ${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(code);
        toast('Code copié.');
      }
    } catch {
      /* partage annulé */
    }
  });

  $('btn-geo-retry').addEventListener('click', () => {
    $('geo-overlay').hidden = true;
    startGeo();
  });
  $('btn-geo-dismiss').addEventListener('click', () => {
    $('geo-overlay').hidden = true;
  });
}

export function toast(text: string, action?: { label: string; onClick: () => void }): void {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.onClick;
  }
  el.hidden = false;
  if (!action) setTimeout(() => (el.hidden = true), 4_000);
}
