require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://snsgnzwkjtyopqxwxqss.supabase.co',
  process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNuc2duendranR5b3BxeHd4cXNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3NTM1MjgsImV4cCI6MjEwMDMyOTUyOH0.H8JHanTTpLIsJ6UOhhTqSxnabugAQrRsKTjlXoRHJVA'
);

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = 'PostMarket <no-reply@postnstatusmarket.co.za>';
const FRONTEND_URL = 'https://postnstatusmarket.co.za';

// In-memory OTP store (resets on deploy, fine for MVP)
const otpStore = {};

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'alive', message: 'PostMarket API v2 — Email + Password Auth' });
});

// ==========================================
// 1. SEND OTP (Signup only)
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email.toLowerCase()] = { otp, expires: Date.now() + 600000 }; // 10 min

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Your PostMarket Verification Code: ${otp}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; padding: 20px; max-width: 500px; margin: auto; color: #0F172A;">
          <h2 style="color: #4F46E5;">Welcome to PostMarket!</h2>
          <p>Your verification code is:</p>
          <div style="font-size: 2rem; font-weight: 800; letter-spacing: 8px; text-align: center; padding: 20px; background: #EEF2FF; border-radius: 8px; color: #4F46E5; margin: 20px 0;">${otp}</div>
          <p style="color: #64748B; font-size: 14px;">This code expires in 10 minutes. Do not share it.</p>
          <p style="font-size: 12px; color: #94A3B8; margin-top: 30px; text-align: center;">Arcon Park, Vereeniging<br><span style="font-size: 10px;">PostMarket is a Sole Proprietorship operated by PB Brantley.</span></p>
        </div>
      `
    });
    res.json({ success: true });
  } catch (error) {
    console.error('OTP Send Error:', error);
    res.status(500).json({ success: false, message: 'Failed to send email' });
  }
});

// ==========================================
// 2. VERIFY OTP
// ==========================================
app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const stored = otpStore[email?.toLowerCase()];

  if (!stored) return res.json({ success: false, message: 'No OTP found. Request a new one.' });
  if (Date.now() > stored.expires) return res.json({ success: false, message: 'Code expired.' });
  if (stored.otp !== otp) return res.json({ success: false, message: 'Invalid code.' });

  delete otpStore[email.toLowerCase()];
  res.json({ success: true });
});

// ==========================================
// 3. SIGNUP (Create account with password)
// ==========================================
app.post('/api/auth/signup', async (req, res) => {
  const { type, email, password, name, ref, niche, audience_desc, platforms, total_reach, rate, sa_id, payout_method, wallet_id, bank_name, bank_acc, company_name } = req.body;

  if (!email || !password || !name) return res.status(400).json({ success: false, message: 'Missing fields' });

  try {
    const password_hash = await bcrypt.hash(password, 10);
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('type', 'creator');
    const isFounding = type === 'creator' && (count || 0) < 50;

    const newUser = {
      ref: ref || (type === 'creator' ? 'CRT-' : 'ADV-') + Math.floor(100000 + Math.random() * 900000),
      type, name, email, password_hash, status: 'active',
      niche: niche || null, audience_desc: audience_desc || null,
      platforms: platforms || {}, total_reach: total_reach || 0, rate: rate || 0,
      sa_id: sa_id || null, payout_method: payout_method || null,
      wallet_id: wallet_id || null, bank_name: bank_name || null, bank_acc: bank_acc || null,
      company_name: company_name || null,
      is_founding_member: isFounding, free_flight_active: isFounding,
      bookings_completed: 0, joined_at: new Date().toISOString()
    };

    const { error } = await supabase.from('users').insert([newUser]);
    if (error) return res.status(400).json({ success: false, message: error.message });

    // Remove password_hash before sending back
    delete newUser.password_hash;
    res.json({ success: true, user: newUser });
  } catch (error) {
    console.error('Signup Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==========================================
// 4. LOGIN (Email + Password)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
    if (error || !user) return res.json({ success: false, message: 'No account found with this email.' });
    if (user.status === 'deleted') return res.json({ success: false, message: 'This account has been deleted.' });
    if (user.status === 'paused') return res.json({ success: false, message: 'This account is paused. Contact support.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.json({ success: false, message: 'Incorrect password.' });

    delete user.password_hash;
    res.json({ success: true, user });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==========================================
// 5. NOTIFY CREATOR (New booking)
// ==========================================
app.post('/api/notify-creator', async (req, res) => {
  const { creator_email, creator_name, adv_name, booking_id, dates, slots, total_fee, brief } = req.body;
  if (!creator_email) return res.status(400).json({ success: false });

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: creator_email,
      subject: `🔔 New Booking: R${Number(total_fee).toFixed(2)} from ${adv_name}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; padding: 20px; max-width: 500px; margin: auto; color: #0F172A;">
          <h2 style="color: #4F46E5;">New Booking Request!</h2>
          <p>Hi ${creator_name}, <strong>${adv_name}</strong> has booked your timeslots.</p>
          <div style="background: #F8FAFC; padding: 15px; border-radius: 8px; margin: 20px 0; font-size: 14px; border: 1px solid #E2E8F0;">
            <strong>Booking ID:</strong> ${booking_id}<br>
            <strong>Total Payout:</strong> R${Number(total_fee).toFixed(2)}<br>
            <strong>Dates:</strong> ${dates.join(', ')}<br>
            <strong>Timeslots:</strong> ${slots.join(', ')}<br>
            <strong>Brief:</strong> ${brief || 'None provided'}
          </div>
          <a href="${FRONTEND_URL}" style="display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Log In & Respond</a>
          <p style="font-size: 12px; color: #94A3B8; margin-top: 30px; text-align: center;">Arcon Park, Vereeniging<br><span style="font-size: 10px;">PostMarket is a Sole Proprietorship operated by PB Brantley.</span></p>
        </div>
      `
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Creator Notify Error:', error);
    res.status(500).json({ success: false });
  }
});

// ==========================================
// 6. NOTIFY ADVERTISER (Booking confirmed)
// ==========================================
app.post('/api/notify-advertiser', async (req, res) => {
  const { adv_email, adv_name, booking_id, creator_name, total_fee, dates, slots } = req.body;
  if (!adv_email) return res.status(400).json({ success: false });

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: adv_email,
      subject: `✅ Booking Confirmed: ${creator_name} | R${Number(total_fee).toFixed(2)}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; padding: 20px; max-width: 500px; margin: auto; color: #0F172A;">
          <h2 style="color: #10B981;">Booking Confirmed!</h2>
          <p>Hi ${adv_name}, your booking with <strong>${creator_name}</strong> is confirmed.</p>
          <div style="background: #F8FAFC; padding: 15px; border-radius: 8px; margin: 20px 0; font-size: 14px; border: 1px solid #E2E8F0;">
            <strong>Booking ID:</strong> ${booking_id}<br>
            <strong>Amount:</strong> R${Number(total_fee).toFixed(2)}<br>
            <strong>Dates:</strong> ${dates.join(', ')}<br>
            <strong>Timeslots:</strong> ${slots.join(', ')}
          </div>
          <a href="${FRONTEND_URL}" style="display: inline-block; background: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Log In to Track</a>
          <p style="font-size: 12px; color: #94A3B8; margin-top: 30px; text-align: center;">Arcon Park, Vereeniging<br><span style="font-size: 10px;">PostMarket is a Sole Proprietorship operated by PB Brantley.</span></p>
        </div>
      `
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Advertiser Notify Error:', error);
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PostMarket API v2 running on port ${PORT}`));
