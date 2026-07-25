// middleware/errors.js
'use strict';

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'AUTHORIZATION_ERROR');
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

function errorHandler(err, req, res, _next) {
  const requestId = req.requestId || 'unknown';
  const isProduction = process.env.NODE_ENV === 'production';

  if (err instanceof AppError) {
    const response = {
      success: false,
      code: err.code,
      message: err.message,
      requestId,
    };

    if (err.details) {
      response.details = err.details;
    }

    if (!isProduction && err.stack) {
      response.stack = err.stack;
    }

    return res.status(err.statusCode).json(response);
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      code: 'INVALID_JSON',
      message: 'Malformed JSON in request body',
      requestId,
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds the maximum allowed size',
      requestId,
    });
  }

  console.error(JSON.stringify({
    level: 'error',
    message: 'Unhandled error',
    error: err.message,
    stack: err.stack,
    requestId,
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString(),
  }));

  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: isProduction ? 'An unexpected error occurred' : err.message,
    requestId,
  });
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  errorHandler,
};
