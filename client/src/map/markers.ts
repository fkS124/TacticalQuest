import L from 'leaflet';
import { STALE_AFTER_MS } from '@tq/shared/constants';
import type { MemberPublic } from '@tq/shared/protocol';
import { getIcon } from './symbols';

function ageLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h`;
}

interface Tracked {
  marker: L.Marker;
  /** Clé du dernier style appliqué — évite de re-setIcon à chaque tick. */
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
  sync(members: Map<string, MemberPublic>, now = Date.now()): void {
    for (const id of this.tracked.keys()) {
      if (!members.has(id)) this.remove(id);
    }
    for (const member of members.values()) this.upsert(member, now);
  }

  upsert(member: MemberPublic, now = Date.now()): void {
    const pos = member.lastPosition;
    if (!pos) return; // pas encore de fix : rien à afficher

    const isSelf = member.id === this.selfId;
    const stale = !isSelf && now - Math.max(pos.ts, member.lastSeen) > STALE_AFTER_MS;
    const styleKey = `${member.sidc}|${stale ? 1 : 0}${member.connected ? 1 : 0}`;
    const tooltipKey = this.tooltipHtml(member, stale, now);

    let t = this.tracked.get(member.id);
    if (!t) {
      const marker = L.marker([pos.lat, pos.lng], {
        icon: getIcon(member.sidc, { stale, disconnected: !member.connected, self: isSelf }),
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
        t.marker.setIcon(getIcon(member.sidc, { stale, disconnected: !member.connected, self: isSelf }));
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

  /** Tick périodique : réévalue la péremption et les libellés d'âge. */
  refresh(members: Map<string, MemberPublic>, now = Date.now()): void {
    for (const member of members.values()) {
      if (this.tracked.has(member.id)) this.upsert(member, now);
    }
  }

  getLatLng(memberId: string): L.LatLng | null {
    return this.tracked.get(memberId)?.marker.getLatLng() ?? null;
  }

  private tooltipHtml(member: MemberPublic, stale: boolean, now: number): string {
    const name = member.callsign + (member.isLeader ? ' ★' : '');
    if (!stale || !member.lastPosition) return name;
    const age = ageLabel(now - Math.max(member.lastPosition.ts, member.lastSeen));
    return `${name}<br><span class="age">${age}</span>`;
  }

  private updateAccuracy(lat: number, lng: number, accuracy: number): void {
    if (!this.accuracyCircle) {
      this.accuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        weight: 1,
        color: '#7da455',
        fillColor: '#7da455',
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.accuracyCircle.setLatLng([lat, lng]);
      this.accuracyCircle.setRadius(accuracy);
    }
  }
}
