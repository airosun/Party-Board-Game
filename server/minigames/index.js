// Minigame registry + picking. All minigames live in list.js.
const all = [...require('./list'), ...require('./list2')];

// Random minigame that supports `mode` ('ffa' | '2v2' | '1v3'), avoiding a repeat of lastId.
function pick(mode = 'ffa', lastId = null) {
  const fits = all.filter(m => m.modes.includes(mode));
  // Dev/testing: MINIGAME=keyDoor,balloonPump forces those whenever the mode allows
  const forced = (process.env.MINIGAME || '').split(',').map(x => x.trim()).filter(Boolean);
  const forcedFits = fits.filter(m => forced.includes(m.id));
  if (forcedFits.length) return forcedFits[Math.floor(Math.random() * forcedFits.length)];
  const pool = fits.length > 1 ? fits.filter(m => m.id !== lastId) : fits;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { all, pick };
