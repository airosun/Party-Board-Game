// Phone controller. Shows only the buttons that make sense for the current phase,
// plus big pop-ups for things that happen to you (your roll, coins, items, robberies, nudges).

const socket = io();
const $ = id => document.getElementById(id);
const esc = str => String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const vibrate = ms => { try { navigator.vibrate?.(ms); } catch {} };

let me = JSON.parse(localStorage.getItem('partyPlayer') || 'null'); // { code, playerId, name }
let ITEMS = {};
let BOARDS = {};
let SPACE_TYPES = {};
let mapOpen = false;
let latest = null;
let latestAt = 0;     // when `latest` arrived (for the nudge timer)
let viewKey = null;   // only rebuild the action buttons when this changes

// ----- joining -----
const params = new URLSearchParams(location.search);
$('code-input').value = params.get('code') || me?.code || '';
$('name-input').value = me?.name || '';
$('join-btn').onclick = () => join($('code-input').value, $('name-input').value, null);

function join(code, name, playerId) {
  $('join-error').textContent = '';
  socket.emit('player:join', { code, name, playerId }, res => {
    if (!res.ok) {
      if (playerId) { localStorage.removeItem('partyPlayer'); me = null; return; } // stale save: show form
      $('join-error').textContent = res.error;
      return;
    }
    ITEMS = res.items || {};
    BOARDS = Object.fromEntries((res.boards || []).map(b => [b.id, b]));
    SPACE_TYPES = res.spaceTypes || {};
    me = { code: res.code, playerId: res.playerId, name };
    window.ME = me.playerId;
    localStorage.setItem('partyPlayer', JSON.stringify(me));
    $('join-view').classList.add('hidden');
    $('game-view').classList.remove('hidden');
  });
}

// Reconnect automatically (page refresh, phone lock, wifi blip)
socket.on('connect', () => { if (me?.playerId) join(me.code, me.name, me.playerId); });

const send = action => socket.emit('player:action', action);
const nameOf = (s, id) => s.players.find(p => p.id === id)?.name ?? '?';
window.nameOfId = id => (latest ? nameOf(latest, id) : '?'); // used by minigame controls

// ----- state -----
socket.on('state', s => {
  if (!me) return;
  const self = s.players.find(p => p.id === me.playerId);
  if (!self) return;
  latest = s;
  latestAt = Date.now();

  $('my-dot').style.background = self.color;
  document.documentElement.style.setProperty('--me', self.color);
  $('my-name').textContent = `${s.hostPlayerId === me.playerId ? '👑 ' : ''}${self.name}`;
  $('my-stats').textContent = s.phase === 'LOBBY' ? '' : `⭐ ${self.stars}   🪙 ${self.coins}`;
  $('turn-pill').textContent = s.phase === 'LOBBY' || s.phase === 'GAME_OVER' || s.phase === 'ROLL_OFF' ? ''
    : s.lastTurn ? '🔥 LAST TURN' : `Turn ${s.round}/${s.maxRounds}`;

  const myTurn = s.turnPlayerId === me.playerId;
  const myPrompt = s.prompt?.playerId === me.playerId;
  const myGate = s.gate && s.gate.pending.includes(me.playerId) ? s.gate.kind : '';
  const key = [s.phase, myTurn, myPrompt && s.prompt.kind, myPrompt && s.prompt.text, s.minigame?.id,
    self.items.join(','), s.turnItemUsed, s.rollOff && (me.playerId in s.rollOff.rolls), myGate].join('|');

  $('status').innerHTML = statusText(s, self, myTurn);
  if (key !== viewKey) {
    viewKey = key;
    buildActions(s, self, myTurn, myPrompt);
  }
  if (s.phase === 'MINIGAME') Controls.update(s.minigame);
  const bag = self.items.map(id => `${ITEMS[id]?.icon ?? ''} ${ITEMS[id]?.name ?? id}`).join(' · ');
  $('bag').textContent = s.phase === 'LOBBY' || !bag ? '' : `Bag: ${bag}`;
  renderNudges();
  if (mapOpen) drawMap(s);
});

function statusText(s, self, myTurn) {
  const turnName = esc(nameOf(s, s.turnPlayerId));
  const mg = s.minigame;
  switch (s.phase) {
    case 'LOBBY': return 'You\'re in! Waiting for the host to start…<br><small>Empty seats get filled by CPUs.</small>';
    case 'ROLL_OFF': {
      const mine = s.rollOff?.rolls[me.playerId];
      if (s.rollOff?.order) return `Turn order:<br><b>${s.rollOff.order.map(id => esc(nameOf(s, id))).join(' → ')}</b>`;
      return mine ? `You rolled <b>${mine}</b>. Waiting for the others…` : '<b>Roll to see who goes first!</b><br><small>Highest roll goes first. No two players can roll the same number.</small>';
    }
    case 'TURN_SPLASH': return s.lastTurn ? '🔥 <b>LAST TURN!</b>' : `<b>Turn ${s.round}</b> of ${s.maxRounds}`;
    case 'ROLL': return myTurn ? '<b>Your turn!</b>' : `${turnName}'s turn`;
    case 'TURN_END': return myTurn ? '<b>Done?</b> Tap End turn to pass to the next player.' : `${turnName} is finishing their turn…`;
    case 'MINIGAME_TEAMS': {
      const r = mg.teamReveal?.find(x => x.playerId === me.playerId);
      return `<span class="mode-tag">${modeLabel(mg.mode)}</span><br>${r ? `You landed on <b>${r.landed}</b>${r.landed === 'green' ? ' (randomized!)' : ''}<br><span class="team-tag ${r.team}">You're on ${r.team.toUpperCase()}</span>` : ''}`;
    }
    case 'FINALE': return '🥁 <b>Bonus Stars and the final results!</b> Watch the TV.';
    case 'MOVING': return s.dice ? `${myTurn ? 'You' : turnName} rolled <b>${s.dice.value}</b>` : '';
    case 'JUNCTION': case 'STAR_PROMPT': case 'SHOP': case 'CUSTOM_DICE': case 'BANDIT': case 'DISCARD': case 'ITEM_TARGET':
      return s.prompt?.playerId === me.playerId ? `<b>${esc(s.prompt.text)}</b>` : `${turnName} is deciding…`;
    case 'ITEM': return `${myTurn ? 'You' : turnName} used an item!`;
    case 'ROULETTE': return `${esc(s.roulette.title)}${s.roulette.resultText ? `<br><b>${esc(s.roulette.resultText)}</b>` : ''}`;
    case 'MINIGAME_INTRO': {
      const team = teamOf(mg, me.playerId);
      const waitingOn = s.gate?.kind === 'ready' ? s.gate.pending.length : 0;
      if (s.gate?.kind === 'ready' && !s.gate.pending.includes(me.playerId)) {
        return `<div class="mg-title">${esc(mg.name)}</div>✅ You're ready! Waiting for ${waitingOn} more…`;
      }
      return `${mg.banner ? `${esc(mg.banner)}<br>` : ''}<span class="mode-tag">${modeLabel(mg.mode)}</span>
        ${team ? `<span class="team-tag ${team}">You're on ${team.toUpperCase()}</span>` : ''}
        <div class="mg-title">${esc(mg.name)}</div><div class="mg-instr">${esc(mg.instructions)}</div>`;
    }
    case 'MINIGAME': return `<b>${esc(mg.name)}</b> · ${Math.ceil(mg.timeLeftMs / 1000)}s`;
    case 'MINIGAME_RESULTS': {
      const r = mg.results.find(x => x.playerId === me.playerId);
      const tr = mg.teamResult;
      const head = tr ? (tr.winner === 'tie' ? 'Tie game!' : r?.team === tr.winner ? '🏆 Your team won!' : 'Your team lost.') : r ? (r.won ? '🏆 You won!' : `You placed #${r.place}`) : '';
      const waiting = s.gate?.kind === 'next' && !s.gate.pending.includes(me.playerId) ? `<br><small>Waiting for ${esc(nameOf(s, s.gate.pending[0]))} to tap Next…</small>` : '';
      return `${head}<br>${r ? `${esc(r.display)}${r.reward ? `<br><b>+${r.reward} coins</b>` : ''}` : ''}${waiting}`;
    }
    case 'GAME_OVER': {
      const st = s.final.standings.find(x => x.playerId === me.playerId);
      return st ? (st.place === 1 ? '🎉 <b>You win!</b> 🎉' : `You finished <b>#${st.place}</b>`) : 'Game over!';
    }
  }
  return '';
}

const modeLabel = m => ({ ffa: 'Free-for-all', '2v2': '2 vs 2', '1v3': '1 vs 3' }[m] || '');
const teamOf = (mg, id) => mg?.teams && Object.keys(mg.teams).find(c => mg.teams[c].includes(id));

function buildActions(s, self, myTurn, myPrompt) {
  const a = $('actions');
  a.innerHTML = '';
  if (s.phase !== 'MINIGAME') Controls.stop();

  const gateMine = s.gate && s.gate.pending.includes(me.playerId) ? s.gate.kind : null;
  const decision = (s.phase === 'ROLL' && myTurn) || myPrompt || gateMine === 'endTurn';

  if (gateMine === 'ready') {
    a.append(btn("✅ I'm ready!", () => send({ type: 'press', kind: 'ready' }), null, 'roll-btn'));
  } else if (gateMine === 'next') {
    a.append(btn('▶️ Next', () => send({ type: 'press', kind: 'next' }), 'You\'re Player 1: carry on when everyone\'s seen the results', 'roll-btn'));
  } else if (gateMine === 'endTurn') {
    a.append(btn('✅ End turn', () => send({ type: 'press', kind: 'endTurn' }), null, 'roll-btn'));
  } else if (s.phase === 'ROLL_OFF' && s.rollOff && !(me.playerId in s.rollOff.rolls)) {
    a.append(btn('🎲 Roll!', () => send({ type: 'rollOff' }), null, 'roll-btn'));
  } else if (s.phase === 'ROLL' && myTurn) {
    a.append(btn('🎲 Roll!', () => send({ type: 'roll' }), null, 'roll-btn'));
    if (self.items.some(id => !ITEMS[id]?.passive) && !s.turnItemUsed) {
      const row = document.createElement('div');
      row.className = 'item-row';
      self.items.forEach((id, index) => {
        const it = ITEMS[id] || { name: id, icon: '', desc: '' };
        if (it.passive) return; // e.g. Secret Key works by itself at gates
        const b = btn(`${it.icon} Use ${it.name}`, () => send({ type: 'useItem', index }), it.desc);
        b.disabled = id === 'warpBlock' && s.players.length < 2;
        row.append(b);
      });
      a.append(row);
    }
  } else if (myPrompt && s.prompt.kind === 'customDice') {
    const grid = document.createElement('div');
    grid.className = 'num-grid';
    s.prompt.options.forEach(o => grid.append(btn(o.label, () => {
      grid.querySelectorAll('button').forEach(x => { x.disabled = true; });
      send({ type: 'choose', value: o.value });
    })));
    a.append(grid);
  } else if (myPrompt) {
    s.prompt.options.forEach(o => {
      const b = btn(o.label, () => {
        a.querySelectorAll('button').forEach(x => { x.disabled = true; });
        send({ type: 'choose', value: o.value });
      }, o.desc);
      b.disabled = !!o.disabled; // e.g. can't afford it / locked
      a.append(b);
    });
  } else if (s.phase === 'MINIGAME') {
    Controls.build(a, s.minigame, input => send({ type: 'minigame', input }));
  } else if (s.phase === 'GAME_OVER') {
    a.append(statsCard(self));
  }
  if (decision) {
    const m = btn('🗺️ View board', () => openMap(true), null, 'map-btn');
    m.onclick = () => openMap(true); // reusable (don't disable)
    a.append(m);
  }
}

// ----- board map: see the whole board on your phone while deciding (the TV zooms out too) -----
function openMap(open) {
  mapOpen = open;
  $('map').classList.toggle('show', open);
  send({ type: 'viewBoard', open });
  if (open && latest) drawMap(latest);
}
$('map-close').onclick = () => openMap(false);

function drawMap(s) {
  const b = BOARDS[s.boardId];
  if (!b) return;
  const type = n => s.spaceOverrides?.[n.id] ?? n.type;
  // Phone held upright + wide board → turn the map sideways so it fills the screen
  const svgBox = $('map-svg').getBoundingClientRect();
  const rotate = svgBox.height > svgBox.width && b.width > b.height;
  const up = (x, y) => (rotate ? ` transform="rotate(-90 ${x} ${y})"` : ''); // keep icons upright
  const byId = Object.fromEntries(b.nodes.map(n => [n.id, n]));
  const lines = b.nodes.flatMap(n => n.next.map(id => `<line x1="${n.x}" y1="${n.y}" x2="${byId[id].x}" y2="${byId[id].y}"/>`)).join('');
  const spaces = b.nodes.map(n => {
    const meta = SPACE_TYPES[type(n)] || {};
    if (meta.passOnly) return `<rect x="${n.x - 22}" y="${n.y - 22}" width="44" height="44" rx="8" fill="${meta.color}" stroke="#fff" stroke-width="4"/><text x="${n.x}" y="${n.y + 2}" class="ic"${up(n.x, n.y)}>${meta.icon}</text>`;
    return `<circle cx="${n.x}" cy="${n.y}" r="${type(n) === 'start' ? 34 : 26}" fill="${type(n) === 'start' ? '#ffd166' : meta.color}" stroke="#fff" stroke-width="4"/><text x="${n.x}" y="${n.y + 2}" class="ic"${up(n.x, n.y)}>${type(n) === 'start' ? 'GO' : meta.icon}</text>`;
  }).join('');
  let star = '';
  if (s.star) {
    const a = byId[s.star.from], c = byId[s.star.to];
    const sx = (a.x + c.x) / 2, sy = (a.y + c.y) / 2;
    star = `<text x="${sx}" y="${sy}" class="star"${up(sx, sy)}>⭐</text>`;
  }
  const pawns = s.players.map((p, i) => {
    const n = byId[p.pos]; const [dx, dy] = [[-16, -16], [16, -16], [-16, 16], [16, 16]][i % 4];
    const mine = p.id === me.playerId;
    return `<circle cx="${n.x + dx}" cy="${n.y + dy}" r="${mine ? 20 : 15}" fill="${p.color}" stroke="${mine ? '#fff' : '#14213d'}" stroke-width="${mine ? 6 : 3}"/>`;
  }).join('');
  const content = `<rect width="${b.width}" height="${b.height}" fill="#1b6ca8"/><g class="roads">${lines}</g>${spaces}${star}${pawns}`;
  $('map-svg').setAttribute('viewBox', rotate ? `0 0 ${b.height} ${b.width}` : `0 0 ${b.width} ${b.height}`);
  $('map-svg').innerHTML = rotate ? `<g transform="translate(${b.height} 0) rotate(90)">${content}</g>` : content;
  $('map-legend').innerHTML = s.players.map(p => `<span><i style="background:${p.color}"></i>${esc(p.name)}${p.id === me.playerId ? ' (you)' : ''}</span>`).join('');
}

function btn(label, onClick, desc, cls) {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  b.textContent = label;
  if (desc) {
    const d = document.createElement('span');
    d.className = 'option-desc';
    d.textContent = desc;
    b.append(d);
  }
  b.onclick = () => { b.disabled = true; onClick(); }; // prevent double-sends
  return b;
}

function statsCard(p) {
  const s = p.stats;
  const rows = [
    ['🎲 Average roll', s.rolls ? (s.totalRolled / s.rolls).toFixed(1) : '–'], ['🎲 Best roll', s.bestRoll],
    ['👣 Spaces moved', s.spacesMoved], ['🔵 Blue / 🔴 Red / 🟢 Green', `${s.blueSpaces} / ${s.redSpaces} / ${s.greenSpaces}`],
    ['🪙 Coins earned', s.coinsEarned], ['💸 Coins lost', s.coinsLost], ['🛒 Coins spent', s.coinsSpent],
    ['⭐ Stars bought', s.starsBought], ['🦹 Coins stolen', s.coinsStolen], ['😭 Coins robbed from you', s.coinsRobbed],
    ['🎁 Items gained / used', `${s.itemsGained} / ${s.itemsUsed}`], ['🏆 Minigame wins', `${s.minigameWins} of ${s.minigamesPlayed}`],
  ];
  const d = document.createElement('div');
  d.className = 'stats-card';
  d.innerHTML = `<h3>Your stats</h3>${rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}`;
  return d;
}

// ----- nudges: after a minute of waiting on someone, others can poke them once per turn -----
setInterval(renderNudges, 1000);
function renderNudges() {
  const el = $('nudges');
  const a = latest?.awaiting;
  if (!a || !me) { el.innerHTML = ''; return; }
  const waited = a.waitedMs + (Date.now() - latestAt);
  const targets = a.playerIds.filter(id => id !== me.playerId);
  if (waited < a.nudgeAfterMs || !targets.length || a.nudgedBy.includes(me.playerId)) { el.innerHTML = ''; return; }
  if (el.dataset.key === targets.join(',')) return;
  el.dataset.key = targets.join(',');
  el.innerHTML = '';
  targets.forEach(id => {
    const b = btn(`👉 Nudge ${nameOf(latest, id)}`, () => { send({ type: 'nudge', targetId: id }); el.innerHTML = ''; el.dataset.key = ''; }, null, 'nudge-btn');
    el.append(b);
  });
}

// ----- fx: pop-ups for things that just happened -----
socket.on('fx', fx => {
  if (!me || !latest) return;
  const mine = id => id === me.playerId;
  switch (fx.kind) {
    case 'roll':
      if (mine(fx.playerId)) {
        const detail = fx.rollOff ? 'Turn order roll' : fx.dice && (fx.dice.length > 1 || fx.boost) ? `${fx.dice.join(' + ')}${fx.boost ? ` + ${fx.boost} 🚀` : ''}` : fx.rollKind === 'bad' ? '🐌 Bad Dice' : '';
        bigPop(String(fx.value), detail, 'roll');
        vibrate(60);
      }
      break;
    case 'coins':
      if (mine(fx.playerId)) toast(`${fx.amount > 0 ? '+' : ''}${fx.amount} 🪙`, fx.amount > 0 ? 'good' : 'bad');
      break;
    case 'star':
      if (mine(fx.playerId)) { bigPop(fx.amount > 0 ? `+${fx.amount} ⭐` : `${fx.amount} ⭐`, fx.amount > 0 ? 'You got a Star!' : 'You lost a Star…', fx.amount > 0 ? 'good' : 'bad'); vibrate(fx.amount > 0 ? [60, 60, 60] : 300); }
      break;
    case 'item':
      if (mine(fx.playerId)) { const it = ITEMS[fx.itemId]; toast(`🎁 You got a ${it?.icon ?? ''} ${it?.name ?? fx.itemId}!`, 'good'); }
      break;
    case 'steal':
      if (mine(fx.thiefId)) bigPop('🦹', fx.star ? `You stole a STAR from ${fx.victimName}!` : `You stole ${fx.coins} coins from ${fx.victimName}!`, 'good');
      else if (mine(fx.victimId)) { bigPop('🦹', fx.star ? `${fx.thiefName} stole a STAR from you!` : `${fx.thiefName} stole ${fx.coins} coins from you!`, 'bad'); vibrate(400); }
      break;
    case 'nudge':
      if (mine(fx.toId)) { bigPop('👉', `${fx.fromName} nudged you! It's your move.`, 'nudge'); vibrate([200, 100, 200]); }
      break;
    case 'announce':
      if (!fx.playerIds?.includes(me.playerId)) toast(`${fx.icon} ${fx.text}`, 'info');
      break;
  }
});

function bigPop(big, small, tone) {
  const el = $('big-pop');
  el.className = `big-pop ${tone}`;
  el.innerHTML = `<div class="big">${esc(big)}</div>${small ? `<div class="small">${esc(small)}</div>` : ''}`;
  el.classList.add('show');
  clearTimeout(bigPop.t);
  bigPop.t = setTimeout(() => el.classList.remove('show'), tone === 'nudge' ? 3500 : 2200);
}
$('big-pop').onclick = () => $('big-pop').classList.remove('show');

function toast(text, tone) {
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.textContent = text;
  $('toasts').append(t);
  setTimeout(() => t.remove(), 2600);
}
