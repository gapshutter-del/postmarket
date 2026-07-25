// config/resend.js
'use strict';

const { Resend } = require('resend');

const apiKey = process.env.RESEND_API_KEY;

if (!apiKey) {
  throw new Error('RESEND_API_KEY must be set');
}

const resend = new Resend(apiKey);

module.exports = resend;
