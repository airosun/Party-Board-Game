// Plays a full game: 2 bot "phones" + 2 CPUs (filled in by the server). Run: npm run simulate
const { io } = require('socket.io-client');
process.env.PORT = process.env.PORT || 3999;
require('../server/index.js');
const URL = `http://localhost:${process.env.PORT}`;
const ROUNDS = Number(process.env.ROUNDS) || 10;

const host = io(URL);
const fxCounts = {};
host.on('fx', fx => { fxCounts[fx.kind] = (fxCounts[fx.kind] || 0) + 1; });

host.emit('host:create', {}, async ({ code }) => {
  console.log('Room', code);
  for (const name of ['Mario', 'Luigi']) {
    const s = io(URL, { forceNew: true });
    await new Promise(r => s.emit('player:join', { code, name }, res => { s.pid = res.playerId; r(); }));
    const act = a => s.emit('player:action', a);
    s.on('state', st => {
      const me = st.players.find(p => p.id === s.pid);
      if (st.phase === 'ROLL_OFF' && st.rollOff && !(s.pid in st.rollOff.rolls)) act({ type: 'rollOff' });
      if (st.phase === 'ROLL' && st.turnPlayerId === s.pid) {
        const usable = me.items.findIndex(id => id !== 'secretKey');
        if (usable >= 0 && !st.turnItemUsed && Math.random() < 0.7) act({ type: 'useItem', index: usable });
        else act({ type: 'roll' });
      }
      if (st.prompt?.playerId === s.pid) {
        const opts = st.prompt.options.filter(o => !o.disabled);
        act({ type: 'choose', value: opts[Math.floor(Math.random() * opts.length)].value });
      }
      const mg = st.minigame;
      if (st.phase === 'MINIGAME' && mg) {
        const c = mg.controls;
        if (c === 'mash') act({ type: 'minigame', input: { tap: true } });
        if (c === 'alternate') act({ type: 'minigame', input: { side: Math.random() < 0.5 ? 'L' : 'R' } });
        if (c === 'reaction' && mg.live.goInMs === 0) act({ type: 'minigame', input: { reactionMs: 200 + Math.random() * 300 } });
        if (c === 'quiz') { const q = mg.live.perPlayer[s.pid]; if (q) act({ type: 'minigame', input: { qid: q.qid, answer: Math.floor(Math.random() * q.options.length) } }); }
        if (['timing', 'grid', 'rhythm'].includes(c)) act({ type: 'minigame', input: { points: Math.floor(Math.random() * 3) } });
        if (['hold', 'blind'].includes(c)) act({ type: 'minigame', input: { value: Math.floor(Math.random() * 1500) } });
        if (c === 'memory') act({ type: 'minigame', input: { value: Math.floor(Math.random() * 8) } });
      }
    });
  }
  let lastLog = '';
  const modes = {};
  host.on('state', st => {
    if (st.phase === 'MINIGAME_INTRO' && st.minigame) modes[`${st.minigame.mode}:${st.minigame.id}`] = 1;
    const l = st.log[st.log.length - 1];
    if (l !== lastLog) { console.log(`[${st.phase}] ${l}`); lastLog = l; }
    if (st.phase === 'GAME_OVER') {
      console.log('PLAYERS', st.players.map(p => `${p.name}${p.cpu ? '(cpu)' : ''} ⭐${p.stars} 🪙${p.coins}`).join(', '));
      console.log('MINIGAMES', Object.keys(modes).join(' '));
      console.log('FX', JSON.stringify(fxCounts));
      console.log('OK');
      process.exit(0);
    }
  });
  host.emit('host:start', { maxRounds: ROUNDS });
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 180000);
