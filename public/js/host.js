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
  // Make sure the board font is loaded before Phaser draws any text
  Promise.race([document.fonts.load('40px "Lilita One"'), new Promise(r => setTimeout(r, 1500))])
    .then(() => { if (shownBoardId === boardId) phaserGame = makeGame(board); });
}

function makeGame(board) {
  return new Phaser.Game({
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
  renderSteps(s);
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
    TURN_SPLASH: 'Here we go!',
    TURN_END: `${turnName}: tap <b>End turn</b> when ready`,
    MINIGAME_TEAMS: 'Picking teams…',
    FINALE: 'And the winner is…',
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
    MINIGAME_INTRO: 'Tap Ready on your phone!',
    MINIGAME: 'Minigame time!',
    MINIGAME_RESULTS: 'Minigame results',
    GAME_OVER: 'Game over!',
  }[s.phase] || '';

  const players = lobby ? s.players : [...s.players].sort((a, b) => b.stars - a.stars || b.coins - a.coins);
  $('players').innerHTML = players.map(p => `
    <div class="player-card ${p.id === s.turnPlayerId ? 'active' : ''} ${p.connected ? '' : 'offline'}">
      <span class="dot" style="background:${p.color}"></span>
      <span>${p.id === s.hostPlayerId ? '<span title="Player 1">👑</span> ' : ''}${esc(p.name)}${p.cpu ? ' <span class="cpu-tag">CPU</span>' : ''}${p.connected ? '' : ' (offline)'}
        ${p.roundColor && !lobby && s.phase !== 'GAME_OVER' ? `<span class="landed ${p.roundColor}" title="Space color landed on this turn"></span>` : ''}
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
  if (s.phase !== 'FINALE') delete c.dataset.key;
  el.classList.remove('see-through');
  if (s.phase === 'GAME_OVER' && !confettiDone) { confettiDone = true; confetti(160); }
  if (s.phase !== 'GAME_OVER') confettiDone = false;

  if (s.phase === 'LOBBY') {
    el.classList.remove('hidden');
    el.classList.add('see-through');
    const seats = [0, 1, 2, 3].map(i => s.players[i]);
    c.innerHTML = `<div class="title-card">
      <div class="logo">PARTY<span>BOARD</span></div>
      <div class="board-name">🏝️ ${esc(BOARDS[s.boardId]?.name || '')}</div>
      <div class="join-line">Join at <b>${esc(location.host)}/play.html</b> with code</div>
      <div class="join-code">${esc(s.code)}</div>
      <div class="seats">${seats.map((p, i) => p
        ? `<div class="seat filled" style="--c:${p.color}"><div class="seat-pawn">♟</div>${esc(p.name)}</div>`
        : `<div class="seat"><div class="seat-pawn">🤖</div>CPU will join</div>`).join('')}</div>
    </div>`;
  } else if (s.phase === 'ROLL_OFF' && s.rollOff) {
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
  } else if (s.phase === 'TURN_SPLASH') {
    el.classList.remove('hidden');
    el.classList.add('see-through');
    if (!c.querySelector('.turn-splash')) {
      c.innerHTML = `<div class="turn-splash ${s.lastTurn ? 'last' : ''}">
        <div class="ts-small">${s.lastTurn ? '🔥 FINAL ROUND 🔥' : s.finalStretch ? '🔥 Final stretch' : 'Get ready!'}</div>
        <div class="ts-big">${s.lastTurn ? 'LAST TURN!' : `TURN ${s.round}`}</div>
        <div class="ts-small">of ${s.maxRounds}</div></div>`;
    }
  } else if (s.phase === 'MINIGAME_TEAMS' && mg) {
    el.classList.remove('hidden');
    if (!c.querySelector('.team-reveal')) c.innerHTML = renderTeamReveal(s, mg);
  } else if (s.phase === 'FINALE' && s.finale) {
    el.classList.remove('hidden');
    renderFinale(s);
  } else if (s.phase === 'ROULETTE' && s.roulette) {
    el.classList.remove('hidden');
    renderRoulette(s.roulette);
  } else if (s.phase === 'MINIGAME_INTRO' && mg) {
    el.classList.remove('hidden');
    const pending = s.gate?.kind === 'ready' ? s.gate.pending : [];
    c.innerHTML = `${mg.banner ? `<div class="banner">${esc(mg.banner)}</div>` : ''}
      <div class="mode-badge">${modeLabel(mg.mode)}</div>
      <h2>${esc(mg.name)}</h2><div class="big rules">${esc(mg.instructions)}</div>
      ${mg.teams ? renderTeams(s, mg.teams) : ''}
      <div class="ready-list">${s.players.map(p => `<div class="ready-chip ${pending.includes(p.id) ? '' : 'ok'}" style="--c:${p.color}">
        ${pending.includes(p.id) ? '⏳' : '✅'} ${esc(p.name)}</div>`).join('')}</div>
      <div class="big get-ready">${pending.length ? 'Tap READY on your phone!' : 'Starting!'}</div>`;
  } else if (s.phase === 'MINIGAME' && mg) {
    el.classList.remove('hidden');
    const view = mg.live?.view;
    c.innerHTML = `<h2>${esc(mg.name)}</h2>${view ? '' : `<div class="timer">${Math.ceil((mg.timeLeftMs ?? 0) / 1000)}</div>`}${view ? renderView(s, mg) : renderLive(s, mg)}`;
  } else if (s.phase === 'MINIGAME_RESULTS' && mg?.results) {
    el.classList.remove('hidden');
    const tr = mg.teamResult;
    c.innerHTML = `<h2>${esc(mg.name)}: Results</h2>
      ${tr ? `<div class="team-result ${tr.winner}">${tr.winner === 'tie' ? '🤝 TIE!' : `🏆 ${tr.winner.toUpperCase()} TEAM WINS`}</div>
        <div class="big">Red ${tr.teams.red.score} · Blue ${tr.teams.blue.score} (team average)</div>` : ''}
      ${tr ? `<table class="results-table">${mg.results.map(r => `<tr>
        <td><span class="team-tag ${r.team}">${r.team}</span></td>
        <td>${chip(s, r.playerId)}</td><td>${esc(r.display)}</td>
        <td>${r.reward ? `+${r.reward} 🪙` : ''}</td></tr>`).join('')}</table>` : podium(s, mg.results.map(r => ({
        playerId: r.playerId, place: r.place, line1: r.display, line2: r.reward ? `+${r.reward} 🪙` : '' })))}
      ${s.gate?.kind === 'next' ? `<div class="next-hint">▶️ Waiting for <b>${esc(nameOf(s, s.gate.pending[0]))}</b> to tap Next</div>` : ''}`;
  } else if (s.phase === 'GAME_OVER' && s.final) {
    el.classList.remove('hidden');
    c.innerHTML = renderGameOver(s);
  } else {
    el.classList.add('hidden');
  }
}

// Teams screen: everyone's landed color; green players flicker red/blue, then lock in
function renderTeamReveal(s, mg) {
  const cards = mg.teamReveal.map((r, i) => `
    <div class="tr-card ${r.landed === 'green' ? 'green-flip' : ''}" style="--final:${r.team === 'red' ? '#e63946' : '#1982c4'}; --delay:${1.2 + i * 0.5}s">
      <div class="tr-name">${chip(s, r.playerId)}</div>
      <div class="tr-landed">landed on <span class="landed ${r.landed}"></span> ${r.landed}</div>
      <div class="tr-team ${r.team}">${r.landed === 'green' ? '🎲 → ' : ''}${r.team.toUpperCase()}</div>
    </div>`).join('');
  return `<div class="team-reveal">
    <h2>Minigame time!</h2>
    <div class="big">Your team is the color of the space you landed on. Green? Random!</div>
    <div class="tr-cards">${cards}</div>
    <div class="tr-mode" style="animation-delay:${1.6 + mg.teamReveal.length * 0.5}s">${modeLabel(mg.mode)}</div>
  </div>`;
}

// Turn-based / round-based minigames: a board of options, whose turn it is, and the play-by-play
function renderView(s, mg) {
  const v = mg.live.view, live = mg.live;
  const turn = live.turn;
  let body = '';
  if (v.grid) {
    body = `<table class="mg-grid"><tr><th></th>${v.grid.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
      ${v.grid.rows.map((r, i) => `<tr><td class="rowlabel">${esc(r)}</td>${v.grid.cells[i].map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</table>`;
  }
  if (v.items) body += `<div class="mg-items ${v.small ? 'small' : ''}">${v.items.map(it => `<div class="mg-item ${it.cls}">${esc(it.label).replace(/\n/g, '<br>')}</div>`).join('')}</div>`;
  const order = live.order ? `<div class="mg-order">${live.order.map(id => `<span class="ro-chip ${turn?.playerId === id ? 'now' : ''} ${live.out?.includes(id) ? 'out' : ''} ${live.finished?.includes(id) ? 'done' : ''}" style="--c:${colorOf(s, id)}">${esc(nameOf(s, id))} <small>${esc(live.display?.[id] ?? '')}</small></span>`).join('')}</div>` : '';
  return `<div class="mg-view">
    <div class="big">${esc(v.title || '')}</div>
    ${order}
    ${turn ? `<div class="mg-turn">👉 <b style="color:${colorOf(s, turn.playerId)}">${esc(nameOf(s, turn.playerId))}</b>: ${esc(turn.prompt)} <small>(${turn.secondsLeft}s)</small></div>` : ''}
    ${v.subtitle ? `<div class="mg-turn">${esc(v.subtitle)}</div>` : ''}
    ${body}
    ${live.log ? `<div class="mg-log">${live.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
  </div>`;
}

// End of game: bonus Stars one by one, then standings from last place to the winner
function renderFinale(s) {
  const f = s.finale, c = $('overlay-content');
  const key = `${f.step}-${f.index}-${f.revealed}-${f.shown}`;
  if (c.dataset.key === key) return;
  c.dataset.key = key;
  if (f.step === 'intro') {
    c.innerHTML = '<div class="finale"><div class="fin-big">🌟 BONUS STARS 🌟</div><div class="big">Three extra Stars are up for grabs…</div></div>';
  } else if (f.step === 'bonus') {
    const b = f.bonuses[f.index];
    c.innerHTML = `<div class="finale">
      <div class="fin-small">Bonus Star ${f.index + 1} of ${f.bonuses.length}</div>
      <div class="fin-big">${b.icon} ${esc(b.title)}</div>
      <div class="big">for the ${esc(b.desc)}${f.revealed ? ` (${b.value})` : ''}…</div>
      ${f.revealed
        ? `<div class="fin-winner">${b.playerIds.length ? b.playerIds.map(id => chip(s, id)).join(' & ') : 'Nobody!'}</div><div class="fin-star">⭐ +1</div>`
        : '<div class="drumroll">🥁</div>'}
    </div>`;
    if (f.revealed && b.playerIds.length) confetti(60);
  } else if (f.step === 'standings') {
    const n = f.standings.length;
    const rows = f.standings.map((st, i) => {
      const visible = i >= n - f.shown; // revealed from the bottom up
      return `<div class="fin-row p${st.place} ${visible ? 'show' : ''}">
        <span class="fin-place">#${st.place}</span>
        <span class="fin-name">${visible ? chip(s, st.playerId) : '???'}</span>
        <span>${visible ? `⭐ ${st.stars} · 🪙 ${st.coins}` : ''}</span></div>`;
    }).join('');
    const winner = f.shown === n;
    c.innerHTML = `<div class="finale"><div class="fin-big">${winner ? `👑 ${esc(nameOf(s, f.standings[0].playerId))} WINS! 👑` : 'Final standings'}</div><div class="fin-rows">${rows}</div></div>`;
    if (winner) confetti(200);
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
  return `<h2 class="winner-title">🎉 ${esc(nameOf(s, winner.playerId))} is the Superstar! 🎉</h2>
    <div class="final-grid">
      <div>
        ${podium(s, s.final.standings.map(st => ({ playerId: st.playerId, place: st.place, line1: `⭐ ${st.stars}`, line2: `🪙 ${st.coins}` })))}
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
    case 'roll': if (!fx.rollOff) showDice(fx); break;
    case 'coins':
      scene?.floatText(fx.playerId, `${fx.amount > 0 ? '+' : ''}${fx.amount} 🪙`, fx.amount > 0 ? '#80ed99' : '#ff8a8a');
      scene?.coinShower(fx.playerId, fx.amount);
      break;
    case 'item': scene?.floatText(fx.playerId, `🎁 ${ITEMS[fx.itemId]?.icon ?? ''} ${ITEMS[fx.itemId]?.name ?? ''}`, '#80ed99', 30); break;
    case 'star': scene?.starFx(fx.playerId, fx.amount); if (fx.amount > 0) confetti(70); break;
    case 'land': scene?.burst(fx.nodeId, SPACE_TYPES[fx.spaceType]?.color || '#ffffff'); break;
    case 'announce': announce(`${fx.icon ? `${fx.icon} ` : ''}${fx.text}`, fx.tone); break;
    case 'nudge': announce(`👉 ${fx.fromName} nudged ${fx.toName}!`, 'info'); break;
    case 'starMoved': scene?.focusStar(fx.star); break;
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

// ----- roulette: a prize wheel that spins and stops on the server's pick -----
let spin = null;
const WHEEL_COLORS = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff924c', '#52b788', '#4cc9f0', '#f72585', '#c77dff'];
function renderRoulette(r) {
  const c = $('overlay-content');
  if (spin?.id !== r.id) {
    stopRoulette();
    const n = r.labels.length, seg = 360 / n, R = 230;
    const pt = a => [R * Math.sin((a * Math.PI) / 180), -R * Math.cos((a * Math.PI) / 180)];
    // Land the chosen slice under the pointer at the top, after a few full turns
    const target = 360 * 5 + (360 - (r.resultIndex * seg + seg / 2)) + (Math.random() - 0.5) * seg * 0.6;
    const slices = r.labels.map((label, i) => {
      const [x1, y1] = pt(i * seg), [x2, y2] = pt((i + 1) * seg);
      const mid = i * seg + seg / 2;
      const text = label.length > 22 ? `${label.slice(0, 21)}…` : label;
      // Labels run along the slice; flip the ones that will end up on the right half
      // (after the spin) so none are upside down when the wheel stops
      const finalAngle = (((mid + target) % 360) + 360) % 360;
      const flip = finalAngle > 0 && finalAngle < 180;
      return `<path d="M0 0 L${x1} ${y1} A${R} ${R} 0 ${seg > 180 ? 1 : 0} 1 ${x2} ${y2} Z" fill="${WHEEL_COLORS[i % WHEEL_COLORS.length]}" stroke="#fff" stroke-width="4"/>
        <text transform="rotate(${mid}) translate(0 ${-R + 26}) rotate(${flip ? -90 : 90})" text-anchor="${flip ? 'end' : 'start'}" dominant-baseline="middle"
          font-size="${n > 7 ? 17 : 21}" class="wheel-text">${esc(text)}</text>`;
    }).join('');
    c.innerHTML = `<h2 class="wheel-title">${esc(r.title)}</h2>
      <div class="wheel-wrap">
        <div class="wheel-pointer">▼</div>
        <svg class="wheel" viewBox="-250 -250 500 500"><g class="wheel-spin">${slices}</g>
          <circle r="34" fill="#14213d" stroke="#ffca3a" stroke-width="6"/><text class="wheel-hub" text-anchor="middle" dominant-baseline="central">🎲</text></svg>
      </div>
      <div class="big roulette-result"></div>`;
    const g = c.querySelector('.wheel-spin');
    spin = { id: r.id, done: false, text: null, timer: null };
    requestAnimationFrame(() => requestAnimationFrame(() => { g.style.transform = `rotate(${target}deg)`; }));
    spin.timer = setTimeout(() => {
      spin.done = true;
      c.querySelector('.wheel-wrap')?.classList.add('stopped');
      if (spin.text) c.querySelector('.roulette-result').textContent = spin.text;
    }, 2500);
  }
  if (r.resultText) {
    spin.text = r.resultText;
    if (spin.done) c.querySelector('.roulette-result').textContent = r.resultText;
  }
}
function stopRoulette() { if (spin) clearTimeout(spin.timer); spin = null; }

// ----- podium (1st in the middle) -----
function podium(s, rows) {
  const byPlace = [...rows].sort((a, b) => a.place - b.place);
  const top = byPlace.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  const rest = byPlace.slice(3);
  return `<div class="podium">${order.map(r => `
      <div class="podium-col p${Math.min(r.place, 3)}">
        <div class="podium-name">${chip(s, r.playerId)}</div>
        <div class="podium-line">${esc(r.line1)}</div>
        <div class="podium-line reward">${esc(r.line2 || '')}</div>
        <div class="podium-block" style="--c:${colorOf(s, r.playerId)}">${r.place}</div>
      </div>`).join('')}</div>
    ${rest.map(r => `<div class="podium-rest">#${r.place} ${chip(s, r.playerId)} · ${esc(r.line1)} ${esc(r.line2 || '')}</div>`).join('')}`;
}

// ----- dice + steps -----
let rollingUntil = 0;
function showDice(fx) {
  const wrap = $('dice'), die = $('die'), detail = $('die-detail');
  const max = fx.rollKind === 'bad' ? 3 : 10;
  rollingUntil = Date.now() + 1800;
  $('steps').classList.add('hidden');
  wrap.className = 'dice-wrap show rolling';
  detail.textContent = '';
  const tick = setInterval(() => { die.textContent = 1 + Math.floor(Math.random() * max); }, 60);
  setTimeout(() => {
    clearInterval(tick);
    die.textContent = fx.value;
    wrap.className = 'dice-wrap show landed';
    detail.textContent = fx.dice && (fx.dice.length > 1 || fx.boost) ? `${fx.dice.join(' + ')}${fx.boost ? ` + ${fx.boost} 🚀` : ''}` : fx.rollKind === 'bad' ? '🐌 Bad Dice' : fx.rollKind === 'custom' ? '🎯 Custom Dice' : '';
  }, 800);
  setTimeout(() => { wrap.className = 'dice-wrap'; if (latest) renderSteps(latest); }, 1800);
}
function renderSteps(s) {
  const el = $('steps');
  const show = s.dice && s.dice.remaining > 0 && Date.now() > rollingUntil && ['MOVING', 'JUNCTION', 'STAR_PROMPT', 'SHOP', 'BANDIT', 'DISCARD'].includes(s.phase);
  el.classList.toggle('hidden', !show);
  if (show) el.innerHTML = `<span style="color:${colorOf(s, s.dice.playerId)}">●</span> ${esc(nameOf(s, s.dice.playerId))} · <b>${s.dice.remaining}</b> step${s.dice.remaining === 1 ? '' : 's'} left`;
}

// ----- confetti -----
let confettiDone = false;
function confetti(n) {
  const layer = $('confetti');
  const colors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ffffff'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = `${2.2 + Math.random() * 2}s`;
    p.style.animationDelay = `${Math.random() * 0.8}s`;
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    layer.append(p);
    setTimeout(() => p.remove(), 5200);
  }
}

function renderLegend() {
  $('legend').innerHTML = Object.values(SPACE_TYPES).filter(t => t.icon !== 'GO').map(t => `
    <div><span class="legend-dot ${t.passOnly ? 'square' : ''}" style="background:${t.color}">${esc(t.icon)}</span>
      <b>${esc(t.name)}</b>: ${esc(t.desc)}</div>`).join('') +
    '<div><span class="legend-dot" style="background:#ffd166">⭐</span><b>Star</b>: sits on the path between spaces. Walk past it to buy one.</div>';
}
