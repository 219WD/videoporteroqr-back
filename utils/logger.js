
const fs = require('fs');
const path = require('path');
const util = require('util');
const winston = require('winston');
const Transport = require('winston-transport');

const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE || 'America/Buenos_Aires';
const LOG_DIRECTORY = path.join(__dirname, '..', 'logs');
const LOG_LEVEL = NODE_ENV === 'development' ? 'debug' : 'info';

const levels = {
  critical: 0,
  error: 1,
  warn: 2,
  info: 3,
  http: 4,
  debug: 5,
};

fs.mkdirSync(LOG_DIRECTORY, { recursive: true });

function getDateStamp(date = new Date(), timeZone = LOG_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone,
  }).formatToParts(date);

  const values = parts.reduce((acc, part) => {
    if (part.type !== 'literal') {
      acc[part.type] = part.value;
    }

    return acc;
  }, {});

  return `${values.year}-${values.month}-${values.day}`;
}

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

function formatConsoleValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return JSON.stringify(normalizeValue(value));
  }

  try {
    return JSON.stringify(normalizeValue(value));
  } catch (error) {
    return util.inspect(value, { breakLength: Infinity, depth: 6 });
  }
}

function formatConsoleArgs(args) {
  return args.map((arg) => formatConsoleValue(arg)).join(' ');
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

function formatLine(info) {
  const timestamp = info.timestamp || new Date().toISOString();
  const scope = info.scope ? ` [${info.scope}]` : '';
  const message =
    typeof info.message === 'string'
      ? info.message
      : util.inspect(info.message, { breakLength: Infinity, depth: 6 });
  const meta = buildMeta(info);
  const stack = info.stack ? `\n${info.stack}` : '';
  const metaText = meta ? ` ${JSON.stringify(meta)}` : '';

  return `${timestamp} ${String(info.level).toUpperCase()}${scope} ${message}${metaText}${stack}`;
}

class DailyFileTransport extends Transport {
  constructor(options = {}) {
    super(options);
    this.directory = options.directory || LOG_DIRECTORY;
    this.filenamePrefix = options.filenamePrefix || 'app';
    this.timeZone = options.timeZone || LOG_TIME_ZONE;
    this.currentDate = null;
    this.stream = null;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  getFilePath(dateStamp) {
    return path.join(this.directory, `${this.filenamePrefix}-${dateStamp}.log`);
  }

  ensureStream() {
    const dateStamp = getDateStamp(new Date(), this.timeZone);

    if (this.currentDate === dateStamp && this.stream) {
      return;
    }

    if (this.stream) {
      this.stream.end();
    }

    this.currentDate = dateStamp;
    this.stream = fs.createWriteStream(this.getFilePath(dateStamp), {
      flags: 'a',
    });

    this.stream.on('error', (error) => {
      this.emit('error', error);
    });
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));

    try {
      this.ensureStream();
      const line = formatLine(info);
      this.stream.write(`${line}\n`, callback);
    } catch (error) {
      this.emit('error', error);
      callback?.();
    }
  }
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

          return `${timestamp} ${level}${scopeText} ${message}${metaText}${stackText}`;
        }),
      ),
    }),
    new DailyFileTransport({
      directory: LOG_DIRECTORY,
      filenamePrefix: 'app',
      level: 'debug',
    }),
  ],
  exitOnError: false,
});

function installConsoleBridge() {
  if (global.__videoportero_console_bridge_installed) {
    return;
  }

  global.__videoportero_console_bridge_installed = true;

  console.log = (...args) => baseLogger.info(formatConsoleArgs(args));
  console.info = (...args) => baseLogger.info(formatConsoleArgs(args));
  console.warn = (...args) => baseLogger.warn(formatConsoleArgs(args));
  console.error = (...args) => baseLogger.error(formatConsoleArgs(args));
  console.debug = (...args) => baseLogger.debug(formatConsoleArgs(args));
  console.trace = (...args) => {
    const message = args.length > 0 ? formatConsoleArgs(args) : 'Trace';
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


