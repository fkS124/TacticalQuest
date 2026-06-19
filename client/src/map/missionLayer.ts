import L from 'leaflet';
import type { OrderMessage } from '@tq/shared/protocol';
import { formatCoords } from '../coords';
import { escapeHtml } from '../util';
import { deriveMissions, isActive, MISSION_DEFS, STATUS_LABEL, type MissionView } from '../orders/missions';

/** Couleur d'une mission remplie (en attente de clôture par le chef). */
const DONE_COLOR = '#4f9d52';

export interface MissionCallbacks {
  callsign: (memberId: string) => string;
  /** Membre courant : détermine les actions disponibles. */
  selfId: () => string;
  canCancel: (m: MissionView) => boolean;
  onAck: (missionId: string) => void;
  onDone: (missionId: string) => void;
  onCancel: (missionId: string) => void;
  isSketching: () => boolean;
}

interface Rendered {
  ring: L.CircleMarker;
  styleKey: string;
}

/**
 * Marqueurs de mission : un point cerclé coloré + une étiquette permanente
 * (icône de tâche + assigné). Volontairement très différent des liserés
 * (simples polylignes) — point d'objectif identifiable d'un coup d'œil.
 */
export class MissionLayer {
  private readonly rendered = new Map<string, Rendered>();

  constructor(
    private readonly map: L.Map,
    private readonly cb: MissionCallbacks,
  ) {}

  sync(orders: Map<string, OrderMessage>): void {
    const active = new Map(deriveMissions(orders).filter(isActive).map((m) => [m.id, m]));
    for (const [id, r] of this.rendered) {
      if (!active.has(id)) {
        r.ring.remove();
        this.rendered.delete(id);
      }
    }
    for (const m of active.values()) this.render(m);
  }

  clear(): void {
    for (const r of this.rendered.values()) r.ring.remove();
    this.rendered.clear();
  }

  private render(m: MissionView): void {
    const def = MISSION_DEFS[m.type];
    const styleKey = `${m.type}|${m.status}|${m.assignee}`;
    const existing = this.rendered.get(m.id);
    if (existing) {
      existing.ring.setLatLng([m.lat, m.lng]);
      if (existing.styleKey === styleKey) return;
      existing.ring.remove();
      this.rendered.delete(m.id);
    }

    const done = m.status === 'done';
    const acked = m.status === 'ack';
    // Mission remplie : anneau vert plein (en attente de clôture par le chef).
    const ringColor = done ? DONE_COLOR : def.color;
    const ring = L.circleMarker([m.lat, m.lng], {
      radius: 9,
      color: ringColor,
      weight: 3,
      fillColor: ringColor,
      fillOpacity: done ? 0.6 : acked ? 0.4 : 0.12,
      dashArray: acked || done ? undefined : '4 4', // pointillé tant que non accusé
    }).addTo(this.map);

    ring.bindTooltip(this.labelHtml(m, def), {
      permanent: true,
      direction: 'top',
      offset: [0, -8],
      className: 'mission-tip',
    });
    ring.on('click', (e) => {
      if (this.cb.isSketching()) return;
      L.DomEvent.stop(e);
      this.openPopup(m, def);
    });

    this.rendered.set(m.id, { ring, styleKey });
  }

  private labelHtml(m: MissionView, def: (typeof MISSION_DEFS)[keyof typeof MISSION_DEFS]): string {
    const mark =
      m.status === 'done'
        ? ' <span class="mt-ack" style="color:' + DONE_COLOR + '">✓✓</span>'
        : m.status === 'ack'
          ? ' <span class="mt-ack">✓</span>'
          : '';
    return (
      `<span class="mt-icon" style="color:${m.status === 'done' ? DONE_COLOR : def.color}">${def.icon}</span>` +
      `<span class="mt-text"><b>${def.short}</b> ${escapeHtml(this.cb.callsign(m.assignee))}` +
      mark +
      `</span>`
    );
  }

  private openPopup(m: MissionView, def: (typeof MISSION_DEFS)[keyof typeof MISSION_DEFS]): void {
    const div = document.createElement('div');
    div.className = 'order-popup mission-popup';
    div.style.setProperty('--mc', def.color);
    const statusTxt = m.status === 'done' ? `${STATUS_LABEL.done} — à clôturer` : STATUS_LABEL[m.status];
    div.innerHTML =
      `<b class="mission-title">${def.icon} ${escapeHtml(def.label)}</b>` +
      `<span>Pour <b>${escapeHtml(this.cb.callsign(m.assignee))}</b> · ${statusTxt}</span>` +
      `<span class="coords">${formatCoords(m.lat, m.lng)}</span>`;

    const isAssignee = m.assignee === this.cb.selfId();
    if (isAssignee && m.status === 'pending') {
      div.appendChild(this.actionBtn("Faire l'aperçu", 'btn-primary', () => this.cb.onAck(m.id)));
    } else if (isAssignee && m.status === 'ack') {
      div.appendChild(this.actionBtn('Mission remplie', 'btn-primary', () => this.cb.onDone(m.id)));
    }
    if (this.cb.canCancel(m)) {
      // Mission remplie : le chef la clôture (la fait disparaître) ; sinon il l'annule.
      if (m.status === 'done') {
        div.appendChild(this.actionBtn('Clôturer la mission', 'btn-primary', () => this.cb.onCancel(m.id)));
      } else {
        div.appendChild(this.actionBtn("Annuler l'ordre", 'order-delete', () => this.cb.onCancel(m.id)));
      }
    }

    L.popup({ className: 'tq-popup' }).setLatLng([m.lat, m.lng]).setContent(div).openOn(this.map);
  }

  private actionBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `btn ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      this.map.closePopup();
      onClick();
    });
    return btn;
  }
}
