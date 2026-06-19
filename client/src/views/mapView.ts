import L from 'leaflet';
import { POSITION_INTERVAL_MS } from '@tq/shared/constants';
import type { MemberPublic, Position } from '@tq/shared/protocol';
import { bus, state } from '../state';
import { cycleCoordFormat, formatCoords, getCoordFormat, setCoordFormat, type CoordFormat } from '../coords';
import { connectForSession, leaveRoom, pendingOrderCount, restorePendingOrders, sendOrder, sendPosition } from '../socket';
import { startGeolocation, type GeoWatcher } from '../geo';
import { dlog, formatLog, clearLog, onLog } from '../debugLog';
import { createBaseLayers, DEFAULT_LAYER } from '../map/layers';
import { MarkerLayer } from '../map/markers';
import { OrdersLayer } from '../map/orders';
import { MissionLayer } from '../map/missionLayer';
import { PolylineSketch } from '../map/sketch';
import { HOSTILE_SIDC, symbolSvg } from '../map/symbols';
import type { MissionType } from '@tq/shared/protocol';
import { MISSION_DEFS, type MissionView } from '../orders/missions';
import {
  checkIncomingMissions,
  closeOrders,
  initOrdersPanel,
  missionAck,
  missionCancel,
  missionDone,
  pendingMissionCountForSelf,
  renderOrdersPanel,
  resetMissionNotifications,
  submitMission,
} from './ordersPanel';
import { escapeHtml, formatDistance, uid } from '../util';
import { showHome } from './home';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let map: L.Map | null = null;
let markers: MarkerLayer | null = null;
let ordersLayer: OrdersLayer | null = null;
let missionLayer: MissionLayer | null = null;
let geo: GeoWatcher | null = null;
let drawerTimer: ReturnType<typeof setInterval> | null = null;
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

  document.body.className = 'screen-map';
  $('room-code-btn').textContent = session.roomCode;

  if (!map) initLeaflet();
  // PWA iOS : le conteneur vient d'être affiché — resynchroniser la taille
  // Leaflet, sinon getCenter() (et donc les plots sous le réticule) dérive.
  requestAnimationFrame(() => map?.invalidateSize());
  markers = new MarkerLayer(map!, session.memberId, (id) => {
    if (sketch) return;
    const m = state.members.get(id);
    if (m) openMemberPopup(m);
  });
  markers.sync(state.members);
  // Réaffiche d'éventuels ordres composés hors-ligne avant la reconnexion.
  restorePendingOrders();
  ordersLayer?.sync(state.orders);
  missionLayer?.sync(state.orders);
  renderTopbar();
  renderDrawer();
  renderOrdersPanel();
  updateReadout();

  if (!busWired) {
    wireBus();
    busWired = true;
  }

  connectForSession();
  startGeo();

  // Garde à jour les libellés d'âge du tiroir (« il y a X min »), s'il est
  // ouvert — renderDrawer se court-circuite sinon. Cadencé sur les positions
  // (30 s) : pas besoin de plus fin, et c'est autant de batterie économisée.
  // Les marqueurs ne sont plus rafraîchis périodiquement : leur seul état
  // visuel (grisé = déconnecté) ne change que sur événement.
  drawerTimer ??= setInterval(renderDrawer, POSITION_INTERVAL_MS);
}

function exitToHome(message?: string): void {
  cancelSketch();
  cancelMissionPlacement();
  closeOrders();
  resetMissionNotifications();
  ordersLayer?.clear();
  missionLayer?.clear();
  geo?.stop();
  geo = null;
  if (drawerTimer) {
    clearInterval(drawerTimer);
    drawerTimer = null;
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
    attributionControl: false,
  });
  // Attribution des données (légalement requise) mais sans le préfixe « Leaflet ».
  L.control.attribution({ prefix: false }).addTo(map);
  const layers = createBaseLayers();
  layers[DEFAULT_LAYER]!.addTo(map);
  L.control.layers(layers, undefined, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  // Le mode suivi se coupe dès que l'utilisateur déplace la carte.
  map.on('dragstart', () => setFollow(false));
  map.on('move', updateReadout);
  // Un appui sur la carte referme tiroir et panneau d'ordres ouverts.
  map.on('click', () => {
    if (!$('drawer').hidden) $('drawer').hidden = true;
    if (!$('orders-panel').hidden) closeOrders();
  });
  // Rotation/redimensionnement (PWA, clavier, barre d'adresse) : resync taille.
  window.addEventListener('resize', () => map?.invalidateSize());
  window.addEventListener('orientationchange', () => setTimeout(() => map?.invalidateSize(), 200));

  const callsignOf = (id: string): string =>
    state.members.get(id)?.callsign ??
    (id === state.session?.memberId ? state.session.callsign : 'inconnu');

  ordersLayer = new OrdersLayer(map, {
    // Tous les membres ont les mêmes droits : chacun peut effacer un tracé/plot.
    canDelete: () => true,
    onDelete: (orderId) => void deleteOrder(orderId),
    authorName: callsignOf,
    isSketching: () => sketch !== null,
  });

  missionLayer = new MissionLayer(map, {
    callsign: callsignOf,
    selfId: () => state.session?.memberId ?? '',
    canCancel: (m) => state.session?.isLeader === true || m.authorId === state.session?.memberId,
    onAck: (id) => missionAck(id),
    onDone: (id) => missionDone(id),
    onCancel: (id) => missionCancel(id),
    isSketching: () => sketch !== null,
  });
}

function wireBus(): void {
  bus.on('members', () => {
    if (!markers) return;
    markers.sync(state.members);
    renderTopbar();
    renderDrawer();
    renderOrdersPanel(); // indicatifs / liste d'assignation
  });

  bus.on('position', (memberId) => {
    const m = state.members.get(memberId as string);
    if (m && markers) markers.upsert(m);
  });

  bus.on('orders', () => {
    ordersLayer?.sync(state.orders);
    missionLayer?.sync(state.orders);
    renderOrdersPanel();
    checkIncomingMissions(); // toast + vibration sur ordre reçu
    renderTopbar(); // badges (éléments en attente + ordres)
  });

  bus.on('conn', () => renderConn());

  bus.on('rejoined', () => geo?.resend());

  bus.on('session-lost', (msg) => exitToHome((msg as string) ?? 'Session expirée.'));
}

// --- géolocalisation ---
// Un point dès l'arrivée sur la carte, puis un envoi toutes les 30 s tant que
// la page est au premier plan. La géoloc écran verrouillé a été abandonnée.

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

function setActiveTool(mode: SketchMode | null): void {
  for (const m of ['measure', 'line', 'arrow'] as const) {
    $(`tool-${m}`).classList.toggle('active', m === mode);
  }
}

function startSketch(mode: SketchMode): void {
  if (!map) return;
  cancelSketch();
  sketchMode = mode;
  setFollow(false);
  setActiveTool(mode);

  const isMeasure = mode === 'measure';
  $('sketch-colors').hidden = isMeasure;
  $('sketch-ok').textContent = isMeasure ? 'Fermer' : 'Valider';
  // La barre contextuelle vient se loger à gauche du bouton de l'outil actif.
  const btn = $(`tool-${mode}`);
  const bar = $('sketchbar');
  btn.parentElement!.insertBefore(bar, btn);
  bar.hidden = false;

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
  setActiveTool(null);
}

function finishSketch(): void {
  if (!sketch) return;
  const mode = sketchMode;
  // « OK » prend la position courante du réticule comme dernier sommet.
  const points = mode === 'measure' ? [] : sketch.getFinalPoints();
  cancelSketch();

  if (mode === 'measure') return; // la mesure est purement locale
  if (points.length < 2) {
    toast('Déplacez la carte pour tracer.');
    return;
  }

  // Optimiste : l'ordre s'affiche tout de suite et se synchronise dès que
  // la liaison est rétablie (voir sendOrder / file d'attente).
  sendOrder({
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
}

function deleteOrder(orderId: string): void {
  sendOrder({
    id: uid(),
    authorId: state.session!.memberId,
    ts: Date.now(),
    kind: 'remove',
    payload: { kind: 'remove', orderId },
  });
}

// --- plot ennemi (losange rouge, accessible à tous) ---
// Un tap sur l'outil = plot immédiat sous le réticule.

function plotEniAtCenter(): void {
  if (!map || !state.session) return;
  cancelSketch(); // un plot ENI interrompt une éventuelle esquisse en cours
  const c = map.getCenter();
  sendOrder({
    id: uid(),
    authorId: state.session.memberId,
    ts: Date.now(),
    kind: 'waypoint',
    payload: { kind: 'waypoint', name: 'ENI', lat: c.lat, lng: c.lng, sidc: HOSTILE_SIDC },
  });
}

// --- placement du point d'une mission ---
// Une mission = un lieu + une action : après le choix de l'action dans le
// panneau, on choisit le point en déplaçant la carte sous le réticule.

let placing: { type: MissionType; assignee: string } | null = null;

function beginMissionPlacement(type: MissionType, assignee: string): void {
  if (!map) return;
  cancelSketch();
  closeOrders();
  setFollow(false);
  placing = { type, assignee };
  document.body.classList.add('placing');
  $('mission-placer').hidden = false;
  updatePlacerInfo();
}

function updatePlacerInfo(): void {
  if (!placing || !map) return;
  const c = map.getCenter();
  $('placer-info').textContent = `${MISSION_DEFS[placing.type].label} → ${formatCoords(c.lat, c.lng)}`;
}

function confirmMissionPlacement(): void {
  if (!placing || !map) return;
  const c = map.getCenter();
  const def = MISSION_DEFS[placing.type];
  submitMission(placing.type, placing.assignee, c.lat, c.lng);
  toast(`Ordre « ${def.short} » transmis.`);
  cancelMissionPlacement();
}

function cancelMissionPlacement(): void {
  placing = null;
  document.body.classList.remove('placing');
  $('mission-placer').hidden = true;
}

// --- coordonnées (réticule central + popups) ---

function updateReadout(): void {
  if (!map) return;
  const c = map.getCenter();
  $('coord-readout').textContent = formatCoords(c.lat, c.lng);
  if (placing) updatePlacerInfo();
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
    `<b>${escapeHtml(m.callsign)}${LEADER_TAG(m.isLeader)}</b>` +
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

const LEADER_TAG = (isLeader: boolean): string =>
  isLeader ? '<span class="leader-tag">CHEF</span>' : '';

function renderTopbar(): void {
  $('member-count').textContent = String(state.members.size);
  const pending = pendingOrderCount();
  const badge = $('pending-badge');
  badge.hidden = pending === 0;
  badge.textContent = pending > 0 ? `↑${pending}` : '';
  badge.title = pending > 0 ? `${pending} élément(s) à synchroniser` : '';

  // Badge du bouton « Ordres » : missions actives qui me sont assignées.
  const myMissions = pendingMissionCountForSelf();
  const ob = $('orders-badge');
  ob.hidden = myMissions === 0;
  ob.textContent = String(myMissions);

  renderConn();
}

/** Centre la carte sur une mission (depuis la timeline). */
function focusMission(m: MissionView): void {
  setFollow(false);
  map?.setView([m.lat, m.lng], Math.max(map.getZoom(), 15));
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
      `<span class="m-callsign">${escapeHtml(m.callsign)}${LEADER_TAG(m.isLeader)}</span>` +
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
  // Panneau latéral des ordres (composer + timeline).
  initOrdersPanel({
    beginPlacement: beginMissionPlacement,
    focusMission,
    notify: (text) => toast(text),
  });
  $('placer-ok').addEventListener('click', confirmMissionPlacement);
  $('placer-cancel').addEventListener('click', cancelMissionPlacement);

  for (const mode of ['measure', 'line', 'arrow'] as const) {
    $(`tool-${mode}`).addEventListener('click', () => {
      // Re-choisir l'outil actif annule l'esquisse en cours.
      if (sketch && sketchMode === mode) cancelSketch();
      else startSketch(mode);
    });
  }
  $('tool-eni').addEventListener('click', () => plotEniAtCenter());
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

  // --- panneau de diagnostic veille (masqué — conservé pour un usage ultérieur) ---
  let diagUnsub: (() => void) | null = null;
  const renderDiag = (): void => {
    const pre = $('diag-log');
    pre.textContent = formatLog() || '(journal vide — verrouille puis déverrouille)';
    pre.scrollTop = pre.scrollHeight;
  };
  $('btn-diag').addEventListener('click', () => {
    $('drawer').hidden = true;
    $('diag-overlay').hidden = false;
    renderDiag();
    diagUnsub = onLog(renderDiag); // mise à jour en direct tant que le panneau est ouvert
  });
  const closeDiag = (): void => {
    $('diag-overlay').hidden = true;
    diagUnsub?.();
    diagUnsub = null;
  };
  $('diag-close').addEventListener('click', closeDiag);
  $('diag-clear').addEventListener('click', () => {
    clearLog();
    dlog('diag', 'journal vidé');
  });
  $('diag-copy').addEventListener('click', () => {
    const txt = formatLog();
    void navigator.clipboard?.writeText(txt).then(
      () => toast('Journal copié'),
      () => toast('Copie impossible — sélectionne le texte à la main'),
    );
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
