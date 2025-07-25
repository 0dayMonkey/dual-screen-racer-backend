const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  path: "/racer/socket.io/",
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
    const playerIndex = session.players.size;
    return availableColors[playerIndex % availableColors.length];
}

// --- MODIFICATION --- : Nouvelle fonction pour vérifier si tout le monde veut rejouer
function checkAllWantReplay(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session || session.players.size === 0) {
        // S'il n'y a plus de joueurs, on peut nettoyer la session après un délai
        setTimeout(() => {
            if (activeSessions.has(sessionCode) && activeSessions.get(sessionCode).players.size === 0) {
                activeSessions.delete(sessionCode);
            }
        }, 60000); // Nettoyage après 1 minute d'inactivité
        return false;
    }
    const allPlayersWantReplay = Array.from(session.players.values()).every(player => player.wantsToReplay);

    if (allPlayersWantReplay) {
        session.gameStarted = false;
        session.players.forEach(player => {
            player.isReady = false;
            player.wantsToReplay = false; // Réinitialiser pour la prochaine partie
        });
        io.to(sessionCode).emit('return_to_lobby', { players: Array.from(session.players.values()) });
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
        creatorSocketId: socket.id
    });
    socket.join(sessionCode);
    socket.emit('session_created', { sessionCode });

    // --- MODIFICATION --- : La déconnexion de l'hôte ne supprime plus la session immédiatement
    socket.on('disconnect', () => {
        const session = activeSessions.get(sessionCode);
        // On ne supprime la session que si le jeu n'a jamais démarré ou s'il n'y a pas de joueurs
        if (session && session.players.size === 0) {
            activeSessions.delete(sessionCode);
        }
        // Sinon, on laisse la session active pour permettre une reconnexion de l'hôte
    });
  });
  
  // --- MODIFICATION --- : Nouvel événement pour gérer la reconnexion de l'hôte
  socket.on('reconnect_host', (data) => {
    const { sessionCode } = data;
    const session = activeSessions.get(sessionCode);
    if (session) {
        session.creatorSocketId = socket.id; // Mettre à jour le socket ID de l'hôte
        socket.join(sessionCode);
        // Renvoyer l'état actuel du lobby à l'hôte reconnecté
        socket.emit('host_reconnected', { 
            sessionCode: sessionCode, 
            players: Array.from(session.players.values()) 
        });
         socket.on('disconnect', () => {
            // Logique de déconnexion future si nécessaire
        });
    } else {
        socket.emit('session_not_found'); // Indiquer à l'hôte que la session a expiré
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
        wantsToReplay: false // --- MODIFICATION ---
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
            session.players.forEach(p => p.wantsToReplay = false); // Réinitialiser le statut
            io.to(sessionCode).emit('start_game_for_all', { players: Array.from(session.players.values()) });
        }
    }
  });

  // --- MODIFICATION --- : Logique de "Rejouer" mise à jour
  socket.on('request_replay', (data) => {
    if (data && data.sessionCode) {
        const session = activeSessions.get(data.sessionCode);
        if (session && session.players.has(socket.id)) {
            const player = session.players.get(socket.id);
            player.wantsToReplay = true;
            // Informer tout le monde que ce joueur veut rejouer
            io.to(data.sessionCode).emit('player_wants_to_replay', { playerId: socket.id });
            // Vérifier si tout le monde est prêt à retourner au lobby
            checkAllWantReplay(data.sessionCode);
        }
    }
  });

  socket.on('disconnect', () => {
    for (const [sessionCode, session] of activeSessions.entries()) {
      if (session.players.has(socket.id)) {
        session.players.delete(socket.id);
        io.to(sessionCode).emit('player_left', { playerId: socket.id });
        // --- MODIFICATION --- : Si un joueur part de l'écran des scores, on vérifie si les autres peuvent continuer
        if (session.gameStarted) { // gameStarted reste true jusqu'au retour au lobby
            checkAllWantReplay(sessionCode);
        }
        break; 
      }
    }
  });

  // ... (les autres handlers comme update_name, start_turn, etc., restent inchangés) ...
  socket.on('update_name', (data) => {
    const { sessionCode, name } = data;
    const session = activeSessions.get(sessionCode);
    if (session && session.players.has(socket.id)) {
      const player = session.players.get(socket.id);
      player.name = name;
      socket.broadcast.to(sessionCode).emit('player_name_updated', { playerId: socket.id, newName: name });
    }
  });
  socket.on('start_turn', (data) => { if (data && data.sessionCode) { socket.broadcast.to(data.sessionCode).emit('start_turn', { playerId: socket.id, direction: data.direction }); } });
  socket.on('stop_turn', (data) => { if (data && data.sessionCode) { socket.broadcast.to(data.sessionCode).emit('stop_turn', { playerId: socket.id }); } });
  socket.on('steer', (data) => { if (data && data.sessionCode) { socket.broadcast.to(data.sessionCode).emit('steer', { playerId: socket.id, angle: data.angle }); } });
  socket.on('game_over', (data) => { if (!data || !data.sessionCode || typeof data.score === 'undefined') return; io.to(data.sessionCode).emit('game_over', { score: data.score }); });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});