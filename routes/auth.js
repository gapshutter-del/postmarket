// routes/auth.js
'use strict';

const express = require('express');
const router = express.Router();

const supabase = require('../config/supabase');
const { createOTP, verifyOTP } = require('../services/otp.service');
const { sendOTPEmail } = require('../services/email.service');
const { signToken } = require('../services/jwt.service');
const { validate, sanitizeBody } = require('../middleware/validation');
const { ValidationError, ConflictError } = require('../middleware/errors');
const { logEvent } = require('../middleware/logger');

const sendOtpSchema = {
  email: { required: true, type: 'email' },
};

const verifyOtpSchema = {
  email: { required: true, type: 'email' },
  otp: {
    required: true,
    type: 'string',
    minLength: 6,
    maxLength: 6,
    custom: (value) => {
      if (!/^\d{6}$/.test(value)) return 'Must be a 6-digit numeric code';
      return null;
    },
  },
  role: { required: false, type: 'enum', allowed: ['creator', 'advertiser'] },
  displayName: { required: false, type: 'optionalString', maxLength: 100 },
  companyName: { required: false, type: 'optionalString', maxLength: 200 },
};

router.post(
  '/send-otp',
  sanitizeBody,
  validate(sendOtpSchema),
  async (req, res, next) => {
    try {
      const { email } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      const otp = await createOTP(normalizedEmail);

      const emailResult = await sendOTPEmail(normalizedEmail, otp);

      if (!emailResult.success) {
        logEvent('error', 'Failed to send OTP email', {
          requestId: req.requestId,
          email: normalizedEmail,
          error: emailResult.error,
          attempts: emailResult.attempts,
        });

        return res.status(502).json({
          success: false,
          code: 'EMAIL_DELIVERY_FAILED',
          message: 'Failed to deliver verification email. Please try again.',
          requestId: req.requestId,
        });
      }

      logEvent('info', 'OTP email sent', {
        requestId: req.requestId,
        email: normalizedEmail,
        emailId: emailResult.emailId,
      });

      return res.status(200).json({
        success: true,
        message: 'Verification code sent',
        requestId: req.requestId,
      });
    } catch (error) {
      logEvent('error', 'send-otp error', {
        requestId: req.requestId,
        error: error.message,
      });
      next(error);
    }
  }
);

router.post(
  '/verify-otp',
  sanitizeBody,
  validate(verifyOtpSchema),
  async (req, res, next) => {
    try {
      const { email, otp, role, displayName, companyName } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      const result = await verifyOTP(normalizedEmail, otp);

      if (!result.valid) {
        logEvent('warn', 'OTP verification failed', {
          requestId: req.requestId,
          email: normalizedEmail,
          reason: result.reason,
        });

        return res.status(401).json({
          success: false,
          code: 'OTP_VERIFICATION_FAILED',
          message: result.reason,
          requestId: req.requestId,
        });
      }

      let { data: user, error: userFetchError } = await supabase
        .from('users')
        .select('id, email, role')
        .eq('email', normalizedEmail)
        .maybeSingle();

      if (userFetchError) {
        logEvent('error', 'Database error fetching user', {
          requestId: req.requestId,
          error: userFetchError.message,
        });
        throw new Error(`Database error: ${userFetchError.message}`);
      }

      if (!user) {
        const newUserRow = {
          email: normalizedEmail,
          role: role || 'creator',
        };

        if (displayName) newUserRow.display_name = displayName;
        if (companyName) newUserRow.company_name = companyName;

        const { data: createdUser, error: createError } = await supabase
          .from('users')
          .insert(newUserRow)
          .select('id, email, role')
          .single();

        if (createError) {
          if (createError.code === '23505') {
            const { data: existingUser } = await supabase
              .from('users')
              .select('id, email, role')
              .eq('email', normalizedEmail)
              .maybeSingle();

            if (existingUser) {
              user = existingUser;
            } else {
              throw new ConflictError('User creation failed due to a conflict');
            }
          } else {
            logEvent('error', 'Database error creating user', {
              requestId: req.requestId,
              error: createError.message,
            });
            throw new Error(`Database error: ${createError.message}`);
          }
        } else {
          user = createdUser;
        }
      }

      const token = signToken({
        sub: user.id,
        email: user.email,
        role: user.role,
      });

      logEvent('info', 'User authenticated via OTP', {
        requestId: req.requestId,
        userId: user.id,
        email: user.email,
      });

      return res.status(200).json({
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
          },
        },
        requestId: req.requestId,
      });
    } catch (error) {
      logEvent('error', 'verify-otp error', {
        requestId: req.requestId,
        error: error.message,
      });
      next(error);
    }
  }
);

module.exports = router;
