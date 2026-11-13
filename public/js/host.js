// Host screen (TV): creates the room, renders the board (Phaser) and the sidebar/overlays (DOM),
// and plays the big animations/announcements from server "fx" events.

const socket = io();
const $ = id => document.getElementById(id);
const esc = str => String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let scene = null;
let latest = null;
let ITEMS = {};
let SPACE_TYPES = {};
let BOARDS = {};
let phaserGame = null;
let shownBoardId = null;

$('join-url').textContent = `${location.host}/play.html`;

// ----- create or rejoin the room -----
const saved = JSON.parse(sessionStorage.getItem('partyHost') || 'null');
if (saved) socket.emit('host:rejoin', saved, res => (res.ok ? onRoom(res) : createRoom()));
else createRoom();

function createRoom() { socket.emit('host:create', {}, onRoom); }

function onRoom({ code, hostKey, boards, spaceTypes, items }) {
  ITEMS = items || {};
  SPACE_TYPES = spaceTypes || {};
  BOARDS = Object.fromEntries(boards.map(b => [b.id, b]));
  $('board-select').innerHTML = boards.map(b => `<option value="${b.id}">${esc(b.name)} (${b.nodes.length} spaces)</option>`).join('');
  renderLegend();
  sessionStorage.setItem('partyHost', JSON.stringify({ code, hostKey }));
  $('code').textContent = code;
  $('join-url').textContent = `${location.host}/play.html?code=${code}`;
  if (latest) showBoard(latest.boardId);
}

// After a server restart the room is gone, so make a fresh one
socket.on('connect', () => {
  if (!latest) return;
  const s = JSON.parse(sessionStorage.getItem('partyHost') || 'null');
  socket.emit('host:rejoin', s || {}, res => { if (!res.ok) { sessionStorage.removeItem('partyHost'); location.reload(); } });
});

// (Re)build the Phaser board whenever the room's board changes
function showBoard(boardId) {
  const board = BOARDS[boardId];
  if (!board || boardId === shownBoardId) return;
  shownBoardId = boardId;
  scene = null;
  if (phaserGame) phaserGame.destroy(true);
  phaserGame = new Phaser.Game({
    type: Phaser.AUTO, parent: 'board', width: board.width, height: board.height, backgroundColor: '#0d1528',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [],
    callbacks: {
      postBoot: game => game.scene.add('board', BoardScene, true, {
        board, spaceTypes: SPACE_TYPES,
        onReady: s => { scene = s; if (latest) scene.applyState(latest); },
      }),
    },
  });
}

// ----- controls -----
$('start-btn').onclick = () => socket.emit('host:start', { maxRounds: Number($('rounds').value) });
$('restart-btn').onclick = () => socket.emit('host:restart');
$('board-select').onchange = e => socket.emit('host:setBoard', { boardId: e.target.value });

// ----- render -----
socket.on('state', s => {
  latest = s;
  showBoard(s.boardId);
  if (scene) scene.applyState(s);
  renderSidebar(s);
  renderOverlay(s);
});

const nameOf = (s, id) => s.players.find(p => p.id === id)?.name ?? '?';
const colorOf = (s, id) => s.players.find(p => p.id === id)?.color ?? '#fff';
const chip = (s, id) => `<span class="dot" style="background:${colorOf(s, id)}"></span> ${esc(nameOf(s, id))}`;
const modeLabel = m => ({ ffa: 'FREE-FOR-ALL', '2v2': '2 VS 2', '1v3': '1 VS 3' }[m] || '');

function renderSidebar(s) {
  const lobby = s.phase === 'LOBBY';
  $('lobby-controls').classList.toggle('hidden', !lobby);
  $('restart-btn').classList.toggle('hidden', s.phase !== 'GAME_OVER');
  if ($('board-select').value !== s.boardId) $('board-select').value = s.boardId;
  const humans = s.players.length;
  $('start-btn').disabled = humans < 1;
  $('start-btn').textContent = humans
    ? `Start game (${humans} player${humans > 1 ? 's' : ''}${humans < 4 ? ` + ${4 - humans} CPU` : ''})` : 'Waiting for players…';

  // Big turn counter
  const tc = $('turn-counter');
  if (lobby || s.phase === 'ROLL_OFF') tc.innerHTML = lobby ? '' : '<div class="tc-main">Turn order roll-off</div>';
  else if (s.phase === 'GAME_OVER') tc.innerHTML = '<div class="tc-main">GAME OVER</div>';
  else {
    tc.innerHTML = `<div class="tc-main">TURN <b>${s.round}</b> / ${s.maxRounds}</div>
      <div class="tc-sub ${s.lastTurn ? 'last' : s.finalStretch ? 'stretch' : ''}">${s.lastTurn ? '🔥 LAST TURN!' : `${s.turnsLeft} turn${s.turnsLeft === 1 ? '' : 's'} left${s.finalStretch ? ' · 🔥 blue & red doubled' : ''}`}</div>`;
  }

  const turnName = s.turnPlayerId ? `<span style="color:${colorOf(s, s.turnPlayerId)}">${esc(nameOf(s, s.turnPlayerId))}</span>` : '';
  $('turn-banner').innerHTML = {
    LOBBY: 'Join on your phone!',
    ROLL_OFF: 'Everyone roll on your phone!',
    ROLL: `${turnName}'s turn: roll!`,
    ITEM: `${turnName} is using an item…`,
    ITEM_TARGET: `🐌 ${turnName} is picking a Bad Dice victim…`,
    BANDIT: `🦹 ${turnName} is meeting the Bandit…`,
    DISCARD: `🗑️ ${turnName}'s bag is full…`,
    SHOP: `🛒 ${turnName} is shopping…`,
    CUSTOM_DICE: `🎯 ${turnName} is picking a number…`,
    ROULETTE: `${turnName}'s roulette…`,
    MOVING: `${turnName} is moving…`,
    JUNCTION: `${turnName} is choosing a path…`,
    STAR_PROMPT: `⭐ ${turnName}: buy a Star?`,
    MINIGAME_INTRO: 'Minigame time!',
    MINIGAME: 'Minigame time!',
    MINIGAME_RESULTS: 'Minigame results',
    GAME_OVER: 'Game over!',
  }[s.phase] || '';

  const players = lobby ? s.players : [...s.players].sort((a, b) => b.stars - a.stars || b.coins - a.coins);
  $('players').innerHTML = players.map(p => `
    <div class="player-card ${p.id === s.turnPlayerId ? 'active' : ''} ${p.connected ? '' : 'offline'}">
      <span class="dot" style="background:${p.color}"></span>
      <span>${esc(p.name)}${p.cpu ? ' <span class="cpu-tag">CPU</span>' : ''}${p.connected ? '' : ' (offline)'}
        <span class="items">${(p.items || []).map(id => ITEMS[id]?.icon ?? '').join(' ')}</span>
        ${p.badDice ? '<span class="cursed" title="Bad Dice: rolls 1–3 next turn">🐌 1–3</span>' : ''}</span>
      ${lobby ? '<span></span><span></span>' : `<span class="stat">⭐ ${p.stars}</span><span class="stat">🪙 ${p.coins}</span>`}
    </div>`).join('');

  $('log').innerHTML = s.log.map(l => `<div>${esc(l)}</div>`).join('');
}

function renderOverlay(s) {
  const el = $('overlay'), c = $('overlay-content');
  const mg = s.minigame;
  if (s.phase !== 'ROULETTE') stopRoulette();
  el.classList.remove('see-through');

  if (s.phase === 'ROLL_OFF' && s.rollOff) {
    el.classList.remove('hidden');
    const ro = s.rollOff;
    c.innerHTML = `<h2>🎲 Who goes first?</h2>
      <div class="big">${ro.order ? 'Turn order' : 'Roll on your phone! Highest goes first. No repeats.'}</div>
      <div class="rolloff">${(ro.order || s.players.map(p => p.id)).map((id, i) => `
        <div class="ro-card ${id in ro.rolls ? 'rolled' : ''}" style="border-color:${colorOf(s, id)}">
          ${ro.order ? `<div class="ro-place">#${i + 1}</div>` : ''}
          <div class="ro-num">${ro.rolls[id] ?? '?'}</div>
          <div>${esc(nameOf(s, id))}</div>
        </div>`).join('')}</div>`;
  } else if (s.phase === 'ROULETTE' && s.roulette) {
    el.classList.remove('hidden');
    renderRoulette(s.roulette);
  } else if (s.phase === 'MINIGAME_INTRO' && mg) {
    el.classList.remove('hidden');
    c.innerHTML = `${mg.banner ? `<div class="banner">${esc(mg.banner)}</div>` : ''}
      <div class="mode-badge">${modeLabel(mg.mode)}</div>
      <h2>${esc(mg.name)}</h2><div class="big">${esc(mg.instructions)}</div>
      ${mg.teams ? renderTeams(s, mg.teams) : ''}
      <div class="big get-ready">Get ready…</div>`;
  } else if (s.phase === 'MINIGAME' && mg) {
    el.classList.remove('hidden');
    c.innerHTML = `<h2>${esc(mg.name)}</h2><div class="timer">${Math.ceil((mg.timeLeftMs ?? 0) / 1000)}</div>${renderLive(s, mg)}`;
  } else if (s.phase === 'MINIGAME_RESULTS' && mg?.results) {
    el.classList.remove('hidden');
    const tr = mg.teamResult;
    c.innerHTML = `<h2>${esc(mg.name)}: Results</h2>
      ${tr ? `<div class="team-result ${tr.winner}">${tr.winner === 'tie' ? '🤝 TIE!' : `🏆 ${tr.winner.toUpperCase()} TEAM WINS`}</div>
        <div class="big">Red ${tr.teams.red.score} · Blue ${tr.teams.blue.score} (team average)</div>` : ''}
      <table class="results-table">${mg.results.map(r => `<tr>
        <td>${tr ? `<span class="team-tag ${r.team}">${r.team}</span>` : `#${r.place}`}</td>
        <td>${chip(s, r.playerId)}</td><td>${esc(r.display)}</td>
        <td>${r.reward ? `+${r.reward} 🪙` : ''}</td></tr>`).join('')}</table>`;
  } else if (s.phase === 'GAME_OVER' && s.final) {
    el.classList.remove('hidden');
    c.innerHTML = renderGameOver(s);
  } else {
    el.classList.add('hidden');
  }
}

function renderTeams(s, teams) {
  return `<div class="teams">${Object.entries(teams).map(([color, ids]) => `
    <div class="team ${color}"><div class="team-name">${color.toUpperCase()}</div>${ids.map(id => `<div>${chip(s, id)}</div>`).join('')}</div>`).join('<div class="vs">VS</div>')}</div>`;
}

// Live view while a minigame runs: bars for everyone (and team averages)
function renderLive(s, mg) {
  const live = mg.live || {};
  let head = '';
  if (mg.controls === 'reaction') {
    const go = live.goInMs === 0;
    head = `<div class="big" style="font-size:3.2rem; color:${go ? '#2b9348' : '#e63946'}">${go ? 'GO!' : 'Wait for it…'}</div>`;
  }
  const scores = live.scores || {};
  const vals = Object.values(scores).filter(v => typeof v === 'number');
  const lower = mg.better === 'lower';
  const max = Math.max(1, ...vals.map(Math.abs));
  const width = v => (typeof v !== 'number' ? 0 : lower ? Math.max(6, 100 - (v / Math.max(max, 1)) * 90) : Math.max(0, (v / max) * 100));
  const row = p => `<div class="bar-row"><span>${chip(s, p.id)}</span>
      <div class="bar"><div style="width:${width(scores[p.id])}%; background:${p.color}"></div></div>
      <span>${esc(live.display?.[p.id] ?? '')}</span></div>`;
  if (mg.teams) {
    return head + `<div class="team-bars">${Object.entries(mg.teams).map(([color, ids]) => `
      <div class="team ${color}"><div class="team-name">${color.toUpperCase()}</div>
      <div class="bars">${ids.map(id => row(s.players.find(p => p.id === id))).join('')}</div></div>`).join('')}</div>`;
  }
  return head + `<div class="bars">${s.players.map(row).join('')}</div>`;
}

function renderGameOver(s) {
  const winner = s.final.standings[0];
  const ps = s.players;
  const stat = (label, f) => `<tr><td>${label}</td>${ps.map(p => `<td>${f(p.stats, p)}</td>`).join('')}</tr>`;
  return `<h2>🎉 ${esc(nameOf(s, winner.playerId))} wins!</h2>
    <div class="final-grid">
      <div>
        <div class="big">Final standings</div>
        <table class="results-table">${s.final.standings.map(st => `<tr>
          <td>#${st.place}</td><td>${chip(s, st.playerId)}</td><td>⭐ ${st.stars}</td><td>🪙 ${st.coins}</td></tr>`).join('')}</table>
        <div class="big" style="margin-top:18px">Bonus Stars</div>
        <table class="results-table small">${s.final.bonuses.map(b => `<tr>
          <td>⭐ ${b.title}</td><td>${b.playerIds.length ? b.playerIds.map(id => esc(nameOf(s, id))).join(', ') : 'nobody'}</td>
          <td style="opacity:.7">${b.desc}</td></tr>`).join('')}</table>
      </div>
      <div>
        <div class="big">Stats</div>
        <table class="stats-table">
          <tr><th></th>${ps.map(p => `<th style="color:${p.color}">${esc(p.name)}</th>`).join('')}</tr>
          ${stat('🎲 Avg roll', st => (st.rolls ? (st.totalRolled / st.rolls).toFixed(1) : '–'))}
          ${stat('🎲 Best roll', st => st.bestRoll)}
          ${stat('👣 Spaces moved', st => st.spacesMoved)}
          ${stat('🔵 Blue spaces', st => st.blueSpaces)}
          ${stat('🔴 Red spaces', st => st.redSpaces)}
          ${stat('🟢 Green spaces', st => st.greenSpaces)}
          ${stat('🪙 Coins earned', st => st.coinsEarned)}
          ${stat('💸 Coins lost', st => st.coinsLost)}
          ${stat('🛒 Coins spent', st => st.coinsSpent)}
          ${stat('⭐ Stars bought', st => st.starsBought)}
          ${stat('🦹 Coins stolen', st => st.coinsStolen)}
          ${stat('😭 Got robbed', st => st.coinsRobbed)}
          ${stat('🎁 Items got / used', st => `${st.itemsGained} / ${st.itemsUsed}`)}
          ${stat('🏆 Minigames won', st => `${st.minigameWins} / ${st.minigamesPlayed}`)}
        </table>
      </div>
    </div>`;
}

// ----- fx: animations + announcements -----
socket.on('fx', fx => {
  if (!latest) return;
  switch (fx.kind) {
    case 'roll': if (!fx.rollOff) scene?.showRoll(fx); break;
    case 'coins': scene?.floatText(fx.playerId, `${fx.amount > 0 ? '+' : ''}${fx.amount} 🪙`, fx.amount > 0 ? '#80ed99' : '#ff8a8a'); break;
    case 'item': scene?.floatText(fx.playerId, `🎁 ${ITEMS[fx.itemId]?.icon ?? ''} ${ITEMS[fx.itemId]?.name ?? ''}`, '#80ed99', 30); break;
    case 'star': scene?.starFx(fx.playerId, fx.amount); break;
    case 'land': scene?.burst(fx.nodeId, SPACE_TYPES[fx.spaceType]?.color || '#ffffff'); break;
    case 'announce': announce(`${fx.icon ? `${fx.icon} ` : ''}${fx.text}`, fx.tone); break;
    case 'nudge': announce(`👉 ${fx.fromName} nudged ${fx.toName}!`, 'info'); break;
  }
});

// Big banner across the board, one at a time
const queue = [];
function announce(text, tone = 'info') {
  queue.push({ text, tone });
  if (queue.length === 1) showNext();
}
function showNext() {
  const item = queue[0];
  if (!item) return;
  const el = $('announce');
  el.className = `announce ${item.tone} show`;
  el.textContent = item.text;
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { queue.shift(); showNext(); }, 250);
  }, queue.length > 2 ? 1400 : 2400);
}

// ----- roulette (spins through the options, then settles on the server's pick) -----
let spin = null;
function renderRoulette(r) {
  const c = $('overlay-content');
  if (spin?.id !== r.id) {
    stopRoulette();
    c.innerHTML = `<h2 style="font-size:2.2rem">${esc(r.title)}</h2>
      <div class="roulette${r.labels.length > 6 ? ' many' : ''}">${r.labels.map((l, i) => `<div class="slot" data-i="${i}">${esc(l)}</div>`).join('')}</div>
      <div class="big roulette-result"></div>`;
    const slots = [...c.querySelectorAll('.slot')];
    let i = 0, delay = 70, steps = 0;
    const total = slots.length * 2 + r.resultIndex;
    const tick = () => {
      slots.forEach(s => s.classList.remove('lit'));
      slots[i % slots.length].classList.add('lit');
      if (steps++ >= total) {
        slots[i % slots.length].classList.add('picked');
        spin.done = true;
        if (spin.text) c.querySelector('.roulette-result').textContent = spin.text;
        return;
      }
      i++; delay *= 1.06;
      spin.timer = setTimeout(tick, delay);
    };
    spin = { id: r.id, timer: null, done: false, text: null };
    tick();
  }
  if (r.resultText) {
    spin.text = r.resultText;
    if (spin.done) c.querySelector('.roulette-result').textContent = r.resultText;
  }
}
function stopRoulette() { if (spin) clearTimeout(spin.timer); spin = null; }

function renderLegend() {
  $('legend').innerHTML = Object.values(SPACE_TYPES).filter(t => t.icon !== 'GO').map(t => `
    <div><span class="legend-dot ${t.passOnly ? 'square' : ''}" style="background:${t.color}">${esc(t.icon)}</span>
      <b>${esc(t.name)}</b>: ${esc(t.desc)}</div>`).join('') +
    '<div><span class="legend-dot" style="background:#ffd166">⭐</span><b>Star</b>: sits on the path between spaces. Walk past it to buy one.</div>';
}
