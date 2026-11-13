// Board space types.
//
// Each type can define:
//   passOnly  true → not a real space: walking through it costs no step and you can't stop on it
//   onPass(game, player, nodeId)  runs when you move THROUGH the space (not when you stop on it)
//   onLand(game, player, nodeId)  runs when your move ends on the space
//   name / color / icon / desc    sent to the screens for drawing + the legend
//
// Hooks are async so they can ask the player something (game.ask) or spin a roulette.

const { ITEMS, MAX_ITEMS } = require('./items');

const BLUE_COINS = 3;
const RED_COINS = 3;
const BANK_FEE = 5;
const STAR_STEAL_COST = 50;
const COIN_STEAL_MIN = 8;
const COIN_STEAL_MAX = 20;

const pickRandom = arr => arr[Math.floor(Math.random() * arr.length)];

const SPACES = {
  start: {
    name: 'Start', color: '#f4f1de', icon: 'GO', desc: 'Where everyone begins',
    async onLand(game, p) { game.addLog(`${p.name} landed on START.`); },
  },

  blue: {
    name: 'Blue Space', color: '#1982c4', icon: '+', desc: '+3 coins (doubled in the last 5 turns)',
    async onLand(game, p) {
      const amt = BLUE_COINS * (game.isFinalStretch() ? 2 : 1);
      game.give(p, amt);
      game.addLog(`🔵 ${p.name} landed on a blue space: +${amt} coins`);
    },
  },

  red: {
    name: 'Red Space', color: '#e63946', icon: '−', desc: '−3 coins (doubled in the last 5 turns)',
    async onLand(game, p) {
      const amt = RED_COINS * (game.isFinalStretch() ? 2 : 1);
      game.give(p, -amt);
      p.redCount++;
      game.addLog(`🔴 ${p.name} landed on a red space: −${amt} coins`);
    },
  },

  shop: {
    name: 'Item Shop', color: '#06d6a0', icon: '🛒', passOnly: true,
    desc: 'Walk past to buy one item (doesn\'t use a step)',
    async onPass(game, p) {
      const stock = Object.entries(ITEMS);
      const unlocked = stock.filter(([id]) => game.itemUnlocked(id));
      const cheapest = Math.min(...unlocked.map(([, it]) => it.price));
      if (p.items.length >= MAX_ITEMS) {
        game.addLog(`🛒 ${p.name}'s bag is full (${MAX_ITEMS} items).`);
        return game.beat();
      }
      if (p.coins < cheapest) {
        game.addLog(`🛒 ${p.name} can't afford anything (cheapest is ${cheapest} coins).`);
        return game.beat();
      }
      const choice = await game.ask(p, 'SHOP', {
        kind: 'shop',
        text: `Item Shop! You have ${p.coins} coins.`,
        options: [
          ...stock.map(([id, it]) => {
            const locked = !game.itemUnlocked(id);
            return {
              value: id,
              label: `${it.icon} ${it.name}: ${it.price}🪙`,
              desc: locked ? `🔒 In stock from turn ${game.rareUnlockRound()}` : it.desc,
              disabled: locked || it.price > p.coins,
            };
          }),
          { value: 'leave', label: 'Just looking' },
        ],
        defaultValue: 'leave',
      });
      if (choice !== 'leave') {
        const it = ITEMS[choice];
        p.coins -= it.price;
        p.items.push(choice);
        game.addLog(`🛒 ${p.name} bought a ${it.name}!`);
      }
      return game.beat();
    },
  },

  lucky: {
    name: 'Lucky Space', color: '#2ec4b6', icon: '🍀', desc: 'Spin for something good',
    async onLand(game, p) {
      const others = game.players.filter(o => o !== p);
      const leader = game.leader();
      await game.roulette(p, `🍀 ${p.name}: Lucky Space!`, [
        { label: '+10 coins', weight: 3, run: () => { game.give(p, 10); return `${p.name} got 10 coins`; } },
        { label: '+20 coins', weight: 1, run: () => { game.give(p, 20); return `${p.name} got 20 coins!`; } },
        {
          label: 'Free item', weight: 2,
          run: () => {
            if (p.items.length >= MAX_ITEMS) { game.give(p, 10); return `${p.name}'s bag is full: +10 coins instead`; }
            const id = pickRandom(Object.keys(ITEMS).filter(i => game.itemUnlocked(i)));
            p.items.push(id);
            return `${p.name} got a free ${ITEMS[id].name}!`;
          },
        },
        {
          label: 'Leader pays you 10', weight: 1, available: others.length > 0 && leader !== p,
          run: () => {
            const amt = Math.min(10, leader.coins);
            game.give(leader, -amt); game.give(p, amt);
            return `${leader.name} paid ${p.name} ${amt} coins`;
          },
        },
      ]);
    },
  },

  badluck: {
    name: 'Super Bad Luck Space', color: '#3d0814', icon: '💀', desc: 'Spin for something terrible',
    async onLand(game, p) {
      const others = game.players.filter(o => o !== p);
      const last = game.lastPlace(p);
      await game.roulette(p, `💀 ${p.name}: Super Bad Luck!`, [
        { label: 'Lose 10 coins', weight: 3, run: () => { const a = Math.min(10, p.coins); game.give(p, -a); return `${p.name} lost ${a} coins`; } },
        { label: 'Lose half your coins', weight: 1, run: () => { const a = Math.floor(p.coins / 2); game.give(p, -a); return `${p.name} lost half their coins (${a})!`; } },
        {
          label: 'Pay everyone 5', weight: 2, available: others.length > 0,
          run: () => {
            others.forEach(o => { const a = Math.min(5, p.coins); game.give(p, -a); game.give(o, a); });
            return `${p.name} paid everyone 5 coins`;
          },
        },
        {
          label: 'Give last place 10', weight: 2, available: last && last !== p,
          run: () => { const a = Math.min(10, p.coins); game.give(p, -a); game.give(last, a); return `${p.name} gave ${last.name} ${a} coins`; },
        },
        { label: 'The Star moves!', weight: 2, run: () => { game.moveStar(); return 'The Star flew to a new spot!'; } },
        {
          label: 'Lose a Star', weight: 1, available: p.stars > 0,
          run: () => { p.stars--; return `${p.name} LOST A STAR!`; },
        },
      ]);
    },
  },

  vs: {
    name: 'VS Space', color: '#fb5607', icon: 'VS', desc: 'Everyone bets coins on a minigame. Turns blue after',
    async onLand(game, p, nodeId) {
      let wager = 0;
      await game.roulette(p, `⚔️ ${p.name} started a VS battle! Wager:`, [5, 10, 15, 20].map(w => ({
        label: `${w} coins each`, weight: 1, run: () => { wager = w; return `Everyone puts in ${w} coins!`; },
      })));
      let pot = 0;
      game.players.forEach(o => { const a = Math.min(wager, o.coins); game.give(o, -a); pot += a; });
      game.setSpaceType(nodeId, 'blue');
      game.addLog(`⚔️ VS pot: ${pot} coins. This space is now blue.`);
      await game.playMinigame({ banner: `VS Battle: winner takes ${pot} coins`, payout: rows => {
        const winners = rows.filter(r => r.valid && r.place === 1);
        if (!winners.length) { // nobody scored: refund
          rows.forEach(r => { r.reward = 0; });
          game.players.forEach(o => game.give(o, Math.floor(pot / game.players.length)));
          return;
        }
        const share = Math.floor(pot / winners.length);
        rows.forEach(r => { r.reward = winners.includes(r) ? share : 0; });
      } });
    },
  },

  bank: {
    name: 'Bank', color: '#ffb703', icon: '🏦', desc: `Pass: pay ${BANK_FEE} coins. Land: take everything in the bank`,
    async onPass(game, p) {
      const a = Math.min(BANK_FEE, p.coins);
      if (!a) return;
      game.give(p, -a);
      game.bank += a;
      game.addLog(`🏦 ${p.name} paid ${a} coins to the Bank (now ${game.bank}).`);
      return game.beat();
    },
    async onLand(game, p) {
      const a = game.bank;
      game.bank = 0;
      game.give(p, a);
      game.addLog(a ? `🏦 ${p.name} cashed out the Bank: +${a} coins!` : `🏦 ${p.name} landed on the Bank… it's empty.`);
    },
  },

  event: {
    // Placeholder: effect still to be designed. Landing here does nothing yet.
    name: '? Space', color: '#8338ec', icon: '?', desc: 'Mystery space (effect coming soon)',
    async onLand(game, p) {
      game.addLog(`❓ ${p.name} landed on a ? Space… nothing happens (yet).`);
    },
  },

  bandit: {
    name: 'Bandit', color: '#9d4edd', icon: '🦹', passOnly: true,
    desc: `Walk past to steal ${COIN_STEAL_MIN}–${COIN_STEAL_MAX} coins (free) or a Star (${STAR_STEAL_COST} coins)`,
    async onPass(game, p) { await banditEncounter(game, p); },
  },

  chance: {
    name: 'Chance Space', color: '#ff006e', icon: '?!', desc: 'Two random players trade something',
    async onLand(game, p) {
      if (game.players.length < 2) {
        game.give(p, 5);
        game.addLog(`❗ Chance Space, but nobody to trade with: +5 coins`);
        return;
      }
      const [a, b] = [...game.players].sort(() => Math.random() - 0.5);
      await game.roulette(p, `❗ Chance Time: ${a.name} ⇄ ${b.name}`, [
        { label: 'Swap coins', weight: 2, run: () => { [a.coins, b.coins] = [b.coins, a.coins]; return `${a.name} and ${b.name} swapped coins!`; } },
        { label: 'Swap Stars', weight: 1, run: () => { [a.stars, b.stars] = [b.stars, a.stars]; return `${a.name} and ${b.name} swapped Stars!!`; } },
        { label: 'Swap spaces', weight: 2, run: () => { [a.pos, b.pos] = [b.pos, a.pos]; return `${a.name} and ${b.name} swapped places!`; } },
        { label: `${a.name} → ${b.name}: 10 coins`, weight: 2, run: () => { const x = Math.min(10, a.coins); game.give(a, -x); game.give(b, x); return `${a.name} gave ${b.name} ${x} coins`; } },
        { label: `${b.name} → ${a.name}: 10 coins`, weight: 2, run: () => { const x = Math.min(10, b.coins); game.give(b, -x); game.give(a, x); return `${b.name} gave ${a.name} ${x} coins`; } },
      ]);
    },
  },
};

// The Bandit: used by Bandit spaces and the Bandit Call item.
// Must pick coins or a Star (Star is greyed out without enough coins or if nobody has one),
// then pick a victim or let it be random.
async function banditEncounter(game, p) {
  const others = game.players.filter(o => o !== p);
  if (!others.length) {
    game.addLog(`🦹 The Bandit has nobody to rob for ${p.name}.`);
    return game.beat();
  }
  const starTargets = others.filter(o => o.stars > 0);
  const canStar = p.coins >= STAR_STEAL_COST && starTargets.length > 0;
  const mode = await game.ask(p, 'BANDIT', {
    kind: 'bandit',
    text: '🦹 The Bandit! What should I steal?',
    options: [
      { value: 'coins', label: '💰 Steal coins (free)', desc: `Take ${COIN_STEAL_MIN}–${COIN_STEAL_MAX} coins from someone` },
      {
        value: 'star', label: `⭐ Steal a Star (${STAR_STEAL_COST} coins)`, disabled: !canStar,
        desc: p.coins < STAR_STEAL_COST ? `You need ${STAR_STEAL_COST} coins` : !starTargets.length ? 'Nobody has a Star yet' : 'Take a Star from someone',
      },
    ],
    defaultValue: 'coins',
  });

  const pool = mode === 'star' ? starTargets : others;
  const pick = await game.ask(p, 'BANDIT', {
    kind: 'banditTarget',
    text: mode === 'star' ? 'Steal a Star from…' : 'Steal coins from…',
    options: [
      ...pool.map(o => ({ value: o.id, label: `${o.name}  ⭐${o.stars} 🪙${o.coins}` })),
      { value: 'random', label: '🎲 Random player' },
    ],
    defaultValue: 'random',
  });
  const victim = pick === 'random' ? pickRandom(pool) : pool.find(o => o.id === pick);

  if (mode === 'star') {
    p.coins -= STAR_STEAL_COST;
    victim.stars--;
    p.stars++;
    game.addLog(`🦹⭐ ${p.name} paid ${STAR_STEAL_COST} coins and stole a STAR from ${victim.name}!`);
  } else {
    const roll = COIN_STEAL_MIN + Math.floor(Math.random() * (COIN_STEAL_MAX - COIN_STEAL_MIN + 1));
    const amt = Math.min(roll, victim.coins);
    game.give(victim, -amt);
    game.give(p, amt);
    game.addLog(amt === 0
      ? `🦹 ${p.name} tried to rob ${victim.name}, but they're broke!`
      : `🦹 ${p.name} stole ${amt} coins from ${victim.name}${amt < roll ? ' (all they had!)' : ''}`);
  }
  return game.beat();
}

// Display info only (sent to screens)
const SPACE_META = Object.fromEntries(Object.entries(SPACES).map(([id, s]) => [id, {
  name: s.name, color: s.color, icon: s.icon, desc: s.desc, passOnly: !!s.passOnly,
}]));

module.exports = { SPACES, SPACE_META, banditEncounter };
