// middleware/logger.js
'use strict';

const crypto = require('crypto');

function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  const startTime = process.hrtime.bigint();

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const originalEnd = res.end;
  res.end = function (...args) {
    const durationNs = Number(process.hrtime.bigint() - startTime);
    const durationMs = (durationNs / 1e6).toFixed(2);

    const logEntry = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Number(durationMs),
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '-',
      timestamp: new Date().toISOString(),
    };

    if (res.statusCode >= 500) {
      console.error(JSON.stringify({ level: 'error', ...logEntry }));
    } else if (res.statusCode >= 400) {
      console.warn(JSON.stringify({ level: 'warn', ...logEntry }));
    } else {
      console.log(JSON.stringify({ level: 'info', ...logEntry }));
    }

    originalEnd.apply(res, args);
  };

  next();
}

function logEvent(level, message, meta = {}) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };

  const output = JSON.stringify(entry);

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

module.exports = {
  requestLogger,
  logEvent,
};
