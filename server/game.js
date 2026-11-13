// The game engine: a server-authoritative state machine.
//
// Phases:
//   LOBBY → ROLL (→ ITEM) → MOVING (→ JUNCTION / STAR_PROMPT / SHOP / ROULETTE / VS minigame)
//   …after every player has moved: MINIGAME_INTRO → MINIGAME → MINIGAME_RESULTS
//   …after the last round: GAME_OVER
//
// Clients never change state directly. They send actions ("roll", "useItem", "choose",
// "minigame") and the engine checks them against the current phase before doing anything.
// Space rules live in spaces.js, items in items.js, minigames in minigames/.

const crypto = require('crypto');
const minigames = require('./minigames');
const { SPACES, SPACE_META, banditEncounter } = require('./spaces');
const { ITEMS, DICE_ITEMS } = require('./items');

const MAX_PLAYERS = 4;
const STAR_COST = 20;
const START_COINS = 10;
const FINAL_STRETCH_TURNS = 5;
const COLORS = ['#ff595e', '#1982c4', '#8ac926', '#ffca3a'];
const PROMPT_TIMEOUT_MS = 30000;        // auto-answer if a player goes AFK mid-prompt
const MINIGAME_REWARDS = [10, 5, 3, 0]; // coins by place for the end-of-round minigame

// GAME_SPEED > 1 shortens every delay (used by the test simulation)
const SPEED = Math.max(1, Number(process.env.GAME_SPEED) || 1);
const wait = ms => new Promise(r => setTimeout(r, ms / SPEED));
const T = { hop: 350, afterRoll: 900, afterLand: 1400, beat: 900, roulette: 4200, intro: 4500, results: 6000 };

function weightedPick(options) {
  const total = options.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of options) if ((r -= o.weight) < 0) return o;
  return options[options.length - 1];
}

class Game {
  constructor(code, board, emit) {
    this.code = code;
    this.emit = emit; // (publicState) => void
    this.setBoard(board);
    this.hostKey = crypto.randomUUID();
    this.lastActivity = Date.now();
    this.players = [];
    this.resetMatch();
  }

  setBoard(board) {
    this.board = board;
    this.nodes = new Map(board.nodes.map(n => [n.id, n]));
    (this.players || []).forEach(p => { p.pos = board.startNodeId; });
  }

  resetMatch() {
    this.phase = 'LOBBY';
    this.round = 0;
    this.maxRounds = 10;
    this.turnIndex = 0;
    this.starNodeId = null;
    this.bank = 0;
    this.spaceOverrides = {};   // nodeId -> type (e.g. VS spaces that turned blue)
    this.dice = null;
    this.pendingDice = null;    // 'custom' | 'double' | 'triple' for this turn
    this.pendingBoost = 0;      // +5 from a Boost
    this.turnItemUsed = false;
    this.prompt = null;
    this.waiter = null;
    this.rouletteState = null;
    this.minigame = null;
    this.lastMinigameId = null;
    this.final = null;
    this.log = [];
  }

  // ---------- helpers used by spaces.js ----------

  spaceType(nodeId) { return this.spaceOverrides[nodeId] ?? this.nodes.get(nodeId).type; }
  setSpaceType(nodeId, type) { this.spaceOverrides[nodeId] = type; }
  isFinalStretch() { return this.round > this.maxRounds - FINAL_STRETCH_TURNS; }
  rareUnlockRound() { return Math.floor(this.maxRounds / 2) + 1; }       // e.g. turn 6 of 10
  itemUnlocked(id) { return !ITEMS[id].rare || this.round >= this.rareUnlockRound(); }
  beat() { this.broadcast(); return wait(T.beat); }
  ranked() { return [...this.players].sort((a, b) => b.stars - a.stars || b.coins - a.coins); }
  leader() { return this.ranked()[0]; }
  lastPlace(exclude) { return this.ranked().reverse().find(p => p !== exclude) ?? null; }

  give(p, n) {
    const before = p.coins;
    p.coins = Math.max(0, p.coins + n);
    if (p.coins > before) p.coinsEarned += p.coins - before;
  }

  // Spin a weighted roulette shown on the TV. options: [{ label, weight, run, available? }]
  async roulette(player, title, options) {
    const pool = options.filter(o => o.available !== false);
    const chosen = weightedPick(pool);
    const prevPhase = this.phase;
    this.rouletteState = {
      id: crypto.randomUUID(), playerId: player.id, title,
      labels: pool.map(o => o.label), resultIndex: pool.indexOf(chosen), resultText: null,
    };
    this.phase = 'ROULETTE';
    this.broadcast();
    await wait(T.roulette * 0.65);
    const text = chosen.run();
    this.rouletteState.resultText = text;
    this.addLog(text);
    this.broadcast();
    await wait(T.roulette * 0.35);
    this.rouletteState = null;
    this.phase = prevPhase;
    this.broadcast();
    return chosen;
  }

  // Pause the flow and wait for one player's answer. Resolves with the chosen value.
  ask(player, phase, prompt) {
    const prevPhase = this.phase;
    this.phase = phase;
    this.prompt = { playerId: player.id, ...prompt };
    this.broadcast();
    return new Promise(resolve => {
      const finish = value => {
        clearTimeout(timer);
        this.waiter = null;
        this.prompt = null;
        this.phase = prevPhase;
        resolve(value);
      };
      const fallback = prompt.defaultValue ?? prompt.options[0].value;
      const timer = setTimeout(() => finish(fallback), PROMPT_TIMEOUT_MS / SPEED);
      if (!player.connected) setTimeout(() => this.waiter && finish(fallback), 1500 / SPEED);
      this.waiter = { playerId: player.id, finish };
    });
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
      pos: this.board.startNodeId, coins: START_COINS, stars: 0, items: [], badDice: false,
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
    if (this.isFinalStretch()) this.addLog('🔥 Blue & red spaces are doubled all game!');
    this.startRollPhase();
  }

  startRollPhase() {
    this.phase = 'ROLL';
    this.dice = null;
    this.pendingDice = null;
    this.pendingBoost = 0;
    this.turnItemUsed = false;
    this.broadcast();
    const p = this.current();
    if (!p.connected) {
      // Don't stall the game on a disconnected player: auto-roll for them.
      setTimeout(() => {
        if (this.phase === 'ROLL' && this.current() === p && !p.connected) this.safe(this.takeTurn());
      }, 3000 / SPEED);
    }
  }

  async useItem(p, index) {
    const id = p.items[index];
    if (!id || this.turnItemUsed) return;
    const others = this.players.filter(o => o !== p);
    if (id === 'warpBlock' && !others.length) return; // nobody to swap with: keep the item

    this.phase = 'ITEM';
    this.turnItemUsed = true;
    p.items.splice(index, 1);
    this.addLog(`${ITEMS[id].icon} ${p.name} used a ${ITEMS[id].name}!`);
    this.broadcast();
    await wait(T.beat);

    if (DICE_ITEMS.has(id)) {
      this.pendingDice = { doubleDice: 'double', tripleDice: 'triple', customDice: 'custom' }[id];
      if (p.badDice) {
        p.badDice = false;
        this.addLog(`🐌 ${p.name}'s Bad Dice was canceled!`);
        await this.beat();
      }
    }
    if (id === 'boost') this.pendingBoost = 5;
    if (id === 'badDice') {
      const targetId = await this.ask(p, 'ITEM_TARGET', {
        kind: 'badDiceTarget',
        text: 'Who gets the Bad Dice? (rolls 1–3 next turn)',
        options: this.players.map(o => ({ value: o.id, label: o === p ? `${o.name} (you)` : o.name })),
        defaultValue: (others[0] || p).id,
      });
      const target = this.players.find(o => o.id === targetId) || p;
      target.badDice = true;
      this.addLog(`🐌 ${target.name} will roll 1–3 on their next turn!`);
      await this.beat();
    }
    if (id === 'warpBlock') {
      const o = others[Math.floor(Math.random() * others.length)];
      [p.pos, o.pos] = [o.pos, p.pos];
      this.addLog(`🌀 ${p.name} swapped places with ${o.name}!`);
      await this.beat();
    }
    if (id === 'goldenPipe') {
      p.pos = this.starNodeId;
      this.addLog(`🟡 ${p.name} warped to the Star!`);
      await this.beat();
      await this.offerStar(p);
    }
    if (id === 'banditCall') await banditEncounter(this, p);

    this.phase = 'ROLL';
    this.broadcast();
  }

  async takeTurn() {
    const p = this.current();
    this.phase = 'MOVING';
    const d = sides => 1 + Math.floor(Math.random() * sides);
    let roll, text;
    if (this.pendingDice === 'custom') {
      roll = await this.ask(p, 'CUSTOM_DICE', {
        kind: 'customDice', text: 'Pick your roll!',
        options: Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
        defaultValue: 5,
      });
      text = `🎯 ${p.name} picked a ${roll}`;
    } else if (this.pendingDice === 'double' || this.pendingDice === 'triple') {
      const dice = Array.from({ length: this.pendingDice === 'double' ? 2 : 3 }, () => d(10));
      roll = dice.reduce((a, b) => a + b, 0);
      text = `🎲 ${p.name} rolled ${dice.join(' + ')} = ${roll}`;
    } else if (p.badDice) {
      p.badDice = false;
      roll = d(3);
      text = `🐌 ${p.name} was stuck with Bad Dice and rolled a ${roll}`;
    } else {
      roll = d(10);
      text = `🎲 ${p.name} rolled a ${roll}`;
    }
    if (this.pendingBoost) {
      roll += this.pendingBoost;
      text += ` +${this.pendingBoost} Boost = ${roll}`;
    }
    text += '!';
    this.dice = { playerId: p.id, value: roll, remaining: roll };
    this.addLog(text);
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
      const space = SPACES[this.spaceType(nextId)];
      if (!space.passOnly) this.dice.remaining--;  // shops etc. don't use up a step
      this.broadcast();
      await wait(T.hop);

      // Like Mario Party: you can buy the star as you pass it, not just land on it.
      if (p.pos === this.starNodeId) await this.offerStar(p);
      // Pass effects only fire when you keep going (landing uses onLand instead)
      if (space.onPass && (space.passOnly || this.dice.remaining > 0)) await space.onPass(this, p, nextId);
    }

    const landed = SPACES[this.spaceType(p.pos)];
    await landed.onLand?.(this, p, p.pos);
    this.broadcast();
    await wait(T.afterLand);
    this.endTurn();
  }

  endTurn() {
    this.dice = null;
    this.turnIndex++;
    if (this.turnIndex >= this.players.length) {
      this.turnIndex = 0;
      this.safe(this.endOfRoundMinigame());
    } else {
      this.startRollPhase();
    }
  }

  // ---------- stars ----------

  async offerStar(p) {
    if (p.coins < STAR_COST) {
      this.addLog(`⭐ ${p.name} passed the Star but needs ${STAR_COST} coins.`);
      return this.beat();
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
    return this.beat();
  }

  moveStar() {
    const options = this.board.nodes.filter(n => this.spaceType(n.id) === 'blue' && n.id !== this.starNodeId);
    this.starNodeId = options[Math.floor(Math.random() * options.length)].id;
  }

  // ---------- minigames ----------

  // Runs one minigame from intro to results. `payout(rows)` sets row.reward for each row.
  async playMinigame({ banner = null, payout }) {
    const prevPhase = this.phase;
    const def = minigames.pick(this.lastMinigameId);
    this.lastMinigameId = def.id;
    this.minigame = { def, banner, state: def.setup(this.players), endsAt: null, results: null };
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

    // Rank (ties share a place). A "valid" result is one that actually scored
    // (not 0 taps, not a false start), so nobody wins by doing nothing.
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
    });
    payout(rows);
    rows.forEach(row => {
      const p = this.players.find(x => x.id === row.playerId);
      if (!p) return;
      this.give(p, row.reward || 0);
      if (row.valid && row.place === 1) p.minigameWins++;
    });

    this.minigame.results = rows;
    this.phase = 'MINIGAME_RESULTS';
    const winners = rows.filter(r => r.valid && r.place === 1).map(r => this.nameOf(r.playerId));
    this.addLog(winners.length ? `🏆 ${def.name}: ${winners.join(' & ')} won!` : `${def.name}: nobody scored!`);
    this.broadcast();
    await wait(T.results);
    this.minigame = null;
    this.phase = prevPhase;
    return rows;
  }

  async endOfRoundMinigame() {
    await this.playMinigame({
      payout: rows => rows.forEach(r => { r.reward = r.valid ? MINIGAME_REWARDS[r.place - 1] ?? 0 : 0; }),
    });
    if (this.round >= this.maxRounds) return this.finish();
    this.round++;
    if (this.round === this.maxRounds) this.addLog('🔥 Last turn!');
    else if (this.round === this.maxRounds - FINAL_STRETCH_TURNS + 1) {
      this.addLog(`🔥 Final ${FINAL_STRETCH_TURNS} turns! Blue & red spaces are now doubled.`);
    }
    this.startRollPhase();
  }

  handleAction(playerId, action) {
    this.lastActivity = Date.now();
    if (!action || typeof action.type !== 'string') return;
    const isTurn = this.phase === 'ROLL' && this.current()?.id === playerId;

    if (action.type === 'roll') {
      if (isTurn) this.safe(this.takeTurn());
    } else if (action.type === 'useItem') {
      if (isTurn) this.safe(this.useItem(this.current(), Number(action.index)));
    } else if (action.type === 'choose') {
      const w = this.waiter;
      if (w && w.playerId === playerId && this.prompt.options.some(o => o.value === action.value && !o.disabled)) {
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

    const standings = this.ranked().map(p => ({ playerId: p.id, stars: p.stars, coins: p.coins }));
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
    const turnPhases = ['ROLL', 'ITEM', 'ITEM_TARGET', 'MOVING', 'JUNCTION', 'STAR_PROMPT', 'SHOP', 'CUSTOM_DICE', 'BANDIT', 'ROULETTE'];
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      maxRounds: this.maxRounds,
      finalStretch: this.phase !== 'LOBBY' && this.isFinalStretch(),
      starCost: STAR_COST,
      boardId: this.board.id,
      rareUnlockRound: this.rareUnlockRound(),
      turnPlayerId: turnPhases.includes(this.phase) && !mg ? this.current()?.id : null,
      turnItemUsed: this.turnItemUsed,
      starNodeId: this.starNodeId,
      bank: this.bank,
      spaceOverrides: this.spaceOverrides,
      dice: this.dice,
      prompt: this.prompt && { ...this.prompt },
      roulette: this.rouletteState,
      players: this.players.map(({ socketId, ...pub }) => pub),
      minigame: mg && {
        id: mg.def.id,
        name: mg.def.name,
        banner: mg.banner,
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

module.exports = { Game, SPACE_META, ITEMS };
