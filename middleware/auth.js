// middleware/auth.js
'use strict';

const { verifyToken } = require('../services/jwt.service');
const { AuthenticationError } = require('./errors');
const { logEvent } = require('./logger');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logEvent('warn', 'Missing authorization header', {
      requestId: req.requestId,
      path: req.originalUrl,
    });
    return next(new AuthenticationError('Authorization header is required'));
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logEvent('warn', 'Malformed authorization header', {
      requestId: req.requestId,
      path: req.originalUrl,
    });
    return next(new AuthenticationError('Authorization header must use Bearer scheme'));
  }

  const token = parts[1];

  try {
    const decoded = verifyToken(token);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };
    next();
  } catch (error) {
    logEvent('warn', 'JWT verification failed', {
      requestId: req.requestId,
      path: req.originalUrl,
      code: error.code || 'UNKNOWN',
    });
    return next(new AuthenticationError(error.message || 'Invalid or expired token'));
  }
}

function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AuthenticationError());
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new (require('./errors').AuthorizationError)(
          `Role '${req.user.role}' is not authorized for this action`
        )
      );
    }

    next();
  };
}

module.exports = {
  authenticate,
  authorize,
};
