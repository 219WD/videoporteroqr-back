// server.js - VERSIÓN CORREGIDA:

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { initializeWebSocket } = require('./websocket-server');

const authRoutes = require('./routes/auth');
const dashRoutes = require('./routes/dashboard');
const notificationRoutes = require('./routes/notifications');
const messageRoutes = require('./routes/messages');
const videoCallRoutes = require('./routes/videocall');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ✅ 1. PRIMERO: Archivos estáticos (IMPORTANTE: debe ir PRIMERO)
app.use(express.static('public'));

const server = http.createServer(app);

// Inicializar WebSocket
initializeWebSocket(server);

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('Mongo connected'))
  .catch(err => console.error(err));

// ✅ 2. DESPUÉS: Tus rutas API
app.use('/auth', authRoutes);
app.use('/dashboard', dashRoutes);
app.use('/notifications', notificationRoutes);
app.use('/messages', messageRoutes);
app.use('/videocall', videoCallRoutes);

// ✅ 3. OPCIONAL: Si quieres mantener /scan para otra cosa, déjala al final
app.get('/scan', (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code');
  res.send(`Código escaneado: ${code} — redirige a la app con deep link o muestra instrucciones.`);
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));