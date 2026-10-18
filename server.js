'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));
app.get('/health', (_, res) => res.json({ ok: true, v: '7.1' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms   = {};   // code -> Room
const players = {};   // socketId -> { name, code, idx }

/* ─ Helpers ─ */
function genCode() {
  let c;
  do { c = Math.random().toString(36).substr(2, 6).toUpperCase(); } while (rooms[c]);
  return c;
}

/* ─ Constants (shared with canMove / move logic) ─ */
const ENTRY_POS  = [0, 13, 26, 39];
const SAFE_SQ    = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const HOME_ENTRY = [51, 11, 24, 37]; // last board square before home lane

/* ─ Room ─ */
class Room {
  constructor(code, host, np, stake) {
    this.code     = code;
    this.np       = np;
    this.stake    = stake;
    this.members  = [{ id: host.id, name: host.name, idx: 0 }];
    this.started  = false;
    this.cur      = 0;
    this.tokens   = [[-1, -1, -1, -1]];
    this.dice     = 0;
    this.rolled   = false;
    this.over     = false;
    this.sixCount = 0;
  }

  isFull()  { return this.members.length >= this.np; }
  curId()   { return this.members[this.cur]?.id; }

  add(id, name) {
    const idx = this.members.length;
    this.members.push({ id, name, idx });
    this.tokens.push([-1, -1, -1, -1]);
    return idx;
  }

  roll() {
    if (this.rolled || this.over) return null;
    this.dice   = Math.ceil(Math.random() * 6);
    this.rolled = true;
    if (this.dice === 6) this.sixCount++;
    else this.sixCount = 0;
    return this.dice;
  }

  calcPos(pi, ti, steps) {
    const cur = this.tokens[pi][ti];
    if (cur < 0)  return ENTRY_POS[pi];
    if (cur >= 52) { const n = cur + steps; return n <= 57 ? n : null; }
    const ei = HOME_ENTRY[pi];
    let p = cur;
    for (let i = 0; i < steps; i++) {
      if (p === ei) { p = 52 + (steps - i - 1); return p <= 57 ? p : null; }
      p = (p + 1) % 52;
    }
    return p;
  }

  canMove(pi, ti) {
    const t = this.tokens[pi][ti];
    if (t === 58) return false;
    if (t < 0)   return this.dice === 6;
    const dest = this.calcPos(pi, ti, this.dice);
    if (dest === null) return false;
    if (dest < 52 && !SAFE_SQ.has(dest)) {
      const blocked = this.tokens.some((pt, oi) => {
        if (oi === pi) return false;
        return pt.filter(pos => pos === dest).length >= 2;
      });
      if (blocked) return false;
    }
    return true;
  }

  anyMove(pi) { return [0, 1, 2, 3].some(ti => this.canMove(pi, ti)); }

  move(pi, ti) {
    if (!this.rolled || this.over || pi !== this.cur) return null;
    if (!this.canMove(pi, ti)) return null;

    const cur   = this.tokens[pi][ti];
    let   newP  = cur < 0 ? ENTRY_POS[pi] : this.calcPos(pi, ti, this.dice);
    if (newP === null) return null;

    this.tokens[pi][ti] = newP;
    let captured = [];
    let bonus    = (newP === 57) || (cur < 0 && this.dice === 6);

    if (newP === 57) {
      this.tokens[pi][ti] = 58;
    } else if (newP < 52 && !SAFE_SQ.has(newP)) {
      this.tokens.forEach((pt, oi) => {
        if (oi === pi) return;
        const cnt = pt.filter(t => t === newP).length;
        if (cnt >= 2) return; // blocked — cannot capture
        pt.forEach((t, oti) => {
          if (t === newP) {
            this.tokens[oi][oti] = -1;
            captured.push([oi, oti]);
            bonus = true;
          }
        });
      });
    }

    const savedDice = this.dice;
    this.rolled     = false;

    // Advance turn unless it's a bonus turn
    if (!(bonus || savedDice === 6)) this.advance();

    const isOver = this.tokens[pi].every(pos => pos === 58);
    if (isOver) this.over = true;

    return {
      newPos: newP, captured, bonus,
      dice: savedDice,
      over: isOver,
      winner: isOver ? pi : null,
      cur: this.cur,
    };
  }

  advance() {
    this.sixCount = 0;
    let n = (this.cur + 1) % this.np, t = 0;
    while (this.tokens[n].every(x => x === 58) && t++ < this.np) n = (n + 1) % this.np;
    this.cur = n;
  }

  // Remove a player who disconnected mid-game; hand their tokens to AI (mark them finished to skip)
  forfeit(socketId) {
    const m = this.members.find(m => m.id === socketId);
    if (!m) return;
    // Mark all that player's tokens as finished so advance() skips them
    this.tokens[m.idx] = [58, 58, 58, 58];
    if (this.cur === m.idx) {
      this.rolled = false;
      this.advance();
    }
  }
}

/* ─ Socket Events ─ */
io.on('connection', socket => {

  /* ── Lobby ── */
  socket.on('createRoom', ({ name, numPlayers, stake }) => {
    name = (name || 'Player').slice(0, 16);
    const code = genCode();
    rooms[code]        = new Room(code, { id: socket.id, name }, numPlayers || 2, stake || 100);
    players[socket.id] = { name, code, idx: 0 };
    socket.join(code);
    socket.emit('roomCreated', { roomId: code, code, playerIndex: 0 });
  });

  socket.on('joinRoom', ({ name, code }) => {
    name = (name || 'Player').slice(0, 16);
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room)         return socket.emit('roomError', { message: 'Room not found' });
    if (room.isFull()) return socket.emit('roomError', { message: 'Room is full' });
    if (room.started)  return socket.emit('roomError', { message: 'Game already started' });

    const idx = room.add(socket.id, name);
    players[socket.id] = { name, code, idx };
    socket.join(code);
    io.to(code).emit('playerJoined', { players: room.members, total: room.np });
    socket.emit('joinedRoom', { roomId: code, playerIndex: idx });
    if (room.isFull()) startRoom(code);
  });

  socket.on('startRoom', ({ roomId }) => {
    const r = rooms[roomId];
    if (r && r.members[0].id === socket.id) startRoom(roomId);
  });

  /* ── Gameplay ── */
  socket.on('rollDice', ({ roomId }) => {
    const r  = rooms[roomId];
    if (!r || !r.started || r.over) return socket.emit('rollRejected', { reason: 'notStarted' });
    const pi = players[socket.id]?.idx;
    if (pi === undefined || pi !== r.cur) return socket.emit('rollRejected', { reason: 'notYourTurn' });

    const dice = r.roll();
    if (dice === null) return; // already rolled

    io.to(roomId).emit('diceRolled', { dice, playerIndex: pi, tokens: r.tokens });

    if (r.sixCount >= 3) {
      // Three sixes — forfeit turn
      r.sixCount = 0;
      r.rolled   = false;
      r.advance();
      setTimeout(() => io.to(roomId).emit('turnChanged', { cur: r.cur, reason: 'threeSixes' }), 1500);
    } else if (!r.anyMove(pi)) {
      // No valid moves
      r.rolled = false;
      if (dice !== 6) r.advance();
      // If dice===6 with no moves, same player rolls again (sixCount kept for triple-6 guard)
      setTimeout(() => io.to(roomId).emit('turnChanged', { cur: r.cur, reason: 'noMove' }), 1500);
    }
  });

  socket.on('moveToken', ({ roomId, tokenIndex }) => {
    const r  = rooms[roomId];
    if (!r || !r.started || r.over) return socket.emit('moveError', { message: 'Game not active' });
    const pi = players[socket.id]?.idx;
    if (pi === undefined || pi !== r.cur) return socket.emit('moveError', { message: 'Not your turn' });

    const result = r.move(pi, tokenIndex);
    if (!result) return socket.emit('moveError', { message: 'Invalid move' });

    // Broadcast the authoritative move result to ALL clients (including sender)
    io.to(roomId).emit('tokenMoved', {
      ...result,
      playerIndex: pi,
      tokenIndex,
      tokens: r.tokens,
    });

    if (result.over) {
      io.to(roomId).emit('gameOver', { winner: pi });
      setTimeout(() => delete rooms[roomId], 5000);
    }
  });

  /* ── Chat ── */
  socket.on('chat', ({ roomId, name, msg }) => {
    if (typeof msg === 'string' && msg.length <= 100) {
      io.to(roomId).emit('chatMsg', {
        name: (name || '?').slice(0, 16),
        msg:  msg.slice(0, 100),
      });
    }
  });

  /* ── WebRTC Voice Signaling (pure relay, no audio hits the server) ── */
  socket.on('voiceOffer',    ({ to, sdp })       => socket.to(to).emit('voiceOffer',    { from: socket.id, sdp }));
  socket.on('voiceAnswer',   ({ to, sdp })       => socket.to(to).emit('voiceAnswer',   { from: socket.id, sdp }));
  socket.on('iceCandidate',  ({ to, candidate }) => socket.to(to).emit('iceCandidate',  { from: socket.id, candidate }));
  socket.on('voiceMuteState',({ roomId, muted }) => socket.to(roomId).emit('voiceMuteState', { from: socket.id, muted }));

  /* ── Disconnect / Leave ── */
  socket.on('leaveRoom',  ({ roomId }) => cleanup(socket, roomId));
  socket.on('disconnect', () => {
    const info = players[socket.id];
    if (info) cleanup(socket, info.code);
    delete players[socket.id];
  });
});

/* ─ Helpers ─ */
function startRoom(code) {
  const r = rooms[code];
  if (!r || r.started) return;
  r.started = true;
  const playerNames = r.members.map(m => m.name);
  const memberIds   = r.members.map(m => m.id);
  r.members.forEach((m, i) =>
    io.to(m.id).emit('gameStart', {
      roomId:      code,
      playerIndex: i,
      numPlayers:  r.np,
      playerNames,
      memberIds,
      stake:       r.stake,
    })
  );
}

function cleanup(socket, code) {
  const r = rooms[code];
  if (!r) return;
  const pInfo = players[socket.id];
  const pName = pInfo?.name || 'A player';

  if (r.started && !r.over) {
    // Game in progress — forfeit that player's tokens and continue
    r.forfeit(socket.id);
    io.to(code).emit('playerLeft', { name: pName, cur: r.cur });
    // If only one human remains, end the game
    const remaining = r.members.filter(m => m.id !== socket.id);
    if (remaining.length <= 1) {
      r.over = true;
      if (remaining.length === 1) {
        const winIdx = r.members.findIndex(m => m.id === remaining[0].id);
        io.to(code).emit('gameOver', { winner: winIdx });
      }
      delete rooms[code];
    } else {
      r.members = r.members.filter(m => m.id !== socket.id);
    }
  } else {
    // Still in lobby
    io.to(code).emit('playerLeft', { name: pName });
    r.members = r.members.filter(m => m.id !== socket.id);
    if (!r.members.length) delete rooms[code];
  }
}

/* ─ Listen ─ */
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => console.log(`\n🎲 Ludo Star Pro v7.1 → http://localhost:${PORT}\n`));
