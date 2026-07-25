// services/email.service.js
'use strict';

const resend = require('../config/resend');

const EMAIL_FROM = process.env.EMAIL_FROM || 'PostMarket <noreply@yourdomain.com>';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(params, attempt = 1) {
  try {
    const result = await resend.emails.send(params);

    if (result.error) {
      throw new Error(result.error.message || 'Resend API returned an error');
    }

    return {
      success: true,
      emailId: result?.data?.id || null,
    };
  } catch (error) {
    if (attempt >= MAX_RETRIES) {
      return {
        success: false,
        error: error.message,
        attempts: attempt,
      };
    }

    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
    await sleep(delay);
    return sendWithRetry(params, attempt + 1);
  }
}

async function sendOTPEmail(email, otp) {
  const params = {
    from: EMAIL_FROM,
    to: [email],
    subject: 'Your PostMarket verification code',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #111; margin-bottom: 8px;">Your verification code</h2>
        <p style="color: #555; margin-bottom: 24px;">Use this code to complete your authentication. It expires in ${process.env.OTP_EXPIRY_MINUTES || 10} minutes.</p>
        <div style="background: #f5f5f5; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #111;">${otp}</span>
        </div>
        <p style="color: #888; font-size: 13px;">If you did not request this code, ignore this email.</p>
      </div>
    `,
    text: `Your PostMarket verification code is: ${otp}. It expires in ${process.env.OTP_EXPIRY_MINUTES || 10} minutes. If you did not request this code, ignore this email.`,
  };

  return sendWithRetry(params);
}

async function sendNotificationEmail({ to, subject, htmlContent, textContent }) {
  const params = {
    from: EMAIL_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html: htmlContent,
    text: textContent || '',
  };

  return sendWithRetry(params);
}

async function sendBookingConfirmationEmail({ to, campaignName, dates, budget }) {
  const subject = `Booking confirmed: ${campaignName}`;
  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #111; margin-bottom: 8px;">Booking Confirmed</h2>
      <p style="color: #555; margin-bottom: 24px;">Your booking for <strong>${campaignName}</strong> has been created.</p>
      <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <p style="margin: 4px 0;"><strong>Campaign:</strong> ${campaignName}</p>
        <p style="margin: 4px 0;"><strong>Dates:</strong> ${Array.isArray(dates) ? dates.join(', ') : dates}</p>
        <p style="margin: 4px 0;"><strong>Budget:</strong> $${Number(budget).toLocaleString()}</p>
      </div>
      <p style="color: #888; font-size: 13px;">You will receive another notification when the booking is accepted.</p>
    </div>
  `;

  return sendNotificationEmail({ to, subject, htmlContent });
}

async function sendBookingAcceptedEmail({ to, campaignName }) {
  const subject = `Booking accepted: ${campaignName}`;
  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #111; margin-bottom: 8px;">Booking Accepted</h2>
      <p style="color: #555;">Your booking for <strong>${campaignName}</strong> has been accepted.</p>
    </div>
  `;

  return sendNotificationEmail({ to, subject, htmlContent });
}

module.exports = {
  sendOTPEmail,
  sendNotificationEmail,
  sendBookingConfirmationEmail,
  sendBookingAcceptedEmail,
};
