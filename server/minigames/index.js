// Minigame registry + picking. All minigames live in list.js.
const all = require('./list');

// Random minigame that supports `mode` ('ffa' | '2v2' | '1v3'), avoiding a repeat of lastId.
function pick(mode = 'ffa', lastId = null) {
  const fits = all.filter(m => m.modes.includes(mode));
  const pool = fits.length > 1 ? fits.filter(m => m.id !== lastId) : fits;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { all, pick };
