// services/jwt.service.js
'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set and at least 32 characters');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
    algorithm: 'HS256',
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET, {
      algorithms: ['HS256'],
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      const err = new Error('Token has expired');
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }
    if (error.name === 'JsonWebTokenError') {
      const err = new Error('Invalid token');
      err.code = 'TOKEN_INVALID';
      throw err;
    }
    throw error;
  }
}

module.exports = {
  signToken,
  verifyToken,
};
