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
// CHANGEMENT : 'activeSessions' est maintenant une Map pour stocker l'état complet de chaque session.
// La clé est le sessionCode, la valeur est un objet { players: Map, gameStarted: boolean }
let activeSessions = new Map();
const availableColors = ['#FF4136', '#0074D9', '#2ECC40', '#FFDC00', '#B10DC9', '#FF851B', '#7FDBFF', '#F012BE'];

function generateSessionCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// NOUVELLE FONCTION : Attribue une couleur unique à un nouveau joueur.
function assignColor(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session) return '#FFFFFF'; // Retourne blanc si la session n'existe pas

    const usedColors = new Set(Array.from(session.players.values()).map(p => p.color));
    const freeColor = availableColors.find(color => !usedColors.has(color));
    
    return freeColor || '#FFFFFF'; // Retourne blanc si toutes les couleurs sont prises
}

// NOUVELLE FONCTION : Vérifie si tous les joueurs dans une session sont prêts.
function checkAllReady(sessionCode) {
    const session = activeSessions.get(sessionCode);
    if (!session || session.players.size === 0) {
        return false;
    }
    return Array.from(session.players.values()).every(player => player.isReady);
}


io.on('connection', (socket) => {
  // Logique inchangée pour la recherche de session
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
    // CHANGEMENT : Initialise une session complète avec une Map de joueurs.
    activeSessions.set(sessionCode, {
        players: new Map(),
        gameStarted: false,
        creatorSocketId: socket.id // On garde l'ID du créateur pour gérer la déconnexion
    });
    socket.join(sessionCode);
    socket.emit('session_created', { sessionCode });

    // La déconnexion de l'écran de jeu détruit toute la session.
    socket.on('disconnect', () => {
        io.to(sessionCode).emit('session_closed'); // Informe les manettes de fermer la connexion
        activeSessions.delete(sessionCode);
    });
  });

  socket.on('join_session', (data) => {
    if (!data || !data.sessionCode) {
      socket.emit('invalid_session'); return;
    }
    const { sessionCode } = data;
    const session = activeSessions.get(sessionCode);

    // On vérifie que la session existe et que la partie n'a pas déjà commencé.
    if (session && !session.gameStarted) {
      socket.join(sessionCode);
      
      // NOUVELLE LOGIQUE : Création du joueur
      const newPlayer = {
        id: socket.id,
        isReady: false,
        color: assignColor(sessionCode)
      };
      session.players.set(socket.id, newPlayer);

      // Informe le nouveau joueur de son succès de connexion et de l'état actuel du lobby
      socket.emit('lobby_joined', {
        playerId: newPlayer.id,
        players: Array.from(session.players.values())
      });

      // Informe les autres joueurs (y compris l'écran de jeu) de l'arrivée d'un nouveau joueur
      socket.broadcast.to(sessionCode).emit('player_joined', newPlayer);

    } else {
      socket.emit('invalid_session');
    }
  });

  // NOUVEL ÉVÉNEMENT : Gère le statut "Prêt" d'un joueur.
  socket.on('player_ready', (data) => {
    const { sessionCode } = data;
    const session = activeSessions.get(sessionCode);
    if (session && session.players.has(socket.id)) {
        const player = session.players.get(socket.id);
        player.isReady = true;

        // Informe tout le monde de la mise à jour du statut de ce joueur.
        io.to(sessionCode).emit('player_status_updated', { playerId: socket.id, isReady: true });
        
        // Vérifie si tout le monde est prêt pour lancer la partie.
        if (checkAllReady(sessionCode)) {
            session.gameStarted = true;
            io.to(sessionCode).emit('start_game_for_all', { players: Array.from(session.players.values()) });
        }
    }
  });

  // NOUVEL ÉVÉNEMENT : Gère la demande de nouvelle partie après un game over.
  socket.on('request_replay', (data) => {
    if (data && data.sessionCode) {
        const session = activeSessions.get(data.sessionCode);
        if (session) {
            session.gameStarted = false;
            // Réinitialise le statut "prêt" de tous les joueurs
            session.players.forEach(player => player.isReady = false);
            // Informe tous les clients de recommencer et envoie l'état réinitialisé du lobby
            io.to(data.sessionCode).emit('return_to_lobby', { players: Array.from(session.players.values()) });
        }
    }
  });

  // GESTION DE LA DÉCONNEXION D'UN JOUEUR (MANETTE)
  socket.on('disconnect', () => {
    // On doit trouver dans quelle session était ce socket
    for (const [sessionCode, session] of activeSessions.entries()) {
      if (session.players.has(socket.id)) {
        session.players.delete(socket.id);
        // Informe les autres que ce joueur est parti
        io.to(sessionCode).emit('player_left', { playerId: socket.id });
        break; 
      }
    }
  });

  // Les événements de jeu incluent maintenant l'ID du joueur.
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