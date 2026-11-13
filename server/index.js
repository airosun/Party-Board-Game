// HTTP + Socket.IO server. Rooms are keyed by a 4-letter code.
// The host screen (TV/laptop) creates a room; phones join it as controllers.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Game, SPACE_META, ITEMS } = require('./game');
const boards = require('./boards');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'phaser', 'dist')));
app.use('/fonts', express.static(path.join(__dirname, '..', 'node_modules', '@fontsource')));
app.get('/health', (_, res) => res.send('ok'));

const games = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (games.has(code));
  return code;
}

const ack = fn => (typeof fn === 'function' ? fn : () => {});

io.on('connection', socket => {
  // ----- host -----
  socket.on('host:create', (_, cb) => {
    const code = makeCode();
    const game = new Game(code, boards.defaultBoard, state => io.to(code).emit('state', state), fx => io.to(code).emit('fx', fx));
    games.set(code, game);
    socket.join(code);
    socket.data = { code, role: 'host' };
    ack(cb)({ ok: true, code, hostKey: game.hostKey, boards: boards.list, spaceTypes: SPACE_META, items: ITEMS });
    game.broadcast();
  });

  socket.on('host:rejoin', ({ code, hostKey } = {}, cb) => {
    const game = games.get(String(code || '').toUpperCase());
    if (!game || game.hostKey !== hostKey) return ack(cb)({ ok: false });
    socket.join(game.code);
    socket.data = { code: game.code, role: 'host' };
    ack(cb)({ ok: true, code: game.code, hostKey, boards: boards.list, spaceTypes: SPACE_META, items: ITEMS });
    game.broadcast();
  });

  socket.on('host:start', ({ maxRounds } = {}) => {
    const game = hostGame(socket);
    if (game) game.start({ maxRounds });
  });

  socket.on('host:setBoard', ({ boardId } = {}) => {
    const game = hostGame(socket);
    const board = boards.byId[boardId];
    if (game && board && game.phase === 'LOBBY') {
      game.setBoard(board);
      game.broadcast();
    }
  });

  socket.on('host:restart', () => {
    const game = hostGame(socket);
    if (game) game.restart();
  });

  // ----- players -----
  socket.on('player:join', ({ code, name, playerId } = {}, cb) => {
    const game = games.get(String(code || '').trim().toUpperCase());
    if (!game) return ack(cb)({ ok: false, error: 'Room not found. Check the code on the TV.' });
    const res = game.addOrReconnect({ playerId, name, socketId: socket.id });
    if (!res.ok) return ack(cb)(res);
    socket.join(game.code);
    socket.data = { code: game.code, role: 'player', playerId: res.playerId };
    ack(cb)({ ok: true, code: game.code, playerId: res.playerId, items: ITEMS });
    game.broadcast();
  });

  socket.on('player:action', action => {
    const { code, role, playerId } = socket.data || {};
    const game = games.get(code);
    if (game && role === 'player') game.handleAction(playerId, action);
  });

  socket.on('disconnect', () => {
    const { code, role } = socket.data || {};
    const game = games.get(code);
    if (game && role === 'player') game.disconnect(socket.id);
  });
});

function hostGame(socket) {
  const { code, role } = socket.data || {};
  return role === 'host' ? games.get(code) : null;
}

// Clean up rooms nobody has touched in 3 hours
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, game] of games) if (game.lastActivity < cutoff) games.delete(code);
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Party Board running on http://localhost:${PORT}`));

module.exports = { server };
