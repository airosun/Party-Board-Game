// Quick Draw: wait for GO, then tap. Fastest reaction wins; tapping early disqualifies you.
//
// Lag fairness: each phone times its own reaction (from when GO appeared on that phone
// to the tap) and reports it. That cancels out network lag, but it means we trust the
// client. Fine for friends; if you ever go public, move timing server-side.

const MIN_HUMAN_MS = 90; // anything faster is almost certainly a pre-tap

module.exports = {
  id: 'quickdraw',
  name: 'Quick Draw',
  instructions: 'Wait for GO… then tap! Tap early and you\'re out.',
  controls: 'reaction',
  durationMs: 7000,
  better: 'lower',

  setup(players) {
    return {
      goAt: null,
      reactions: Object.fromEntries(players.map(p => [p.id, null])), // ms | 'early' | null
    };
  },

  start(state, now) {
    const speed = Math.max(1, Number(process.env.GAME_SPEED) || 1); // test mode only
    state.goAt = now + (1500 + Math.random() * 3000) / speed;
  },

  onInput(state, playerId, input, now) {
    if (!(playerId in state.reactions) || state.reactions[playerId] !== null) return; // one shot
    if (now < state.goAt - 150 || input?.early) {
      state.reactions[playerId] = 'early';
      return;
    }
    const ms = Number(input?.reactionMs);
    state.reactions[playerId] = Number.isFinite(ms) && ms >= MIN_HUMAN_MS ? Math.round(ms) : 'early';
  },

  publicState(state) {
    return {
      goInMs: state.goAt ? Math.max(0, state.goAt - Date.now()) : null,
      reactions: state.reactions,
    };
  },

  getResults(state) {
    return Object.entries(state.reactions).map(([playerId, r]) => ({
      playerId,
      score: typeof r === 'number' ? r : Infinity,
      display: r === 'early' ? 'Too early!' : r === null ? 'No tap' : `${r} ms`,
    }));
  },
};
