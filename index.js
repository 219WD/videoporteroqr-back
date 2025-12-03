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
const flowRoutes = require('./routes/flows'); // ✅ NUEVA RUTA

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ✅ 1. PRIMERO: Archivos estáticos
app.use(express.static('public'));

const server = http.createServer(app);

// Inicializar WebSocket
initializeWebSocket(server);

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB conectado'))
  .catch(err => console.error('❌ Error MongoDB:', err));

// ✅ 2. DESPUÉS: Rutas API
app.use('/auth', authRoutes);
app.use('/dashboard', dashRoutes);
app.use('/notifications', notificationRoutes);
app.use('/messages', messageRoutes);
app.use('/videocall', videoCallRoutes);
app.use('/flows', flowRoutes); // ✅ NUEVA RUTA

// ✅ 3. Ruta de prueba
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'VideoPortero Backend'
  });
});

// ✅ 4. Ruta para escanear QR (landing page)
app.get('/scan', (req, res) => {
  const { code } = req.query;
  if (!code) {
    // Si no hay código, mostrar página de error o redirigir
    return res.sendFile(__dirname + '/public/qr-landing.html');
  }
  
  // Redirigir a la landing page con el código
  res.redirect(`/qr-landing.html?code=${code}`);
});

// ✅ 5. Manejo de errores 404
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Ruta no encontrada' 
  });
});

// ✅ 6. Manejo de errores generales
app.use((err, req, res, next) => {
  console.error('❌ Error del servidor:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Error interno del servidor',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
  console.log(`🌍 URL: http://localhost:${PORT}`);
  console.log(`🔧 Entorno: ${process.env.NODE_ENV || 'development'}`);
});