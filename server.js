const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://harib-naim.fr",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 8888;

function generateSessionCode() {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  return code;
}

io.on('connection', (socket) => {
  socket.on('create_session', () => {
    const sessionCode = generateSessionCode();
    socket.join(sessionCode);
    socket.emit('session_created', { sessionCode });
  });

  socket.on('join_session', (data) => {
    if (!data || !data.sessionCode) {
      socket.emit('invalid_session');
      return;
    }
    const { sessionCode } = data;
    const roomExists = io.sockets.adapter.rooms.has(sessionCode);
    if (roomExists) {
      socket.join(sessionCode);
      io.to(sessionCode).emit('connection_successful');
    } else {
      socket.emit('invalid_session');
    }
  });

  socket.on('player_input', (data) => {
    if (!data || !data.sessionCode || !data.action) {
      return;
    }
    socket.broadcast.to(data.sessionCode).emit('game_state_update', { action: data.action });
  });

  socket.on('game_over', (data) => {
     if (!data || !data.sessionCode || typeof data.score === 'undefined') {
       return;
     }
     io.to(data.sessionCode).emit('game_over', { score: data.score });
     io.sockets.in(data.sessionCode).sockets.forEach(clientSocket => {
        clientSocket.leave(data.sessionCode);
     });
  });
});

server.listen(PORT, () => {
});