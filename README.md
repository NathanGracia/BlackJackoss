# BlackJackoss

Blackjack trainer with card counting and basic strategy. Vanilla HTML/CSS/JS — no build step.

## Lancer le projet

### Option 1 — Ouvrir directement dans le navigateur

Double-cliquez sur `index.html` ou ouvrez-le via `File > Open` dans votre navigateur.

> Suffisant pour jouer. L'appel à Determinoss peut échouer selon la politique CORS du navigateur en `file://`.

### Option 2 — Serveur local (recommandé)

```bash
npx serve .
```

Puis ouvrez http://localhost:3000

Ou avec Python si vous l'avez :

```bash
python -m http.server 8080
```

Puis ouvrez http://localhost:8080

## Intégration Determinoss (optionnel)

Determinoss fournit une graine d'entropie vraie (lava lamp) pour le mélange du sabot.
Sans token, le jeu utilise `Math.random()` — ça marche très bien pour s'entraîner.

Pour activer Determinoss, collez votre token dans `js/config.js` :

```js
window.Config = {
  DETERMINOSS_TOKEN: 'votre-token-ici',
};
```

> Ne commitez pas ce fichier avec un vrai token dedans.

## Structure

```
black-jackoss/
├── index.html      # Shell HTML
├── style.css       # Design neon glassmorphism
├── js/
│   ├── config.js   # Token Determinoss
│   ├── strategy.js # Tables de stratégie de base, rendu des charts
│   └── game.js     # Logique du jeu, FSM, comptage de cartes
└── favicon.svg
```

## Règles implémentées

- 6 jeux, S17 (dealer stands on soft 17)
- DAS (double after split)
- Late surrender
- Split jusqu'à 4 mains (pas de re-split des aces)
- Blackjack paye 3:2
- Insurance proposée sur As du dealer
