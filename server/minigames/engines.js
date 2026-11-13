// Minigame "engines": reusable game types. Each minigame in list.js is one engine + settings.
//
// A minigame definition has:
//   id, name, instructions, controls   controls tells the phone which controller to show
//   durationMs, better                 'higher' or 'lower' score wins
//   modes                              which of 'ffa' | '2v2' | '1v3' it can be played in
//   config                             extra settings sent to phones (e.g. target time)
//   setup(players) → state
//   start(state, now)
//   onInput(state, playerId, input, now)
//   publicState(state) → { scores: {id: number|null}, display: {id: text}, perPlayer?: {id: {...}} }
//   getResults(state) → [{ playerId, score, display }]
//   cpu(state, playerId, now)           called ~5x/sec for each CPU player
//   worst                               score used for players who didn't play (team averages)
//
// Lag: most engines either only count totals or let the phone time/score itself and report it.
// Phone-reported scores are trusted (fine for friends), but clamped to sane ranges.

const ALL_MODES = ['ffa', '2v2', '1v3'];
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const perPlayer = (players, make) => Object.fromEntries(players.map(p => [p.id, make(p)]));
const isCpu = (state, id) => state.cpu?.has(id);

function base(def) {
  return { modes: ALL_MODES, better: 'higher', config: {}, worst: 0, ...def };
}

// ---------- Quiz: a stream of multiple-choice questions on your own phone ----------
// gen() → { prompt: { text, color?, size? }, options: [text | {text,color}], answer: index | [indexes] }
const isRight = (q, a) => (Array.isArray(q.answer) ? q.answer.includes(a) : a === q.answer);
function quiz({ penalty = 1, durationMs = 20000, cpuAccuracy = 0.75, cpuSpeed = [1400, 2600], gen, ...def }) {
  const nextQ = s => { s.qid++; return { ...gen(), qid: s.qid }; };
  return base({
    controls: 'quiz', durationMs, ...def,
    setup: players => ({ qid: 0, p: perPlayer(players, () => ({ score: 0, right: 0, wrong: 0, q: null, cpuNext: 0 })) }),
    start(s, now) { for (const ps of Object.values(s.p)) { ps.q = nextQ(s); ps.cpuNext = now + rand(...cpuSpeed); } },
    onInput(s, id, input) {
      const ps = s.p[id];
      if (!ps?.q || input?.qid !== ps.q.qid) return;
      if (isRight(ps.q, Number(input.answer))) { ps.score++; ps.right++; } else { ps.score -= penalty; ps.wrong++; }
      ps.q = nextQ(s);
    },
    cpu(s, id, now) {
      const ps = s.p[id];
      if (now < ps.cpuNext) return;
      ps.cpuNext = now + rand(...cpuSpeed);
      const idx = ps.q.options.map((_, i) => i);
      const pool = Math.random() < cpuAccuracy ? idx.filter(i => isRight(ps.q, i)) : idx.filter(i => !isRight(ps.q, i));
      this.onInput(s, id, { qid: ps.q.qid, answer: pool[Math.floor(Math.random() * pool.length)] });
    },
    publicState: s => ({
      scores: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.score])),
      display: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, `${ps.right} ✓  ${ps.wrong} ✗`])),
      perPlayer: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.q && { qid: ps.q.qid, prompt: ps.q.prompt, options: ps.q.options }])),
    }),
    getResults: s => Object.entries(s.p).map(([playerId, ps]) => ({ playerId, score: ps.score, display: `${ps.score} pts (${ps.right}✓ ${ps.wrong}✗)` })),
  });
}

// ---------- Counters: mash one button, or alternate two ----------
function counter({ alternate = false, cpuRate = [5, 8], durationMs = 7000, ...def }) {
  return base({
    controls: alternate ? 'alternate' : 'mash', durationMs, ...def,
    setup: players => ({ p: perPlayer(players, () => ({ n: 0, last: 0, side: null, rate: rand(...cpuRate) })) }),
    start() {},
    onInput(s, id, input, now) {
      const ps = s.p[id];
      if (!ps || now - ps.last < 45) return; // ~22 taps/sec cap
      if (alternate) {
        if (input?.side !== 'L' && input?.side !== 'R') return;
        if (input.side === ps.side) return; // must alternate
        ps.side = input.side;
      }
      ps.last = now;
      ps.n++;
    },
    cpu(s, id) {
      const ps = s.p[id];
      ps.acc = (ps.acc || 0) + (ps.rate / 5) * rand(0.7, 1.3); // called 5x/sec
      while (ps.acc >= 1) { ps.n++; ps.acc--; }
    },
    publicState: s => ({
      scores: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.n])),
      display: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, `${ps.n} ${alternate ? 'steps' : 'taps'}`])),
    }),
    getResults: s => Object.entries(s.p).map(([playerId, ps]) => ({ playerId, score: ps.n, display: `${ps.n} ${alternate ? 'steps' : 'taps'}` })),
  });
}

// ---------- Reaction: wait for GO, then tap (phone times itself) ----------
function reaction(def) {
  return base({
    controls: 'reaction', durationMs: 7000, better: 'lower', worst: 2000, ...def,
    setup: players => ({ goAt: null, r: perPlayer(players, () => null), cpuMs: perPlayer(players, () => randInt(230, 480)) }),
    start(s, now) {
      const speed = Math.max(1, Number(process.env.GAME_SPEED) || 1); // test mode only
      s.goAt = now + rand(1500, 4500) / speed;
    },
    onInput(s, id, input, now) {
      if (!(id in s.r) || s.r[id] !== null) return; // one shot
      if (now < s.goAt - 150 || input?.early) { s.r[id] = 'early'; return; }
      const ms = Number(input?.reactionMs);
      s.r[id] = Number.isFinite(ms) && ms >= 90 ? Math.round(ms) : 'early';
    },
    cpu(s, id, now) { if (s.r[id] === null && now >= s.goAt + s.cpuMs[id]) s.r[id] = s.cpuMs[id]; },
    publicState: s => ({
      goInMs: s.goAt ? Math.max(0, s.goAt - Date.now()) : null,
      scores: Object.fromEntries(Object.entries(s.r).map(([id, r]) => [id, typeof r === 'number' ? r : null])),
      display: Object.fromEntries(Object.entries(s.r).map(([id, r]) => [id, r === null ? '…' : r === 'early' ? '❌ too early' : '✅ tapped'])),
    }),
    getResults: s => Object.entries(s.r).map(([playerId, r]) => ({
      playerId, score: typeof r === 'number' ? r : Infinity,
      display: r === 'early' ? 'Too early!' : r === null ? 'No tap' : `${r} ms`,
    })),
  });
}

// ---------- Self-reported: the phone runs the game and reports a number ----------
// mode 'add'  → each input adds input.points (live scores, e.g. whack-a-mole)
// mode 'once' → one final input.value per player (e.g. how long you held)
// mode 'max'  → keep the best input.value (e.g. memory level reached)
function selfReport({ mode = 'add', min = -999, max = 999, maxInputs = 9999, cpuScore, unit = 'pts', ...def }) {
  return base({
    ...def,
    setup: players => ({ p: perPlayer(players, () => ({ v: null, inputs: 0, cpuTarget: null, cpuNext: 0 })) }),
    start(s, now) { for (const ps of Object.values(s.p)) ps.cpuNext = now + rand(800, 1600); },
    onInput(s, id, input) {
      const ps = s.p[id];
      if (!ps || ps.inputs >= maxInputs) return;
      const n = Number(mode === 'add' ? input?.points : input?.value);
      if (!Number.isFinite(n)) return;
      if (mode === 'once' && ps.v !== null) return;
      ps.inputs++;
      const v = clamp(n, min, max);
      if (mode === 'add') ps.v = clamp((ps.v ?? 0) + v, min, max);
      else if (mode === 'max') ps.v = Math.max(ps.v ?? v, v);
      else ps.v = v;
    },
    cpu(s, id, now) { cpuScore(s.p[id], now, this); },
    publicState: s => ({
      scores: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.v])),
      display: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.v === null ? 'playing…' : mode === 'once' ? '✅ done' : `${ps.v} ${unit}`])),
    }),
    getResults(s) {
      return Object.entries(s.p).map(([playerId, ps]) => ({
        playerId,
        score: ps.v === null ? (this.better === 'lower' ? Infinity : 0) : ps.v,
        display: ps.v === null ? 'No score' : `${ps.v} ${unit}`,
      }));
    },
  });
}

module.exports = { quiz, counter, reaction, selfReport, rand, randInt, clamp, isCpu, ALL_MODES };
