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

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = 'PostMarket <no-reply@postnstatusmarket.co.za>';
const FRONTEND_URL = 'https://postnstatusmarket.co.za';
const otpStore = {};

app.get('/api/health', (req, res) => res.json({ status: 'alive', version: '3.0.0' }));

app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email.toLowerCase()] = { otp, expires: Date.now() + 600000 };

  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: email, subject: `Your PostMarket Verification Code`,
      html: `<div style="font-family: 'Inter', sans-serif; color: #1A1A1A; max-width: 500px; margin: auto; padding: 40px 20px;">
        <h1 style="font-family: 'Playfair Display', serif; font-size: 24px; margin-bottom: 20px;">Verify Your Identity</h1>
        <p style="line-height: 1.6; color: #5A5A5A;">To ensure the security of your account, please use the following six-digit code to complete your verification. This code will expire in ten minutes.</p>
        <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; text-align: center; padding: 24px; background: #f7f2ea; border-radius: 4px; color: #1A1A1A; margin: 30px 0;">${otp}</div>
        <p style="font-size: 12px; color: #94A3B8; margin-top: 40px; text-align: center;">PostMarket is a Sole Proprietorship operated by PB Brantley. Arcon Park, Vereeniging.</p>
      </div>`
    });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, message: 'Failed to send email' }); }
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const stored = otpStore[email?.toLowerCase()];
  if (!stored) return res.json({ success: false, message: 'No OTP found.' });
  if (Date.now() > stored.expires) return res.json({ success: false, message: 'Code expired.' });
  if (stored.otp !== otp) return res.json({ success: false, message: 'Invalid code.' });
  delete otpStore[email.toLowerCase()];
  res.json({ success: true });
});

app.post('/api/auth/signup', async (req, res) => {
  const { type, email, password, name, ref, company_name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ success: false, message: 'Missing fields' });
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const newUser = {
      ref: ref || (type === 'creator' ? 'CRT-' : 'ADV-') + Math.floor(100000 + Math.random() * 900000),
      type, name, email, password_hash, status: 'active', company_name: company_name || null,
      platforms: {}, total_reach: 0, rate: 0, joined_at: new Date().toISOString()
    };
    const { error } = await supabase.from('users').insert([newUser]);
    if (error) return res.status(400).json({ success: false, message: error.message });
    delete newUser.password_hash;
    res.json({ success: true, user: newUser });
  } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
  try {
    const { data: user, error } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
    if (error || !user) return res.json({ success: false, message: 'No account found.' });
    if (user.status !== 'active') return res.json({ success: false, message: 'Account is inactive.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.json({ success: false, message: 'Incorrect password.' });
    delete user.password_hash;
    res.json({ success: true, user });
  } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/notify-creator', async (req, res) => {
  const { creator_email, creator_name, adv_name, booking_id, dates, slots, total_fee, brief } = req.body;
  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: creator_email, subject: `New Booking Request: ${booking_id}`,
      html: `<div style="font-family: 'Inter', sans-serif; color: #1A1A1A; max-width: 500px; margin: auto; padding: 40px 20px;">
        <h1 style="font-family: 'Playfair Display', serif; font-size: 24px; margin-bottom: 20px;">New Booking Request</h1>
        <p style="line-height: 1.6; color: #5A5A5A;">Hello ${creator_name}, ${adv_name} has requested to secure your timeslots. Please log in to your dashboard to review the campaign brief and confirm your availability.</p>
        <div style="background: #f7f2ea; padding: 20px; border-radius: 4px; margin: 30px 0; font-size: 14px; color: #1A1A1A;">
          <strong>Reference:</strong> ${booking_id}<br>
          <strong>Remuneration:</strong> R${Number(total_fee).toFixed(2)}<br>
          <strong>Dates:</strong> ${dates.join(', ')}<br>
          <strong>Timeslots:</strong> ${slots.join(', ')}
        </div>
        <a href="${FRONTEND_URL}" style="display: inline-block; background: #1A1A1A; color: white; padding: 14px 24px; text-decoration: none; border-radius: 4px; font-weight: 600;">Access Dashboard</a>
        <p style="font-size: 12px; color: #94A3B8; margin-top: 40px; text-align: center;">PostMarket is a Sole Proprietorship operated by PB Brantley. Arcon Park, Vereeniging.</p>
      </div>`
    });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/notify-status-change', async (req, res) => {
  const { adv_email, adv_name, creator_name, booking_id, status } = req.body;
  const statusText = status === 'confirmed' ? 'has confirmed your booking request.' : 'was unable to accommodate your request at this time.';
  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: adv_email, subject: `Booking Update: ${booking_id}`,
      html: `<div style="font-family: 'Inter', sans-serif; color: #1A1A1A; max-width: 500px; margin: auto; padding: 40px 20px;">
        <h1 style="font-family: 'Playfair Display', serif; font-size: 24px; margin-bottom: 20px;">Booking Status Update</h1>
        <p style="line-height: 1.6; color: #5A5A5A;">Hello ${adv_name}, ${creator_name} ${statusText}</p>
        <a href="${FRONTEND_URL}" style="display: inline-block; background: #1A1A1A; color: white; padding: 14px 24px; text-decoration: none; border-radius: 4px; font-weight: 600;">View Campaigns</a>
        <p style="font-size: 12px; color: #94A3B8; margin-top: 40px; text-align: center;">PostMarket is a Sole Proprietorship operated by PB Brantley. Arcon Park, Vereeniging.</p>
      </div>`
    });
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PostMarket API v3 running on port ${PORT}`));
