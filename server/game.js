// The game engine: a server-authoritative state machine.
//
// Phases:
//   LOBBY → ROLL → MOVING (→ JUNCTION / STAR_PROMPT) → back to ROLL for next player
//   …after every player has moved: MINIGAME_INTRO → MINIGAME → MINIGAME_RESULTS
//   …after the last round: GAME_OVER
//
// Clients never change state directly. They send actions ("roll", "choose", "minigame")
// and the engine checks them against the current phase before doing anything.

const crypto = require('crypto');
const minigames = require('./minigames');

const MAX_PLAYERS = 4;
const STAR_COST = 20;
const START_COINS = 10;
const COLORS = ['#ff595e', '#1982c4', '#8ac926', '#ffca3a'];
const PROMPT_TIMEOUT_MS = 30000;   // auto-answer if a player goes AFK mid-prompt
const MINIGAME_REWARDS = [10, 5, 3, 0]; // coins by place

// GAME_SPEED > 1 shortens every delay (used by the test simulation)
const SPEED = Math.max(1, Number(process.env.GAME_SPEED) || 1);
const wait = ms => new Promise(r => setTimeout(r, ms / SPEED));
const T = { hop: 350, afterRoll: 900, afterLand: 1400, beat: 900, intro: 4500, results: 6000 };

class Game {
  constructor(code, board, emit) {
    this.code = code;
    this.board = board;
    this.emit = emit; // (publicState) => void
    this.nodes = new Map(board.nodes.map(n => [n.id, n]));
    this.hostKey = crypto.randomUUID();
    this.lastActivity = Date.now();
    this.players = [];
    this.resetMatch();
  }

  resetMatch() {
    this.phase = 'LOBBY';
    this.round = 0;
    this.maxRounds = 10;
    this.turnIndex = 0;
    this.starNodeId = null;
    this.dice = null;
    this.prompt = null;
    this.waiter = null;
    this.minigame = null;
    this.lastMinigameId = null;
    this.final = null;
    this.log = [];
  }

  // ---------- players ----------

  addOrReconnect({ playerId, name, socketId }) {
    const existing = playerId && this.players.find(p => p.id === playerId);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      return { ok: true, playerId: existing.id };
    }
    if (this.phase !== 'LOBBY') return { ok: false, error: 'That game has already started.' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: 'That room is full.' };

    const used = new Set(this.players.map(p => p.color));
    const p = {
      id: crypto.randomUUID(),
      name: String(name || '').trim().slice(0, 12) || `Player ${this.players.length + 1}`,
      color: COLORS.find(c => !used.has(c)),
      socketId,
      connected: true,
    };
    this.resetPlayerStats(p);
    this.players.push(p);
    return { ok: true, playerId: p.id };
  }

  resetPlayerStats(p) {
    Object.assign(p, {
      pos: this.board.startNodeId, coins: START_COINS, stars: 0,
      minigameWins: 0, redCount: 0, coinsEarned: 0,
    });
  }

  disconnect(socketId) {
    const p = this.players.find(x => x.socketId === socketId);
    if (!p) return;
    if (this.phase === 'LOBBY') {
      this.players = this.players.filter(x => x !== p); // free the seat
    } else {
      p.connected = false;
    }
    this.broadcast();
  }

  current() { return this.players[this.turnIndex]; }

  safe(promise) { promise.catch(err => console.error(`[${this.code}]`, err)); }

  // ---------- flow ----------

  start({ maxRounds } = {}) {
    if (this.phase !== 'LOBBY' || this.players.length < 1) return;
    const r = Number(maxRounds);
    this.maxRounds = [5, 10, 15, 20].includes(r) ? r : 10;
    this.players.forEach(p => this.resetPlayerStats(p));
    this.round = 1;
    this.turnIndex = 0;
    this.moveStar();
    this.addLog(`Game on! ${this.maxRounds} turns. Stars cost ${STAR_COST} coins.`);
    this.startRollPhase();
  }

  startRollPhase() {
    this.phase = 'ROLL';
    this.dice = null;
    this.broadcast();
    const p = this.current();
    if (!p.connected) {
      // Don't stall the game on a disconnected player: auto-roll for them.
      setTimeout(() => {
        if (this.phase === 'ROLL' && this.current() === p && !p.connected) this.safe(this.takeTurn());
      }, 3000 / SPEED);
    }
  }

  async takeTurn() {
    const p = this.current();
    this.phase = 'MOVING';
    const roll = 1 + Math.floor(Math.random() * 10);
    this.dice = { playerId: p.id, value: roll, remaining: roll };
    this.addLog(`🎲 ${p.name} rolled a ${roll}!`);
    this.broadcast();
    await wait(T.afterRoll);

    while (this.dice.remaining > 0) {
      const node = this.nodes.get(p.pos);
      let nextId = node.next[0];
      if (node.next.length > 1) {
        nextId = await this.ask(p, 'JUNCTION', {
          kind: 'junction',
          text: 'Which way?',
          options: node.next.map(id => ({ value: id, label: node.labels?.[id] || `Path ${id}` })),
        });
      }
      p.pos = nextId;
      this.dice.remaining--;
      this.broadcast();
      await wait(T.hop);

      // Like Mario Party: you can buy the star as you pass it, not just land on it.
      if (p.pos === this.starNodeId) await this.offerStar(p);
    }

    this.landOn(p);
    await wait(T.afterLand);
    this.endTurn();
  }

  endTurn() {
    this.turnIndex++;
    if (this.turnIndex >= this.players.length) {
      this.turnIndex = 0;
      this.safe(this.runMinigame());
    } else {
      this.startRollPhase();
    }
  }

  // Pause the flow and wait for one player's answer. Resolves with the chosen value.
  ask(player, phase, prompt) {
    this.phase = phase;
    this.prompt = { playerId: player.id, ...prompt };
    this.broadcast();
    return new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer);
        this.waiter = null;
        this.prompt = null;
        this.phase = 'MOVING';
        resolve(value);
      };
      const fallback = prompt.defaultValue ?? prompt.options[0].value;
      const timer = setTimeout(() => finish(fallback), PROMPT_TIMEOUT_MS / SPEED);
      if (!player.connected) setTimeout(() => this.waiter && finish(fallback), 1500 / SPEED);
      this.waiter = { playerId: player.id, finish };
    });
  }

  // ---------- spaces & stars ----------

  landOn(p) {
    const node = this.nodes.get(p.pos);
    switch (node.type) {
      case 'blue':
        this.give(p, 3);
        this.addLog(`🔵 ${p.name} landed on a blue space: +3 coins`);
        break;
      case 'red':
        this.give(p, -3);
        p.redCount++;
        this.addLog(`🔴 ${p.name} landed on a red space: −3 coins`);
        break;
      case 'event':
        this.addLog(`❓ ${p.name}: ${this.randomEvent(p)}`);
        break;
      default:
        this.addLog(`${p.name} landed on START.`);
    }
    this.broadcast();
  }

  randomEvent(p) {
    const others = this.players.filter(o => o !== p);
    const events = [
      () => { this.give(p, 10); return 'found a coin pouch! +10 coins'; },
      () => { const lost = Math.min(5, p.coins); this.give(p, -lost); return `tripped and dropped ${lost} coins`; },
      () => { this.players.forEach(o => this.give(o, 2)); return 'it\'s raining coins! Everyone +2'; },
      () => { this.moveStar(); return 'the Star flew to a new spot!'; },
    ];
    if (others.length) {
      events.push(() => {
        const o = others[Math.floor(Math.random() * others.length)];
        [p.pos, o.pos] = [o.pos, p.pos];
        return `swapped places with ${o.name}!`;
      });
      events.push(() => {
        const o = others[Math.floor(Math.random() * others.length)];
        const amt = Math.min(5, o.coins);
        this.give(o, -amt); this.give(p, amt);
        return `stole ${amt} coins from ${o.name}!`;
      });
    }
    return events[Math.floor(Math.random() * events.length)]();
  }

  async offerStar(p) {
    if (p.coins < STAR_COST) {
      this.addLog(`⭐ ${p.name} passed the Star but needs ${STAR_COST} coins.`);
      this.broadcast();
      await wait(T.beat);
      return;
    }
    const choice = await this.ask(p, 'STAR_PROMPT', {
      kind: 'star',
      text: `Buy a Star for ${STAR_COST} coins?`,
      options: [{ value: 'buy', label: '⭐ Buy Star' }, { value: 'skip', label: 'No thanks' }],
      defaultValue: 'skip',
    });
    if (choice === 'buy') {
      p.coins -= STAR_COST;
      p.stars++;
      this.addLog(`⭐ ${p.name} got a Star!`);
      this.moveStar();
    }
    this.broadcast();
    await wait(T.beat);
  }

  moveStar() {
    const options = this.board.nodes.filter(n => n.type === 'blue' && n.id !== this.starNodeId);
    this.starNodeId = options[Math.floor(Math.random() * options.length)].id;
  }

  give(p, n) {
    const before = p.coins;
    p.coins = Math.max(0, p.coins + n);
    if (p.coins > before) p.coinsEarned += p.coins - before;
  }

  // ---------- minigames ----------

  async runMinigame() {
    const def = minigames.pick(this.lastMinigameId);
    this.lastMinigameId = def.id;
    this.minigame = { def, state: def.setup(this.players), endsAt: null, results: null };
    this.phase = 'MINIGAME_INTRO';
    this.broadcast();
    await wait(T.intro);

    this.phase = 'MINIGAME';
    const now = Date.now();
    def.start(this.minigame.state, now);
    this.minigame.endsAt = now + def.durationMs / SPEED;
    this.broadcast();
    const ticker = setInterval(() => this.broadcast(), 200); // live scores
    await wait(def.durationMs);
    clearInterval(ticker);

    // Rank (ties share a place) and pay out. A "valid" result is one that actually
    // scored (not 0 taps, not a false start), so nobody wins by doing nothing.
    const sign = def.better === 'lower' ? 1 : -1;
    const rows = def.getResults(this.minigame.state).map(r => ({
      ...r, valid: Number.isFinite(r.score) && !(def.better === 'higher' && r.score <= 0),
    }));
    rows.sort((a, b) => (b.valid - a.valid) || sign * (a.score - b.score));
    const validCount = rows.filter(r => r.valid).length;
    rows.forEach((row, i) => {
      const prev = rows[i - 1];
      if (!row.valid) row.place = validCount + 1;
      else row.place = prev && prev.valid && prev.score === row.score ? prev.place : i + 1;
      row.reward = row.valid ? MINIGAME_REWARDS[row.place - 1] ?? 0 : 0;
      const p = this.players.find(x => x.id === row.playerId);
      if (!p) return;
      this.give(p, row.reward);
      if (row.valid && row.place === 1) p.minigameWins++;
    });
    this.minigame.results = rows;
    this.phase = 'MINIGAME_RESULTS';
    const winners = rows.filter(r => r.valid && r.place === 1).map(r => this.nameOf(r.playerId));
    this.addLog(winners.length ? `🏆 ${def.name}: ${winners.join(' & ')} won!` : `${def.name}: nobody scored!`);
    this.broadcast();
    await wait(T.results);

    this.minigame = null;
    if (this.round >= this.maxRounds) return this.finish();
    this.round++;
    if (this.round === this.maxRounds) this.addLog('🔥 Last turn!');
    this.startRollPhase();
  }

  handleAction(playerId, action) {
    this.lastActivity = Date.now();
    if (!action || typeof action.type !== 'string') return;

    if (action.type === 'roll') {
      if (this.phase === 'ROLL' && this.current()?.id === playerId) this.safe(this.takeTurn());
    } else if (action.type === 'choose') {
      const w = this.waiter;
      if (w && w.playerId === playerId && this.prompt.options.some(o => o.value === action.value)) {
        w.finish(action.value);
      }
    } else if (action.type === 'minigame') {
      if (this.phase === 'MINIGAME') {
        this.minigame.def.onInput(this.minigame.state, playerId, action.input, Date.now());
      }
    }
  }

  // ---------- ending ----------

  finish() {
    const bonuses = [
      { title: 'Minigame Star', stat: 'minigameWins', desc: 'most minigame wins' },
      { title: 'Coin Star', stat: 'coinsEarned', desc: 'most coins earned' },
      { title: 'Unlucky Star', stat: 'redCount', desc: 'most red spaces' },
    ].map(b => {
      const best = Math.max(...this.players.map(p => p[b.stat]));
      const winners = best > 0 ? this.players.filter(p => p[b.stat] === best) : [];
      winners.forEach(p => p.stars++);
      return { ...b, value: best, playerIds: winners.map(p => p.id) };
    });

    const standings = [...this.players]
      .sort((a, b) => b.stars - a.stars || b.coins - a.coins)
      .map(p => ({ playerId: p.id, stars: p.stars, coins: p.coins }));
    standings.forEach((s, i) => {
      const prev = standings[i - 1];
      s.place = prev && prev.stars === s.stars && prev.coins === s.coins ? prev.place : i + 1;
    });

    this.final = { bonuses, standings };
    this.phase = 'GAME_OVER';
    this.addLog(`🎉 ${this.nameOf(standings[0].playerId)} is the Superstar!`);
    this.broadcast();
  }

  // Back to the lobby with the same players (players who left are dropped)
  restart() {
    if (this.phase !== 'GAME_OVER') return;
    this.players = this.players.filter(p => p.connected);
    this.resetMatch();
    this.broadcast();
  }

  // ---------- output ----------

  nameOf(id) { return this.players.find(p => p.id === id)?.name ?? '?'; }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 30) this.log.shift();
  }

  publicState() {
    const mg = this.minigame;
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      maxRounds: this.maxRounds,
      starCost: STAR_COST,
      turnPlayerId: ['ROLL', 'MOVING', 'JUNCTION', 'STAR_PROMPT'].includes(this.phase) ? this.current()?.id : null,
      starNodeId: this.starNodeId,
      dice: this.dice,
      prompt: this.prompt && { ...this.prompt },
      players: this.players.map(({ socketId, ...pub }) => pub),
      minigame: mg && {
        id: mg.def.id,
        name: mg.def.name,
        instructions: mg.def.instructions,
        controls: mg.def.controls,
        timeLeftMs: mg.endsAt ? Math.max(0, mg.endsAt - Date.now()) : null,
        live: mg.def.publicState(mg.state),
        results: mg.results,
      },
      final: this.final,
      log: this.log.slice(-8),
    };
  }

  broadcast() {
    this.lastActivity = Date.now();
    this.emit(this.publicState());
  }
}

module.exports = { Game };
