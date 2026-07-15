import L from 'leaflet';

// Les hostnames de ces couches sont aussi listés dans public/sw.js
// (cache hors-ligne des tuiles) — garder les deux synchronisés.

// Clé de la couche affichée par défaut (voir aussi mapView.initLeaflet).
export const DEFAULT_LAYER = 'Satellite';

/** Fond imagerie (sombre) ? Sert au quadrillage pour choisir sa couleur. */
export function isSatelliteBase(name: string): boolean {
  return name.startsWith('Sat');
}

// Géoplateforme IGN : flux WMTS ouverts, sans clé (ortho BD ORTHO 20 cm et
// Plan IGN v2). Couverture France + DOM uniquement — l'Esri mondial reste
// disponible en secours. SCAN 25 écarté : licence payante (clé privée).
function ignWmts(layer: string, format: string, maxZoom: number): L.TileLayer {
  return L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      `&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM` +
      '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}' +
      `&FORMAT=${format}`,
    { maxZoom, attribution: '© <a href="https://www.ign.fr">IGN</a>' },
  );
}

export function createBaseLayers(): Record<string, L.Layer> {
  // Mentions légales volontairement concises (cf. CSS .leaflet-control-attribution).
  const ignOrtho = ignWmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg', 19);
  const esriImagery = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '© <a href="https://www.esri.com">Esri</a>' },
  );
  // Surcouche transparente (routes, voies, chemins) posée sur l'imagerie : rend
  // visibles les axes masqués par la canopée forestière.
  const transportation = () =>
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19 },
    );
  return {
    // Ortho IGN 20 cm (France) + surcouche des routes/chemins.
    Satellite: L.layerGroup([ignOrtho, transportation()]),
    // Secours mondial (hors couverture IGN) : imagerie Esri + mêmes routes.
    'Sat. monde': L.layerGroup([esriImagery, transportation()]),
    Topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> · OSM',
    }),
    // Plan IGN v2 : nettement plus riche et lisible que le rendu OSM brut
    // (chemins, végétation, bâti, toponymie militaire-compatible).
    Plan: ignWmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png', 19),
  };
}
