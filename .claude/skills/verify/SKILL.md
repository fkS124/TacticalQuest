---
name: verify
description: Vérifier un changement client TacticalQuest en pilotant la PWA dans Chromium headless (puppeteer-core + vite dev).
---

# Vérifier TacticalQuest (client)

## Lancer

- Le dev de l'utilisateur tourne souvent déjà (`npm run dev` → concurrently
  server :3000 + client vite :5173). **Ne pas `pkill -f vite`** : cela tue
  aussi le sien. Si un vite doit être lancé pour la vérif, il prendra :5174 ;
  le tuer par PID précis.
- Client seul : `npm run dev -w client` (solo mode = aucune salle requise,
  le socket ne se connecte pas ; tous les outils carte marchent en local,
  persistés dans localStorage `tq-solo-orders`).

## Piloter

- Pas de Playwright/Puppeteer dans le repo : `npm install puppeteer-core`
  dans le scratchpad + `executablePath: '/usr/bin/chromium'`,
  `args: ['--no-sandbox']`. Chaque launch = profil vierge (localStorage vide).
- Au boot, la géoloc est refusée → overlay `#geo-overlay` ; cliquer
  `#btn-geo-dismiss`.
- Leaflet n'est pas exposé sur `window` : naviguer par l'UI réelle —
  `#coord-search` puis `#coord-search-input` (« 49.11, 4.36 ») + `#coord-search-ok`
  pour aller quelque part ; pans à la souris (drag depuis le centre 450,390).
- Esquisses (mesure/liseré/flèche/box/mission) : l'origine se pose au réticule
  central ; déplacer la carte étire le tracé ; `#sketch-ok` valide.
- Vérifier l'état : `localStorage.getItem('tq-solo-orders')` (figurés solo),
  `tq-layers` (calques).

## Gotchas

- `vitest` tourne en env node : tout module qui importe `leaflet` est
  intestable (window manquant) — les catalogues/purs sont séparés
  (ex. `map/missionCatalog.ts` vs `map/missions.ts`).
- Screenshots : attendre ~1 s après un setView pour les tuiles IGN.
