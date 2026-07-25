// routes/notifications.js
'use strict';

const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/auth');
const { validate, sanitizeBody } = require('../middleware/validation');
const { sendNotificationEmail } = require('../services/email.service');
const { logEvent } = require('../middleware/logger');

const sendNotificationSchema = {
  to: { required: true, type: 'email' },
  subject: { required: true, type: 'string', minLength: 1, maxLength: 200 },
  htmlContent: { required: true, type: 'string', minLength: 1, maxLength: 50000 },
  textContent: { required: false, type: 'optionalString', maxLength: 50000 },
};

router.use(authenticate);

router.post(
  '/send',
  sanitizeBody,
  validate(sendNotificationSchema),
  async (req, res, next) => {
    try {
      const { to, subject, htmlContent, textContent } = req.body;

      const emailResult = await sendNotificationEmail({
        to,
        subject,
        htmlContent,
        textContent,
      });

      if (!emailResult.success) {
        logEvent('error', 'Failed to send notification email', {
          requestId: req.requestId,
          to,
          subject,
          error: emailResult.error,
          attempts: emailResult.attempts,
        });

        return res.status(502).json({
          success: false,
          code: 'EMAIL_DELIVERY_FAILED',
          message: 'Failed to deliver notification email. Please try again.',
          requestId: req.requestId,
        });
      }

      logEvent('info', 'Notification email sent', {
        requestId: req.requestId,
        to,
        subject,
        emailId: emailResult.emailId,
      });

      return res.status(200).json({
        success: true,
        data: {
          emailId: emailResult.emailId,
        },
        message: 'Notification email sent',
        requestId: req.requestId,
      });
    } catch (error) {
      logEvent('error', 'send-notification error', {
        requestId: req.requestId,
        error: error.message,
      });
      next(error);
    }
  }
);

module.exports = router;
