// CPU players: simple, readable heuristics. They aim for the Star, buy useful items,
// and pick on whoever is winning.

const { ITEMS } = require('./items');

const CPU_NAMES = ['Bolt', 'Pip', 'Rusty', 'Nova', 'Ziggy', 'Mochi'];
const chance = p => Math.random() < p;
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

// Answer any prompt (see Game.ask) for a CPU
function decide(game, p, prompt) {
  const values = prompt.options.filter(o => !o.disabled).map(o => o.value);
  const others = game.players.filter(o => o !== p);
  const richest = list => [...list].sort((a, b) => b.stars - a.stars || b.coins - a.coins)[0];

  switch (prompt.kind) {
    case 'star': return 'buy';
    case 'junction': {
      // Head toward the Star if one path is clearly closer; otherwise wander
      const star = game.star;
      const scored = values.map(v => ({ v, d: game.stepsBetween(v, star.to, p) }));
      scored.sort((a, b) => a.d - b.d);
      return chance(0.75) ? scored[0].v : pickOne(values);
    }
    case 'customDice': {
      const d = game.stepsBetween(p.pos, game.star.to, p);
      return d >= 1 && d <= 10 ? d : 10;
    }
    case 'shop': {
      const affordable = values.filter(v => v !== 'leave');
      if (!affordable.length || chance(0.35)) return 'leave';
      // Keep enough for a Star when close to 20 coins
      const spare = p.coins - game.starCost;
      const ok = affordable.filter(v => ITEMS[v].price <= Math.max(spare, 5));
      if (!ok.length) return 'leave';
      return ok.sort((a, b) => ITEMS[b].price - ITEMS[a].price)[0];
    }
    case 'bandit': return values.includes('star') ? 'star' : 'coins';
    case 'banditTarget': {
      const targets = others.filter(o => values.includes(o.id));
      return targets.length ? richest(targets).id : 'random';
    }
    case 'badDiceTarget': return (richest(others) || p).id;
    case 'discard': {
      // Throw away the cheapest item
      let worst = 0;
      p.items.forEach((id, i) => { if (ITEMS[id].price < ITEMS[p.items[worst]].price) worst = i; });
      return worst;
    }
    default: return prompt.defaultValue ?? values[0];
  }
}

// Which item (index) a CPU uses before rolling, or -1 for none
function chooseItem(game, p) {
  const has = id => p.items.indexOf(id);
  const others = game.players.filter(o => o !== p);
  const distToStar = game.stepsBetween(p.pos, game.star.to, p);
  const canBuyStar = p.coins >= game.starCost;
  const someoneHasStar = others.some(o => o.stars > 0);

  if (has('goldenPipe') >= 0 && canBuyStar) return has('goldenPipe');
  if (has('customDice') >= 0 && canBuyStar && distToStar <= 10) return has('customDice');
  if (has('banditCall') >= 0 && (p.coins >= 50 ? someoneHasStar : chance(0.6))) return has('banditCall');
  if (has('twister') >= 0 && distToStar > 15 && chance(0.6)) return has('twister');
  if (has('badDice') >= 0 && chance(0.5)) return has('badDice');
  for (const id of ['tripleDice', 'doubleDice', 'boost']) {
    if (has(id) >= 0 && (canBuyStar || chance(0.4))) return has(id);
  }
  if (has('warpBlock') >= 0 && others.length && chance(0.3)) return has('warpBlock');
  return -1;
}

module.exports = { decide, chooseItem, CPU_NAMES };
