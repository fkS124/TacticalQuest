# TacticalQuest

Carte tactique collaborative (PWA). Un chef de section crée une salle et obtient
un code à 6 caractères ; les membres rejoignent avec un indicatif et partagent
leurs positions GPS en temps réel, affichées en symbologie OTAN (APP-6).

- **Auto-hébergé** : un seul process Node, aucune dépendance cloud.
- **Rooms éphémères** : en mémoire, sans comptes ; une salle vide depuis 15 min disparaît.
- **Hors-ligne** : les tuiles de carte consultées sont mises en cache (PWA installable).
- **Compatibilité max** : Leaflet (pas de WebGL), cible es2017, testé sur vieux Android.

## Développement

```bash
npm install
npm run dev        # serveur :3000 + Vite :5173 (proxy /socket.io)
```

Ouvrir http://localhost:5173 dans deux onglets (dont un en navigation privée)
pour simuler deux membres. La géolocalisation fonctionne sur `localhost` sans
TLS ; pour simuler un déplacement : DevTools → ⋮ → More tools → **Sensors** →
Location.

```bash
npm test           # tests unitaires (rooms serveur + throttle géoloc client)
npm run typecheck
```

## Production

```bash
npm install
npm run build      # construit client/dist
npm start          # sert client + WebSocket sur :3000
```

### TLS (obligatoire hors localhost)

La géolocalisation et le service worker exigent HTTPS. Utiliser Caddy devant
le port 3000 (voir `Caddyfile`) :

- **VPS + domaine** : mettre votre domaine dans le Caddyfile, `caddy run` —
  certificat Let's Encrypt automatique.
- **Laptop de terrain / LAN sans internet** : bloc `tls internal` du Caddyfile.
  ⚠️ Piège classique : il faut installer le certificat racine de Caddy
  (`~/.local/share/caddy/pki/authorities/local/root.crt`) **une fois sur chaque
  téléphone** (Android : Paramètres → Sécurité → Installer un certificat → CA),
  sinon ni la géolocalisation ni le service worker ne fonctionneront.
  Alternative : `mkcert -install` + certificat pour l'IP LAN.

### Réglages

Les limites (membres par salle, TTL, throttles…) sont dans
`shared/src/constants.ts`. Port serveur : variable d'environnement `PORT`
(défaut 3000).

## Architecture

```
shared/   types du protocole Socket.IO + constantes (source de vérité unique)
server/   Express + Socket.IO : rooms en mémoire, GC, rate limiting
client/   Vanilla TS + Leaflet + milsymbol ; PWA (manifest + sw.js)
```

Le protocole prévoit déjà la transmission d'ordres (`send_order`, enveloppe
`OrderMessage` générique relayée sans interprétation par le serveur, ring
buffer `recentOrders` livré aux retardataires) — l'UI correspondante reste à
construire (waypoints, ordres texte, accusés de réception).
