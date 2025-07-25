const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  path: "/racer/socket.io/",
  
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
    const playerIndex = session.players.size;
    return availableColors[playerIndex % availableColors.length];
}

// --- MODIFICATION --- : La fonction de retour au lobby est maintenant séparée
function returnSessionToLobby(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session) return;

    // Annuler le timer s'il existe pour éviter une double exécution
    if (session.lobbyReturnTimer) {
        clearTimeout(session.lobbyReturnTimer);
        session.lobbyReturnTimer = null;
    }

    session.gameStarted = false;
    session.players.forEach(player => {
        player.isReady = false;
        player.wantsToReplay = false;
    });
    io.to(sessionCode).emit('return_to_lobby', { players: Array.from(session.players.values()) });
}


function checkAllWantReplay(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session || session.players.size === 0) {
        // S'il n'y a plus de joueurs, on peut nettoyer la session
        if (session && session.lobbyReturnTimer) {
            clearTimeout(session.lobbyReturnTimer);
        }
        setTimeout(() => {
            if (activeSessions.has(sessionCode) && activeSessions.get(sessionCode).players.size === 0) {
                activeSessions.delete(sessionCode);
            }
        }, 60000);
        return false;
    }
    
    const allPlayersWantReplay = Array.from(session.players.values()).every(player => player.wantsToReplay);

    if (allPlayersWantReplay) {
        returnSessionToLobby(sessionCode);
    }
}


io.on('connection', (socket) => {
  socket.on('request_active_sessions', () => {
    if (activeSessions.size > 0) {
      const firstSessionKey = Array.from(activeSessions.keys()).find(key => !activeSessions.get(key).gameStarted);
      if (firstSessionKey) {
        socket.emit('active_session_found', { sessionCode: firstSessionKey });
      }
    }
  });

  socket.on('create_session', () => {
    const sessionCode = generateSessionCode();
    activeSessions.set(sessionCode, {
        players: new Map(),
        gameStarted: false,
        creatorSocketId: socket.id,
        lobbyReturnTimer: null // --- AJOUT --- : Initialisation du timer
    });
    socket.join(sessionCode);
    socket.emit('session_created', { sessionCode });

    socket.on('disconnect', () => {
        const session = activeSessions.get(sessionCode);
        if (session && session.players.size === 0) {
            activeSessions.delete(sessionCode);
        }
    });
  });
  
  socket.on('reconnect_host', (data) => {
    const { sessionCode } = data;
    const session = activeSessions.get(sessionCode);
    if (session) {
        session.creatorSocketId = socket.id;
        socket.join(sessionCode);
        socket.emit('host_reconnected', { 
            sessionCode: sessionCode, 
            players: Array.from(session.players.values()) 
        });
         socket.on('disconnect', () => {});
    } else {
        socket.emit('session_not_found');
    }
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
        name: `Joueur ${session.players.size + 1}`,
        isReady: false,
        color: assignColor(sessionCode),
        wantsToReplay: false
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
        
        const allReady = Array.from(session.players.values()).every(p => p.isReady);
        if (session.players.size > 0 && allReady) {
            session.gameStarted = true;
            session.players.forEach(p => p.wantsToReplay = false);
            io.to(sessionCode).emit('start_game_for_all', { players: Array.from(session.players.values()) });
        }
    }
  });

  socket.on('request_replay', (data) => {
    if (data && data.sessionCode) {
        const session = activeSessions.get(data.sessionCode);
        if (session && session.players.has(socket.id)) {
            const player = session.players.get(socket.id);
            player.wantsToReplay = true;
            io.to(data.sessionCode).emit('player_wants_to_replay', { playerId: socket.id });
            checkAllWantReplay(data.sessionCode);
        }
    }
  });

  socket.on('disconnect', () => {
    for (const [sessionCode, session] of activeSessions.entries()) {
      if (session.players.has(socket.id)) {
        session.players.delete(socket.id);
        io.to(sessionCode).emit('player_left', { playerId: socket.id });
        if (session.gameStarted) {
            checkAllWantReplay(sessionCode);
        }
        break; 
      }
    }
  });

  socket.on('update_name', (data) => {
    const { sessionCode, name } = data;
    const session = activeSessions.get(sessionCode);
    if (session && session.players.has(socket.id)) {
      const player = session.players.get(socket.id);
      player.name = name;
      socket.broadcast.to(sessionCode).emit('player_name_updated', { playerId: socket.id, newName: name });
    }
  });

  // --- MODIFICATION --- : Le timer de retour au lobby est lancé ici
  socket.on('game_over', (data) => {
     if (!data || !data.sessionCode || typeof data.score === 'undefined') return;
     
     const session = activeSessions.get(data.sessionCode);
     if (session && !session.lobbyReturnTimer) {
        io.to(data.sessionCode).emit('game_over', { score: data.score });
        
        session.lobbyReturnTimer = setTimeout(() => {
            returnSessionToLobby(data.sessionCode);
        }, 30000); // 30 secondes
     }
  });
  
  socket.on('start_turn', (data) => { if (data && data.sessionCode) { socket.broadcast.to(data.sessionCode).emit('start_turn', { playerId: socket.id, direction: data.direction }); } });
  socket.on('stop_turn', (data) => { if (data && data.sessionCode) { socket.broadcast.to(data.sessionCode).emit('stop_turn', { playerId: socket.id }); } });
  socket.on('steer', (data) => { if (data && data.sessionCode) { socket.broadcast.to(data.sessionCode).emit('steer', { playerId: socket.id, angle: data.angle }); } });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});