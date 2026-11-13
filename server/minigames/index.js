// Minigame registry. To add a minigame: create a file with the same shape as mash.js
// (id, name, instructions, controls, durationMs, better, setup, start, onInput,
// publicState, getResults) and add it to this list.

const all = [
  require('./mash'),
  require('./quickdraw'),
];

// Random minigame, avoiding an immediate repeat of the last one played.
function pick(lastId) {
  const pool = all.length > 1 ? all.filter(m => m.id !== lastId) : all;
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { all, pick };
