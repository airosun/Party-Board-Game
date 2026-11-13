// Phone controller. Shows only the buttons that make sense for the current phase.

const socket = io();
const $ = id => document.getElementById(id);
const esc = str => String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let me = JSON.parse(localStorage.getItem('partyPlayer') || 'null'); // { code, playerId, name }
let viewKey = null;   // only rebuild the buttons when this changes (keeps mash taps smooth)
let reaction = null;  // Quick Draw local timing
let ITEMS = {};       // item catalog from the server

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
    me = { code: res.code, playerId: res.playerId, name };
    localStorage.setItem('partyPlayer', JSON.stringify(me));
    $('join-view').classList.add('hidden');
    $('game-view').classList.remove('hidden');
  });
}

// Reconnect automatically (page refresh, phone lock, wifi blip)
socket.on('connect', () => {
  if (me?.playerId) join(me.code, me.name, me.playerId);
});

const send = action => socket.emit('player:action', action);

// ----- render -----
socket.on('state', s => {
  if (!me) return;
  const self = s.players.find(p => p.id === me.playerId);
  if (!self) return;

  $('my-dot').style.background = self.color;
  $('my-name').textContent = self.name;
  $('my-stats').textContent = s.phase === 'LOBBY' ? '' : `⭐ ${self.stars}   🪙 ${self.coins}`;

  const myTurn = s.turnPlayerId === me.playerId;
  const myPrompt = s.prompt?.playerId === me.playerId;
  const key = [s.phase, myTurn, myPrompt && s.prompt.kind, s.minigame?.id, self.items.join(','), s.turnItemUsed].join('|');

  $('status').innerHTML = statusText(s, myTurn);
  if (key !== viewKey) {
    viewKey = key;
    buildActions(s, myTurn, myPrompt, self);
  }
  updateLive(s);
  const bag = self.items.map(id => `${ITEMS[id]?.icon ?? ''} ${ITEMS[id]?.name ?? id}`).join(' · ');
  $('bag').textContent = s.phase === 'LOBBY' || !bag ? '' : `Bag: ${bag}`;
});

function statusText(s, myTurn) {
  const turnName = esc(s.players.find(p => p.id === s.turnPlayerId)?.name ?? '');
  switch (s.phase) {
    case 'LOBBY': return 'You\'re in! Waiting for the host to start…';
    case 'ROLL': return myTurn ? 'Your turn!' : `${turnName}'s turn`;
    case 'MOVING': return s.dice ? `${myTurn ? 'You' : turnName} rolled ${s.dice.value}` : '';
    case 'JUNCTION':
    case 'STAR_PROMPT':
    case 'SHOP':
    case 'CUSTOM_DICE':
    case 'BANDIT':
    case 'ITEM_TARGET': return myTurn && s.prompt ? esc(s.prompt.text) : `${turnName} is deciding…`;
    case 'ITEM': return `${myTurn ? 'You' : turnName} used an item!`;
    case 'ROULETTE': return `${esc(s.roulette.title)}${s.roulette.resultText ? `<br><b>${esc(s.roulette.resultText)}</b>` : ''}`;
    case 'MINIGAME_INTRO': return `${s.minigame.banner ? `${esc(s.minigame.banner)}<br>` : ''}<b>${esc(s.minigame.name)}</b><br>${esc(s.minigame.instructions)}`;
    case 'MINIGAME': return `<b>${esc(s.minigame.name)}</b> · ${Math.ceil(s.minigame.timeLeftMs / 1000)}s`;
    case 'MINIGAME_RESULTS': {
      const r = s.minigame.results.find(x => x.playerId === me.playerId);
      return r ? `You placed #${r.place}${r.reward ? `: +${r.reward} coins` : ''}` : '';
    }
    case 'GAME_OVER': {
      const st = s.final.standings.find(x => x.playerId === me.playerId);
      return st ? (st.place === 1 ? '🎉 You win! 🎉' : `You finished #${st.place}`) : 'Game over!';
    }
  }
  return '';
}

function buildActions(s, myTurn, myPrompt, self) {
  const a = $('actions');
  a.innerHTML = '';
  reaction = null;

  if (s.phase === 'ROLL' && myTurn) {
    a.append(btn('🎲 Roll!', () => send({ type: 'roll' })));
    if (self.items.length && !s.turnItemUsed) {
      const row = document.createElement('div');
      row.className = 'item-row';
      self.items.forEach((id, index) => {
        const it = ITEMS[id] || { name: id, icon: '', desc: '' };
        const solo = id === 'warpBlock' && s.players.length < 2;
        const b = btn(`${it.icon} Use ${it.name}`, () => send({ type: 'useItem', index }), it.desc);
        b.disabled = solo;
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
  } else if (s.phase === 'MINIGAME' && s.minigame.controls === 'mash') {
    const b = document.createElement('button');
    b.className = 'mash-btn';
    b.textContent = 'TAP!';
    b.addEventListener('pointerdown', e => { e.preventDefault(); send({ type: 'minigame', input: { tap: true } }); });
    a.append(b);
  } else if (s.phase === 'MINIGAME' && s.minigame.controls === 'reaction') {
    const pad = document.createElement('div');
    pad.className = 'reaction-pad';
    pad.textContent = 'WAIT…';
    reaction = { pad, goAt: null, done: false, timer: null };
    pad.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (reaction.done) return;
      reaction.done = true;
      if (reaction.goAt == null) {
        pad.textContent = 'TOO EARLY!';
        send({ type: 'minigame', input: { early: true } });
      } else {
        const ms = Math.round(performance.now() - reaction.goAt);
        pad.textContent = `${ms} ms`;
        send({ type: 'minigame', input: { reactionMs: ms } });
      }
    });
    a.append(pad);
  }
}

// Per-tick updates that shouldn't rebuild buttons
function updateLive(s) {
  if (!reaction || s.phase !== 'MINIGAME' || s.minigame.live.goInMs == null || reaction.timer) return;
  reaction.timer = setTimeout(() => {
    if (!reaction || reaction.done) return;
    reaction.goAt = performance.now();
    reaction.pad.classList.add('go');
    reaction.pad.textContent = 'GO!';
  }, s.minigame.live.goInMs);
}

function btn(label, onClick, desc) {
  const b = document.createElement('button');
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
