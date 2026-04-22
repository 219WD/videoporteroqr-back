const util = require('util');
const winston = require('winston');

const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = NODE_ENV === 'development' ? 'debug' : 'info';

const levels = {
  critical: 0,
  error: 1,
  warn: 2,
  info: 3,
  http: 4,
  debug: 5,
};

function normalizeValue(value) {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }

  return value;
}

function buildMeta(info) {
  const meta = {};
  const reservedKeys = new Set([
    'level',
    'message',
    'timestamp',
    'scope',
    'stack',
    'label',
    'service',
  ]);

  for (const [key, value] of Object.entries(info)) {
    if (reservedKeys.has(key)) {
      continue;
    }

    if (value !== undefined) {
      meta[key] = normalizeValue(value);
    }
  }

  return Object.keys(meta).length > 0 ? meta : null;
}

const baseLogger = winston.createLogger({
  defaultMeta: {
    service: 'videoporteroqr-back',
  },
  level: LOG_LEVEL,
  levels,
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.timestamp(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.printf(({ timestamp, level, message, scope, stack, ...meta }) => {
          const scopeText = scope ? ` [${scope}]` : '';
          const normalizedMeta = buildMeta(meta);
          const metaText = normalizedMeta ? ` ${JSON.stringify(normalizedMeta)}` : '';
          const stackText = stack ? `\n${stack}` : '';

          return `${timestamp} ${level.toUpperCase()}${scopeText} ${message}${metaText}${stackText}`;
        }),
      ),
    }),
  ],
  exitOnError: false,
});

function installConsoleBridge() {
  if (global.__videoportero_console_bridge_installed) {
    return;
  }

  global.__videoportero_console_bridge_installed = true;

  console.log = (...args) => baseLogger.info(util.format(...args));
  console.info = (...args) => baseLogger.info(util.format(...args));
  console.warn = (...args) => baseLogger.warn(util.format(...args));
  console.error = (...args) => baseLogger.error(util.format(...args));
  console.debug = (...args) => baseLogger.debug(util.format(...args));
  console.trace = (...args) => {
    const message = args.length > 0 ? util.format(...args) : 'Trace';
    baseLogger.debug(message);
  };
}

installConsoleBridge();

function createScopedLogger(scope) {
  const scoped = {};

  for (const level of Object.keys(levels)) {
    scoped[level] = (message, meta = {}) => {
      baseLogger.log({
        level,
        message,
        scope,
        ...meta,
      });
    };
  }

  scoped.log = (level, message, meta = {}) => {
    baseLogger.log({
      level,
      message,
      scope,
      ...meta,
    });
  };

  scoped.child = (childScope) => createScopedLogger(scope ? `${scope}:${childScope}` : childScope);

  return scoped;
}

module.exports = {
  levels,
  logger: baseLogger,
  createScopedLogger,
};


