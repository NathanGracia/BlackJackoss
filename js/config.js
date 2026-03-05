/* ─────────────────────────────────────────────────────────────
   BlackJackoss — Configuration (équivalent .env pour le browser)
   Colle ton token Determinoss ci-dessous.
   ───────────────────────────────────────────────────────────── */

window.Config = {
  DETERMINOSS_TOKEN: '',   // ne pas mettre le token ici — il est lu depuis .env au runtime
  WS_URL: (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host,
};
