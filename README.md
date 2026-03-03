# BlackJackoss

Blackjack trainer + multiplayer. Solo training with card counting and basic strategy, or shared multiplayer table with sequential turns and persistent balances.

## Lancer le projet

### Docker (recommandé)

```bash
# Premier lancement
docker compose up --build

# Ensuite (hot-reload, pas de rebuild)
docker compose up
```

Ouvrez http://localhost:3000

### Node.js direct

```bash
npm install
node server.js       # prod
npm run dev          # hot-reload (node --watch)
```

## Pages

| URL | Mode |
|---|---|
| `/` | Landing — choix Solo / Multijoueur |
| `/solo.html` | Solo Training — stratégie, comptage, historique |
| `/multi.html` | Multijoueur — table partagée 1-7 joueurs |

## Multijoueur

- Table partagée avec sabot commun
- Timer de mise de **8 secondes** — le deal part automatiquement quand le timer tombe à 0 si au moins un joueur a misé
- Tours séquentiels par ordre d'arrivée, indicateur `▶` sur le joueur actif
- **Pré-sélection d'action** : cliquez une action pendant le tour d'un autre joueur pour l'exécuter automatiquement quand votre tour arrive
- Balances persistées dans `data/balances.json` entre les sessions

## Intégration Determinoss (optionnel)

Seed d'entropie vraie (lava lamp) pour le mélange du sabot. Sans token, le jeu utilise `Math.random()`.

Créez un fichier `token.txt` à la racine (gitignored) avec votre token, ou via variable d'environnement :

```bash
DETERMINOSS_TOKEN=votre-token docker compose up
```

Ou dans un fichier `.env` :
```env
DETERMINOSS_TOKEN=votre-token
```

## Structure

```
├── index.html              # Landing page
├── solo.html               # Solo training
├── multi.html              # Multijoueur
├── style.css               # Design
├── server.js               # Serveur HTTP + WebSocket
├── server/
│   ├── game-engine.js      # Logique de jeu autoritaire (FSM, sabot, résolution)
│   └── persistence.js      # Lecture/écriture data/balances.json
├── data/
│   └── balances.json       # Balances persistées par pseudo
├── js/
│   ├── config.js           # WS_URL + token Determinoss
│   ├── strategy.js         # Tables de stratégie, rendu des charts
│   ├── game.js             # Client WebSocket + renderer (multi)
│   └── game-solo.js        # Logique standalone (solo)
├── Dockerfile
├── docker-compose.yml
└── docker-compose.override.yml  # Hot-reload dev
```

## Règles

6 decks · S17 · DAS · late surrender · split ×4 · no re-split aces · BJ 3:2 · insurance on dealer Ace
