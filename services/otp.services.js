// services/otp.service.js
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const supabase = require('../config/supabase');

const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES, 10) || 10;
const OTP_MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS, 10) || 5;
const BCRYPT_ROUNDS = 10;

function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function hashOTP(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

async function createOTP(email) {
  const otp = generateOTP();
  const otpHash = await hashOTP(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const { error: invalidateError } = await supabase
    .from('otp_codes')
    .update({ expires_at: new Date().toISOString() })
    .eq('email', email)
    .eq('verified', false)
    .gt('expires_at', new Date().toISOString());

  if (invalidateError) {
    throw new Error(`Failed to invalidate previous OTPs: ${invalidateError.message}`);
  }

  const { error: insertError } = await supabase
    .from('otp_codes')
    .insert({
      email,
      otp_hash: otpHash,
      expires_at: expiresAt,
      attempts: 0,
      verified: false,
    });

  if (insertError) {
    throw new Error(`Failed to store OTP: ${insertError.message}`);
  }

  return otp;
}

async function verifyOTP(email, plaintextOtp) {
  const now = new Date().toISOString();

  const { data: otpRecord, error: fetchError } = await supabase
    .from('otp_codes')
    .select('id, email, otp_hash, expires_at, attempts, verified')
    .eq('email', email)
    .eq('verified', false)
    .gt('expires_at', now)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Failed to retrieve OTP: ${fetchError.message}`);
  }

  if (!otpRecord) {
    return { valid: false, reason: 'No valid OTP found. Request a new code.' };
  }

  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
    await deleteOTP(otpRecord.id);
    return { valid: false, reason: 'Too many attempts. Request a new code.' };
  }

  const match = await bcrypt.compare(plaintextOtp, otpRecord.otp_hash);

  if (!match) {
    await supabase
      .from('otp_codes')
      .update({ attempts: otpRecord.attempts + 1 })
      .eq('id', otpRecord.id);

    const remaining = OTP_MAX_ATTEMPTS - otpRecord.attempts - 1;
    return { valid: false, reason: `Invalid code. ${remaining} attempts remaining.` };
  }

  await deleteOTP(otpRecord.id);

  return { valid: true };
}

async function deleteOTP(id) {
  const { error } = await supabase
    .from('otp_codes')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Failed to delete OTP: ${error.message}`);
  }
}

module.exports = {
  generateOTP,
  createOTP,
  verifyOTP,
  deleteOTP,
};
