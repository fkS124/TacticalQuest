import L from 'leaflet';
import '../map/rotate'; // expose `L` au global (doit précéder leaflet-rotate)
import 'leaflet-rotate'; // patche L.Map avec setBearing()
import { startCompass, type CompassStop } from '../map/compass';
import { POSITION_INTERVAL_MS } from '@tq/shared/constants';
import type { GraphicStyle, LineEchelon, MemberPublic, Position } from '@tq/shared/protocol';
import { bus, state } from '../state';
import { cycleCoordFormat, formatCoords, getCoordFormat, parseCoords, setCoordFormat, type CoordFormat } from '../coords';
import { cachedElevation, coordsWithAltitudeHtml, elevationKey, fetchElevation, hydrateAltitudes } from '../elevation';
import { connectForSession, leaveRoom, pendingOrderCount, restorePendingOrders, sendOrder, sendPosition } from '../socket';
import { startGeolocation, type GeoWatcher } from '../geo';
import { dlog, formatLog, clearLog, onLog } from '../debugLog';
import { createBaseLayers, DEFAULT_LAYER } from '../map/layers';
import { MarkerLayer } from '../map/markers';
import { OrdersLayer } from '../map/orders';
import { PolylineSketch } from '../map/sketch';
import { HOSTILE_SIDC, symbolSvg } from '../map/symbols';
import {
  checkIncomingMessages,
  closeComms,
  initCommsPanel,
  renderComms,
  resetCommsNotifications,
  unreadCommsCount,
} from './commsPanel';
import { escapeHtml, formatDistance, uid } from '../util';
import { showHome } from './home';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let map: L.Map | null = null;
let markers: MarkerLayer | null = null;
let ordersLayer: OrdersLayer | null = null;
let geo: GeoWatcher | null = null;
let drawerTimer: ReturnType<typeof setInterval> | null = null;
let follow = true;
let hasCentered = false;
let busWired = false;
// Boussole : si actif, fonction d'arrêt de l'écoute ; bearing courant appliqué.
let compassStop: CompassStop | null = null;
let compassBearing = 0;

// 'arrow' reste un mode valide (retiré de l'affichage, voir index.html) ;
// les outils réellement présentés sont listés dans DISPLAYED_TOOLS.
type SketchMode = 'measure' | 'line' | 'arrow' | 'polygon';
const DISPLAYED_TOOLS = ['measure', 'line', 'polygon'] as const;
let sketch: PolylineSketch | null = null;
let sketchMode: SketchMode = 'measure';
let sketchColor = '#e8d44d';
// Tracé d'un liseré figé, en attente de finalisation par le menu contextuel.
let pendingLine: L.LatLng[] | null = null;
let pendingEchelon: LineEchelon | '' = '';
// Box (polygone) figée, en attente de nom.
let pendingBox: L.LatLng[] | null = null;
// Point nommé (rond de couleur) en attente de nom/couleur.
let pendingPoint: L.LatLng | null = null;
let pointColor = '#e8d44d';
// Plot ENI (losange rouge) en attente de texte.
let pendingEni: L.LatLng | null = null;

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
  renderTopbar();
  renderDrawer();
  renderComms();
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

// --- boussole : carte « cap en haut » (mobile) ---

async function toggleCompass(): Promise<void> {
  if (compassStop) {
    stopCompass();
    return;
  }
  if (!map || typeof map.setBearing !== 'function') {
    toast('Rotation de carte non supportée sur cet appareil.');
    return;
  }
  const stop = await startCompass(applyHeading);
  if (!stop) {
    toast('Boussole indisponible sur cet appareil.');
    return;
  }
  compassStop = stop;
  $('tool-compass').classList.add('active');
  setFollow(true); // cap en haut : on recadre sur la position
}

function stopCompass(): void {
  compassStop?.();
  compassStop = null;
  $('tool-compass').classList.remove('active');
  compassBearing = 0;
  map?.setBearing(0);
}

/** Cap boussole → rotation carte (cap en haut). Seuil pour éviter de tourner à
 *  la cadence du capteur (~60 Hz) ; on ignore les variations < 1,5°. */
function applyHeading(heading: number): void {
  if (!map || !compassStop) return;
  const target = -heading;
  const delta = (((target - compassBearing) % 360) + 540) % 360 - 180;
  if (Math.abs(delta) < 1.5) return;
  compassBearing = target;
  map.setBearing(target);
}

function exitToHome(message?: string): void {
  stopCompass();
  cancelSketch();
  closeComms();
  resetCommsNotifications();
  ordersLayer?.clear();
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
    rotate: true, // active la rotation (boussole) ; bearing 0 = nord en haut
    rotateControl: false, // on fournit notre propre bouton
    touchRotate: false,
    shiftKeyRotate: false,
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
  // Un appui sur la carte referme tiroir et panneau Comms ouverts.
  map.on('click', () => {
    if (!$('drawer').hidden) $('drawer').hidden = true;
    if (!$('comms-panel').hidden) closeComms();
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

  bus.on('orders', () => {
    ordersLayer?.sync(state.orders);
    renderComms();
    checkIncomingMessages(); // toast + vibration sur message reçu
    renderTopbar(); // badges (éléments en attente + non-lus Comms)
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
  for (const m of DISPLAYED_TOOLS) {
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
  const btn = $(`tool-${mode}`);
  const bar = $('sketchbar');
  if (isMeasure) {
    // Mesure : la barre reste enfant de #map-screen et s'ancre en bas-centre
    // (hors de l'axe de visée). Logée dans la rangée du bouton mesure — haute
    // dans la pile, donc proche du centre vertical — elle masquait le réticule
    // central qu'on pointe justement pour mesurer.
    bar.classList.add('measure-hud');
    $('map-screen').appendChild(bar);
  } else {
    // La barre contextuelle vient se loger à gauche du bouton de l'outil actif.
    bar.classList.remove('measure-hud');
    btn.parentElement!.insertBefore(bar, btn);
  }
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
  if (mode === 'measure') {
    cancelSketch(); // la mesure est purement locale
    return;
  }
  // « OK » prend la position courante du réticule comme dernier sommet.
  const points = sketch.getFinalPoints();
  if (points.length < 2) {
    toast('Déplacez la carte pour tracer.');
    return;
  }
  if (mode === 'arrow') {
    cancelSketch();
    sendGraphic(points, { color: sketchColor, weight: 4, arrow: true });
    return;
  }
  if (mode === 'polygon') {
    if (points.length < 3) {
      toast('Posez au moins 3 sommets pour une box.');
      return;
    }
    freezeAndHideSketchbar();
    openBoxMenu(points);
    return;
  }
  // Liseré : on fige le tracé (il reste visible) et on ouvre le menu de
  // finalisation (nom + figuré d'échelon) ; rien n'est transmis avant Valider.
  freezeAndHideSketchbar();
  openLineMenu(points);
}

/** Transmet un ordre graphique (optimiste : affiché tout de suite, file d'attente
 *  vidée à la (re)connexion — voir sendOrder). */
function sendGraphic(points: L.LatLng[], style: GraphicStyle): void {
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
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
      },
      style,
    },
  });
}

function openLineMenu(points: L.LatLng[]): void {
  pendingLine = points;
  pendingEchelon = '';
  const input = $<HTMLInputElement>('line-name');
  input.value = '';
  selectEchelon('');
  $('line-menu').hidden = false;
  input.focus();
}

/** Met en évidence le figuré choisi (et mémorise la sélection). */
function selectEchelon(echelon: LineEchelon | ''): void {
  pendingEchelon = echelon;
  document.querySelectorAll<HTMLButtonElement>('.line-ech').forEach((btn) => {
    btn.classList.toggle('selected', (btn.dataset.echelon ?? '') === echelon);
  });
}

function confirmLineMenu(): void {
  if (!pendingLine) return;
  const style: GraphicStyle = { color: sketchColor, weight: 4 };
  const name = $<HTMLInputElement>('line-name').value.trim();
  if (name) style.label = name;
  if (pendingEchelon) style.echelon = pendingEchelon;
  sendGraphic(pendingLine, style);
  closeLineMenu();
}

/** Fige le tracé en cours (il reste visible) et range la barre d'esquisse. */
function freezeAndHideSketchbar(): void {
  sketch?.freeze();
  $('sketchbar').hidden = true;
  setActiveTool(null);
}

/** Ferme le menu et détruit le tracé figé (qu'il ait été transmis ou non). */
function closeLineMenu(): void {
  $('line-menu').hidden = true;
  pendingLine = null;
  cancelSketch();
}

// --- box (polygone semi-transparent + nom au centre) ---
// Réutilise le système de lignes : on dessine les sommets au réticule, puis un
// menu contextuel demande le nom. La couleur vient du sketchbar (comme les lignes).

function openBoxMenu(points: L.LatLng[]): void {
  pendingBox = points;
  const input = $<HTMLInputElement>('box-name');
  input.value = '';
  $('box-menu').hidden = false;
  input.focus();
}

function confirmBoxMenu(): void {
  if (!pendingBox) return;
  const name = $<HTMLInputElement>('box-name').value.trim();
  const style: GraphicStyle = { color: sketchColor, weight: 3, polygon: true };
  if (name) style.label = name;
  sendGraphic(pendingBox, style);
  closeBoxMenu();
}

function closeBoxMenu(): void {
  $('box-menu').hidden = true;
  pendingBox = null;
  cancelSketch();
}

// --- point nommé (rond de couleur + texte, accessible à tous) ---
// Tap sur l'outil = capture du point sous le réticule, puis menu nom + couleur.

function beginPoint(): void {
  if (!map || !state.session) return;
  cancelSketch();
  pendingPoint = map.getCenter();
  const input = $<HTMLInputElement>('point-name');
  input.value = '';
  $('point-menu').hidden = false;
  input.focus();
}

function confirmPointMenu(): void {
  if (!pendingPoint || !state.session) return;
  const name = $<HTMLInputElement>('point-name').value.trim() || 'Point';
  const c = pendingPoint;
  sendOrder({
    id: uid(),
    authorId: state.session.memberId,
    ts: Date.now(),
    kind: 'waypoint',
    payload: { kind: 'waypoint', name, lat: c.lat, lng: c.lng, color: pointColor },
  });
  closePointMenu();
}

function closePointMenu(): void {
  $('point-menu').hidden = true;
  pendingPoint = null;
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
// Tap sur l'outil = capture du réticule, puis menu texte (réutilise le système
// du point nommé) ; le texte devient la désignation affichée près du losange.

function beginEni(): void {
  if (!map || !state.session) return;
  cancelSketch(); // un plot ENI interrompt une éventuelle esquisse en cours
  pendingEni = map.getCenter();
  const input = $<HTMLInputElement>('eni-name');
  input.value = '';
  $('eni-menu').hidden = false;
  input.focus();
}

function confirmEniMenu(): void {
  if (!pendingEni || !state.session) return;
  const name = $<HTMLInputElement>('eni-name').value.trim() || 'ENI';
  const c = pendingEni;
  sendOrder({
    id: uid(),
    authorId: state.session.memberId,
    ts: Date.now(),
    kind: 'waypoint',
    payload: { kind: 'waypoint', name, lat: c.lat, lng: c.lng, sidc: HOSTILE_SIDC },
  });
  closeEniMenu();
}

function closeEniMenu(): void {
  $('eni-menu').hidden = true;
  pendingEni = null;
}

// --- coordonnées (réticule central + popups) ---

let elevTimer: ReturnType<typeof setTimeout> | null = null;

function updateReadout(): void {
  if (!map) return;
  const c = map.getCenter();
  // Altitude du point visé en dernier groupe, même police : « … 14018 43518 158 ».
  // Affichée seulement si on la connaît déjà pour ce point : on évite ainsi tout
  // chiffre périmé hérité d'un endroit qu'on vient de quitter en panoramique.
  const coords = formatCoords(c.lat, c.lng);
  const alt = cachedElevation(c.lat, c.lng);
  $('coord-readout').textContent = alt !== null ? `${coords} ${Math.round(alt)}` : coords;
  scheduleElevation(c.lat, c.lng);
}

/** Va chercher l'altitude du centre une fois la carte stabilisée (débounce). */
function scheduleElevation(lat: number, lng: number): void {
  if (cachedElevation(lat, lng) !== null) return; // déjà affichée
  if (elevTimer) clearTimeout(elevTimer);
  elevTimer = setTimeout(() => {
    void fetchElevation(lat, lng).then((alt) => {
      if (alt === null || !map) return;
      // N'applique le résultat que si le réticule est resté sur ce point.
      const c = map.getCenter();
      if (elevationKey(c.lat, c.lng) === elevationKey(lat, lng)) updateReadout();
    });
  }, 500);
}

// --- aller à des coordonnées saisies (MGRS ou lat/lng) ---

function openCoordSearch(): void {
  const input = $<HTMLInputElement>('coord-search-input');
  input.value = '';
  $('coord-search-error').hidden = true;
  $('coord-search-menu').hidden = false;
  input.focus();
}

function confirmCoordSearch(): void {
  if (!map) return;
  const parsed = parseCoords($<HTMLInputElement>('coord-search-input').value);
  if (!parsed) {
    $('coord-search-error').hidden = false;
    return;
  }
  setFollow(false); // on va à un point précis : plus de recadrage auto
  map.setView([parsed.lat, parsed.lng], Math.max(map.getZoom(), 15));
  $('coord-search-menu').hidden = true;
}

function closeCoordSearch(): void {
  $('coord-search-menu').hidden = true;
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
    coordsWithAltitudeHtml(p.lat, p.lng) +
    `<span class="order-author">±${Math.round(p.accuracy)} m · ${memberMeta(m, Date.now())}</span>`;
  hydrateAltitudes(div);
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
  const connected = [...state.members.values()].filter((m) => m.connected).length;
  $('member-count').textContent = String(connected);
  const pending = pendingOrderCount();
  const badge = $('pending-badge');
  badge.hidden = pending === 0;
  badge.textContent = pending > 0 ? `↑${pending}` : '';
  badge.title = pending > 0 ? `${pending} élément(s) à synchroniser` : '';

  // Badge du bouton « Comms » : messages reçus non lus.
  const unread = unreadCommsCount();
  const cb = $('comms-badge');
  cb.hidden = unread === 0;
  cb.textContent = String(unread);

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
  if (!m.connected) return ago(now - m.lastSeen);
  if (!m.lastPosition) return 'pas de position';
  return ago(now - Math.max(m.lastPosition.ts, m.lastSeen), 'à jour');
}

/** « il y a X s / min ». En deçà de `fresh` secondes, renvoie le libellé frais. */
function ago(ms: number, fresh = ''): string {
  const s = Math.floor(ms / 1000);
  if (fresh && s < 15) return fresh;
  if (s < 60) return `il y a ${s} s`;
  return `il y a ${Math.floor(s / 60)} min`;
}

export function initMapView(): void {
  // Panneau latéral « Comms » (chat libre de la salle).
  initCommsPanel({ notify: (text) => toast(text) });

  for (const mode of DISPLAYED_TOOLS) {
    $(`tool-${mode}`).addEventListener('click', () => {
      // Re-choisir l'outil actif annule l'esquisse en cours.
      if (sketch && sketchMode === mode) cancelSketch();
      else startSketch(mode);
    });
  }
  $('tool-eni').addEventListener('click', () => beginEni());
  // Bascule du menu d'outils (paysage / faible hauteur).
  $('fab-toggle').addEventListener('click', () => {
    const open = $('fab-stack').classList.toggle('open');
    $('fab-toggle').setAttribute('aria-expanded', String(open));
  });
  $('eni-ok').addEventListener('click', confirmEniMenu);
  $('eni-cancel').addEventListener('click', closeEniMenu);
  $('tool-compass').addEventListener('click', () => void toggleCompass());
  $('sketch-add').addEventListener('click', () => sketch?.addVertexAtCenter());

  // Recherche de coordonnées (loupe) : saisie MGRS / lat-lng puis « Y aller ».
  $('coord-search').addEventListener('click', openCoordSearch);
  $('coord-search-ok').addEventListener('click', confirmCoordSearch);
  $('coord-search-cancel').addEventListener('click', closeCoordSearch);
  $<HTMLInputElement>('coord-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCoordSearch();
  });

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

  // Menu contextuel du liseré : choix du figuré d'échelon + valider / annuler.
  document.querySelectorAll<HTMLButtonElement>('.line-ech').forEach((btn) => {
    btn.addEventListener('click', () => selectEchelon((btn.dataset.echelon ?? '') as LineEchelon | ''));
  });
  $('line-ok').addEventListener('click', confirmLineMenu);
  $('line-cancel').addEventListener('click', closeLineMenu);
  $('box-ok').addEventListener('click', confirmBoxMenu);
  $('box-cancel').addEventListener('click', closeBoxMenu);

  // Outil point nommé + son menu (nom + couleur du rond).
  $('tool-point').addEventListener('click', () => beginPoint());
  document.querySelectorAll<HTMLButtonElement>('#point-colors .color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      pointColor = dot.dataset.color!;
      document.querySelectorAll('#point-colors .color-dot').forEach((el) => el.classList.remove('selected'));
      dot.classList.add('selected');
    });
  });
  $('point-ok').addEventListener('click', confirmPointMenu);
  $('point-cancel').addEventListener('click', closePointMenu);
  document.querySelectorAll<HTMLButtonElement>('#sketch-colors .color-dot').forEach((dot, i) => {
    if (i === 0) dot.classList.add('selected');
    dot.addEventListener('click', () => {
      sketchColor = dot.dataset.color!;
      document.querySelectorAll('#sketch-colors .color-dot').forEach((el) => el.classList.remove('selected'));
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
