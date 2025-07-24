const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// --- CONFIGURATION CORRECTE ET FINALE ---
const io = new Server(server, {
  // 1. On définit un chemin explicite pour éviter les conflits.
  path: "/racer/socket.io/",
  
  // 2. On configure CORS pour autoriser spécifiquement votre site web.
  cors: {
    origin: "https://harib-naim.fr", 
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8888;
let activeSessions = new Map();
const availableColors = ['#FF4136', '#0074D9', '#2ECC40', '#FFDC00', '#B10DC9', '#FF851B', '#7FDBFF', '#F012BE'];

function generateSessionCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function assignColor(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session) return '#FFFFFF';

    const usedColors = new Set(Array.from(session.players.values()).map(p => p.color));
    const freeColor = availableColors.find(color => !usedColors.has(color));
    
    return freeColor || '#FFFFFF';
}

function checkAllReady(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session || session.players.size === 0) {
        return false;
    }
    return Array.from(session.players.values()).every(player => player.isReady);
}


io.on('connection', (socket) => {
  socket.on('request_active_sessions', () => {
    if (activeSessions.size > 0) {
      const firstSessionKey = activeSessions.keys().next().value;
      const session = activeSessions.get(firstSessionKey);
      if (session && !session.gameStarted) {
        socket.emit('active_session_found', { sessionCode: firstSessionKey });
      }
    }
  });

  socket.on('create_session', () => {
    const sessionCode = generateSessionCode();
    activeSessions.set(sessionCode, {
        players: new Map(),
        gameStarted: false,
        creatorSocketId: socket.id
    });
    socket.join(sessionCode);
    socket.emit('session_created', { sessionCode });

    socket.on('disconnect', () => {
        io.to(sessionCode).emit('session_closed');
        activeSessions.delete(sessionCode);
    });
  });

  socket.on('join_session', (data) => {
    if (!data || !data.sessionCode) {
      socket.emit('invalid_session'); return;
    }
    const { sessionCode } = data;
    const session = activeSessions.get(sessionCode);

    if (session && !session.gameStarted) {
      socket.join(sessionCode);
      
      const newPlayer = {
        id: socket.id,
        isReady: false,
        color: assignColor(sessionCode)
      };
      session.players.set(socket.id, newPlayer);

      socket.emit('lobby_joined', {
        playerId: newPlayer.id,
        players: Array.from(session.players.values())
      });

      socket.broadcast.to(sessionCode).emit('player_joined', newPlayer);

    } else {
      socket.emit('invalid_session');
    }
  });

  socket.on('player_ready', (data) => {
    const { sessionCode } = data;
    const session = activeSessions.get(sessionCode);
    if (session && session.players.has(socket.id)) {
        const player = session.players.get(socket.id);
        player.isReady = true;

        io.to(sessionCode).emit('player_status_updated', { playerId: socket.id, isReady: true });
        
        if (checkAllReady(sessionCode)) {
            session.gameStarted = true;
            io.to(sessionCode).emit('start_game_for_all', { players: Array.from(session.players.values()) });
        }
    }
  });

  socket.on('request_replay', (data) => {
    if (data && data.sessionCode) {
        const session = activeSessions.get(data.sessionCode);
        if (session) {
            session.gameStarted = false;
            session.players.forEach(player => player.isReady = false);
            io.to(data.sessionCode).emit('return_to_lobby', { players: Array.from(session.players.values()) });
        }
    }
  });

  socket.on('disconnect', () => {
    for (const [sessionCode, session] of activeSessions.entries()) {
      if (session.players.has(socket.id)) {
        session.players.delete(socket.id);
        io.to(sessionCode).emit('player_left', { playerId: socket.id });
        break; 
      }
    }
  });

  socket.on('start_turn', (data) => {
    if (data && data.sessionCode) {
        socket.broadcast.to(data.sessionCode).emit('start_turn', { playerId: socket.id, direction: data.direction });
    }
  });

  socket.on('stop_turn', (data) => {
    if (data && data.sessionCode) {
        socket.broadcast.to(data.sessionCode).emit('stop_turn', { playerId: socket.id });
    }
  });

  socket.on('game_over', (data) => {
     if (!data || !data.sessionCode || typeof data.score === 'undefined') return;
     io.to(data.sessionCode).emit('game_over', { score: data.score });
  });
});


server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});