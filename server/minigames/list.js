// All minigames. Each one is an engine (engines.js) plus settings.
// To add one: pick an engine, give it an id/name/instructions, and add it to the list below.

const { quiz, counter, reaction, selfReport, rand, randInt } = require('./engines');

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Build a question from a correct answer + wrong answers (shuffled)
const mc = (prompt, correct, wrongs) => {
  const options = shuffle([correct, ...wrongs]);
  return { prompt, options, answer: options.indexOf(correct) };
};
// Unique wrong numbers near the right one
const nearby = (n, count, spread = 5, min = 0) => {
  const out = new Set();
  while (out.size < count) { const w = n + randInt(-spread, spread); if (w !== n && w >= min) out.add(w); }
  return [...out];
};

const COLORS = [
  { name: 'RED', css: '#ff595e' }, { name: 'BLUE', css: '#4cc9f0' },
  { name: 'GREEN', css: '#8ac926' }, { name: 'YELLOW', css: '#ffca3a' },
];

const list = [
  // ---------- tap / mash ----------
  counter({
    id: 'mash', name: 'Mash Mania', instructions: 'Tap the button as fast as you can!',
  }),
  counter({
    id: 'tug', name: 'Tug of War', modes: ['2v2', '1v3'], durationMs: 8000,
    instructions: 'Teams only! Mash to pull the rope. Your team\'s average taps wins.',
  }),
  counter({
    id: 'sprint', name: 'Sprint Steps', alternate: true, cpuRate: [4, 7],
    instructions: 'Tap LEFT, RIGHT, LEFT, RIGHT… Alternate feet to run! Same foot twice doesn\'t count.',
  }),

  // ---------- timing ----------
  reaction({
    id: 'quickdraw', name: 'Quick Draw',
    instructions: 'Wait for GO… then tap! Tap early and you\'re out.',
  }),
  selfReport({
    id: 'perfectStop', name: 'Perfect Stop', controls: 'timing', mode: 'add', maxInputs: 3, min: 0, max: 100,
    durationMs: 14000, config: { periodMs: 1100, attempts: 3 },
    instructions: 'A marker slides back and forth. Tap to stop it in the middle. 3 tries, points add up.',
    cpuScore(ps, now) {
      if (ps.inputs < 3 && now >= ps.cpuNext) { ps.cpuNext = now + rand(2000, 3500); ps.v = (ps.v ?? 0) + randInt(45, 95); ps.inputs++; }
    },
  }),
  selfReport({
    id: 'holdBreath', name: 'Hold Your Breath', controls: 'hold', mode: 'once', better: 'lower', worst: 5000,
    min: 0, max: 60000, unit: 'ms off', durationMs: 13000, config: { targetMs: 5000 },
    instructions: 'Press and HOLD the button, then let go at exactly 5.00 seconds. Closest wins.',
    cpuScore(ps, now) { if (ps.v === null && now >= ps.cpuNext + 5000) ps.v = randInt(60, 900); },
  }),
  selfReport({
    id: 'blindTimer', name: 'Blind Timer', controls: 'blind', mode: 'once', better: 'lower', worst: 5000,
    min: 0, max: 60000, unit: 'ms off', durationMs: 17000, config: { targetMs: 10000, visibleMs: 3000 },
    instructions: 'A timer starts, then vanishes after 3 seconds. Tap when you think it hits 10.00.',
    cpuScore(ps, now) { if (ps.v === null && now >= ps.cpuNext + 9000) ps.v = randInt(100, 1600); },
  }),
  selfReport({
    id: 'beatKeeper', name: 'Beat Keeper', controls: 'rhythm', mode: 'add', min: 0, max: 400,
    durationMs: 15000, config: { bpm: 100 },
    instructions: 'Tap on every beat as the circle pulses. Perfect = 2 pts, Good = 1.',
    cpuScore(ps, now) { if (now >= ps.cpuNext) { ps.cpuNext = now + 600; ps.v = (ps.v ?? 0) + pick([0, 1, 1, 2, 2]); } },
  }),

  // ---------- phone mini-arcades ----------
  selfReport({
    id: 'moleSmash', name: 'Mole Smash', controls: 'grid', mode: 'add', min: -50, max: 200,
    durationMs: 15000, config: { spawnMs: 750, bombs: false },
    instructions: 'Moles 🐹 pop up on your screen. Tap them before they hide!',
    cpuScore(ps, now) { if (now >= ps.cpuNext) { ps.cpuNext = now + rand(700, 1300); ps.v = (ps.v ?? 0) + 1; } },
  }),
  selfReport({
    id: 'bombSquad', name: 'Bomb Squad', controls: 'grid', mode: 'add', min: -100, max: 200,
    durationMs: 15000, config: { spawnMs: 600, bombs: true, bombPenalty: 2 },
    instructions: 'Tap the coins 🪙, NOT the bombs 💣 (−2 each)!',
    cpuScore(ps, now) { if (now >= ps.cpuNext) { ps.cpuNext = now + rand(600, 1200); ps.v = (ps.v ?? 0) + (Math.random() < 0.85 ? 1 : -2); } },
  }),
  selfReport({
    id: 'memoryLane', name: 'Memory Lane', controls: 'memory', mode: 'max', min: 0, max: 50, unit: 'level',
    durationMs: 35000,
    instructions: 'Watch the pads light up, then repeat the pattern. It gets longer each level!',
    cpuScore(ps, now) {
      ps.cpuTarget ??= randInt(4, 9);
      if (now >= ps.cpuNext && (ps.v ?? 0) < ps.cpuTarget) { ps.cpuNext = now + 3000; ps.v = (ps.v ?? 0) + 1; }
    },
  }),

  // ---------- quick-fire questions (on your phone) ----------
  quiz({
    id: 'mathDash', name: 'Math Dash',
    instructions: 'Solve as many as you can! Wrong answers cost a point.',
    gen() {
      const op = pick(['+', '−', '×']);
      let a = randInt(2, 12), b = randInt(2, 12);
      if (op === '−' && b > a) [a, b] = [b, a];
      const ans = op === '+' ? a + b : op === '−' ? a - b : a * b;
      return mc({ text: `${a} ${op} ${b}`, size: 'xl' }, String(ans), nearby(ans, 3, op === '×' ? 10 : 4).map(String));
    },
  }),
  quiz({
    id: 'colorClash', name: 'Color Clash',
    instructions: 'Tap the COLOR the word is painted in, not what it says!',
    gen() {
      const word = pick(COLORS), ink = pick(COLORS.filter(c => c !== word));
      const options = shuffle(COLORS).map(c => ({ text: c.name, color: '#ffffff' }));
      return { prompt: { text: word.name, color: ink.css, size: 'xl' }, options, answer: options.findIndex(o => o.text === ink.name) };
    },
  }),
  quiz({
    id: 'countUp', name: 'Count Up',
    instructions: 'How many 🍄 mushrooms are there? Count fast!',
    gen() {
      const n = randInt(3, 9);
      const junk = Array.from({ length: randInt(6, 12) }, () => pick(['🌸', '🍀', '🌼', '🪨']));
      const all = shuffle([...Array(n).fill('🍄'), ...junk]).join(' ');
      return mc({ text: all, size: 'md' }, String(n), nearby(n, 3, 3, 1).map(String));
    },
  }),
  quiz({
    id: 'oddOneOut', name: 'Odd One Out',
    instructions: 'One emoji shows up only ONCE. Find it!',
    gen() {
      const set = shuffle(['🍎', '🍌', '🍇', '🍓', '🍒', '🥝', '🍑', '🍍']).slice(0, 4);
      const [once, ...rest] = set;
      const all = shuffle([once, ...rest.flatMap(e => Array(randInt(2, 4)).fill(e))]).join(' ');
      return mc({ text: all, size: 'lg' }, once, rest);
    },
  }),
  quiz({
    id: 'higherLower', name: 'Higher or Lower', penalty: 0, cpuAccuracy: 0.6,
    instructions: 'Will the next number (1–10) be higher or lower? Every right guess scores.',
    gen() {
      const n = randInt(2, 9);
      let next; do { next = randInt(1, 10); } while (next === n);
      const options = ['⬆️ Higher', '⬇️ Lower'];
      return { prompt: { text: String(n), size: 'xl' }, options, answer: next > n ? 0 : 1 };
    },
  }),
  quiz({
    id: 'simonSays', name: 'Simon Says',
    instructions: 'Tap the arrow, but ONLY if Simon says. Otherwise tap ✋ Stay!',
    gen() {
      const arrows = ['⬅️', '➡️', '⬆️', '⬇️'];
      const a = pick(arrows), simon = Math.random() < 0.65;
      const options = [...arrows, '✋ Stay'];
      return { prompt: { text: simon ? `Simon says ${a}` : `${a}`, size: 'lg' }, options, answer: simon ? arrows.indexOf(a) : 4 };
    },
  }),
  quiz({
    id: 'biggerBet', name: 'Bigger Bet',
    instructions: 'Which side is bigger? Quick!',
    gen() {
      const side = () => { const a = randInt(2, 12), b = randInt(2, 9); return Math.random() < 0.5 ? { t: `${a} × ${b}`, v: a * b } : { t: `${a * 3} + ${b * 4}`, v: a * 3 + b * 4 }; };
      let l = side(), r = side();
      while (l.v === r.v) r = side();
      return { prompt: { text: `${l.t}   vs   ${r.t}`, size: 'lg' }, options: ['⬅️ Left', 'Right ➡️'], answer: l.v > r.v ? 0 : 1 };
    },
  }),
  quiz({
    id: 'patternPanic', name: 'Pattern Panic',
    instructions: 'What number comes next in the pattern?',
    gen() {
      const start = randInt(1, 10), step = randInt(2, 7);
      const kind = pick(['add', 'add', 'double']);
      const seq = kind === 'add' ? [0, 1, 2, 3].map(i => start + step * i) : [0, 1, 2, 3].map(i => start * 2 ** i);
      const ans = kind === 'add' ? start + step * 4 : start * 16;
      return mc({ text: `${seq.join(', ')}, ?`, size: 'lg' }, String(ans), nearby(ans, 3, kind === 'add' ? 5 : 12, 1).map(String));
    },
  }),
  quiz({
    id: 'coinCounter', name: 'Coin Counter',
    instructions: 'Add it up! 🪙 = 1, 💰 = 5, 💎 = 10.',
    gen() {
      const coins = Array.from({ length: randInt(3, 7) }, () => pick(['🪙', '🪙', '💰', '💎']));
      const total = coins.reduce((s, c) => s + (c === '🪙' ? 1 : c === '💰' ? 5 : 10), 0);
      return mc({ text: coins.join(' '), size: 'lg' }, String(total), nearby(total, 3, 6, 1).map(String));
    },
  }),
  quiz({
    id: 'doorDash', name: 'Door Dash', penalty: 2, cpuAccuracy: 0.67,
    instructions: 'Pick a door! Two are safe (+1), one hides a trap (−2). Pure guts.',
    gen() {
      const trap = randInt(0, 2);
      return { prompt: { text: '🚪 🚪 🚪', size: 'xl' }, options: ['🚪 1', '🚪 2', '🚪 3'], answer: [0, 1, 2].filter(i => i !== trap) };
    },
  }),
];

module.exports = list;
