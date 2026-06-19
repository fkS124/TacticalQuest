import L from 'leaflet';
import type { MemberPublic } from '@tq/shared/protocol';
import { getIcon } from './symbols';
import { escapeHtml } from '../util';

interface Tracked {
  marker: L.Marker;
  /** Clé du dernier style appliqué — évite de re-setIcon inutilement. */
  styleKey: string;
  tooltipKey: string;
}

export class MarkerLayer {
  private readonly tracked = new Map<string, Tracked>();
  private accuracyCircle: L.Circle | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly selfId: string,
    private readonly onClick?: (memberId: string) => void,
  ) {}

  /** Réconciliation complète avec l'état courant (roster + styles). */
  sync(members: Map<string, MemberPublic>): void {
    for (const id of this.tracked.keys()) {
      if (!members.has(id)) this.remove(id);
    }
    for (const member of members.values()) this.upsert(member);
  }

  upsert(member: MemberPublic): void {
    const pos = member.lastPosition;
    if (!pos) return; // pas encore de fix : rien à afficher

    const isSelf = member.id === this.selfId;
    // Seul état visuel : grisé tant que le membre n'est pas (re)connecté.
    const styleKey = `${member.sidc}|${member.connected ? 1 : 0}`;
    const tooltipKey = this.tooltipHtml(member);

    let t = this.tracked.get(member.id);
    if (!t) {
      const marker = L.marker([pos.lat, pos.lng], {
        icon: getIcon(member.sidc, { disconnected: !member.connected, self: isSelf }),
        zIndexOffset: isSelf ? 1000 : 0,
      });
      marker.bindTooltip(tooltipKey, {
        permanent: true,
        direction: 'bottom',
        offset: [0, 6],
        className: 'tq-tooltip',
      });
      marker.on('click', (e) => {
        L.DomEvent.stop(e);
        this.onClick?.(member.id);
      });
      marker.addTo(this.map);
      t = { marker, styleKey, tooltipKey };
      this.tracked.set(member.id, t);
    } else {
      t.marker.setLatLng([pos.lat, pos.lng]);
      if (t.styleKey !== styleKey) {
        t.marker.setIcon(getIcon(member.sidc, { disconnected: !member.connected, self: isSelf }));
        t.styleKey = styleKey;
      }
      if (t.tooltipKey !== tooltipKey) {
        t.marker.setTooltipContent(tooltipKey);
        t.tooltipKey = tooltipKey;
      }
    }

    if (isSelf) this.updateAccuracy(pos.lat, pos.lng, pos.accuracy);
  }

  /** Retire tout de la carte (sortie de salle). */
  clear(): void {
    for (const id of [...this.tracked.keys()]) this.remove(id);
    this.accuracyCircle?.remove();
    this.accuracyCircle = null;
  }

  remove(memberId: string): void {
    const t = this.tracked.get(memberId);
    if (!t) return;
    t.marker.remove();
    this.tracked.delete(memberId);
  }

  private tooltipHtml(member: MemberPublic): string {
    return escapeHtml(member.callsign) + (member.isLeader ? '<span class="leader-tag">CHEF</span>' : '');
  }

  private updateAccuracy(lat: number, lng: number, accuracy: number): void {
    if (!this.accuracyCircle) {
      this.accuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        weight: 1,
        color: '#8aa86a',
        fillColor: '#8aa86a',
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.accuracyCircle.setLatLng([lat, lng]);
      this.accuracyCircle.setRadius(accuracy);
    }
  }
}
