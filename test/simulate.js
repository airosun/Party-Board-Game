// Plays a full game with 3 bot players against a local server. Run: npm run simulate
const { io } = require('socket.io-client');
process.env.PORT = process.env.PORT || 3999;
require('../server/index.js');
const URL = `http://localhost:${process.env.PORT}`;

const host = io(URL);
host.emit('host:create', {}, async ({ code }) => {
  console.log('Room', code);
  const bots = [];
  for (const name of ['Mario', 'Luigi', 'Peach']) {
    const s = io(URL);
    await new Promise(r => s.emit('player:join', { code, name }, res => { s.pid = res.playerId; r(); }));
    s.on('state', st => {
      if (st.phase === 'ROLL' && st.turnPlayerId === s.pid) {
        const me = st.players.find(p => p.id === s.pid);
        if (me.items.length && !st.turnItemUsed && Math.random() < 0.5) s.emit('player:action', { type: 'useItem', index: 0 });
        else s.emit('player:action', { type: 'roll' });
      }
      if (st.prompt?.playerId === s.pid) {
        const o = st.prompt.options[Math.floor(Math.random() * st.prompt.options.length)];
        s.emit('player:action', { type: 'choose', value: o.value });
      }
      if (st.phase === 'MINIGAME') {
        if (st.minigame.controls === 'mash' && Math.random() < 0.6) s.emit('player:action', { type: 'minigame', input: { tap: true } });
        if (st.minigame.controls === 'reaction' && st.minigame.live.goInMs === 0) s.emit('player:action', { type: 'minigame', input: { reactionMs: 150 + Math.random() * 300 } });
      }
    });
    bots.push(s);
  }
  let lastLog = '';
  host.on('state', st => {
    const l = st.log[st.log.length - 1];
    if (l !== lastLog) { console.log(`[${st.phase}] ${l}`); lastLog = l; }
    if (st.phase === 'GAME_OVER') {
      console.log('FINAL', JSON.stringify(st.final, null, 1));
      console.log('OK'); process.exit(0);
    }
  });
  host.emit('host:start', { maxRounds: 10 });
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 60000);
