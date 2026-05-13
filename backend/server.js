require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');

// ─── Init ────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: '*' }));
app.use(express.json());

// Multer — store uploads in memory, then send to Supabase Storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── In-Memory Game State ────────────────────────────────────────────────────
// rooms: { [roomCode]: { players, rounds, currentRound, status, timer, hostId } }
const rooms = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calculateScore(guessLat, guessLng, answerLat, answerLng, timeRemainingSeconds, totalTimeSeconds) {
  // Haversine distance in metres
  const R = 6371000;
  const dLat = (answerLat - guessLat) * Math.PI / 180;
  const dLng = (answerLng - guessLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(guessLat * Math.PI / 180) * Math.cos(answerLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Max distance on the map ~1800m, scale accordingly
  const MAX_DISTANCE = 1800;
  const distanceScore = Math.max(0, Math.round(5000 * Math.max(0, 1 - distance / MAX_DISTANCE)));

  // Time bonus: up to 2000 points for speed
  const timeRatio = timeRemainingSeconds / totalTimeSeconds;
  const timeBonus = Math.round(2000 * timeRatio);

  return {
    total: distanceScore + timeBonus,
    distanceScore,
    timeBonus,
    distanceMetres: Math.round(distance)
  };
}

function getRoomSummary(room) {
  return {
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    currentRound: room.currentRound,
    totalRounds: room.rounds.length,
    status: room.status
  };
}

// ─── REST: Admin Routes ───────────────────────────────────────────────────────

// Middleware: simple password check for admin routes
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (pw !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Upload map image
app.post('/admin/upload-map', adminAuth, upload.single('map'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const { error } = await supabase.storage
      .from('game-assets')
      .upload('map/map.png', file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (error) throw error;

    const { data } = supabase.storage.from('game-assets').getPublicUrl('map/map.png');
    res.json({ url: data.publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Upload a round (photo + coordinates)
app.post('/admin/upload-round', adminAuth, upload.single('photo'), async (req, res) => {
  try {
    const { lat, lng, label } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No photo provided' });

    const ext = path.extname(file.originalname) || '.jpg';
    const filename = `rounds/${uuidv4()}${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('game-assets')
      .upload(filename, file.buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) throw uploadError;

    const { data } = supabase.storage.from('game-assets').getPublicUrl(filename);

    // Save round to DB
    const { data: round, error: dbError } = await supabase
      .from('rounds')
      .insert({ photo_url: data.publicUrl, answer_lat: parseFloat(lat), answer_lng: parseFloat(lng), label: label || '' })
      .select()
      .single();

    if (dbError) throw dbError;

    res.json({ round });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get all rounds
app.get('/admin/rounds', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('rounds').select('*').order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ rounds: data });
});

// Delete a round
app.delete('/admin/rounds/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('rounds').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Create a game lobby — admin picks which rounds to use and in what order
app.post('/admin/create-game', adminAuth, async (req, res) => {
  try {
    const { roundIds } = req.body; // array of round IDs in desired order
    if (!roundIds || !roundIds.length) return res.status(400).json({ error: 'roundIds required' });

    // Fetch selected rounds
    const { data: rounds, error } = await supabase
      .from('rounds')
      .select('*')
      .in('id', roundIds);

    if (error) throw error;

    // Sort by roundIds order
    const orderedRounds = roundIds.map(id => rounds.find(r => r.id === id)).filter(Boolean);

    const roomCode = generateRoomCode();

    // Fetch map URL
    const { data: mapData } = supabase.storage.from('game-assets').getPublicUrl('map/map.png');

    rooms[roomCode] = {
      roomCode,
      players: [],
      rounds: orderedRounds,
      currentRound: -1, // -1 = lobby, not started
      status: 'lobby',   // lobby | active | results | finished
      hostId: null,
      mapUrl: mapData.publicUrl,
      roundTimer: null,
      roundStartTime: null,
      ROUND_DURATION: 30 // seconds per round
    };

    res.json({ roomCode, totalRounds: orderedRounds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get map URL
app.get('/map-url', async (req, res) => {
  const { data } = supabase.storage.from('game-assets').getPublicUrl('map/map.png');
  res.json({ url: data.publicUrl });
});

// ─── Socket.io Game Logic ─────────────────────────────────────────────────────
const ROUND_DURATION = 30; // seconds
const RESULTS_DURATION = 10; // seconds between rounds

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // ── Join Room ──
  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', { message: 'Room not found. Check your invite code.' });
    if (room.status !== 'lobby') return socket.emit('error', { message: 'Game already in progress.' });
    if (!playerName || playerName.trim().length < 1) return socket.emit('error', { message: 'Name required.' });

    const player = {
      id: socket.id,
      name: playerName.trim().substring(0, 20),
      score: 0,
      roundGuesses: {} // { roundIndex: { lat, lng, score, timeRemaining } }
    };

    // First player becomes host
    if (room.players.length === 0) {
      room.hostId = socket.id;
      player.isHost = true;
    }

    room.players.push(player);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('joined_room', {
      roomCode,
      playerId: socket.id,
      isHost: player.isHost,
      mapUrl: room.mapUrl,
      totalRounds: room.rounds.length,
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.isHost }))
    });

    socket.to(roomCode).emit('player_joined', {
      player: { id: player.id, name: player.name, score: 0 },
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.isHost }))
    });

    console.log(`${playerName} joined room ${roomCode}`);
  });

  // ── Host Starts Game ──
  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error', { message: 'Room not found.' });
    if (socket.id !== room.hostId) return socket.emit('error', { message: 'Only the host can start the game.' });
    if (room.status !== 'lobby') return socket.emit('error', { message: 'Game already started.' });
    if (room.players.length < 1) return socket.emit('error', { message: 'Need at least 1 player.' });

    startNextRound(roomCode);
  });

  // ── Player Submits Guess ──
  socket.on('submit_guess', ({ roomCode, lat, lng }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'active') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const roundIdx = room.currentRound;
    if (player.roundGuesses[roundIdx] !== undefined) return; // already guessed

    const timeElapsed = (Date.now() - room.roundStartTime) / 1000;
    const timeRemaining = Math.max(0, ROUND_DURATION - timeElapsed);

    const answer = room.rounds[roundIdx];
    const scoreResult = calculateScore(lat, lng, answer.answer_lat, answer.answer_lng, timeRemaining, ROUND_DURATION);

    player.roundGuesses[roundIdx] = { lat, lng, ...scoreResult, timeRemaining };
    player.score += scoreResult.total;

    // Confirm to the guesser
    socket.emit('guess_confirmed', {
      roundIdx,
      ...scoreResult,
      yourScore: player.score
    });

    // Tell everyone else this player guessed (not the answer)
    socket.to(roomCode).emit('player_guessed', { playerId: socket.id, name: player.name });

    // If all players have guessed, end round early
    const allGuessed = room.players.every(p => p.roundGuesses[roundIdx] !== undefined);
    if (allGuessed) {
      clearTimeout(room.roundTimer);
      endRound(roomCode);
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];

    room.players = room.players.filter(p => p.id !== socket.id);

    // If host left, assign new host
    if (socket.id === room.hostId && room.players.length > 0) {
      room.players[0].isHost = true;
      room.hostId = room.players[0].id;
      io.to(roomCode).emit('new_host', { hostId: room.hostId });
    }

    io.to(roomCode).emit('player_left', {
      playerId: socket.id,
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, isHost: p.isHost }))
    });

    // Clean up empty rooms
    if (room.players.length === 0) {
      clearTimeout(room.roundTimer);
      delete rooms[roomCode];
      console.log(`Room ${roomCode} deleted (empty)`);
    }
  });
});

// ─── Game Round Logic ─────────────────────────────────────────────────────────
function startNextRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.currentRound++;

  if (room.currentRound >= room.rounds.length) {
    return endGame(roomCode);
  }

  room.status = 'active';
  room.roundStartTime = Date.now();

  const round = room.rounds[room.currentRound];

  // Push round start to ALL players simultaneously — photo URL sent here only
  io.to(roomCode).emit('round_start', {
    roundIndex: room.currentRound,
    totalRounds: room.rounds.length,
    photoUrl: round.photo_url,
    durationSeconds: ROUND_DURATION,
    label: round.label || ''
  });

  console.log(`Room ${roomCode}: Round ${room.currentRound + 1} started`);

  // Server-side timer ends the round
  room.roundTimer = setTimeout(() => endRound(roomCode), ROUND_DURATION * 1000);
}

function endRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.status !== 'active') return;

  room.status = 'results';
  clearTimeout(room.roundTimer);

  const round = room.rounds[room.currentRound];
  const roundIdx = room.currentRound;

  // Build per-player results
  const playerResults = room.players.map(p => {
    const guess = p.roundGuesses[roundIdx];
    return {
      playerId: p.id,
      name: p.name,
      totalScore: p.score,
      roundScore: guess ? guess.total : 0,
      distanceMetres: guess ? guess.distanceMetres : null,
      guessLat: guess ? guess.lat : null,
      guessLng: guess ? guess.lng : null,
      didGuess: !!guess
    };
  }).sort((a, b) => b.totalScore - a.totalScore);

  io.to(roomCode).emit('round_end', {
    roundIndex: roundIdx,
    answerLat: round.answer_lat,
    answerLng: round.answer_lng,
    label: round.label || '',
    playerResults,
    nextRoundIn: RESULTS_DURATION
  });

  console.log(`Room ${roomCode}: Round ${roundIdx + 1} ended`);

  // Move to next round after results window
  room.roundTimer = setTimeout(() => {
    room.status = 'active'; // reset so startNextRound works
    startNextRound(roomCode);
  }, RESULTS_DURATION * 1000);
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.status = 'finished';

  const finalScores = room.players
    .map(p => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  io.to(roomCode).emit('game_over', { finalScores });

  console.log(`Room ${roomCode}: Game over`);

  // Save scores to Supabase
  Promise.all(finalScores.map((p, i) =>
    supabase.from('game_scores').insert({
      room_code: roomCode,
      player_name: p.name,
      score: p.score,
      rank: i + 1
    })
  )).catch(console.error);
}

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
