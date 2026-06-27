// logger.js - Structured logging via pino.
// In development (LOG_PRETTY=true) it pretty-prints; in production it emits JSON lines
// suitable for log aggregation (Cloud Logging, Loki, etc.).

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';
const pretty = process.env.LOG_PRETTY === 'true' || process.env.NODE_ENV !== 'production';

const logger = pino({
  level,
  base: { service: 'gmeet-recorder' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' }
        }
      }
    : {})
});

module.exports = logger;
