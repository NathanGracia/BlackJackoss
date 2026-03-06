# BlackJackoss

Blackjack multijoueur avec comptage de cartes, stratégie de base, succès et skins. Table partagée 1-7 joueurs, tours séquentiels, balances persistées en base de données.

## Lancer le projet

### Prérequis

- Node.js ≥ 18
- npm

### Installation

```bash
npm install
```

> La première `npm install` compile aussi `better-sqlite3` (dépendance native). Si elle échoue, installe les build tools : `npm install --global windows-build-tools` (Windows) ou `sudo apt install build-essential` (Linux).

### Démarrage

```bash
node server.js       # production
npm run dev          # hot-reload (node --watch)
```

Ouvre **http://localhost:3000**

### Docker

```bash
docker compose up --build   # premier lancement
docker compose up           # ensuite
```

---

## Pages

| URL | Description |
|---|---|
| `/` | Landing — choix Solo / Multijoueur |
| `/solo.html` | Solo Training — stratégie, comptage, historique |
| `/multi.html` | Multijoueur — table partagée 1-7 joueurs |

---

## Multijoueur

- Table partagée, sabot commun 6 jeux
- **Timer de mise 8s** — deal automatique quand au moins un joueur a misé
- **Si tous les joueurs sont en AUTO**, le deal part immédiatement sans attendre le timer
- **Timer de tour 10s** par joueur — auto-stand à expiration
- Tours séquentiels par ordre d'arrivée, indicateur `▶` sur le joueur actif
- **Pré-sélection d'action** pendant le tour d'un autre joueur
- Joueurs déconnectés : retirés immédiatement en IDLE, auto-stand en cours de partie
- Balances persistées en **SQLite** (`data/blackjackoss.db`) entre les sessions

### Boutons spéciaux

| Bouton | Effet |
|---|---|
| `ALL IN` | Mise toute la balance en un clic |
| `AUTO` | Rejoue automatiquement la dernière mise à chaque tour |
| `NO INS` | Refuse automatiquement l'assurance (toggle, actif en permanence) |

---

## Chat & Émotes

### Chat
- Champ texte en bas à droite (max 80 caractères), envoi avec Entrée
- Le message apparaît en bulle flottante au-dessus du seat de l'émetteur, visible par tous
- Broadcast immédiat à tous les clients connectés

### Émotes
- **8 emotes libres** accessibles à tous (👍 👎 😂 🔥 💀 🎉 🤔 😎)
- **6 emotes débloquables** via succès (⚡ 💰 🌟 👑 ✨ 🌋)
- **Ouverture de la roue** : maintenir `G` n'importe où sur la table, relâcher sur un slot pour envoyer — ou cliquer le bouton `😀`
- **Zone morte** : 30px au centre de la roue, aucun slot sélectionné
- **Personnalisation** : bouton ⚙ au centre de la roue → panel pour assigner les emotes aux 8 slots
- La config de la roue est sauvegardée dans `localStorage` par pseudo
- L'émote apparaît en popup flottant à la position du curseur de l'émetteur, visible par tous

### Admin — emotes personnalisées
Endpoint non protégé, usage interne :

```bash
# Lister
GET /api/emotes

# Ajouter (fileData = base64 de l'image)
POST /api/admin/emotes
{ "id": "eric", "label": "Eric", "fileData": "...", "fileExt": "jpg", "free": true }

# Supprimer
DELETE /api/admin/emotes/:id
```

Images servies depuis `/emotes/`, config dans `data/emotes-custom.json`.

---

## Succès

19 succès débloquables liés à chaque pseudo :

| Catégorie | Exemples |
|---|---|
| All In | Tout ou Rien · All In Hero · Triple Fougue |
| Blackjack | Natural · Favori des Dieux |
| Mains | Quatuor · Maître du Split · David vs Goliath |
| Sessions | Habitué (100) · Vétéran (500) · Légende (1000) |
| Balance | High Roller ($5k) · Millionnaire ($10k) · Rock Bottom ($0) |
| Streaks | En Feu (×5) · Inarrêtable (×10) |

Récompenses : **balance créditée** (+$X) ou **skin de table** débloqué.

Les skins se sélectionnent depuis le panel `🏆` en haut de la table.

---

## Données

```
data/
└── blackjackoss.db     # SQLite — players, player_stats, achievements
```

Si `data/balances.json` existe (ancien format), il est migré automatiquement au premier démarrage et renommé `balances.json.migrated`.

---

## Intégration Determinoss (optionnel)

Seed d'entropie vraie (lava lamp) pour le mélange du sabot. Sans token, le jeu utilise `Math.random()`.

Créez `token.txt` à la racine (gitignored) :
```
votre-token-determinoss
```

Ou via variable d'environnement :
```bash
DETERMINOSS_TOKEN=votre-token node server.js
```

---

## Structure

```
├── index.html                  # Landing
├── solo.html                   # Solo training (standalone, pas de serveur)
├── multi.html                  # Multijoueur (WebSocket)
├── style.css                   # Design principal
├── achievements.css            # Styles succès, toasts, skins
├── favicon.svg
├── server.js                   # Serveur HTTP + WebSocket
├── server/
│   ├── game-engine.js          # Logique de jeu (FSM, sabot, résolution, achievements)
│   ├── db.js                   # Couche SQLite (balances, stats, succès)
│   └── achievements-def.js     # Définitions des 19 succès
├── js/
│   ├── config.js               # WS_URL + token Determinoss
│   ├── strategy.js             # Tables de stratégie de base
│   ├── sounds.js               # Sons synthétisés (Web Audio API)
│   ├── achievements-client.js  # Toasts, galerie, skins côté client
│   ├── game.js                 # Client WebSocket + renderer (multi)
│   └── game-solo.js            # Logique standalone (solo)
├── data/
│   └── blackjackoss.db         # Base de données SQLite (auto-créée)
├── package.json
├── Dockerfile
└── docker-compose.yml
```

## Règles

6 decks · S17 · DAS · late surrender · split ×4 · no re-split aces · BJ 3:2 · insurance on dealer Ace
