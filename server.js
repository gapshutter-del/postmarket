require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

// Supabase Client
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[ERROR] Missing Supabase env vars');
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Email Client
const RESEND_KEY = process.env.RESEND_API_KEY;
if (!RESEND_KEY) {
    console.error('[ERROR] Missing Resend env var');
    process.exit(1);
}
const resend = new Resend(RESEND_KEY);

const FROM_EMAIL = 'PostMarket <ramoupi33@gmail.com>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://postnstatusmarket.co.za';
const otpStore = {};

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ==========================================
// AUTH: SEND OTP
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ success: false, message: 'Valid email required' });
  
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email.toLowerCase()] = { otp, expires: Date.now() + 600000 };

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'PostMarket Verification Code',
      html: `<div style="font-family:system-ui,sans-serif; padding:24px; max-width:500px; margin:auto; background:#fff; border:1px solid #eee; border-radius:8px;"><h2 style="margin:0 0 16px; color:#1A1A1A;">Verify Your Identity</h2><p style="margin:0 0 24px; color:#5A5A5A;">Your verification code is:</p><div style="font-size:28px; font-weight:700; letter-spacing:6px; text-align:center; padding:16px; background:#f7f2ea; border-radius:6px; color:#1A1A1A; margin-bottom:24px;">${otp}</div><p style="font-size:12px; color:#8E8E8E; margin:0; text-align:center;">Valid for 10 minutes. If you did not request this, ignore it.</p></div>`
    });
    console.log(`[AUTH] OTP sent to ${email}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[AUTH] OTP Send Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to send verification email' });
  }
});

// ==========================================
// AUTH: VERIFY OTP
// ==========================================
app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.json({ success: false, message: 'Email and OTP required' });
  
  const stored = otpStore[email.toLowerCase()];
  if (!stored) return res.json({ success: false, message: 'No pending verification. Request a new code.' });
  if (Date.now() > stored.expires) { delete otpStore[email.toLowerCase()]; return res.json({ success: false, message: 'Code expired. Request a new one.' }); }
  if (stored.otp !== otp) return res.json({ success: false, message: 'Invalid code. Please try again.' });
  
  delete otpStore[email.toLowerCase()];
  console.log(`[AUTH] OTP verified for ${email}`);
  res.json({ success: true });
});

// ==========================================
// AUTH: SIGNUP
// ==========================================
app.post('/api/auth/signup', async (req, res) => {
  const { type, email, password, name, company_name, niche, audience_desc, platforms, total_reach, rate, sa_id, payout_method, wallet_id, bank_name, bank_acc } = req.body;
  if (!email || !password || !name) return res.status(400).json({ success: false, message: 'Email, password, and name are required' });

  try {
    // Check if already exists
    const { data: existing } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).single();
    if (existing) return res.status(409).json({ success: false, message: 'An account with this email already exists' });

    const password_hash = await bcrypt.hash(password, 10);
    const ref = (type === 'creator' ? 'CRT-' : 'ADV-') + Math.floor(100000 + Math.random() * 900000);
    
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true }).eq('type', 'creator');
    const isFounding = type === 'creator' && (count || 0) < 50;

    const newUser = {
      ref, type, name, email: email.toLowerCase(), password_hash, status: 'active',
      company_name: company_name || null, niche: niche || null, audience_desc: audience_desc || null,
      platforms: platforms || {}, total_reach: total_reach || 0, rate: rate || 0,
      sa_id: sa_id || null, payout_method: payout_method || null, wallet_id: wallet_id || null, bank_name: bank_name || null, bank_acc: bank_acc || null,
      is_founding_member: isFounding, free_flight_active: isFounding,
      joined_at: new Date().toISOString()
    };

    const { error } = await supabase.from('users').insert([newUser]);
    if (error) throw new Error(error.message);

    delete newUser.password_hash;
    console.log(`[AUTH] New account created: ${newUser.ref} (${type})`);
    res.json({ success: true, user: newUser });
  } catch (error) {
    console.error('[AUTH] Signup Error:', error.message);
    res.status(500).json({ success: false, message: 'Account creation failed' });
  }
});

// ==========================================
// AUTH: LOGIN (Direct, NO OTP)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
    if (error || !user) return res.json({ success: false, message: 'No account found with this email.' });
    if (user.status !== 'active') return res.json({ success: false, message: `Account is currently ${user.status}.` });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.json({ success: false, message: 'Incorrect password.' });

    delete user.password_hash;
    console.log(`[AUTH] Login successful: ${user.ref}`);
    res.json({ success: true, user });
  } catch (error) {
    console.error('[AUTH] Login Error:', error.message);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// ==========================================
// NOTIFICATIONS
// ==========================================
app.post('/api/notify-creator', async (req, res) => {
  const { creator_email, creator_name, adv_name, booking_id, dates, slots, total_fee, brief } = req.body;
  if (!creator_email) return res.status(400).json({ success: false });
  try {
    await resend.emails.send({ from: FROM_EMAIL, to: creator_email, subject: `New Booking Request: R${Number(total_fee).toFixed(2)}`, html: `<div style="font-family:system-ui; padding:20px; max-width:480px; margin:auto; color:#1A1A1A;"><h2>New Booking Request</h2><p>Advertiser: <strong>${adv_name}</strong><br>Amount: <strong>R${Number(total_fee).toFixed(2)}</strong><br>Dates: ${dates.join(', ')}<br>Timeslots: ${slots.join(', ')}<br>Brief: ${brief || 'None'}</p><a href="${FRONTEND_URL}" style="display:inline-block; background:#1A1A1A; color:white; padding:12px 24px; text-decoration:none; border-radius:4px;">Log In & Review</a></div>` });
    res.json({ success: true });
  } catch (e) { console.error('[EMAIL] Error:', e.message); res.status(500).json({ success: false }); }
});

app.post('/api/notify-advertiser', async (req, res) => {
  const { adv_email, adv_name, booking_id, creator_name, total_fee, dates, slots } = req.body;
  if (!adv_email) return res.status(400).json({ success: false });
  try {
    await resend.emails.send({ from: FROM_EMAIL, to: adv_email, subject: `Booking Confirmed: ${creator_name} | R${Number(total_fee).toFixed(2)}`, html: `<div style="font-family:system-ui; padding:20px; max-width:480px; margin:auto; color:#1A1A1A;"><h2>Booking Confirmed</h2><p>Creator: <strong>${creator_name}</strong><br>Amount: <strong>R${Number(total_fee).toFixed(2)}</strong><br>Dates: ${dates.join(', ')}<br>Timeslots: ${slots.join(', ')}</p><a href="${FRONTEND_URL}" style="display:inline-block; background:#1A1A1A; color:white; padding:12px 24px; text-decoration:none; border-radius:4px;">Track Campaign</a></div>` });
    res.json({ success: true });
  } catch (e) { console.error('[EMAIL] Error:', e.message); res.status(500).json({ success: false }); }
});

app.post('/api/notify-status-change', async (req, res) => {
  const { adv_email, adv_name, creator_name, booking_id, status } = req.body;
  if (!adv_email) return res.status(400).json({ success: false });
  try {
    const msg = status === 'confirmed' ? 'has accepted your booking.' : 'has declined your booking. Please try another creator.';
    await resend.emails.send({ from: FROM_EMAIL, to: adv_email, subject: `Booking Update: ${booking_id}`, html: `<div style="font-family:system-ui; padding:20px; max-width:480px; margin:auto; color:#1A1A1A;"><h2>Booking Status Update</h2><p><strong>${creator_name}</strong> ${msg}</p><a href="${FRONTEND_URL}" style="display:inline-block; background:#1A1A1A; color:white; padding:12px 24px; text-decoration:none; border-radius:4px;">View Dashboard</a></div>` });
    res.json({ success: true });
  } catch (e) { console.error('[EMAIL] Error:', e.message); res.status(500).json({ success: false }); }
});

// ==========================================
// SERVER START
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[SERVER] Running on port ${PORT}`));
