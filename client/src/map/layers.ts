import L from 'leaflet';

// Les hostnames de ces couches sont aussi listés dans public/sw.js
// (cache hors-ligne des tuiles) — garder les deux synchronisés.

export function createBaseLayers(): Record<string, L.TileLayer> {
  return {
    'Topographique (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution:
        'Données © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, ' +
        'SRTM | Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }),
    'Plan (OSM)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    Satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Tuiles © Esri — Source : Esri, Maxar, Earthstar Geographics',
      },
    ),
  };
}
