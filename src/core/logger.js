const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const os = require('os');

// Defense-in-depth redaction applied to every log call's metadata, regardless
// of caller (e.g. the interview latency diagnostics, which are content-free
// by construction, but also every other service logger in the app). Strips
// values under credential-shaped keys and drops query strings from anything
// that looks like a URL, so a stray secret or endpoint query parameter never
// reaches disk even if a future call accidentally includes one.
const SENSITIVE_KEY = /^(api[-_]?key|authorization|credential|token|secret|password)s?$/i;
const URL_WITH_QUERY = /^([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)\?[^\s#]*/i;

function redactValue(value, depth) {
  if (typeof value === 'string') {
    const match = value.match(URL_WITH_QUERY);
    return match ? `${match[1]}?[REDACTED]` : value;
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
  if (value && typeof value === 'object') return redactMeta(value, depth + 1);
  return value;
}

function redactMeta(meta, depth = 0) {
  if (!meta || typeof meta !== 'object' || depth > 6) return meta;
  const redacted = Array.isArray(meta) ? [] : {};
  for (const [key, value] of Object.entries(meta)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(value, depth);
  }
  return redacted;
}

class Logger {
  constructor() {
    this.logDir = path.join(os.homedir(), '.OpenCluely', 'logs');
    this.setupLogger();
  }

  setupLogger() {
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack, service, ...meta }) => {
        const safeMeta = redactMeta(meta);
        const metaStr = Object.keys(safeMeta).length ? JSON.stringify(safeMeta, null, 2) : '';
        const serviceStr = service ? `[${service}]` : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `${timestamp} ${level.toUpperCase()} ${serviceStr} ${message}${stackStr}${metaStr ? `\n${metaStr}` : ''}`;
      })
    );

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      defaultMeta: { pid: process.pid },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            logFormat
          ),
          stderrLevels: ['error', 'warn']
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, 'application-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
          level: 'info'
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, 'error-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d',
          level: 'error'
        })
      ],
      exceptionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'exceptions.log')
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'rejections.log')
        })
      ]
    });
  }

  createServiceLogger(serviceName) {
    return {
      debug: (message, meta = {}) => this.logger.debug(message, { service: serviceName, ...meta }),
      info: (message, meta = {}) => this.logger.info(message, { service: serviceName, ...meta }),
      warn: (message, meta = {}) => this.logger.warn(message, { service: serviceName, ...meta }),
      error: (message, meta = {}) => this.logger.error(message, { service: serviceName, ...meta }),
      logPerformance: (operation, startTime, metadata = {}) => this.logPerformance(operation, startTime, { service: serviceName, ...metadata })
    };
  }

  getSystemMetrics() {
    return {
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      platform: process.platform,
      nodeVersion: process.version
    };
  }

  logPerformance(operation, startTime, metadata = {}) {
    const duration = Date.now() - startTime;
    this.logger.info(`Performance: ${operation} completed`, {
      service: 'PERFORMANCE',
      duration: `${duration}ms`,
      ...metadata
    });
    return duration;
  }
}

module.exports = new Logger();
// Exposed for direct unit testing of the redaction logic (the real
// formatter, not a stub). Not part of the logger's day-to-day API surface.
module.exports.redactMeta = redactMeta;
module.exports.redactValue = redactValue;