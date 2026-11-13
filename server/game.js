// The game engine: a server-authoritative state machine.
//
// Phases:
//   LOBBY → ROLL_OFF (who goes first)
//   → ROLL (→ ITEM) → MOVING (→ JUNCTION / STAR_PROMPT / SHOP / ROULETTE / BANDIT / VS minigame)
//   …after every player has moved: MINIGAME_INTRO → MINIGAME → MINIGAME_RESULTS
//   …after the last round: GAME_OVER
//
// Clients never change state directly. They send actions ("roll", "useItem", "choose",
// "minigame", "rollOff", "nudge") and the engine checks them against the current phase.
// Space rules live in spaces.js, items in items.js, minigames in minigames/, CPU brains in cpu.js.
//
// Besides the full state, the engine sends short-lived "fx" events (a roll, coins gained,
// an item, a robbery…) so screens can play animations.

const crypto = require('crypto');
const minigames = require('./minigames');
const { SPACES, SPACE_META, banditEncounter } = require('./spaces');
const { ITEMS, DICE_ITEMS, MAX_ITEMS, dropWeight } = require('./items');
const cpuBrain = require('./cpu');

const SEATS = 4;                         // games always have 4 players; CPUs fill empty seats
const STAR_COST = 20;
const START_COINS = 10;
const FINAL_STRETCH_TURNS = 5;
const COLORS = ['#ff595e', '#1982c4', '#8ac926', '#ffca3a'];
const FFA_REWARDS = [10, 5, 3, 0];       // coins by place, end-of-round free-for-all
const TEAM_REWARD = 10;                  // each player on the winning team
const VS_SHARES = [0.9, 0.09, 0.01, 0];  // VS pot split by place
const NUDGE_AFTER_MS = 60000;            // nudge button appears after a minute of waiting

// GAME_SPEED > 1 shortens every delay (used by the test simulation)
const SPEED = Math.max(1, Number(process.env.GAME_SPEED) || 1);
const wait = ms => new Promise(r => setTimeout(r, ms / SPEED));
const T = {
  hop: 350, afterRoll: 1500, afterLand: 1200, beat: 1000, roulette: 4200,
  results: 1500, cpuThink: 1100, rollOffEnd: 3500, turnSplash: 2800, teams: 6500,
  starReveal: 3200, finaleIntro: 3000, drumroll: 2600, reveal: 3200,
};
const sleep = ms => new Promise(r => setTimeout(r, ms)); // real time (minigame clock)

// Space color groups (used for team minigames)
const COLOR_GROUP = {
  blue: 'blue', lucky: 'blue', vs: 'blue', chance: 'blue',
  red: 'red', badluck: 'red',
  event: 'green', bank: 'green', item: 'green', start: 'green',
};

function weightedPick(options) {
  const total = options.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of options) if ((r -= o.weight) < 0) return o;
  return options[options.length - 1];
}

const newStats = () => ({
  rolls: 0, totalRolled: 0, bestRoll: 0, spacesMoved: 0,
  blueSpaces: 0, redSpaces: 0, greenSpaces: 0,
  coinsEarned: 0, coinsLost: 0, coinsSpent: 0, coinsStolen: 0, coinsRobbed: 0,
  starsBought: 0, starsStolen: 0, starsLost: 0,
  itemsGained: 0, itemsUsed: 0, minigameWins: 0, minigamesPlayed: 0,
});

class Game {
  constructor(code, board, emit, emitFx = () => {}) {
    this.code = code;
    this.emit = emit;     // (publicState) => void
    this.emitFx = emitFx; // (fxEvent) => void
    this.setBoard(board);
    this.hostKey = crypto.randomUUID();
    this.lastActivity = Date.now();
    this.players = [];
    this.starCost = STAR_COST;
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
    this.star = null;           // { from, to }: the Star sits on the path BETWEEN two spaces
    this.bank = 0;
    this.spaceOverrides = {};   // nodeId -> type (e.g. VS spaces that turned blue)
    this.dice = null;
    this.pendingDice = null;    // 'custom' | 'double' | 'triple' for this turn
    this.pendingBoost = 0;      // +5 from a Boost
    this.turnItemUsed = false;
    this.prompt = null;
    this.waiter = null;
    this.rouletteState = null;
    this.rollOff = null;
    this.minigame = null;
    this.lastMinigameId = null;
    this.final = null;
    this.awaiting = null;       // { playerIds, since, key }: who we're waiting on (for nudges)
    this.nudges = new Set();    // `${key}|${fromId}`
    this.gate = null;           // waiting for button presses: { kind, pending:Set, press(id) }
    this.finale = null;         // end-of-game reveal steps
    this.boardViewer = null;    // player looking at the whole board on their phone (TV zooms out)
    this.turnKey = '';
    this.log = [];
  }

  // ---------- small helpers (also used by spaces.js) ----------

  spaceType(nodeId) { return this.spaceOverrides[nodeId] ?? this.nodes.get(nodeId).type; }
  setSpaceType(nodeId, type) { this.spaceOverrides[nodeId] = type; }
  isPassOnly(nodeId) { return !!SPACES[this.spaceType(nodeId)].passOnly; }
  isFinalStretch() { return this.round > this.maxRounds - FINAL_STRETCH_TURNS; }
  isLastTurn() { return this.round === this.maxRounds; }
  rareUnlockRound() { return Math.floor(this.maxRounds / 2) + 1; }       // e.g. turn 6 of 10
  itemUnlocked(id) { return !ITEMS[id].rare || this.round >= this.rareUnlockRound(); }
  randomItem() {
    const pool = Object.keys(ITEMS).filter(id => this.itemUnlocked(id)).map(id => ({ id, weight: dropWeight(id) }));
    return weightedPick(pool).id;
  }
  beat() { this.broadcast(); return wait(T.beat); }
  ranked() { return [...this.players].sort((a, b) => b.stars - a.stars || b.coins - a.coins); }
  leader() { return this.ranked()[0]; }
  lastPlace(exclude) { return this.ranked().reverse().find(p => p !== exclude) ?? null; }
  current() { return this.players[this.turnIndex]; }
  humans() { return this.players.filter(p => !p.cpu); }
  safe(promise) { promise.catch(err => console.error(`[${this.code}]`, err)); }

  fx(kind, data = {}) { this.emitFx({ id: crypto.randomUUID(), kind, ...data }); }

  // Big message on every screen (and in the log)
  announce(text, { icon = '', tone = 'info', playerIds = [] } = {}) {
    this.addLog(`${icon ? `${icon} ` : ''}${text}`);
    this.fx('announce', { text, icon, tone, playerIds });
  }

  // Coins from the board / minigames / other players. Negative = loss.
  give(p, n) {
    const before = p.coins;
    p.coins = Math.max(0, p.coins + n);
    const delta = p.coins - before;
    if (delta > 0) p.stats.coinsEarned += delta;
    if (delta < 0) p.stats.coinsLost -= delta;
    if (delta) this.fx('coins', { playerId: p.id, amount: delta });
    return delta;
  }

  // Coins paid for something (shop, Star, Bandit)
  spend(p, n) {
    p.coins -= n;
    p.stats.coinsSpent += n;
    this.fx('coins', { playerId: p.id, amount: -n });
  }

  addStar(p, n) {
    p.stars = Math.max(0, p.stars + n);
    if (n < 0) p.stats.starsLost -= n;
    this.fx('star', { playerId: p.id, amount: n });
  }

  // Shortest number of steps from one space to another (shops/Bandit don't count;
  // gates only count as open if p carries the key). Used by CPUs.
  stepsBetween(fromId, toId, p) {
    if (fromId === toId) return 0;
    const dist = new Map([[fromId, 0]]);
    const queue = [fromId];
    while (queue.length) {
      const id = queue.shift();
      const node = this.nodes.get(id);
      for (const next of node.next) {
        const gate = node.gates?.[next];
        if (gate && !(p && p.items.includes(gate))) continue;
        if (dist.has(next)) continue;
        const d = dist.get(id) + (this.isPassOnly(next) ? 0 : 1);
        if (next === toId) return d;
        dist.set(next, d);
        queue.push(next);
      }
    }
    return Infinity;
  }

  // ---------- waiting / nudges ----------

  setAwaiting(playerIds) {
    const humans = playerIds.filter(id => !this.players.find(p => p.id === id)?.cpu);
    this.awaiting = humans.length ? { playerIds: humans, since: Date.now(), key: this.turnKey } : null;
  }
  clearAwaiting(playerId) {
    if (!this.awaiting) return;
    this.awaiting.playerIds = this.awaiting.playerIds.filter(id => id !== playerId);
    if (!this.awaiting.playerIds.length) this.awaiting = null;
  }

  nudge(fromId, targetId) {
    const from = this.players.find(p => p.id === fromId);
    const target = this.players.find(p => p.id === targetId);
    const a = this.awaiting;
    if (!from || !target || from === target || !a || !a.playerIds.includes(targetId)) return;
    if ((Date.now() - a.since) * SPEED < NUDGE_AFTER_MS) return;
    const key = `${a.key}|${fromId}`;
    if (this.nudges.has(key)) return; // once per player per turn
    this.nudges.add(key);
    this.fx('nudge', { fromId, toId: targetId, fromName: from.name, toName: target.name });
    this.addLog(`👉 ${from.name} nudged ${target.name}!`);
    this.broadcast();
  }

  // Wait until each listed player presses a button (Ready, Next, End turn…).
  // No time limit for humans; CPUs press after a moment; dropped phones count as pressed.
  waitForPress(kind, ids, cpuDelay = 1200) {
    return new Promise(resolve => {
      const pending = new Set(ids);
      const gate = { kind, pending, done: false };
      gate.press = id => {
        if (gate.done || !pending.delete(id)) return;
        this.clearAwaiting(id);
        if (!pending.size) { gate.done = true; if (this.gate === gate) this.gate = null; this.awaiting = null; resolve(); }
        this.broadcast();
      };
      this.gate = gate;
      this.setAwaiting([...pending]);
      this.broadcast();
      for (const id of ids) {
        const p = this.players.find(x => x.id === id);
        if (!p || p.cpu) setTimeout(() => gate.press(id), (cpuDelay + Math.random() * 800) / SPEED);
        else if (!p.connected) setTimeout(() => gate.press(id), 800 / SPEED);
      }
      if (!ids.length) { gate.done = true; this.gate = null; resolve(); }
    });
  }

  // Player 1 (first to join) moves things along between minigames and turns.
  // If they've dropped, any connected human can.
  nextPresserId() {
    const host = this.players.find(p => p.id === this.hostPlayerId && p.connected);
    return (host || this.humans().find(p => p.connected) || this.players[0]).id;
  }

  async relocateStar() {
    this.moveStar();
    this.fx('starMoved', { star: this.star });
    this.announce('The Star moved to a new spot!', { icon: '⭐' });
    this.broadcast();
    await wait(T.starReveal);
  }

  // ---------- roulette, items, prompts ----------

  // Spin a weighted roulette shown on the TV. options: [{ label, weight, run, after?, available? }]
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
    if (chosen.after) await chosen.after(); // follow-ups that may prompt (e.g. a discard)
    return chosen;
  }

  // Give a player an item. If that overfills the bag, they pick one of the 4 to throw away.
  async addItem(p, id) {
    p.items.push(id);
    p.stats.itemsGained++;
    this.fx('item', { playerId: p.id, itemId: id });
    this.broadcast();
    await wait(T.beat * 0.8);
    if (p.items.length <= MAX_ITEMS) return;
    const newIndex = p.items.length - 1;
    const drop = await this.ask(p, 'DISCARD', {
      kind: 'discard',
      text: `Your bag only holds ${MAX_ITEMS}. Throw one away:`,
      options: p.items.map((it, i) => ({
        value: i,
        label: `${ITEMS[it].icon} ${ITEMS[it].name}${i === newIndex ? ' (new)' : ''}`,
        desc: ITEMS[it].desc,
      })),
      defaultValue: newIndex,
    });
    const [gone] = p.items.splice(drop, 1);
    this.addLog(`🗑️ ${p.name} threw away a ${ITEMS[gone].name}.`);
    await this.beat();
  }

  // ? space: fly forward n spaces along the main road. Nothing triggers on the way or where you land.
  async launch(p, n) {
    let left = n;
    while (left > 0) {
      p.pos = this.nodes.get(p.pos).next[0]; // forks: follow the main road; never through a gate
      if (!this.isPassOnly(p.pos)) left--;   // shops/Bandit can't be landed on
      this.broadcast();
      await wait(T.hop * 0.6);
    }
  }

  // Pause the flow and wait for one player's answer. Resolves with the chosen value.
  // Humans have no time limit (others can nudge them). CPUs answer after a short "think".
  ask(player, phase, prompt) {
    const prevPhase = this.phase;
    this.phase = phase;
    this.prompt = { playerId: player.id, ...prompt };
    if (!player.cpu) this.setAwaiting([player.id]);
    this.broadcast();
    return new Promise(resolve => {
      const finish = value => {
        if (this.waiter?.finish !== finish) return;
        this.waiter = null;
        this.prompt = null;
        this.clearAwaiting(player.id);
        this.phase = prevPhase;
        resolve(value);
      };
      const fallback = prompt.defaultValue ?? prompt.options.find(o => !o.disabled).value;
      this.waiter = { playerId: player.id, finish, fallback };
      if (player.cpu) setTimeout(() => finish(cpuBrain.decide(this, player, prompt)), T.cpuThink / SPEED);
      else if (!player.connected) setTimeout(() => finish(fallback), 1500 / SPEED);
    });
  }

  // ---------- players ----------

  addOrReconnect({ playerId, name, socketId }) {
    const existing = playerId && this.players.find(p => p.id === playerId && !p.cpu);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      return { ok: true, playerId: existing.id };
    }
    if (this.phase !== 'LOBBY') return { ok: false, error: 'That game has already started.' };
    if (this.players.length >= SEATS) return { ok: false, error: 'That room is full.' };
    const p = this.makePlayer(String(name || '').trim().slice(0, 12) || `Player ${this.players.length + 1}`, false);
    p.socketId = socketId;
    this.players.push(p);
    if (!this.players.some(x => x.id === this.hostPlayerId)) this.hostPlayerId = p.id; // Player 1
    return { ok: true, playerId: p.id };
  }

  makePlayer(name, cpu) {
    const used = new Set(this.players.map(p => p.color));
    const p = { id: crypto.randomUUID(), name, cpu, connected: true, color: COLORS.find(c => !used.has(c)) };
    this.resetPlayerStats(p);
    return p;
  }

  resetPlayerStats(p) {
    Object.assign(p, {
      pos: this.board.startNodeId, coins: START_COINS, stars: 0, items: [], badDice: false,
      roundColor: null, stats: newStats(),
    });
  }

  disconnect(socketId) {
    const p = this.players.find(x => x.socketId === socketId);
    if (!p) return;
    if (this.phase === 'LOBBY') {
      this.players = this.players.filter(x => x !== p); // free the seat
      if (this.hostPlayerId === p.id) this.hostPlayerId = this.humans()[0]?.id ?? null;
    } else {
      this.gate?.press(p.id);
      p.connected = false;
      // Don't let a dropped phone freeze the game
      if (this.waiter?.playerId === p.id) this.waiter.finish(this.waiter.fallback);
      if (this.phase === 'ROLL' && this.current() === p) this.safe(this.takeTurn());
      if (this.phase === 'ROLL_OFF' && this.rollOff && !(p.id in this.rollOff.rolls)) this.rollFor(p);
    }
    this.broadcast();
  }

  // ---------- start: fill seats with CPUs, then roll off for turn order ----------

  start({ maxRounds } = {}) {
    if (this.phase !== 'LOBBY' || this.players.length < 1) return;
    const r = Number(maxRounds);
    this.maxRounds = [5, 10, 15, 20].includes(r) ? r : 10;
    const names = cpuBrain.CPU_NAMES.filter(n => !this.players.some(p => p.name === `CPU ${n}`));
    while (this.players.length < SEATS) this.players.push(this.makePlayer(`CPU ${names.shift()}`, true));
    this.players.forEach(p => this.resetPlayerStats(p));
    this.round = 1;
    this.turnIndex = 0;
    this.moveStar();
    this.addLog(`Game on! ${this.maxRounds} turns. Stars cost ${STAR_COST} coins.`);

    // Roll-off: every number can only be rolled once, so there are no ties
    this.phase = 'ROLL_OFF';
    this.turnKey = 'rolloff';
    this.rollOff = { rolls: {}, order: null };
    this.setAwaiting(this.players.map(p => p.id));
    this.players.filter(p => p.cpu).forEach(p => setTimeout(() => this.rollFor(p), (1200 + Math.random() * 2500) / SPEED));
    this.broadcast();
  }

  rollFor(p) {
    const ro = this.rollOff;
    if (this.phase !== 'ROLL_OFF' || !ro || p.id in ro.rolls) return;
    const taken = new Set(Object.values(ro.rolls));
    const free = Array.from({ length: 10 }, (_, i) => i + 1).filter(n => !taken.has(n));
    const n = free[Math.floor(Math.random() * free.length)];
    ro.rolls[p.id] = n;
    this.clearAwaiting(p.id);
    this.fx('roll', { playerId: p.id, value: n, rollOff: true });
    this.broadcast();
    if (Object.keys(ro.rolls).length === this.players.length) this.safe(this.finishRollOff());
  }

  async finishRollOff() {
    const ro = this.rollOff;
    await wait(1500);
    this.players.sort((a, b) => ro.rolls[b.id] - ro.rolls[a.id]);
    ro.order = this.players.map(p => p.id);
    this.announce(`${this.players[0].name} goes first!`, { icon: '🎲', tone: 'good' });
    this.addLog(`Turn order: ${this.players.map(p => p.name).join(' → ')}`);
    this.broadcast();
    await wait(T.rollOffEnd);
    this.rollOff = null;
    await this.startRound();
  }

  async startRound() {
    this.players.forEach(p => { p.roundColor = null; });
    this.phase = 'TURN_SPLASH';
    this.fx('turnSplash', { round: this.round, maxRounds: this.maxRounds, last: this.isLastTurn() });
    this.broadcast();
    await wait(T.turnSplash);
    if (this.isLastTurn()) this.announce('LAST TURN! Shops are closed and Item spaces are empty.', { icon: '🔥', tone: 'bad' });
    else if (this.round === this.maxRounds - FINAL_STRETCH_TURNS + 1) {
      this.announce(`Final ${FINAL_STRETCH_TURNS} turns! Blue & red spaces are now doubled.`, { icon: '🔥', tone: 'bad' });
    } else if (this.round === 1 && this.isFinalStretch()) {
      this.announce('Short game: blue & red spaces are doubled all game!', { icon: '🔥' });
    }
    this.startRollPhase();
  }

  // ---------- turns ----------

  startRollPhase() {
    this.phase = 'ROLL';
    this.dice = null;
    this.pendingDice = null;
    this.pendingBoost = 0;
    this.turnItemUsed = false;
    this.turnKey = `${this.round}-${this.turnIndex}`;
    this.boardViewer = null;
    const p = this.current();
    this.setAwaiting([p.id]);
    this.broadcast();
    if (p.cpu) this.safe(this.cpuTurn(p));
    else if (!p.connected) {
      setTimeout(() => { if (this.phase === 'ROLL' && this.current() === p && !p.connected) this.safe(this.takeTurn()); }, 3000 / SPEED);
    }
  }

  async cpuTurn(p) {
    await wait(T.cpuThink);
    const idx = cpuBrain.chooseItem(this, p);
    if (idx >= 0) await this.useItem(p, idx);
    if (this.phase === 'ROLL' && this.current() === p) await this.takeTurn();
  }

  async useItem(p, index) {
    const id = p.items[index];
    if (!id || this.turnItemUsed || ITEMS[id].passive) return;
    const others = this.players.filter(o => o !== p);
    if (id === 'warpBlock' && !others.length) return; // nobody to swap with: keep the item

    this.phase = 'ITEM';
    this.clearAwaiting(p.id);
    this.turnItemUsed = true;
    p.items.splice(index, 1);
    p.stats.itemsUsed++;
    this.announce(`${p.name} used a ${ITEMS[id].name}!`, { icon: ITEMS[id].icon, playerIds: [p.id] });
    this.broadcast();
    await wait(T.beat);

    if (DICE_ITEMS.has(id)) {
      this.pendingDice = { doubleDice: 'double', tripleDice: 'triple', customDice: 'custom' }[id];
      if (p.badDice) {
        p.badDice = false;
        this.announce(`${p.name}'s Bad Dice was canceled!`, { icon: '🐌' });
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
      this.announce(`${target.name} will roll 1–3 on their next turn!`, { icon: '🐌', tone: 'bad', playerIds: [target.id] });
      await this.beat();
    }
    if (id === 'warpBlock') {
      const o = others[Math.floor(Math.random() * others.length)];
      [p.pos, o.pos] = [o.pos, p.pos];
      this.announce(`${p.name} swapped places with ${o.name}!`, { icon: '🌀', playerIds: [p.id, o.id] });
      await this.beat();
    }
    if (id === 'goldenPipe') {
      // Drops you on the space just before the Star: you still have to roll past it
      p.pos = this.star.from;
      this.announce(`${p.name} warped right next to the Star!`, { icon: '🟡', tone: 'good', playerIds: [p.id] });
      await this.beat();
    }
    if (id === 'banditCall') await banditEncounter(this, p);
    if (id === 'twister') {
      this.announce('Twister! The Star is blowing away…', { icon: '🌪️' });
      await this.beat();
      await this.relocateStar();
    }

    this.phase = 'ROLL';
    this.setAwaiting([p.id]);
    this.broadcast();
  }

  async takeTurn() {
    const p = this.current();
    this.phase = 'MOVING';
    this.clearAwaiting(p.id);
    const d = sides => 1 + Math.floor(Math.random() * sides);
    let roll, dice, kind = 'normal';
    if (this.pendingDice === 'custom') {
      roll = await this.ask(p, 'CUSTOM_DICE', {
        kind: 'customDice', text: 'Pick your roll!',
        options: Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
        defaultValue: 5,
      });
      dice = [roll]; kind = 'custom';
    } else if (this.pendingDice === 'double' || this.pendingDice === 'triple') {
      dice = Array.from({ length: this.pendingDice === 'double' ? 2 : 3 }, () => d(10));
      roll = dice.reduce((a, b) => a + b, 0); kind = this.pendingDice;
    } else if (p.badDice) {
      p.badDice = false;
      roll = d(3); dice = [roll]; kind = 'bad';
    } else {
      roll = d(10); dice = [roll];
    }
    const boost = this.pendingBoost;
    roll += boost;
    const detail = `${dice.join(' + ')}${boost ? ` + ${boost} Boost` : ''}`;
    this.addLog(`🎲 ${p.name} rolled ${dice.length > 1 || boost ? `${detail} = ` : ''}${roll}!${kind === 'bad' ? ' (Bad Dice)' : ''}`);
    p.stats.rolls++;
    p.stats.totalRolled += roll;
    p.stats.bestRoll = Math.max(p.stats.bestRoll, roll);
    this.dice = { playerId: p.id, value: roll, remaining: roll, dice, boost, kind };
    this.fx('roll', { playerId: p.id, value: roll, dice, boost, rollKind: kind });
    this.broadcast();
    await wait(T.afterRoll);

    while (this.dice.remaining > 0) {
      const from = p.pos;
      const nextId = await this.chooseNext(p, this.nodes.get(from));
      p.pos = nextId;
      const space = SPACES[this.spaceType(nextId)];
      if (!space.passOnly) { this.dice.remaining--; p.stats.spacesMoved++; }  // shops etc. don't use up a step
      this.broadcast();
      await wait(T.hop);

      // The Star sits between two spaces: walking across that stretch of path offers it
      if (this.star && from === this.star.from && nextId === this.star.to) await this.offerStar(p);
      // Pass effects only fire when you keep going (landing uses onLand instead)
      if (space.onPass && (space.passOnly || this.dice.remaining > 0)) await space.onPass(this, p, nextId);
    }

    await this.landOn(p);
    this.broadcast();
    await wait(T.afterLand);
    // The player taps "End turn" when they're done looking
    this.phase = 'TURN_END';
    this.turnKey = `${this.round}-${this.turnIndex}-end`;
    await this.waitForPress('endTurn', [p.id], 700);
    this.endTurn();
  }

  // Pick the next space at a fork (asks the player). Handles locked gates.
  async chooseNext(p, node) {
    if (node.next.length === 1) return node.next[0];
    const gateItem = id => node.gates?.[id];
    const open = node.next.filter(id => !gateItem(id) || p.items.includes(gateItem(id)));
    let nextId;
    if (open.length === 1) {
      nextId = open[0];
      if (open.length < node.next.length) { this.addLog(`🔒 The gate is locked: ${p.name} has no Secret Key.`); this.broadcast(); }
    } else {
      nextId = await this.ask(p, 'JUNCTION', {
        kind: 'junction',
        text: 'Which way?',
        options: open.map(id => ({
          value: id,
          label: (gateItem(id) ? `${ITEMS[gateItem(id)].icon} Use ${ITEMS[gateItem(id)].name}: ` : '') + (node.labels?.[id] || `Path ${id}`),
        })),
      });
    }
    if (gateItem(nextId)) {
      p.items.splice(p.items.indexOf(gateItem(nextId)), 1);
      this.announce(`${p.name} unlocked the gate to the Bandit's Hideout!`, { icon: '🗝️', playerIds: [p.id] });
      this.broadcast();
    }
    return nextId;
  }

  async landOn(p) {
    const type = this.spaceType(p.pos);
    const group = COLOR_GROUP[type] || 'green';
    p.roundColor ??= group; // first space landed this round decides your minigame team
    p.stats[`${group}Spaces`]++;
    this.fx('land', { playerId: p.id, nodeId: p.pos, spaceType: type });
    await SPACES[type].onLand?.(this, p, p.pos);
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
      this.spend(p, STAR_COST);
      this.addStar(p, 1);
      p.stats.starsBought++;
      this.announce(`${p.name} got a Star!`, { icon: '⭐', tone: 'good', playerIds: [p.id] });
      await this.beat();
      await this.relocateStar();
    }
    return this.beat();
  }

  // Pick a new stretch of path for the Star: between two real spaces, never next to
  // shops/Bandit, never in no-star areas (e.g. the Bandit's Hideout), never off Start.
  moveStar() {
    const ok = id => !this.isPassOnly(id) && !this.nodes.get(id).noStar && id !== this.board.startNodeId;
    const edges = [];
    for (const n of this.board.nodes) {
      if (!ok(n.id)) continue;
      for (const m of n.next) {
        if (ok(m) && !n.gates?.[m] && !(this.star && this.star.from === n.id && this.star.to === m)) edges.push({ from: n.id, to: m });
      }
    }
    this.star = edges[Math.floor(Math.random() * edges.length)];
  }

  // ---------- minigames ----------

  // Runs one minigame from intro to results.
  //   mode: 'ffa' | '2v2' | '1v3'; teams: { red: [ids], blue: [ids] } for team modes
  //   payout(rows, ctx) sets row.reward for each row
  async playMinigame({ banner = null, mode = 'ffa', teams = null, teamReveal = null, payout }) {
    const prevPhase = this.phase;
    const def = minigames.pick(mode, this.lastMinigameId);
    this.lastMinigameId = def.id;
    const cpuIds = new Set(this.players.filter(p => p.cpu).map(p => p.id));
    const state = def.setup(this.players);
    state.cpu = cpuIds;
    state.teams = teams;
    this.minigame = { def, banner, mode, teams, teamReveal, state, endsAt: null, results: null, teamResult: null };

    // 1) What kind of minigame + who's on which team (greens get randomized on screen)
    if (teamReveal) {
      this.phase = 'MINIGAME_TEAMS';
      this.broadcast();
      await wait(T.teams);
    }
    // 2) Name + rules; everyone taps Ready
    this.phase = 'MINIGAME_INTRO';
    this.turnKey = `${this.round}-mg-ready`;
    await this.waitForPress('ready', this.players.map(p => p.id), 1500);

    // 3) Play
    this.phase = 'MINIGAME';
    const now = Date.now();
    def.start(state, now);
    this.minigame.endsAt = now + def.durationMs / SPEED;
    this.broadcast();
    while (Date.now() < this.minigame.endsAt && !def.isOver?.(state)) {
      await sleep(Math.max(20, 200 / SPEED));
      const t = Date.now();
      cpuIds.forEach(id => def.cpu(state, id, t));
      def.tick?.(state, t);
      this.broadcast(); // live scores
    }
    await sleep(400 / SPEED); // a little grace for last inputs from phones

    // Rank individuals (ties share a place). "Valid" = actually scored, so nobody wins by doing nothing.
    const sign = def.better === 'lower' ? 1 : -1;
    const rows = def.getResults(state).map(r => ({
      ...r, valid: Number.isFinite(r.score) && !(def.better === 'higher' && r.score <= 0),
    }));
    rows.sort((a, b) => (b.valid - a.valid) || sign * (a.score - b.score));
    const validCount = rows.filter(r => r.valid).length;
    rows.forEach((row, i) => {
      const prev = rows[i - 1];
      if (!row.valid) row.place = validCount + 1;
      else row.place = prev && prev.valid && prev.score === row.score ? prev.place : i + 1;
    });

    // Teams: average of each team's scores (non-scorers count as the worst score),
    // unless the minigame scores teams itself (e.g. 1v3 hide & seek)
    if (teams) {
      const val = r => (r.valid ? r.score : def.better === 'lower' ? def.worst : 0);
      const custom = def.teamScores?.(state, teams);
      const tr = {};
      for (const [color, ids] of Object.entries(teams)) {
        const mine = rows.filter(r => ids.includes(r.playerId));
        const avg = custom ? custom[color] : mine.reduce((s, r) => s + val(r), 0) / Math.max(1, mine.length);
        tr[color] = { ids, score: Math.round(avg * 10) / 10 };
        mine.forEach(r => { r.team = color; });
      }
      const [a, b] = Object.keys(tr);
      const winner = tr[a].score === tr[b].score ? 'tie' : (sign * (tr[a].score - tr[b].score) < 0 ? a : b);
      this.minigame.teamResult = { teams: tr, winner };
      rows.forEach(r => { r.won = winner === 'tie' || r.team === winner; });
    } else {
      rows.forEach(r => { r.won = r.valid && r.place === 1; });
    }

    payout(rows, this.minigame);
    rows.forEach(row => {
      const p = this.players.find(x => x.id === row.playerId);
      if (!p) return;
      p.stats.minigamesPlayed++;
      if (row.won && this.minigame.teamResult?.winner !== 'tie') p.stats.minigameWins++;
      if (row.reward) this.give(p, row.reward);
    });

    this.minigame.results = rows;
    this.phase = 'MINIGAME_RESULTS';
    const tr = this.minigame.teamResult;
    if (tr) {
      this.addLog(tr.winner === 'tie' ? `🤝 ${def.name}: it's a tie!` : `🏆 ${def.name}: ${tr.winner.toUpperCase()} team wins! (${tr.teams[tr.winner].ids.map(id => this.nameOf(id)).join(' & ')})`);
    } else {
      const winners = rows.filter(r => r.won).map(r => this.nameOf(r.playerId));
      this.addLog(winners.length ? `🏆 ${def.name}: ${winners.join(' & ')} won!` : `${def.name}: nobody scored!`);
    }
    this.broadcast();
    await wait(T.results);
    // Player 1 taps Next to carry on
    this.turnKey = `${this.round}-mg-next`;
    await this.waitForPress('next', [this.nextPresserId()], 2500);
    this.minigame = null;
    this.phase = prevPhase;
    return rows;
  }

  // Teams come from the color of the space each player landed on this round.
  // Green spaces are randomly counted as red or blue. 4-0 → free-for-all, 3-1 → 1v3, 2-2 → 2v2.
  roundTeams() {
    const teams = { red: [], blue: [] };
    const reveal = [];
    for (const p of this.players) {
      const landed = p.roundColor || 'green';
      const c = landed === 'red' || landed === 'blue' ? landed : (Math.random() < 0.5 ? 'red' : 'blue');
      teams[c].push(p.id);
      reveal.push({ playerId: p.id, landed, team: c });
    }
    const sizes = [teams.red.length, teams.blue.length].sort();
    const mode = sizes[0] === 0 ? 'ffa' : sizes[0] === 1 ? '1v3' : '2v2';
    return { mode, teams: mode === 'ffa' ? null : teams, reveal };
  }

  async endOfRoundMinigame() {
    const { mode, teams, reveal } = this.roundTeams();
    await this.playMinigame({
      mode, teams, teamReveal: reveal,
      payout: rows => rows.forEach(r => {
        if (teams) r.reward = r.won ? (this.minigame.teamResult.winner === 'tie' ? TEAM_REWARD / 2 : TEAM_REWARD) : 0;
        else r.reward = r.valid ? FFA_REWARDS[r.place - 1] ?? 0 : 0;
      }),
    });
    if (this.round >= this.maxRounds) return this.finish();
    this.round++;
    await this.startRound();
  }

  // VS spaces: free-for-all, pot split by place (90% / 9% / 1% / 0%). Tied places share.
  async vsMinigame(pot) {
    await this.playMinigame({
      banner: `VS Battle: ${pot} coins on the line (90% / 9% / 1%)`,
      payout: rows => {
        if (!rows.some(r => r.valid)) { // nobody scored: refund
          rows.forEach(r => { r.reward = Math.floor(pot / rows.length); });
          return;
        }
        const byPlace = {};
        rows.filter(r => r.valid).forEach(r => { (byPlace[r.place] ||= []).push(r); });
        let paid = 0;
        for (const [place, group] of Object.entries(byPlace)) {
          const start = Number(place) - 1;
          const share = VS_SHARES.slice(start, start + group.length).reduce((s, x) => s + x, 0);
          const each = Math.floor((pot * share) / group.length);
          group.forEach(r => { r.reward = each; paid += each; });
        }
        rows.forEach(r => { r.reward ??= 0; });
        const first = rows.find(r => r.place === 1 && r.valid);
        if (first) first.reward += pot - paid; // rounding leftovers go to 1st
      },
    });
  }

  // ---------- actions from phones ----------

  handleAction(playerId, action) {
    this.lastActivity = Date.now();
    if (!action || typeof action.type !== 'string') return;
    const p = this.players.find(x => x.id === playerId);
    if (!p || p.cpu) return;
    const isTurn = this.phase === 'ROLL' && this.current()?.id === playerId;

    if (action.type === 'roll') {
      if (isTurn) this.safe(this.takeTurn());
    } else if (action.type === 'rollOff') {
      this.rollFor(p);
    } else if (action.type === 'useItem') {
      if (isTurn) this.safe(this.useItem(p, Number(action.index)));
    } else if (action.type === 'choose') {
      const w = this.waiter;
      if (w && w.playerId === playerId && this.prompt.options.some(o => o.value === action.value && !o.disabled)) {
        w.finish(action.value);
      }
    } else if (action.type === 'minigame') {
      if (this.phase === 'MINIGAME') this.minigame.def.onInput(this.minigame.state, playerId, action.input, Date.now());
    } else if (action.type === 'nudge') {
      this.nudge(playerId, action.targetId);
    } else if (action.type === 'press') {
      if (this.gate && this.gate.kind === action.kind) this.gate.press(playerId);
    } else if (action.type === 'viewBoard') {
      this.boardViewer = action.open ? playerId : (this.boardViewer === playerId ? null : this.boardViewer);
      this.broadcast();
    }
  }

  // ---------- ending ----------

  // End of game: reveal each bonus Star one at a time, then the standings from 4th to 1st
  async finish() {
    const bonuses = [
      { title: 'Minigame Star', stat: 'minigameWins', desc: 'most minigame wins', icon: '🏆' },
      { title: 'Coin Star', stat: 'coinsEarned', desc: 'most coins earned', icon: '🪙' },
      { title: 'Unlucky Star', stat: 'redSpaces', desc: 'most red spaces', icon: '🔴' },
    ].map(b => {
      const best = Math.max(...this.players.map(p => p.stats[b.stat]));
      const winners = best > 0 ? this.players.filter(p => p.stats[b.stat] === best) : [];
      return { ...b, value: best, playerIds: winners.map(p => p.id) };
    });
    this.awaiting = null;
    this.phase = 'FINALE';
    this.finale = { step: 'intro', bonuses, index: -1, revealed: false, standings: null, shown: 0 };
    this.broadcast();
    await wait(T.finaleIntro);

    for (let i = 0; i < bonuses.length; i++) {
      Object.assign(this.finale, { step: 'bonus', index: i, revealed: false });
      this.broadcast();
      await wait(T.drumroll);
      bonuses[i].playerIds.forEach(id => this.addStar(this.players.find(p => p.id === id), 1));
      this.finale.revealed = true;
      this.broadcast();
      await wait(T.reveal);
    }

    const standings = this.ranked().map(p => ({ playerId: p.id, stars: p.stars, coins: p.coins }));
    standings.forEach((st, i) => {
      const prev = standings[i - 1];
      st.place = prev && prev.stars === st.stars && prev.coins === st.coins ? prev.place : i + 1;
    });
    Object.assign(this.finale, { step: 'standings', standings, shown: 0 });
    for (let k = 1; k <= standings.length; k++) {
      this.finale.shown = k; // reveals from last place up to the winner
      this.broadcast();
      await wait(k === standings.length ? T.reveal * 1.6 : T.reveal);
    }

    this.final = { bonuses, standings };
    this.phase = 'GAME_OVER';
    this.addLog(`🎉 ${this.nameOf(standings[0].playerId)} is the Superstar!`);
    this.broadcast();
  }

  // Back to the lobby with the same human players (CPUs and players who left are dropped)
  restart() {
    if (this.phase !== 'GAME_OVER') return;
    this.players = this.players.filter(p => p.connected && !p.cpu);
    if (!this.players.some(p => p.id === this.hostPlayerId)) this.hostPlayerId = this.players[0]?.id ?? null;
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
    const turnPhases = ['ROLL', 'ITEM', 'ITEM_TARGET', 'DISCARD', 'MOVING', 'JUNCTION', 'STAR_PROMPT', 'SHOP', 'CUSTOM_DICE', 'BANDIT', 'ROULETTE', 'TURN_END'];
    const a = this.awaiting;
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      maxRounds: this.maxRounds,
      turnsLeft: Math.max(0, this.maxRounds - this.round),
      lastTurn: this.phase !== 'LOBBY' && this.isLastTurn(),
      finalStretch: this.phase !== 'LOBBY' && this.isFinalStretch(),
      starCost: STAR_COST,
      boardId: this.board.id,
      hostPlayerId: this.hostPlayerId,
      gate: this.gate && { kind: this.gate.kind, pending: [...this.gate.pending] },
      finale: this.finale,
      boardView: !!this.boardViewer,
      rareUnlockRound: this.rareUnlockRound(),
      turnPlayerId: turnPhases.includes(this.phase) && !mg ? this.current()?.id : null,
      turnItemUsed: this.turnItemUsed,
      star: this.star,
      bank: this.bank,
      spaceOverrides: this.spaceOverrides,
      dice: this.dice,
      prompt: this.prompt && { ...this.prompt },
      roulette: this.rouletteState,
      rollOff: this.rollOff,
      awaiting: a && {
        playerIds: a.playerIds,
        waitedMs: (Date.now() - a.since) * SPEED,
        nudgeAfterMs: NUDGE_AFTER_MS,
        nudgedBy: [...this.nudges].filter(k => k.startsWith(`${a.key}|`)).map(k => k.split('|')[1]),
      },
      players: this.players.map(({ socketId, ...pub }) => pub),
      minigame: mg && {
        id: mg.def.id,
        name: mg.def.name,
        banner: mg.banner,
        mode: mg.mode,
        teams: mg.teams,
        teamReveal: mg.teamReveal,
        instructions: mg.def.instructions,
        controls: mg.def.controls,
        config: mg.def.config,
        better: mg.def.better,
        durationMs: mg.def.durationMs / SPEED,
        timeLeftMs: mg.endsAt ? Math.max(0, mg.endsAt - Date.now()) : null,
        live: mg.def.publicState(mg.state),
        results: mg.results,
        teamResult: mg.teamResult,
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
