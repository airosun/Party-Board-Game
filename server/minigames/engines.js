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

const SPEED = Math.max(1, Number(process.env.GAME_SPEED) || 1);
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- Turn-taking games (free-for-all only) ----------
// Players go one at a time in a random order. Everyone sees every pick on the TV + phones.
// cfg.init(s, players)              set up the board
// cfg.options(s, id) → [{id,label,disabled}]   what the current player can pick
// cfg.prompt(s, id) → text
// cfg.choose(s, id, optionId, now) → 'again' (same player picks again) | 'next'
// cfg.cpuChoose(s, id) → optionId
// cfg.isOver(s), cfg.view(s) → { title, items:[{label, cls}], grid? }
// cfg.scoring: 'places' (finish order, s.finished / s.out) or 'points' (s.points)
function turnGame({ turnMs = 20000, durationMs = 300000, scoring = 'places', remainingLabel = 'Last one standing', ...cfg }) {
  const active = s => s.order.filter(id => !s.finished.includes(id) && !s.out.includes(id));
  const def = base({
    controls: 'turns', durationMs, modes: ['ffa'], better: scoring === 'points' ? 'higher' : 'lower', worst: 99,
    instructions: cfg.instructions, id: cfg.id, name: cfg.name,
    setup(players) {
      const s = { order: shuffle(players.map(p => p.id)), names: Object.fromEntries(players.map(p => [p.id, p.name])), idx: 0,
        finished: [], out: [], points: Object.fromEntries(players.map(p => [p.id, 0])), log: [], turnStart: 0, cpuAt: 0, pauseUntil: 0 };
      cfg.init(s, players);
      return s;
    },
    start(s, now) { s.turnStart = now; s.cpuAt = now + rand(1500, 2500) / SPEED; s.log.push(`Turn order: ${s.order.map(id => s.names[id]).join(' → ')}`); },
    current: s => (active(s).length ? s.order[s.idx] : null),
    apply(s, id, choice, now) {
      const res = cfg.choose(s, id, choice, now);
      if (res !== 'again' && !cfg.isOver(s)) {
        // next player who is still in
        for (let k = 1; k <= s.order.length; k++) {
          const j = (s.idx + k) % s.order.length;
          if (active(s).includes(s.order[j])) { s.idx = j; break; }
        }
      }
      if (!active(s).includes(s.order[s.idx]) && active(s).length) s.idx = s.order.indexOf(active(s)[0]);
      s.turnStart = Math.max(now, s.pauseUntil);
      s.cpuAt = s.turnStart + rand(1200, 2400) / SPEED;
    },
    onInput(s, id, input, now) {
      if (now < s.pauseUntil || def.current(s) !== id || cfg.isOver(s)) return;
      const opt = cfg.options(s, id).find(o => o.id === input?.choice && !o.disabled);
      if (opt) def.apply(s, id, opt.id, now);
    },
    cpu(s, id, now) {
      if (def.current(s) === id && now >= s.cpuAt && now >= s.pauseUntil && !cfg.isOver(s)) def.apply(s, id, cfg.cpuChoose(s, id), now);
    },
    tick(s, now) {
      cfg.tick?.(s, now);
      // Slow humans get a random pick after turnMs so the game keeps moving
      const cur = def.current(s);
      if (cur && !cfg.isOver(s) && now >= s.pauseUntil && now - s.turnStart > turnMs / SPEED) def.apply(s, cur, cfg.cpuChoose(s, cur), now);
    },
    isOver: s => cfg.isOver(s),
    publicState(s) {
      const cur = def.current(s);
      const paused = Date.now() < s.pauseUntil;
      return {
        turn: cur && !cfg.isOver(s) ? { playerId: cur, prompt: cfg.prompt(s, cur), options: paused ? [] : cfg.options(s, cur), secondsLeft: Math.max(0, Math.ceil((turnMs / SPEED - (Date.now() - s.turnStart)) / 1000)) } : null,
        view: cfg.view(s),
        log: s.log.slice(-6),
        order: s.order, finished: s.finished, out: s.out,
        scores: scoring === 'points' ? s.points : null,
        display: Object.fromEntries(s.order.map(id => [id, scoring === 'points' ? `${s.points[id]} pts`
          : s.finished.includes(id) ? `✅ #${s.finished.indexOf(id) + 1}` : s.out.includes(id) ? '💥 out' : '…'])),
      };
    },
    getResults(s) {
      if (scoring === 'points') return s.order.map(id => ({ playerId: id, score: s.points[id], display: `${s.points[id]} pts` }));
      // finished first (in order), then whoever is still in, then those knocked out (last out = better)
      const ranking = [...s.finished, ...active(s), ...[...s.out].reverse()];
      return ranking.map((id, i) => ({ playerId: id, score: i + 1, display: s.finished.includes(id) ? `Escaped #${s.finished.indexOf(id) + 1}` : s.out.includes(id) ? 'Knocked out' : remainingLabel }));
    },
  });
  return def;
}

// ---------- 1v3 guessing rounds: the solo player hides / blocks, the other three guess ----------
// soloWins(soloPick, crowdPicks) decides each round.
function guessRounds({ rounds = 5, spots, soloPrompt, crowdPrompt, soloWins, describe, ...def }) {
  const pickMs = 12000;
  return base({
    controls: 'quiz', modes: ['1v3'], durationMs: 150000, ...def,
    setup: players => ({ round: 1, phase: 'pick', picks: {}, names: Object.fromEntries(players.map(p => [p.id, p.name])),
      ids: players.map(p => p.id), score: Object.fromEntries(players.map(p => [p.id, 0])), won: { solo: 0, crowd: 0 },
      phaseStart: 0, last: null, cpuAt: {} }),
    start(s, now) {
      const t = s.teams || {};
      const soloColor = Object.keys(t).find(c => t[c].length === 1) || 'red';
      s.solo = (t[soloColor] || [s.ids[0]])[0];
      s.soloColor = soloColor;
      s.crowdColor = soloColor === 'red' ? 'blue' : 'red';
      s.phaseStart = now;
      s.ids.forEach(id => { s.cpuAt[id] = now + rand(1000, 3500) / SPEED; });
    },
    onInput(s, id, input) {
      if (s.phase !== 'pick' || id in s.picks || input?.qid !== s.round) return;
      const a = Number(input.answer);
      if (a >= 0 && a < spots.length) s.picks[id] = a;
    },
    cpu(s, id, now) { if (s.phase === 'pick' && !(id in s.picks) && now >= s.cpuAt[id]) s.picks[id] = randInt(0, spots.length - 1); },
    tick(s, now) {
      if (s.round > rounds) return;
      if (s.phase === 'pick' && (Object.keys(s.picks).length === s.ids.length || now - s.phaseStart > pickMs / SPEED)) {
        s.ids.forEach(id => { if (!(id in s.picks)) s.picks[id] = randInt(0, spots.length - 1); });
        const crowd = s.ids.filter(id => id !== s.solo);
        const soloWon = soloWins(s.picks[s.solo], crowd.map(id => s.picks[id]));
        if (soloWon) { s.won.solo++; s.score[s.solo]++; } else { s.won.crowd++; crowd.forEach(id => { s.score[id]++; }); }
        s.last = { picks: { ...s.picks }, soloWon, text: describe(s, soloWon) };
        s.phase = 'reveal'; s.phaseStart = now;
      } else if (s.phase === 'reveal' && now - s.phaseStart > 3000 / SPEED) {
        s.round++; s.picks = {}; s.phase = 'pick'; s.phaseStart = now;
        s.ids.forEach(id => { s.cpuAt[id] = now + rand(1000, 3500) / SPEED; });
      }
    },
    isOver: s => s.round > rounds,
    publicState(s) {
      const perPlayer = {};
      for (const id of s.ids) {
        perPlayer[id] = s.phase === 'pick' && !(id in s.picks) && s.round <= rounds
          ? { qid: s.round, prompt: { text: id === s.solo ? soloPrompt : crowdPrompt, size: 'md' }, options: spots } : null;
      }
      const items = spots.map((label, i) => {
        if (s.phase !== 'reveal' || !s.last) return { label, cls: '' };
        const who = Object.entries(s.last.picks).filter(([, v]) => v === i).map(([id]) => (id === s.solo ? `⭐${s.names[id]}` : s.names[id]));
        return { label: `${label}${who.length ? `\n${who.join(', ')}` : ''}`, cls: s.last.picks[s.solo] === i ? 'hit' : who.length ? 'open' : '' };
      });
      return {
        perPlayer,
        view: { title: `Round ${Math.min(s.round, rounds)} / ${rounds} · ${s.names[s.solo]} vs everyone · ${s.won.solo}–${s.won.crowd}`,
          items, subtitle: s.phase === 'reveal' && s.last ? s.last.text : 'Everyone is picking…' },
        scores: s.score,
        display: Object.fromEntries(s.ids.map(id => [id, `${s.score[id]} rounds`])),
      };
    },
    teamScores: (s) => ({ [s.soloColor]: s.won.solo, [s.crowdColor]: s.won.crowd }),
    getResults: s => s.ids.map(id => ({ playerId: id, score: s.score[id], display: `${s.score[id]} rounds won` })),
  });
}

// ---------- 2v2 sync: teammates score when they tap within 0.3s of each other ----------
function syncTap(def) {
  const WINDOW = 300;
  const mate = (s, id) => Object.values(s.teams || {}).find(ids => ids.includes(id))?.find(x => x !== id);
  return base({
    controls: 'mash', modes: ['2v2'], durationMs: 15000, ...def,
    setup: players => ({ p: perPlayer(players, () => ({ n: 0, lastTap: -1e9, used: true })) }),
    start() {},
    onInput(s, id, input, now) { this.tap(s, id, now); },
    tap(s, id, now) {
      const me = s.p[id], m = s.p[mate(s, id)];
      if (!me || now - me.lastTap < 120) return;
      me.lastTap = now; me.used = false;
      if (m && !m.used && now - m.lastTap <= WINDOW) { me.n++; m.n++; me.used = true; m.used = true; }
    },
    cpu(s, id, now) {
      const m = s.p[mate(s, id)];
      if (m && !m.used && now - m.lastTap < 180 && Math.random() < 0.75) this.tap(s, id, now); // follow the teammate
      else if (Math.random() < 0.12) this.tap(s, id, now);
    },
    publicState: s => ({
      scores: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.n])),
      display: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, `${ps.n} syncs`])),
    }),
    getResults: s => Object.entries(s.p).map(([playerId, ps]) => ({ playerId, score: ps.n, display: `${ps.n} syncs` })),
  });
}

// ---------- Balloon pump: pump for points, cash out before it pops ----------
function balloon(def) {
  return base({
    controls: 'pump', modes: ['ffa'], durationMs: 15000, ...def,
    setup: players => ({ p: perPlayer(players, () => ({ n: 0, popAt: randInt(8, 32), popped: false, cashed: false, target: randInt(7, 26), last: 0 })) }),
    start() {},
    onInput(s, id, input, now) {
      const ps = s.p[id];
      if (!ps || ps.popped || ps.cashed) return;
      if (input?.cash) { ps.cashed = true; return; }
      if (now - ps.last < 70) return;
      ps.last = now; ps.n++;
      if (ps.n > ps.popAt) ps.popped = true;
    },
    cpu(s, id, now) {
      const ps = s.p[id];
      if (ps.popped || ps.cashed) return;
      if (ps.n >= ps.target) ps.cashed = true;
      else if (Math.random() < 0.6) this.onInput(s, id, { pump: true }, now);
    },
    publicState: s => ({
      scores: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.popped ? 0 : ps.n])),
      display: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, ps.popped ? '💥 POPPED' : ps.cashed ? `🎈 banked ${ps.n}` : `🎈 ${ps.n}`])),
      perPlayer: Object.fromEntries(Object.entries(s.p).map(([id, ps]) => [id, { n: ps.n, popped: ps.popped, cashed: ps.cashed }])),
    }),
    getResults: s => Object.entries(s.p).map(([playerId, ps]) => ({ playerId, score: ps.popped ? 0 : ps.n, display: ps.popped ? 'Popped!' : `${ps.n} pumps` })),
  });
}

module.exports = { quiz, counter, reaction, selfReport, turnGame, guessRounds, syncTap, balloon, rand, randInt, clamp, shuffle, isCpu, ALL_MODES };
