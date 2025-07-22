// server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Pour le développement, nous autorisons toutes les origines.
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// --- Logique du jeu ---

/**
 * Génère un code de session alphanumérique à 6 caractères.
 * @returns {string} Le code de session.
 */
function generateSessionCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log(`Un client s'est connecté : ${socket.id}`);

  // Étape 1 : L'écran de jeu demande à créer une session
  socket.on('create_session', () => {
    const sessionCode = generateSessionCode();
    socket.join(sessionCode); // Le créateur rejoint son propre salon
    console.log(`[Session Créée] Client ${socket.id} a créé la session : ${sessionCode}`);
    socket.emit('session_created', { sessionCode });
  });

  // Étape 2 : La manette tente de rejoindre une session
  socket.on('join_session', ({ sessionCode }) => {
    // On vérifie si le salon (la session) existe
    const roomExists = io.sockets.adapter.rooms.has(sessionCode);
    if (roomExists) {
      socket.join(sessionCode);
      console.log(`[Session Rejointe] Client ${socket.id} a rejoint la session : ${sessionCode}`);
      
      // On notifie tout le monde dans le salon (jeu et manette) que la connexion est réussie
      io.to(sessionCode).emit('connection_successful');
    } else {
      console.log(`[Erreur] Client ${socket.id} a tenté de rejoindre une session invalide : ${sessionCode}`);
      socket.emit('invalid_session'); // On notifie la manette que le code est mauvais
    }
  });

  // Étape 3 : La manette envoie une commande
  socket.on('player_input', (data) => {
    // data devrait être de la forme { sessionCode: 'K8F3N1', action: 'left' }
    console.log(`[Input Reçu] Action '${data.action}' pour la session ${data.sessionCode}`);
    
    // On relaie la commande uniquement à l'écran de jeu (et pas à celui qui l'a envoyée)
    socket.broadcast.to(data.sessionCode).emit('game_state_update', { action: data.action });
  });
  
  // Étape 4 : Le jeu notifie la fin de partie
  socket.on('game_over', (data) => {
     // data devrait être de la forme { sessionCode: 'K8F3N1', score: 125.4 }
     console.log(`[Fin de Partie] La session ${data.sessionCode} est terminée. Score : ${data.score}`);
     
     // On relaie l'information à tout le monde dans le salon
     io.to(data.sessionCode).emit('game_over', { score: data.score });
     
     // On peut nettoyer le salon ici si nécessaire
     io.sockets.in(data.sessionCode).sockets.forEach(socket => {
        socket.leave(data.sessionCode);
     });
  });

  socket.on('disconnect', () => {
    console.log(`Un client s'est déconnecté : ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Serveur Dual Screen Racer démarré sur le port ${PORT}`);
});