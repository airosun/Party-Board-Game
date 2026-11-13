// Board registry. The first board is the default. Add a JSON file and list it here.
const list = [
  require('./bandit-bay.json'),
  require('./classic.json'),
];
const byId = Object.fromEntries(list.map(b => [b.id, b]));
module.exports = { list, byId, defaultBoard: list[0] };
