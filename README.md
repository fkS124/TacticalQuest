# TacticalQuest

Carte tactique collaborative (PWA). Un chef de section crée une salle et obtient
un code à 6 caractères ; ses subordonnés rejoignent avec un indicatif et tous
partagent leur position GPS en temps réel, en symbologie OTAN (APP-6). Le chef
peut diffuser des tracés (liserés, flèches/axes) et chacun peut plotter des
positions ennemies — le tout fonctionne même en réseau dégradé.

- **Auto-hébergé** : un seul process Node, aucune dépendance cloud, les données
  ne transitent par aucun tiers.
- **Salles éphémères** : en mémoire serveur, sans comptes. Un membre déconnecté
  reste visible (grisé) 20 min ; une salle vide disparaît après 30 min.
- **Résilient hors-ligne** : tuiles mises en cache pour les zones blanches ;
  ajouts/suppressions de tracés et de plots faits sans réseau, synchronisés à la
  reconnexion. PWA installable.
- **Compatibilité maximale** : Leaflet (pas de WebGL requis), cible es2017,
  vanilla TypeScript sans framework — pensé pour de vieux Android.

## Fonctionnalités

| Domaine | Détail |
|---|---|
| Positions | Partage temps réel, symbole APP-6 par membre, cercle de précision, péremption visuelle (grisé + ancienneté), badge **CHEF** |
| Carte | Satellite ESRI (défaut), OpenTopoMap, OSM ; sélecteur de couches ; échelle métrique |
| Coordonnées | Réticule central fixe + lecture du centre en bas à gauche, formats **MGRS / UTM / géographique** commutables (mémorisés) ; coordonnées dans chaque popup |
| Mesure | Outil règle : sommets posés sous le réticule, distance cumulée en direct (local, tous) |
| Tracés | Liserés et flèches/axes, 3 couleurs ; origine sous le réticule, aperçu élastique, « Valider » ; suppression par n'importe qui |
| Outils | 4 boutons toujours visibles en bas à droite (Mesure, Plot ENI, Liseré, Flèche) ; le menu contextuel d'esquisse sort à gauche du bouton actif. Mêmes droits pour tous |
| Plots ennemis | Losange rouge APP-6 sous le réticule, accessible à tous (un tap depuis le menu) |
| Ordres | Le chef transmet une mission (S'emparer de, Appuyer, Couvrir, Interdire, Détruire, Neutraliser, Reconnaître, Éclairer, Tenir — symboles de tâche APP-6) à un subordonné via le panneau « Ordres » ; il choisit ensuite le **point** de la mission sur la carte. Timeline avec « Faire l'aperçu » puis « Mission remplie ». Notifications (toast + vibration). Une mission **remplie reste affichée** jusqu'à ce que le **chef la clôture** (pour qu'aucune ne se ferme sans qu'il l'ait vue) ; le chef est notifié à chaque mission remplie |
| Réseau dégradé | Reconnexion auto (Socket.IO), rejoin transparent, file d'attente des ordres hors-ligne (badge d'éléments non synchronisés) |
| Terrain / batterie | Position échantillonnée en **basse précision** à cadence lente : un point dès l'arrivée sur le site, puis **1 point / 30 s** tant que la page est au premier plan (récepteur GPS éteint entre deux). Partage du code via `navigator.share` |

## Développement

```bash
npm install
npm run dev        # serveur :3000 + Vite :5173 (proxy /socket.io, HMR)
```

Ouvrir http://localhost:5173 dans deux onglets (dont un en navigation privée)
pour simuler deux membres. La géolocalisation fonctionne sur `localhost` sans
TLS ; pour simuler un déplacement : DevTools → ⋮ → More tools → **Sensors** →
Location. Pour simuler une coupure : DevTools → Network → Offline.

```bash
npm test           # tests unitaires (serveur + client)
npm run typecheck
node scripts/e2e.mjs   # scénario protocole bout-en-bout (serveur lancé requis)
```

### Test sur mobile sans déployer

- **Câble USB (Android)** : `adb reverse tcp:3000 tcp:3000` puis ouvrir
  `http://localhost:3000` sur le téléphone (exemption HTTPS de localhost).
- **Tailscale (iOS/Android)** : `tailscale serve --bg --https=443 localhost:3000`
  → URL `https://<machine>.<tailnet>.ts.net` avec certificat valide, rien à
  installer sur le téléphone. (Pour le dev Vite : pointer vers `:5173` ;
  `allowedHosts: ['.ts.net']` est déjà configuré.)

## Production

```bash
npm install
npm run build      # construit client/dist
npm start          # sert le client + WebSocket sur :3000 (PORT pour changer)
```

### TLS (obligatoire hors localhost)

Géolocalisation et service worker exigent HTTPS. Utiliser Caddy devant le port
3000 (voir `Caddyfile`) :

- **VPS + domaine** : renseigner le domaine dans le Caddyfile, `caddy run` —
  certificat Let's Encrypt automatique.
- **Laptop de terrain / LAN sans internet** : bloc `tls internal`.
  ⚠️ Piège classique : installer le certificat racine de Caddy
  (`~/.local/share/caddy/pki/authorities/local/root.crt`) **une fois sur chaque
  téléphone** (Android : Paramètres → Sécurité → Installer un certificat → CA),
  sinon ni la géolocalisation ni le service worker ne fonctionneront.
  Alternative : `mkcert -install` + certificat pour l'IP LAN.

### Console d'administration

Une page `/admin` permet de lister les salles actives, les **terminer**, les
**rallonger** (24 h) et **exclure** un membre. Elle est protégée par un code
dont seul le **hash sha256** vit côté serveur, dans le secret `ADMIN_CODE_HASH` :

```bash
# Calculer le hash d'un code (ou en générer un aléatoire sans argument) :
node scripts/admin-hash.mjs "mon-code-secret"

# En production (Fly) :
fly secrets set ADMIN_CODE_HASH=<hash>
# En local :
ADMIN_CODE_HASH=<hash> npm start
```

Sans ce secret, toute la zone `/admin` renvoie 503 (désactivée). Le code saisi
sur la page n'est jamais stocké côté serveur ; il transite en
`Authorization: Bearer` sur chaque appel et est comparé au hash à temps constant.
La page est servie hors du build PWA (le service worker ignore `/admin`).
Terminer une salle ou exclure un membre renvoie les clients concernés à l'accueil
(`room_closed` `closed`/`kicked`).

Durcissements :

- **HTTPS imposé au niveau applicatif** : toute requête `/admin` non chiffrée est
  refusée (403). Détection via `x-forwarded-proto` (posé par Fly/Caddy) ;
  `localhost` est toléré en dev, et `ADMIN_ALLOW_INSECURE=1` lève la contrainte
  si vraiment nécessaire.
- **Verrou anti brute-force** : au-delà de `ADMIN_AUTH_MAX_FAILS` (8) échecs par
  IP sur 15 min, l'IP est bloquée (429 + `Retry-After`) jusqu'à expiration de la
  fenêtre — un succès remet le compteur à zéro. Sur Fly, l'IP réelle vient de
  l'en-tête non usurpable `Fly-Client-IP`. ⚠️ Conséquence assumée : huit fautes
  de frappe verrouillent la console 15 min — d'où l'intérêt de coller le code
  généré plutôt que de le retaper.

Le code lui-même doit être à **haute entropie** : le hash stocké est un sha256 nu
(non salé), donc un code faible serait cassable hors-ligne s'il fuyait. Utiliser
`node scripts/admin-hash.mjs` sans argument génère un code aléatoire fort.

## Architecture

```
shared/   protocole Socket.IO typé + constantes (source de vérité unique)
server/   Express + Socket.IO : salles en mémoire, GC, rate limiting
client/   Vanilla TS + Leaflet + milsymbol ; PWA (manifest + sw.js)
```

**Modèle d'ordres.** Tracés, plots et (à venir) waypoints/ordres texte passent
tous par une enveloppe générique `OrderMessage` (`shared/src/protocol.ts`,
champ `kind`). Le serveur la **relaie sans l'interpréter** : valider la taille,
pousser dans le ring buffer `recentOrders` (livré aux retardataires), diffuser.
Un nouveau type d'ordre est donc un changement **client uniquement**.

**Corollaire sécurité** : comme le serveur ne valide pas la sémantique des
payloads (relais opaque), le client traite tout ordre reçu comme **non fiable**.
Les textes sont échappés (`escapeHtml`) et les champs réinjectés dans des
attributs HTML sont assainis : `color` passe par `safeColor` (hex ou nom
alphabétique seulement — bloque l'évasion d'attribut / l'injection CSS) et le
`sidc` d'un plot est validé contre `SIDC_REGEX` avant milsymbol. Sans cela, un
participant malveillant pourrait injecter du HTML/JS rendu chez tous les autres
(XSS stocké).

Côté client, les ordres sont appliqués de façon **optimiste** (visibles
immédiatement) et placés dans une file persistée (`sessionStorage`) ; la file
est vidée vers le serveur à chaque (re)connexion, après réconciliation avec le
snapshot serveur — ce qui rend l'édition hors-ligne transparente.

Les **missions** s'appuient sur deux types d'ordre (`mission`, `mission_status`)
et une logique pure `client/src/orders/missions.ts` (testée) qui reconstruit
l'état de chaque mission (pending → ack → done) depuis le flux d'ordres. Rendu
carte : `client/src/map/missionLayer.ts` ; UI panneau : `client/src/views/ordersPanel.ts`.

### Réglages

Limites et délais (membres/salle, période de grâce, TTL, throttles, plafond du
cache de tuiles…) : `shared/src/constants.ts`.

### Reste à faire

- Ordres de mission « à tous » (broadcast) ; pour l'instant un ordre cible un
  seul subordonné.
- Waypoints amis nommés, ordres texte libre.
- Suivi en arrière-plan / écran verrouillé : abandonné côté web (les navigateurs
  mobiles gèlent timers et GPS en arrière-plan). Un wrapper natif (Capacitor)
  avec autorisation de localisation en arrière-plan serait la voie si le besoin
  revient.

## Limites connues

- **Veille / arrière-plan** : la position n'est suivie que **page au premier
  plan**. Écran verrouillé ou onglet en arrière-plan, les navigateurs mobiles
  gèlent les timers et le GPS : aucun point n'est envoyé. La grâce de 20 min
  maintient le dernier point connu côté serveur, et l'échantillonnage reprend au
  retour au premier plan. (Un journal de diagnostic veille reste dans le code,
  masqué dans l'UI, pour un éventuel usage ultérieur.)
- **Cache de tuiles** : plafonné (~2000 tuiles, éviction FIFO) ; Safari peut
  purger le stockage d'un site non installé après ~7 jours — installer la PWA
  sur l'écran d'accueil pour la persistance.
