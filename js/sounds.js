/* ════════════════════════════════════════════════════════════════════
   BlackJackoss — Sound Design (Web Audio API, no external files)
   All sounds are synthesized procedurally.
   ════════════════════════════════════════════════════════════════════ */

window.Sounds = (() => {
  'use strict';

  let _ctx = null;

  function _getCtx() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  // Single sine/triangle note
  function _note(freq, vol, dur, when = 0, type = 'sine') {
    const ctx = _getCtx();
    const t   = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  // Filtered white noise burst
  function _noise(vol, dur, when = 0, hipass = 800) {
    const ctx = _getCtx();
    const t   = ctx.currentTime + when;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.8);
    const src  = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = hipass;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt);
    filt.connect(gain);
    gain.connect(ctx.destination);
    src.start(t);
  }

  return {

    // Call on first user gesture to unlock AudioContext early
    unlock() { _getCtx(); },

    // Card flip — quick noise snap + high tick
    deal() {
      _noise(0.14, 0.055, 0, 1200);
      _note(1800, 0.025, 0.04, 0.01, 'triangle');
    },

    // Chip placed on table — triangular click with pitch drop
    chip() {
      const ctx  = _getCtx();
      const t    = ctx.currentTime;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(950, t);
      osc.frequency.exponentialRampToValueAtTime(480, t + 0.055);
      gain.gain.setValueAtTime(0.13, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.08);
    },

    // Soft action click (HIT / STAND / DOUBLE…)
    action() {
      _note(700, 0.055, 0.06, 0, 'triangle');
    },

    // Surrender — falling glide
    surrender() {
      const ctx  = _getCtx();
      const t    = ctx.currentTime;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, t);
      osc.frequency.exponentialRampToValueAtTime(220, t + 0.28);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.31);
    },

    // Bust — low thud + noise
    bust() {
      _noise(0.18, 0.14, 0, 200);
      _note(140, 0.12, 0.22, 0.02, 'triangle');
    },

    // 21 — two quick ascending pings
    twentyone() {
      _note(880, 0.09, 0.14, 0);
      _note(1108, 0.09, 0.14, 0.1);
    },

    // Win — epic orchestral hit
    win(step = 0) {
      const ctx  = _getCtx();
      const mult = Math.pow(2, step * 2 / 12);
      const t    = ctx.currentTime;
      // Bass thud + low power chord
      _noise(0.22, 0.07, 0, 110);
      _note(98  * mult, 0.14, 0.55, 0,    'sawtooth');
      [196, 247, 294].forEach(f => _note(f * mult, 0.09, 0.45, 0.02, 'square'));
      // Rising frequency sweep
      { const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(260 * mult, t + 0.03);
        o.frequency.exponentialRampToValueAtTime(1500 * mult, t + 0.45);
        g.gain.setValueAtTime(0.11, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + 0.03); o.stop(t + 0.58); }
      // Bright top notes
      [[523, 0.12], [784, 0.22], [1047, 0.32]]
        .forEach(([f, w]) => _note(f * mult, 0.09, 0.28, w));
    },

    // Double win — massive orchestral explosion
    doubleWin(step = 0) {
      const ctx  = _getCtx();
      const mult = Math.pow(2, step * 2 / 12);
      const t    = ctx.currentTime;
      // Heavy bass + double noise hit
      _noise(0.30, 0.09, 0,    80);
      _noise(0.18, 0.07, 0.06, 500);
      _note(65  * mult, 0.18, 0.7, 0,    'sawtooth');
      _note(98  * mult, 0.14, 0.6, 0.02, 'sawtooth');
      // Power chord wall
      [196, 247, 294, 392].forEach(f => _note(f * mult, 0.11, 0.55, 0, 'square'));
      // Sweep up + sustain
      { const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(180 * mult, t + 0.02);
        o.frequency.exponentialRampToValueAtTime(2200 * mult, t + 0.5);
        g.gain.setValueAtTime(0.13, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + 0.02); o.stop(t + 0.68); }
      // Triumphant top fanfare
      [[523, 0.1], [784, 0.2], [1047, 0.3], [1319, 0.4], [1568, 0.5]]
        .forEach(([f, w]) => _note(f * mult, 0.12, 0.32, w));
    },

    // Push — neutral single ping
    push() {
      _note(440, 0.07, 0.18);
    },

    // Loss — cinematic doom drop
    loss() {
      const ctx = _getCtx();
      const t   = ctx.currentTime;
      // Heavy crash
      _noise(0.30, 0.20, 0,    75);
      _note(82, 0.16, 0.7, 0, 'sawtooth');
      // Descending pitch bomb
      { const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(300, t + 0.02);
        o.frequency.exponentialRampToValueAtTime(40, t + 1.05);
        g.gain.setValueAtTime(0.16, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 1.15);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + 0.02); o.stop(t + 1.2); }
      // Dissonant minor chord stab
      [110, 131, 156].forEach(f => _note(f, 0.09, 0.4, 0.05, 'square'));
      // Sub rumble
      _note(48, 0.07, 0.6, 0.08, 'sine');
    },

    // Blackjack — biggest possible orchestral fanfare
    blackjack(step = 0) {
      const ctx  = _getCtx();
      const mult = Math.pow(2, step * 2 / 12);
      const t    = ctx.currentTime;
      // Massive bass foundation
      _noise(0.28, 0.08, 0,    90);
      _note(65  * mult, 0.2,  0.8,  0,    'sawtooth');
      _note(98  * mult, 0.15, 0.7,  0.02, 'sawtooth');
      // Power chord wall
      [196, 247, 294, 392].forEach(f => _note(f * mult, 0.12, 0.6, 0, 'square'));
      // Heroic sweep
      { const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(200 * mult, t + 0.03);
        o.frequency.exponentialRampToValueAtTime(2800 * mult, t + 0.55);
        g.gain.setValueAtTime(0.14, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + 0.03); o.stop(t + 0.72); }
      // 6-note ascending fanfare
      [[523, 0.08], [659, 0.16], [784, 0.24], [1047, 0.33], [1319, 0.43], [1568, 0.55]]
        .forEach(([f, w]) => _note(f * mult, 0.14, 0.38, w));
    },

    // Shoe shuffle — cascading noise bursts
    shuffle() {
      for (let i = 0; i < 10; i++) _noise(0.06, 0.07, i * 0.055, 600);
    },

  };
})();
