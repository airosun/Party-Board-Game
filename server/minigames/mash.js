// Mash Mania: tap as fast as you can. Most taps wins.
// Lag-friendly: only the total count matters, not exact timing.

const MIN_TAP_GAP_MS = 45; // ~22 taps/sec cap, stops auto-clickers from dominating

module.exports = {
  id: 'mash',
  name: 'Mash Mania',
  instructions: 'Tap the button as fast as you can!',
  controls: 'mash',          // tells the phone which controller UI to show
  durationMs: 6000,
  better: 'higher',          // higher score wins

  setup(players) {
    return {
      taps: Object.fromEntries(players.map(p => [p.id, 0])),
      lastTap: {},
    };
  },

  start(state, now) {},

  onInput(state, playerId, input, now) {
    if (!(playerId in state.taps)) return;
    const last = state.lastTap[playerId] || 0;
    if (now - last < MIN_TAP_GAP_MS) return;
    state.lastTap[playerId] = now;
    state.taps[playerId]++;
  },

  // What gets sent to screens during play (keep it small, it goes out ~5x/sec)
  publicState(state) {
    return { scores: state.taps };
  },

  getResults(state) {
    return Object.entries(state.taps).map(([playerId, score]) => ({
      playerId,
      score,
      display: `${score} taps`,
    }));
  },
};
