import type { MissionType } from '@tq/shared/protocol';
import { state } from '../state';
import { sendOrder } from '../socket';
import { uid, escapeHtml } from '../util';
import {
  deriveMissions,
  isActive,
  MISSION_DEFS,
  MISSION_ORDER,
  STATUS_LABEL,
  type MissionView,
} from '../orders/missions';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Deps {
  /** Démarre le choix du point de la mission sur la carte. */
  beginPlacement: (type: MissionType, assignee: string) => void;
  focusMission: (m: MissionView) => void;
  notify: (text: string) => void;
}

let deps: Deps;
let selectedType: MissionType = 'seize';

export function initOrdersPanel(d: Deps): void {
  deps = d;

  const types = $('composer-types');
  for (const t of MISSION_ORDER) {
    const def = MISSION_DEFS[t];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'composer-type';
    btn.dataset.type = t;
    btn.innerHTML = `<span class="ct-icon" style="color:${def.color}">${def.icon}</span><span>${def.label}</span>`;
    btn.addEventListener('click', () => {
      selectedType = t;
      renderTypeSelection();
    });
    types.appendChild(btn);
  }
  renderTypeSelection();

  $('btn-orders').addEventListener('click', () => toggleOrders());
  $('orders-close').addEventListener('click', () => closeOrders());
  $('composer-send').addEventListener('click', sendMission);
}

function renderTypeSelection(): void {
  document.querySelectorAll<HTMLButtonElement>('.composer-type').forEach((b) => {
    b.classList.toggle('selected', b.dataset.type === selectedType);
  });
}

export function toggleOrders(): void {
  if ($('orders-panel').hidden) openOrders();
  else closeOrders();
}

export function openOrders(): void {
  $('orders-panel').hidden = false;
  renderOrdersPanel();
}

export function closeOrders(): void {
  $('orders-panel').hidden = true;
}

// --- envoi / actions (passent par sendOrder : optimiste + file hors-ligne) ---

function sendMission(): void {
  const session = state.session;
  if (!session) return;
  const assignee = $<HTMLSelectElement>('composer-assignee').value;
  if (!assignee) {
    deps.notify('Aucun subordonné à qui assigner l’ordre.');
    return;
  }
  // On ne transmet pas tout de suite : on passe en mode placement du point.
  deps.beginPlacement(selectedType, assignee);
}

/** Émet réellement la mission une fois le point choisi (appelé par mapView). */
export function submitMission(type: MissionType, assignee: string, lat: number, lng: number): void {
  const session = state.session;
  if (!session) return;
  sendOrder({
    id: uid(),
    authorId: session.memberId,
    ts: Date.now(),
    kind: 'mission',
    payload: { kind: 'mission', missionType: type, lat, lng, assignee },
  });
}

export function missionAck(missionId: string): void {
  sendStatus(missionId, 'ack');
}
export function missionDone(missionId: string): void {
  sendStatus(missionId, 'done');
}
export function missionCancel(missionId: string): void {
  if (!state.session) return;
  sendOrder({
    id: uid(),
    authorId: state.session.memberId,
    ts: Date.now(),
    kind: 'remove',
    payload: { kind: 'remove', orderId: missionId },
  });
}

function sendStatus(missionId: string, status: 'ack' | 'done'): void {
  if (!state.session) return;
  sendOrder({
    id: uid(),
    authorId: state.session.memberId,
    ts: Date.now(),
    kind: 'mission_status',
    payload: { kind: 'mission_status', missionId, status },
  });
}

// --- rendu ---

export function renderOrdersPanel(): void {
  const session = state.session;
  if (!session) return;
  $('orders-composer').hidden = !session.isLeader;
  if (session.isLeader) renderAssignees();
  renderTimeline();
}

function renderAssignees(): void {
  const sel = $<HTMLSelectElement>('composer-assignee');
  const prev = sel.value;
  const others = [...state.members.values()].filter((m) => m.id !== state.session?.memberId);
  sel.innerHTML = '';
  if (others.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— aucun subordonné —';
    sel.appendChild(opt);
  } else {
    for (const m of others) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.callsign + (m.connected ? '' : ' (hors ligne)');
      sel.appendChild(opt);
    }
    if (others.some((m) => m.id === prev)) sel.value = prev;
  }
  $('composer-send').toggleAttribute('disabled', others.length === 0);
}

function renderTimeline(): void {
  const list = $('orders-timeline');
  list.innerHTML = '';
  const missions = deriveMissions(state.orders);
  if (missions.length === 0) {
    list.innerHTML = '<li class="orders-empty">Aucun ordre pour l’instant.</li>';
    return;
  }
  const now = Date.now();
  for (const m of missions) {
    list.appendChild(missionItem(m, now));
  }
}

function missionItem(m: MissionView, now: number): HTMLLIElement {
  const def = MISSION_DEFS[m.type];
  const li = document.createElement('li');
  li.className = `mission-item status-${m.status}${m.removed ? ' removed' : ''}`;
  li.style.setProperty('--mc', def.color);

  const statusTxt = m.removed ? 'Annulé' : STATUS_LABEL[m.status];
  const head = document.createElement('div');
  head.className = 'mi-head';
  head.innerHTML =
    `<span class="mi-icon" style="color:${def.color}">${def.icon}</span>` +
    `<span class="mi-main"><b>${escapeHtml(def.label)}</b>` +
    `<span class="mi-sub">${escapeHtml(callsign(m.assignee))} · ${ago(now - m.ts)}</span></span>` +
    `<span class="mi-status">${statusTxt}</span>`;
  // Tap sur l'en-tête : centrer la carte sur la mission.
  head.addEventListener('click', () => {
    deps.focusMission(m);
    closeOrders();
  });
  li.appendChild(head);

  if (!m.removed) {
    const actions = document.createElement('div');
    actions.className = 'mi-actions';
    const isAssignee = m.assignee === state.session?.memberId;
    if (isAssignee && m.status === 'pending') {
      actions.appendChild(actionBtn("Faire l'aperçu", 'btn-primary', () => missionAck(m.id)));
    } else if (isAssignee && m.status === 'ack') {
      actions.appendChild(actionBtn('Mission remplie', 'btn-primary', () => missionDone(m.id)));
    }
    if (canCancel(m)) {
      // Mission remplie : le chef la clôture (la fait disparaître) ; sinon il l'annule.
      if (m.status === 'done') {
        actions.appendChild(actionBtn('Clôturer', 'btn-primary', () => missionCancel(m.id)));
      } else {
        actions.appendChild(actionBtn('Annuler', 'order-delete', () => missionCancel(m.id)));
      }
    }
    if (actions.childElementCount > 0) li.appendChild(actions);
  }
  return li;
}

function actionBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ${cls}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

// --- badge + notifications ---

/** Missions actives assignées au membre courant (tâches en attente d'action). */
export function pendingMissionCountForSelf(): number {
  const me = state.session?.memberId;
  if (!me) return 0;
  return deriveMissions(state.orders).filter((m) => m.assignee === me && isActive(m)).length;
}

const seenMissions = new Set<string>();
const seenDone = new Set<string>();

/**
 * Notifie (toast + vibration) :
 * - le subordonné, quand un nouvel ordre lui est assigné ;
 * - l'auteur (le chef), quand une de ses missions est déclarée remplie et reste
 *   à clôturer — pour qu'aucune mission ne se ferme sans qu'il l'ait vue.
 */
export function checkIncomingMissions(): void {
  const me = state.session?.memberId;
  if (!me) return;
  for (const m of deriveMissions(state.orders)) {
    if (!seenMissions.has(m.id)) {
      seenMissions.add(m.id);
      if (m.assignee === me && m.status === 'pending' && m.authorId !== me) {
        deps.notify(`Nouvel ordre : ${MISSION_DEFS[m.type].label}`);
        if ('vibrate' in navigator) navigator.vibrate?.([120, 60, 120]);
      }
    }
    if (m.status === 'done' && !m.removed && !seenDone.has(m.id)) {
      seenDone.add(m.id);
      if (m.authorId === me && m.assignee !== me) {
        deps.notify(`Mission remplie : ${MISSION_DEFS[m.type].label} — à clôturer`);
        if ('vibrate' in navigator) navigator.vibrate?.([120, 60, 120]);
      }
    }
  }
}

export function resetMissionNotifications(): void {
  seenMissions.clear();
  seenDone.clear();
}

// --- utilitaires ---

function callsign(memberId: string): string {
  const m = state.members.get(memberId);
  if (m) return m.callsign;
  if (memberId === state.session?.memberId) return state.session.callsign;
  return 'inconnu';
}

function canCancel(m: MissionView): boolean {
  return state.session?.isLeader === true || m.authorId === state.session?.memberId;
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return 'à l’instant';
  const min = Math.floor(s / 60);
  if (min < 60) return `il y a ${min} min`;
  return `il y a ${Math.floor(min / 60)} h`;
}
