const http = require('http')
const express = require('express')
const mongoose = require('mongoose')
const cors = require('cors')
const morgan = require('morgan')
const { randomUUID } = require('crypto')

const { ALLOWED_ORIGINS, ANON_WEB_APP_URL, APP_PUBLIC_URL, MONGO_URI, NODE_ENV, PORT } = require('./config/env')
const { initializeWebSocket } = require('./websocket-server')
const { buildCorsOptions, createRateLimiter, securityHeaders } = require('./middleware/security')
const { createScopedLogger, logger: baseLogger } = require('./utils/logger')
const { seedAdminUser } = require('./scripts/seedAdmin')

const authRoutes = require('./routes/auth')
const dashRoutes = require('./routes/dashboard')
const notificationRoutes = require('./routes/notifications')
const messageRoutes = require('./routes/messages')
const callRoutes = require('./routes/calls')
const videoCallRoutes = require('./routes/videocall')
const flowRoutes = require('./routes/flows')
const serverRoutes = require('./routes/server')

const logger = createScopedLogger('app')
const httpLogger = createScopedLogger('http')

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.use(securityHeaders);
  app.use(cors(buildCorsOptions(ALLOWED_ORIGINS)));
  app.use(express.json({ limit: '1mb' }));
  morgan.token('id', (req) => req.requestId || '-');
  app.use(
    morgan(':date[iso] :remote-addr :method :url :status :res[content-length] - :response-time ms req=:id origin=":req[origin]" ua=":user-agent"', {
      stream: {
        write: (message) => {
          httpLogger.http(message.trim());
        },
      },
    }),
  );
  const publicLimiter = createRateLimiter({
    max: 120,
    message: 'Demasiadas solicitudes desde esta IP',
    windowMs: 60 * 1000,
  });
  const authLimiter = createRateLimiter({
    max: 10,
    message: 'Demasiados intentos de autenticacion',
    windowMs: 15 * 60 * 1000,
  });

  app.use(['/auth/login', '/auth/register'], authLimiter);
  app.use(['/videocall/anonymous-call', '/flows/start', '/notifications/call-host', '/notifications/push-tokens'], publicLimiter);

  app.use('/auth', authRoutes);
  app.use('/dashboard', dashRoutes);
  app.use('/notifications', notificationRoutes);
  app.use('/messages', messageRoutes);
  app.use('/calls', callRoutes);
  app.use('/videocall', videoCallRoutes);
  app.use('/flows', flowRoutes);
  app.use('/server', serverRoutes);

  app.get('/health', (req, res) => {
    res.json({
      service: 'VideoPortero Backend',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/', (req, res) => {
    res.type('text/plain').send('ok');
  });

  app.get('/scan', (req, res) => {
    const { code } = req.query;
    const anonWebBase = ANON_WEB_APP_URL.replace(/\/$/, '');

    if (!code) {
      return res.redirect(`${anonWebBase}/`);
    }

    return res.redirect(`${anonWebBase}/qr/${encodeURIComponent(String(code))}`);
  });

  app.use((req, res) => {
    res.status(404).json({
      error: 'Ruta no encontrada',
      success: false,
    });
  });

  app.use((err, req, res, next) => {
    logger.error('Error del servidor', { error: err, path: req.path, method: req.method });
    res.status(500).json({
      error: 'Error interno del servidor',
      message: NODE_ENV === 'development' ? err.message : undefined,
      success: false,
    });
  });

  return app;
}

async function start() {
  const app = createApp();
  const server = http.createServer(app);

  initializeWebSocket(server);

  await mongoose.connect(MONGO_URI);
  await seedAdminUser();
  logger.info('MongoDB conectado');

  server.once('error', (error) => {
    logger.critical('Error iniciando el servidor HTTP', { error });
    process.exit(1);
  });

  server.listen(PORT, () => {
    logger.info(`Servidor ejecutandose en puerto ${PORT}`);
    logger.info(`URL local: ${APP_PUBLIC_URL}`);
    logger.info(`Entorno: ${NODE_ENV}`);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.critical('Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (error) => {
  logger.critical('Uncaught exception', { error });
});

start().catch((error) => {
  logger.critical('No fue posible iniciar el servidor', { error });
  process.exit(1);
});


