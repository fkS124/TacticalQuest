import L from 'leaflet';

// Les hostnames de ces couches sont aussi listés dans public/sw.js
// (cache hors-ligne des tuiles) — garder les deux synchronisés.

// Clé de la couche affichée par défaut (voir aussi mapView.initLeaflet).
export const DEFAULT_LAYER = 'Satellite';

export function createBaseLayers(): Record<string, L.TileLayer> {
  // Mentions légales volontairement concises (cf. CSS .leaflet-control-attribution).
  return {
    Satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: '© <a href="https://www.esri.com">Esri</a>' },
    ),
    Topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> · OSM',
    }),
    Plan: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    }),
  };
}
