// Host screen: creates the room, renders the board (Phaser) and the sidebar/overlays (DOM).

const socket = io();
const $ = id => document.getElementById(id);
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
if (saved) {
  socket.emit('host:rejoin', saved, res => (res.ok ? onRoom(res) : createRoom()));
} else {
  createRoom();
}

function createRoom() {
  socket.emit('host:create', {}, onRoom);
}

function onRoom({ code, hostKey, boards, spaceTypes, items }) {
  ITEMS = items || {};
  SPACE_TYPES = spaceTypes || {};
  BOARDS = Object.fromEntries(boards.map(b => [b.id, b]));
  $('board-select').innerHTML = boards.map(b =>
    `<option value="${b.id}">${esc(b.name)} (${b.nodes.length} spaces)</option>`).join('');
  renderLegend();
  sessionStorage.setItem('partyHost', JSON.stringify({ code, hostKey }));
  $('code').textContent = code;
  $('join-url').textContent = `${location.host}/play.html?code=${code}`;
  if (latest) showBoard(latest.boardId);
}

// (Re)build the Phaser board whenever the room's board changes
function showBoard(boardId) {
  const board = BOARDS[boardId];
  if (!board || boardId === shownBoardId) return;
  shownBoardId = boardId;
  scene = null;
  if (phaserGame) phaserGame.destroy(true);
  phaserGame = startPhaser(board, SPACE_TYPES);
}

// After a server restart the room is gone, so make a fresh one
socket.on('connect', () => {
  if (latest) {
    const s = JSON.parse(sessionStorage.getItem('partyHost') || 'null');
    socket.emit('host:rejoin', s || {}, res => {
      if (!res.ok) { sessionStorage.removeItem('partyHost'); location.reload(); }
    });
  }
});

function startPhaser(board, spaceTypes) {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'board',
    width: board.width,
    height: board.height,
    backgroundColor: '#0d1528',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [],
    callbacks: {
      postBoot: game => {
        game.scene.add('board', BoardScene, true, {
          board,
          spaceTypes,
          onReady: s => {
            scene = s;
            if (latest) scene.applyState(latest);
          },
        });
      },
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
const esc = str => String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderSidebar(s) {
  const lobby = s.phase === 'LOBBY';
  $('lobby-controls').classList.toggle('hidden', !lobby);
  if ($('board-select').value !== s.boardId) $('board-select').value = s.boardId;
  $('restart-btn').classList.toggle('hidden', s.phase !== 'GAME_OVER');
  $('start-btn').disabled = s.players.length < 1;
  $('start-btn').textContent = s.players.length ? `Start game (${s.players.length} player${s.players.length > 1 ? 's' : ''})` : 'Waiting for players…';

  const turnName = s.turnPlayerId ? esc(nameOf(s, s.turnPlayerId)) : '';
  $('turn-banner').innerHTML = {
    LOBBY: 'Join on your phone!',
    ROLL: `Turn ${s.round}/${s.maxRounds}: <span style="color:${colorOf(s, s.turnPlayerId)}">${turnName}</span>, roll!`,
    ITEM: `${turnName} is using an item…`,
    ITEM_TARGET: `🐌 ${turnName} is picking a Bad Dice victim…`,
    BANDIT: `🦹 ${turnName} is meeting the Bandit…`,
    SHOP: `🛒 ${turnName} is shopping…`,
    CUSTOM_DICE: `🎯 ${turnName} is picking a number…`,
    ROULETTE: `${turnName}'s roulette…`,
    MOVING: `${turnName} is moving…`,
    JUNCTION: `${turnName} is choosing a path…`,
    STAR_PROMPT: `${turnName}: buy a Star?`,
    MINIGAME_INTRO: 'Minigame time!',
    MINIGAME: 'Minigame time!',
    MINIGAME_RESULTS: 'Minigame results',
    GAME_OVER: 'Game over!',
  }[s.phase] || '';
  if (s.finalStretch && !['LOBBY', 'GAME_OVER'].includes(s.phase)) {
    $('turn-banner').innerHTML += '<div class="final-stretch">🔥 Final 5 turns: blue &amp; red doubled</div>';
  }

  // Standings order once the game is running
  const players = lobby ? s.players : [...s.players].sort((a, b) => b.stars - a.stars || b.coins - a.coins);
  $('players').innerHTML = players.map(p => `
    <div class="player-card ${p.id === s.turnPlayerId ? 'active' : ''} ${p.connected ? '' : 'offline'}">
      <span class="dot" style="background:${p.color}"></span>
      <span>${esc(p.name)}${p.connected ? '' : ' (offline)'}
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

  if (s.phase === 'ROULETTE' && s.roulette) {
    el.classList.remove('hidden');
    renderRoulette(s.roulette);
  } else if (s.phase === 'MINIGAME_INTRO' && mg) {
    el.classList.remove('hidden');
    c.innerHTML = `${mg.banner ? `<div class="banner">${esc(mg.banner)}</div>` : ''}
      <h2>${esc(mg.name)}</h2><div class="big">${esc(mg.instructions)}</div><div class="big">Get ready…</div>`;
  } else if (s.phase === 'MINIGAME' && mg) {
    el.classList.remove('hidden');
    c.innerHTML = `<h2>${esc(mg.name)}</h2>
      <div class="timer">${Math.ceil((mg.timeLeftMs ?? 0) / 1000)}</div>
      ${renderLive(s, mg)}`;
  } else if (s.phase === 'MINIGAME_RESULTS' && mg?.results) {
    el.classList.remove('hidden');
    c.innerHTML = `<h2>${esc(mg.name)}: Results</h2><table class="results-table">${
      mg.results.map(r => `<tr>
        <td>#${r.place}</td>
        <td><span class="dot" style="background:${colorOf(s, r.playerId)}"></span> ${esc(nameOf(s, r.playerId))}</td>
        <td>${esc(r.display)}</td>
        <td>${r.reward ? `+${r.reward} 🪙` : ''}</td></tr>`).join('')
    }</table>`;
  } else if (s.phase === 'GAME_OVER' && s.final) {
    el.classList.remove('hidden');
    const winner = s.final.standings[0];
    c.innerHTML = `<h2>🎉 ${esc(nameOf(s, winner.playerId))} wins!</h2>
      <div class="big">Bonus Stars</div>
      <table class="results-table">${s.final.bonuses.map(b => `<tr>
        <td>⭐ ${b.title}</td>
        <td>${b.playerIds.length ? b.playerIds.map(id => esc(nameOf(s, id))).join(', ') : 'nobody'}</td>
        <td style="opacity:.7">${b.desc}</td></tr>`).join('')}</table>
      <div class="big" style="margin-top:28px">Final standings</div>
      <table class="results-table">${s.final.standings.map(st => `<tr>
        <td>#${st.place}</td>
        <td><span class="dot" style="background:${colorOf(s, st.playerId)}"></span> ${esc(nameOf(s, st.playerId))}</td>
        <td>⭐ ${st.stars}</td><td>🪙 ${st.coins}</td></tr>`).join('')}</table>`;
  } else {
    el.classList.add('hidden');
  }
}

// Live view while a minigame is running. Add a case here for each new minigame.
function renderLive(s, mg) {
  if (mg.id === 'mash') {
    const scores = mg.live.scores;
    const max = Math.max(10, ...Object.values(scores));
    return `<div class="bars">${s.players.map(p => `
      <div class="bar-row"><span>${esc(p.name)}</span>
        <div class="bar"><div style="width:${(scores[p.id] / max) * 100}%; background:${p.color}"></div></div>
        <span>${scores[p.id]} taps</span></div>`).join('')}</div>`;
  }
  if (mg.id === 'quickdraw') {
    const go = mg.live.goInMs === 0;
    return `<div class="big" style="font-size:3rem; color:${go ? '#2b9348' : '#e63946'}">${go ? 'GO!' : 'Wait for it…'}</div>
      <div class="bars">${s.players.map(p => {
        const r = mg.live.reactions[p.id];
        return `<div class="bar-row"><span>${esc(p.name)}</span><span></span>
          <span>${r === null ? '…' : r === 'early' ? '❌ early' : '✅ tapped'}</span></div>`;
      }).join('')}</div>`;
  }
  return '';
}

// ----- roulette (spins through the options, then settles on the server's pick) -----
let spin = null; // { id, timer }

function renderRoulette(r) {
  const c = $('overlay-content');
  if (spin?.id !== r.id) {
    stopRoulette();
    c.innerHTML = `<h2 style="font-size:2.2rem">${esc(r.title)}</h2>
      <div class="roulette${r.labels.length > 6 ? ' many' : ''}">${r.labels.map((l, i) => `<div class="slot" data-i="${i}">${esc(l)}</div>`).join('')}</div>
      <div class="big roulette-result"></div>`;
    const slots = [...c.querySelectorAll('.slot')];
    let i = 0, delay = 70;
    const total = slots.length * 2 + r.resultIndex; // two laps, ending on the result
    let steps = 0;
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
  // Only reveal the result once the wheel has stopped on it
  if (r.resultText) {
    spin.text = r.resultText;
    if (spin.done) c.querySelector('.roulette-result').textContent = r.resultText;
  }
}

function stopRoulette() {
  if (spin) clearTimeout(spin.timer);
  spin = null;
}

function renderLegend() {
  $('legend').innerHTML = Object.values(SPACE_TYPES).filter(t => t.icon !== 'GO').map(t => `
    <div><span class="legend-dot" style="background:${t.color}">${esc(t.icon)}</span>
      <b>${esc(t.name)}</b>: ${esc(t.desc)}</div>`).join('');
}
