import L from 'leaflet';
import type { OrderMessage } from '@tq/shared/protocol';
import { formatCoords } from '../coords';
import { distanceM } from '../geo';
import { escapeHtml, formatDistance } from '../util';
import { visibleGraphics, visibleWaypoints, type GraphicOrder, type WaypointOrder } from './orderFilter';
import { getPlotIcon, HOSTILE_SIDC } from './symbols';

const DEFAULT_COLOR = '#e8d44d';
const HEAD_LENGTH_PX = 16;
const HEAD_SPREAD_RAD = Math.PI / 6;

/** ~1 m près de l'équateur : en dessous, deux taps sont le même point. */
function isSamePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}

type Rendered =
  | {
      kind: 'graphic';
      graphic: GraphicOrder;
      line: L.Polyline;
      /** Pointe de flèche, recalculée à chaque zoom (géométrie en pixels). */
      head: L.Polyline | null;
    }
  | { kind: 'plot'; marker: L.Marker };

export interface OrdersLayerCallbacks {
  /** Peut-on supprimer cet élément ? (chef ou auteur) */
  canDelete: (authorId: string) => boolean;
  onDelete: (orderId: string) => void;
  authorName: (authorId: string) => string;
  /** Vrai pendant une esquisse : ne pas ouvrir de popup sous le doigt. */
  isSketching: () => boolean;
}

export class OrdersLayer {
  private readonly rendered = new Map<string, Rendered>();

  constructor(
    private readonly map: L.Map,
    private readonly cb: OrdersLayerCallbacks,
  ) {
    map.on('zoomend', () => this.redrawHeads());
  }

  sync(orders: Map<string, OrderMessage>): void {
    const graphics = new Map(visibleGraphics(orders).map((g) => [g.id, g]));
    const plots = new Map(visibleWaypoints(orders).map((w) => [w.id, w]));
    for (const [id, r] of this.rendered) {
      if (!graphics.has(id) && !plots.has(id)) {
        this.removeRendered(r);
        this.rendered.delete(id);
      }
    }
    for (const g of graphics.values()) {
      if (!this.rendered.has(g.id)) this.renderGraphic(g);
    }
    for (const w of plots.values()) {
      if (!this.rendered.has(w.id)) this.renderPlot(w);
    }
  }

  clear(): void {
    for (const r of this.rendered.values()) this.removeRendered(r);
    this.rendered.clear();
  }

  private removeRendered(r: Rendered): void {
    if (r.kind === 'graphic') {
      r.line.remove();
      r.head?.remove();
    } else {
      r.marker.remove();
    }
  }

  private renderGraphic(g: GraphicOrder): void {
    const color = g.style.color ?? DEFAULT_COLOR;
    const line = L.polyline(g.latlngs, {
      color,
      weight: g.style.weight ?? 4,
      dashArray: g.style.dashArray,
      opacity: 0.9,
    }).addTo(this.map);
    line.on('click', (e) => {
      if (this.cb.isSketching()) return;
      L.DomEvent.stop(e);
      this.openGraphicPopup(g, e.latlng);
    });
    const r: Rendered = { kind: 'graphic', graphic: g, line, head: null };
    if (g.style.arrow) r.head = this.makeHead(g, color);
    this.rendered.set(g.id, r);
  }

  private renderPlot(w: WaypointOrder): void {
    const marker = L.marker([w.lat, w.lng], {
      icon: getPlotIcon(w.sidc ?? HOSTILE_SIDC),
      zIndexOffset: 500,
    }).addTo(this.map);
    marker.on('click', (e) => {
      if (this.cb.isSketching()) return;
      L.DomEvent.stop(e);
      const title =
        `<b>${escapeHtml(w.name)}</b>` +
        `<span class="coords">${formatCoords(w.lat, w.lng)}</span>`;
      this.openPopup(w.id, w.authorId, title, e.latlng);
    });
    this.rendered.set(w.id, { kind: 'plot', marker });
  }

  /** Pointe en bout de ligne. Taille constante à l'écran (d'où le recalcul
   *  au zoom), mais direction calculée en géographique : la projection en
   *  pixels donne un angle de bruit quand la carte est très dézoomée ou que
   *  les derniers points sont confondus. */
  private makeHead(g: GraphicOrder, color: string): L.Polyline | null {
    const n = g.latlngs.length;
    if (n < 2) return null;
    const tipLL = g.latlngs[n - 1]!;
    // Dernier point réellement distinct (un double tap crée des doublons).
    let i = n - 2;
    while (i > 0 && isSamePoint(g.latlngs[i]!, tipLL)) i--;
    const prevLL = g.latlngs[i]!;
    if (isSamePoint(prevLL, tipLL)) return null;

    // Cap en espace écran (x = est, y = sud) via équirectangulaire locale.
    const dx = (tipLL[1] - prevLL[1]) * Math.cos((tipLL[0] * Math.PI) / 180);
    const dy = tipLL[0] - prevLL[0];
    const ang = Math.atan2(-dy, dx);
    const tip = this.map.latLngToLayerPoint(L.latLng(...tipLL));
    const wing = (side: number) =>
      this.map.layerPointToLatLng(
        L.point(
          tip.x - HEAD_LENGTH_PX * Math.cos(ang + side * HEAD_SPREAD_RAD),
          tip.y - HEAD_LENGTH_PX * Math.sin(ang + side * HEAD_SPREAD_RAD),
        ),
      );
    return L.polyline([wing(-1), this.map.layerPointToLatLng(tip), wing(1)], {
      color,
      weight: g.style.weight ?? 4,
      opacity: 0.9,
      interactive: false,
    }).addTo(this.map);
  }

  private redrawHeads(): void {
    for (const r of this.rendered.values()) {
      if (r.kind !== 'graphic' || !r.graphic.style.arrow) continue;
      r.head?.remove();
      r.head = this.makeHead(r.graphic, r.graphic.style.color ?? DEFAULT_COLOR);
    }
  }

  private openGraphicPopup(g: GraphicOrder, at: L.LatLng): void {
    let len = 0;
    for (let i = 1; i < g.latlngs.length; i++) {
      len += distanceM(
        { lat: g.latlngs[i - 1]![0], lng: g.latlngs[i - 1]![1] },
        { lat: g.latlngs[i]![0], lng: g.latlngs[i]![1] },
      );
    }
    const title = `<b>${g.style.arrow ? 'Flèche' : 'Liseré'}</b> — ${formatDistance(len)}`;
    this.openPopup(g.id, g.authorId, title, at);
  }

  private openPopup(orderId: string, authorId: string, titleHtml: string, at: L.LatLng): void {
    const div = document.createElement('div');
    div.className = 'order-popup';
    div.innerHTML =
      `${titleHtml}<br>` +
      `<span class="order-author">par ${escapeHtml(this.cb.authorName(authorId))}</span>`;
    if (this.cb.canDelete(authorId)) {
      const btn = document.createElement('button');
      btn.className = 'btn order-delete';
      btn.textContent = 'Supprimer';
      btn.addEventListener('click', () => {
        this.map.closePopup();
        this.cb.onDelete(orderId);
      });
      div.appendChild(btn);
    }
    L.popup({ closeButton: true, className: 'tq-popup' }).setLatLng(at).setContent(div).openOn(this.map);
  }
}
