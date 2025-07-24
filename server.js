const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8888;
let activeSessions = new Set();

function generateSessionCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {
  socket.on('request_active_sessions', () => {
    if (activeSessions.size > 0) {
      const firstSession = activeSessions.values().next().value;
      socket.emit('active_session_found', { sessionCode: firstSession });
    }
  });

  socket.on('create_session', () => {
    const sessionCode = generateSessionCode();
    activeSessions.add(sessionCode);
    socket.join(sessionCode);
    socket.emit('session_created', { sessionCode });
    
    socket.on('disconnect', () => {
        activeSessions.delete(sessionCode);
    });
  });

  socket.on('join_session', (data) => {
    if (!data || !data.sessionCode) {
      socket.emit('invalid_session'); return;
    }
    const { sessionCode } = data;
    if (activeSessions.has(sessionCode)) {
      socket.join(sessionCode);
      io.to(sessionCode).emit('connection_successful');
    } else {
      socket.emit('invalid_session');
    }
  });

  // NOUVEL ÉVÉNEMENT : Gère la demande de nouvelle partie
  socket.on('request_replay', (data) => {
    if (data && data.sessionCode) {
        // Informe tous les clients de la session de recommencer
        io.to(data.sessionCode).emit('start_new_game');
    }
  });

  socket.on('start_turn', (data) => {
    if (data && data.sessionCode) {
        socket.broadcast.to(data.sessionCode).emit('start_turn', { direction: data.direction });
    }
  });

  socket.on('stop_turn', (data) => {
    if (data && data.sessionCode) {
        socket.broadcast.to(data.sessionCode).emit('stop_turn');
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