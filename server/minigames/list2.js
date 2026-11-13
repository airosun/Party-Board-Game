// Minigame pack 2: turn-taking games, team-only games, and more quick-fire games.

const { quiz, selfReport, turnGame, guessRounds, syncTap, balloon, rand, randInt, shuffle } = require('./engines');

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const mc = (prompt, correct, wrongs) => {
  const options = shuffle([correct, ...wrongs]);
  return { prompt, options, answer: options.indexOf(correct) };
};
const nearby = (n, count, spread = 5, min = 0) => {
  const out = new Set();
  while (out.size < count) { const w = n + randInt(-spread, spread); if (w !== n && w >= min) out.add(w); }
  return [...out];
};

// ---------- turn-taking (free-for-all only) ----------

const KEYS = [
  { id: 'kR', label: '🔑 Ruby key' }, { id: 'kB', label: '🗝️ Old iron key' }, { id: 'kG', label: '🔑 Emerald key' },
  { id: 'kS', label: '💀 Skull key' }, { id: 'kC', label: '⭐ Star key' },
];
const DOORS = [{ id: 'd1', label: '🚪 Left door' }, { id: 'd2', label: '🚪 Middle door' }, { id: 'd3', label: '🚪 Right door' }];

// 5 keys, 3 doors. Three keys each open one specific door; the other two keys open nothing.
// Open a door → that key and door are removed. After the 2nd door opens, one wrong key is
// thrown out, so the last door is a 50/50. Every try (and whether it worked) is public.
const keyDoor = turnGame({
  id: 'keyDoor', name: 'Key & Door',
  remainingLabel: 'Still locked in',
  instructions: 'Take turns: pick a key, then a door. Three of the 5 keys each open one door; two keys are duds. Open a door to escape! Watch everyone\'s tries. After two doors open, a dud key is thrown out.',
  init(s) {
    const keys = shuffle(KEYS.map(k => k.id));
    const doors = shuffle(DOORS.map(d => d.id));
    s.match = { [keys[0]]: doors[0], [keys[1]]: doors[1], [keys[2]]: doors[2] }; // keys[3], keys[4] are duds
    s.duds = [keys[3], keys[4]];
    s.keys = KEYS.map(k => k.id);   // keys still on the table
    s.doors = DOORS.map(d => d.id); // doors still closed
    s.tried = new Set();            // `${key}|${door}` that failed
    s.pending = null;               // key the current player picked
  },
  options: s => keyDoorOptions(s, true),
  prompt: s => (s.pending ? `Which door for the ${KEYS.find(k => k.id === s.pending).label}?` : 'Pick a key'),
  choose(s, id, choice) {
    const name = s.names[id];
    if (choice.startsWith('k')) { s.pending = choice; s.log.push(`${name} picks the ${KEYS.find(k => k.id === choice).label}…`); return 'again'; }
    const key = s.pending, keyLabel = KEYS.find(k => k.id === key).label, doorLabel = DOORS.find(d => d.id === choice).label;
    s.pending = null;
    if (s.match[key] === choice) {
      s.finished.push(id);
      s.keys = s.keys.filter(k => k !== key);
      s.doors = s.doors.filter(d => d !== choice);
      s.log.push(`🎉 ${name} opened the ${doorLabel} with the ${keyLabel}! Escaped!`);
      if (s.finished.length === 2) {
        const dud = pick(s.duds.filter(k => s.keys.includes(k)));
        if (dud) {
          s.keys = s.keys.filter(k => k !== dud);
          s.log.push(`🗑️ The ${KEYS.find(k => k.id === dud).label} was a dud: thrown out! Last door is a 50/50.`);
        }
      }
    } else {
      s.tried.add(`${key}|${choice}`);
      s.log.push(`❌ ${name}: ${keyLabel} + ${doorLabel} didn't work`);
    }
    return 'next';
  },
  cpuChoose: s => pick(keyDoorOptions(s, false).filter(o => !o.disabled)).id,
  isOver: s => s.order.length - s.finished.length <= 1 || !s.doors.length,
  view(s) {
    return {
      title: `Doors open: ${3 - s.doors.length} / 3 · Escaped: ${s.finished.map(id => s.names[id]).join(', ') || 'nobody yet'}`,
      grid: {
        rows: s.keys.map(id => KEYS.find(k => k.id === id).label),
        cols: s.doors.map(d => DOORS.find(x => x.id === d).label.replace('🚪 ', '')),
        cells: s.keys.map(k => s.doors.map(d => (s.tried.has(`${k}|${d}`) ? '❌' : (s.pending === k ? '👀' : '')))),
      },
    };
  },
});
// Keys you can still pick (not every remaining door already tried with it), then doors not yet tried with that key
function keyDoorOptions(s, labels) {
  const L = (list, id) => (labels ? { label: list.find(x => x.id === id).label } : {});
  if (!s.pending) return s.keys.map(id => ({ id, ...L(KEYS, id), disabled: s.doors.every(d => s.tried.has(`${id}|${d}`)) }));
  return s.doors.map(d => ({ id: d, ...L(DOORS, d), disabled: s.tried.has(`${s.pending}|${d}`) }));
}

const WIRE_COLORS = ['🔴 Red', '🔵 Blue', '🟢 Green', '🟡 Yellow', '🟣 Purple', '🟠 Orange'];
const wireCutter = turnGame({
  id: 'wireCutter', name: 'Wire Cutter',
  instructions: 'Take turns cutting a wire. One wire sets off the bomb: cut it and you\'re out! Then the bomb resets. Last one standing wins.',
  init(s) { s.reset = n => { s.wires = WIRE_COLORS.slice(0, n); s.cut = new Set(); s.bomb = randInt(0, n - 1); }; s.reset(6); },
  options: s => s.wires.map((w, i) => ({ id: `w${i}`, label: w, disabled: s.cut.has(i) })),
  prompt: () => 'Cut a wire…',
  choose(s, id, choice) {
    const i = Number(choice.slice(1));
    s.cut.add(i);
    if (i === s.bomb) {
      s.out.push(id);
      s.log.push(`💥 BOOM! ${s.names[id]} cut the ${s.wires[i]} wire and is out!`);
      s.reset(Math.max(3, s.order.length - s.out.length + 2));
    } else s.log.push(`✂️ ${s.names[id]} cut the ${s.wires[i]} wire… safe!`);
    return 'next';
  },
  cpuChoose: s => `w${pick(s.wires.map((_, i) => i).filter(i => !s.cut.has(i)))}`,
  isOver: s => s.order.length - s.out.length <= 1,
  view: s => ({ title: '💣 Which wire is it?', items: s.wires.map((w, i) => ({ label: w, cls: s.cut.has(i) ? 'gone' : '' })) }),
});

const numberBomb = turnGame({
  id: 'numberBomb', name: 'Number Bomb',
  instructions: 'A bomb hides on a number from 1–30. Take turns picking: you\'ll learn if it\'s higher or lower. Hit the bomb and you\'re out!',
  init(s) { s.reset = () => { s.lo = 1; s.hi = 30; s.bomb = randInt(1, 30); }; s.reset(); },
  options: s => Array.from({ length: s.hi - s.lo + 1 }, (_, i) => ({ id: `n${s.lo + i}`, label: String(s.lo + i) })),
  prompt: s => `Pick a number from ${s.lo} to ${s.hi}`,
  choose(s, id, choice) {
    const n = Number(choice.slice(1));
    if (n === s.bomb) {
      s.out.push(id);
      s.log.push(`💥 ${s.names[id]} picked ${n}: BOOM! Out! (new bomb hidden)`);
      s.reset();
    } else if (n < s.bomb) { s.lo = n + 1; s.log.push(`${s.names[id]} picked ${n}: the bomb is HIGHER ⬆️`); }
    else { s.hi = n - 1; s.log.push(`${s.names[id]} picked ${n}: the bomb is LOWER ⬇️`); }
    return 'next';
  },
  cpuChoose: s => `n${randInt(s.lo, s.hi)}`,
  isOver: s => s.order.length - s.out.length <= 1,
  view: s => ({ title: `💣 The bomb is between ${s.lo} and ${s.hi}`, items: Array.from({ length: 30 }, (_, i) => ({ label: String(i + 1), cls: i + 1 >= s.lo && i + 1 <= s.hi ? '' : 'gone' })), small: true }),
});

const treasureChests = turnGame({
  id: 'treasureChests', name: 'Treasure Chests', scoring: 'points',
  instructions: 'Take turns opening chests. Most hold coins, one has a 💎 (10!), but two have a 💀 that wipes your points to zero.',
  init(s) {
    s.chests = shuffle([1, 1, 2, 2, 3, 3, 4, 4, 5, 10, 'skull', 'skull']);
    s.opened = new Set();
  },
  options: s => s.chests.map((_, i) => ({ id: `c${i}`, label: `🧰 ${i + 1}`, disabled: s.opened.has(i) })),
  prompt: () => 'Open a chest!',
  choose(s, id, choice) {
    const i = Number(choice.slice(1));
    s.opened.add(i);
    const v = s.chests[i];
    if (v === 'skull') { s.points[id] = 0; s.log.push(`💀 ${s.names[id]} opened chest ${i + 1}: a skull! Points wiped!`); }
    else { s.points[id] += v; s.log.push(`${v === 10 ? '💎' : '🪙'} ${s.names[id]} opened chest ${i + 1}: +${v}`); }
    return 'next';
  },
  cpuChoose: s => `c${pick(s.chests.map((_, i) => i).filter(i => !s.opened.has(i)))}`,
  isOver: s => s.opened.size === s.chests.length,
  view: s => ({ title: '🧰 Treasure Chests', items: s.chests.map((v, i) => ({ label: s.opened.has(i) ? (v === 'skull' ? '💀' : v === 10 ? '💎 10' : `🪙 ${v}`) : `🧰 ${i + 1}`, cls: s.opened.has(i) ? (v === 'skull' ? 'hit' : 'open') : '' })) }),
});

const FACES = ['🐸', '🦊', '🐼', '🐙', '🦄', '🐝'];
const memoryMatch = turnGame({
  id: 'memoryMatch', name: 'Memory Match', scoring: 'points',
  instructions: 'Take turns flipping two cards. Find a matching pair to score and go again! Watch the others\' flips.',
  init(s) { s.cards = shuffle([...FACES, ...FACES]); s.matched = new Set(); s.first = null; s.showing = []; s.seen = {}; },
  options: s => s.cards.map((_, i) => ({ id: `m${i}`, label: s.matched.has(i) ? `✅ ${s.cards[i]}` : s.first === i ? s.cards[i] : `🂠 ${i + 1}`, disabled: s.matched.has(i) || s.first === i })),
  prompt: s => (s.first === null ? 'Flip a card' : `You flipped ${s.cards[s.first]}. Find its match!`),
  choose(s, id, choice, now) {
    const i = Number(choice.slice(1));
    s.seen[i] = s.cards[i];
    if (s.first === null) { s.first = i; s.log.push(`${s.names[id]} flipped ${s.cards[i]} (card ${i + 1})`); return 'again'; }
    const a = s.first;
    s.first = null;
    if (s.cards[a] === s.cards[i]) {
      s.matched.add(a); s.matched.add(i); s.points[id]++;
      s.log.push(`✅ ${s.names[id]} matched ${s.cards[i]}! Go again!`);
      return 'again';
    }
    s.showing = [a, i];
    s.pauseUntil = now + 1800 / Math.max(1, Number(process.env.GAME_SPEED) || 1);
    s.log.push(`❌ ${s.names[id]} flipped ${s.cards[i]} (card ${i + 1}): no match`);
    return 'next';
  },
  tick(s, now) { if (s.showing.length && now >= s.pauseUntil) s.showing = []; },
  cpuChoose(s) {
    const open = s.cards.map((_, i) => i).filter(i => !s.matched.has(i) && i !== s.first);
    const remember = () => Math.random() < 0.6;
    if (s.first !== null) {
      const known = open.find(i => s.seen[i] === s.cards[s.first]);
      return `m${known !== undefined && remember() ? known : pick(open)}`;
    }
    // A pair we've seen both halves of?
    for (const i of open) {
      const j = open.find(k => k !== i && s.seen[k] && s.seen[k] === s.seen[i]);
      if (j !== undefined && remember()) return `m${i}`;
    }
    return `m${pick(open)}`;
  },
  isOver: s => s.matched.size === s.cards.length,
  view: s => ({ title: `🃏 Pairs found: ${s.matched.size / 2} / ${FACES.length}`, items: s.cards.map((c, i) => ({ label: s.matched.has(i) || s.showing.includes(i) || s.first === i ? c : '🂠', cls: s.matched.has(i) ? 'open' : s.showing.includes(i) || s.first === i ? 'hit' : '' })) }),
});

// ---------- 1v3 only ----------

const hideSeek = guessRounds({
  id: 'hideSeek', name: 'Hide & Seek',
  instructions: '1 vs 3! The solo player hides in a spot; the other three each search one spot. Find them to win the round. 5 rounds.',
  spots: ['🌳 Tree', '🪨 Rock', '🏠 House', '🛶 Boat', '🌻 Flowers'],
  soloPrompt: 'Where do you hide?', crowdPrompt: 'Where are they hiding?',
  soloWins: (solo, crowd) => !crowd.includes(solo),
  describe: (s, soloWon) => (soloWon ? `${s.names[s.solo]} stayed hidden!` : `Found ${s.names[s.solo]}!`),
});

const ambush = guessRounds({
  id: 'ambush', name: 'Bandit Ambush',
  instructions: '1 vs 3! The solo player is the Bandit and blocks one road. The others each pick a road. Catch anyone to win the round; if everyone escapes, they win it.',
  spots: ['🌲 Forest path', '🏔️ Mountain pass', '🌊 Beach road', '🏜️ Desert trail'],
  soloPrompt: 'Which road do you ambush?', crowdPrompt: 'Which road do you run?',
  soloWins: (solo, crowd) => crowd.includes(solo),
  describe: (s, soloWon) => (soloWon ? `🦹 ${s.names[s.solo]} caught someone!` : 'Everyone escaped!'),
});

// ---------- 2v2 only ----------

const twinSync = syncTap({
  id: 'twinSync', name: 'Twin Sync',
  instructions: '2 vs 2! Tap at the SAME moment as your teammate (within 0.3s). Count down out loud, coordinate!',
});

const relayMath = quiz({
  id: 'relayMath', name: 'Math Relay', modes: ['2v2'],
  instructions: '2 vs 2! Two-step sums. Your team\'s average score wins.',
  gen() {
    const a = randInt(2, 9), b = randInt(2, 9), c = randInt(1, 20);
    const ans = a * b + c;
    return mc({ text: `${a} × ${b} + ${c}`, size: 'xl' }, String(ans), nearby(ans, 3, 8).map(String));
  },
});

// ---------- free-for-all only ----------

const balloonPump = balloon({
  id: 'balloonPump', name: 'Balloon Pump',
  instructions: 'Pump your balloon for points. Bank it before it pops! Every balloon pops at a different size.',
});

// ---------- quick-fire (any mode) ----------

const WORDS = ['STAR', 'COIN', 'DICE', 'BOAT', 'PALM', 'BANK', 'GOLD', 'KEYS', 'DOOR', 'PIPE', 'SHOP', 'ROAD', 'SAND', 'WAVE', 'FISH', 'LUCK', 'GAME', 'PLAY', 'TURN', 'JUMP', 'CAKE', 'MOON'];
const scramble = w => { let x; do { x = shuffle(w.split('')).join(''); } while (x === w); return x; };

const quick = [
  quiz({
    id: 'evenOdd', name: 'Even or Odd', instructions: 'Is the number even or odd? Fast!',
    gen: () => { const n = randInt(1, 99); return { prompt: { text: String(n), size: 'xl' }, options: ['Even', 'Odd'], answer: n % 2 }; },
  }),
  quiz({
    id: 'arrowFlip', name: 'Arrow Flip', instructions: 'Tap the OPPOSITE direction of the arrow!',
    gen: () => {
      const arrows = ['⬅️', '➡️', '⬆️', '⬇️'], opp = { '⬅️': '➡️', '➡️': '⬅️', '⬆️': '⬇️', '⬇️': '⬆️' };
      const a = pick(arrows);
      return { prompt: { text: a, size: 'xl' }, options: arrows, answer: arrows.indexOf(opp[a]) };
    },
  }),
  quiz({
    id: 'biggerGroup', name: 'Bigger Group', instructions: 'Which side has MORE?',
    gen: () => {
      const l = randInt(3, 9); let r; do { r = randInt(3, 9); } while (r === l);
      const e = pick(['🍎', '🐟', '⭐', '🪙']);
      return { prompt: { text: `${e.repeat(l)}\n—\n${e.repeat(r)}`, size: 'md' }, options: ['⬆️ Top', '⬇️ Bottom'], answer: l > r ? 0 : 1 };
    },
  }),
  quiz({
    id: 'wordScramble', name: 'Word Scramble', instructions: 'Unscramble the word!',
    gen: () => { const w = pick(WORDS); return mc({ text: scramble(w), size: 'xl' }, w, shuffle(WORDS.filter(x => x !== w)).slice(0, 3)); },
  }),
  quiz({
    id: 'sumTen', name: 'Make Ten', instructions: 'What number makes 10?',
    gen: () => { const a = randInt(1, 9); return mc({ text: `${a} + ? = 10`, size: 'xl' }, String(10 - a), nearby(10 - a, 3, 3, 0).map(String)); },
  }),
  quiz({
    id: 'colorCount', name: 'Color Count', instructions: 'How many 🟥 red squares?',
    gen: () => {
      const n = randInt(2, 8);
      const all = shuffle([...Array(n).fill('🟥'), ...Array.from({ length: randInt(6, 12) }, () => pick(['🟦', '🟩', '🟨', '🟧']))]).join('');
      return mc({ text: all, size: 'md' }, String(n), nearby(n, 3, 3, 1).map(String));
    },
  }),
];

// ---------- more timing / arcade ----------

const more = [
  selfReport({
    id: 'stopwatch', name: 'Stopwatch', controls: 'blind', mode: 'once', better: 'lower', worst: 5000,
    min: 0, max: 60000, unit: 'ms off', durationMs: 14000, config: { targetMs: 7770, visibleMs: 999999 },
    instructions: 'Stop the clock at exactly 7.77 seconds. You can see it the whole time… can you nail it?',
    cpuScore(ps, now) { if (ps.v === null && now >= ps.cpuNext + 7000) ps.v = randInt(10, 400); },
  }),
  selfReport({
    id: 'speedMole', name: 'Speed Mole', controls: 'grid', mode: 'add', min: -50, max: 300,
    durationMs: 12000, config: { spawnMs: 430, bombs: false },
    instructions: 'Like Mole Smash, but the moles are FAST. Tap tap tap!',
    cpuScore(ps, now) { if (now >= ps.cpuNext) { ps.cpuNext = now + rand(500, 1000); ps.v = (ps.v ?? 0) + 1; } },
  }),
  selfReport({
    id: 'goldenHold', name: 'Golden Hold', controls: 'hold', mode: 'once', better: 'lower', worst: 5000,
    min: 0, max: 60000, unit: 'ms off', durationMs: 11000, config: { targetMs: 3330 },
    instructions: 'Press and HOLD, then release at exactly 3.33 seconds.',
    cpuScore(ps, now) { if (ps.v === null && now >= ps.cpuNext + 3300) ps.v = randInt(50, 700); },
  }),
  selfReport({
    id: 'rhythmRush', name: 'Rhythm Rush', controls: 'rhythm', mode: 'add', min: 0, max: 400,
    durationMs: 13000, config: { bpm: 140 },
    instructions: 'Beat Keeper, but faster! Tap on every pulse.',
    cpuScore(ps, now) { if (now >= ps.cpuNext) { ps.cpuNext = now + 430; ps.v = (ps.v ?? 0) + pick([0, 1, 1, 2]); } },
  }),
];

module.exports = [keyDoor, wireCutter, numberBomb, treasureChests, memoryMatch, hideSeek, ambush, twinSync, relayMath, balloonPump, ...quick, ...more];
