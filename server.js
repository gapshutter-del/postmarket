/**
 * POSTMARKET BACKEND — PRODUCTION SERVER
 * Handles: Auth, OTP Email Delivery, Bookings, Notifications
 * Runtime: Node.js + Express | DB: Supabase | Email: Resend v2 SDK
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== ENVIRONMENT CONFIGURATION ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://postnstatusmarket.co.za';

// Validate critical dependencies on boot
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

if (!RESEND_API_KEY) {
  console.warn('[WARN] RESEND_API_KEY not set. Email delivery will fail.');
}

// ==================== CLIENT INITIALIZATION ====================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Must match your verified domain in Resend
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@postnstatusmarket.co.za';

// In-memory OTP storage (session-based)
const otpStore = {};

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Request ID correlation middleware
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID().slice(0, 8);
  console.log(`[${req.requestId}] ${req.method} ${req.path} | IP: ${req.ip}`);
  next();
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    services: {
      supabase: !!SUPABASE_URL,
      resend: !!RESEND_API_KEY,
      from_email: FROM_EMAIL
    }
  });
});

// ==================== AUTH ROUTES ====================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const id = req.requestId;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required', requestId: id });
  }

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .eq('password', password)
      .eq('status', 'active')
      .single();

    if (error || !user) {
      console.log(`[${id}] Login failed: ${email}`);
      return res.status(401).json({ success: false, message: 'Invalid credentials', requestId: id });
    }

    const { password: _, ...safeUser } = user;
    console.log(`[${id}] Login success: ${email}`);
    res.json({ success: true, user: safeUser, requestId: id });
  } catch (err) {
    console.error(`[${id}] Login error:`, err.message);
    res.status(500).json({ success: false, message: 'Server error during login', requestId: id });
  }
});

// POST /api/auth/send-otp — PRODUCTION FIXED
app.post('/api/auth/send-otp', async (req, res) => {
  const id = req.requestId;
  console.log(`[${id}] OTP request initiated`);

  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, error: 'Valid email required', requestId: id });
  }

  // Generate & store OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email.toLowerCase()] = { otp, expires: Date.now() + 600000 };
  console.log(`[${id}] OTP generated`);

  // Validate Resend config
  const hasValidKey = !!RESEND_API_KEY && RESEND_API_KEY.startsWith('re_');
  if (!hasValidKey) {
    console.error(`[${id}] RESEND_API_KEY missing or malformed`);
    return res.status(502).json({ success: false, error: 'Email service misconfigured', requestId: id });
  }

  // Send via Resend
  try {
    console.log(`[${id}] Calling resend.emails.send()`);
    const response = await resend.emails.send({
      from: `PostMarket <${FROM_EMAIL}>`,
      to: email,
      subject: 'PostMarket Verification Code',
      html: `
        <div style="font-family:system-ui,sans-serif;padding:24px;max-width:500px;margin:auto;background:#fff;border:1px solid #eee;border-radius:8px;">
          <h2 style="margin:0 0 16px;color:#1A1A1A;">Verify Your Identity</h2>
          <p style="margin:0 0 24px;color:#5A5A5A;">Your verification code:</p>
          <div style="font-size:28px;font-weight:700;letter-spacing:6px;text-align:center;padding:16px;background:#f7f2ea;border-radius:6px;color:#1A1A1A;">${otp}</div>
          <p style="font-size:12px;color:#8E8E8E;margin:16px 0 0;text-align:center;">Valid for 10 minutes. Ignore if not requested.</p>
        </div>`
    });

    console.log(`[${id}] Resend raw response: ${JSON.stringify(response)}`);

    // ✅ FIX: Resend v2 nests the ID inside `response.data.id`
    const messageId = response?.data?.id;
    if (messageId) {
      console.log(`[${id}] ✅ Email queued. ID: ${messageId}`);
      return res.json({ success: true, message: 'OTP sent', requestId: id });
    }

    console.error(`[${id}] ❌ Resend returned no ID.`, response);
    return res.status(502).json({ success: false, error: 'Email service unexpected response', requestId: id });

  } catch (err) {
    console.error(`[${id}] ❌ Resend API Exception: ${err.name} - ${err.message}`);
    return res.status(500).json({
      success: false,
      error: 'Failed to send verification email',
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      requestId: id
    });
  }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  const id = req.requestId;

  if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP required', requestId: id });

  const key = email.toLowerCase();
  const record = otpStore[key];

  if (!record) return res.status(400).json({ success: false, message: 'OTP not found', requestId: id });
  if (Date.now() > record.expires) {
    delete otpStore[key];
    return res.status(400).json({ success: false, message: 'OTP expired', requestId: id });
  }
  if (record.otp !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP', requestId: id });

  delete otpStore[key];
  console.log(`[${id}] ✅ OTP verified for ${email}`);
  res.json({ success: true, requestId: id });
});

// POST /api/auth/signup — FIXED: removed created_at to match Supabase schema
app.post('/api/auth/signup', async (req, res) => {
  const id = req.requestId;
  const { type, email, password, name, niche, audience_desc, platforms, total_reach, rate, sa_id, payout_method, wallet_id, company_name } = req.body;

  if (!type || !email || !password || !name) return res.status(400).json({ success: false, message: 'Missing required fields', requestId: id });

  const { data: existing } = await supabase.from('users').select('ref').eq('email', email.toLowerCase()).single();
  if (existing) return res.status(409).json({ success: false, message: 'Email already registered', requestId: id });

  const ref = 'usr_' + Math.random().toString(36).substring(2, 10);
  
  // ✅ FIX: Removed created_at — Supabase auto-generates it if column exists, or we omit it
  const userRecord = {
    ref, type, email: email.toLowerCase(), password, name, status: 'active'
    // created_at removed — let Supabase handle defaults or add column later
  };

  if (type === 'creator') {
    if (!sa_id || sa_id.length !== 13) return res.status(400).json({ success: false, message: 'Valid 13-digit SA ID required', requestId: id });
    if (!platforms || Object.keys(platforms).length === 0) return res.status(400).json({ success: false, message: 'At least one platform required', requestId: id });
    Object.assign(userRecord, { niche, audience_desc, platforms: JSON.stringify(platforms), total_reach, rate, sa_id, payout_method, wallet_id });
  }
  if (type === 'advertiser' && company_name) userRecord.company_name = company_name;

  try {
    const { data: newUser, error } = await supabase.from('users').insert([userRecord]).select().single();
    if (error) throw error;

    const { password: _, ...safeUser } = newUser;
    console.log(`[${id}] ✅ Signup success: ${email}`);
    res.json({ success: true, user: safeUser, requestId: id });
  } catch (err) {
    console.error(`[${id}] Signup error:`, err.message);
    res.status(500).json({ success: false, message: 'Account creation failed', requestId: id });
  }
});

// ==================== BOOKING ROUTES ====================

// POST /api/bookings/create
app.post('/api/bookings/create', async (req, res) => {
  const id = req.requestId;
  const { creator_ref, advertiser_ref, platforms, slots, dates, total_fee, creator_payout, campaign_brief, campaign_assets } = req.body;

  if (!creator_ref || !advertiser_ref || !slots?.length || !dates?.length) {
    return res.status(400).json({ success: false, message: 'Missing booking fields', requestId: id });
  }

  const bookingId = 'BK-' + Date.now().toString(36).toUpperCase();
  try {
    const { data, error } = await supabase.from('bookings').insert([{
      id: bookingId, creator_ref, advertiser_ref,
      platforms: JSON.stringify(platforms), slots: JSON.stringify(slots), dates: JSON.stringify(dates),
      total_fee, creator_payout, status: 'provisional', campaign_brief, campaign_assets,
      created_at: new Date().toISOString()
    }]).select().single();

    if (error) throw error;
    console.log(`[${id}] ✅ Booking created: ${bookingId}`);
    res.json({ success: true, booking: data, requestId: id });
  } catch (err) {
    console.error(`[${id}] Booking error:`, err.message);
    res.status(500).json({ success: false, message: 'Booking failed', requestId: id });
  }
});

// POST /api/bookings/:id/accept
app.post('/api/bookings/:id/accept', async (req, res) => {
  const { id: bookingId } = req.params;
  const reqId = req.requestId;
  try {
    const { data, error } = await supabase.from('bookings').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', bookingId).select().single();
    if (error || !data) return res.status(404).json({ success: false, message: 'Booking not found', requestId: reqId });
    console.log(`[${reqId}] ✅ Booking accepted: ${bookingId}`);
    res.json({ success: true, booking: data, requestId: reqId });
  } catch (err) {
    console.error(`[${reqId}] Accept error:`, err.message);
    res.status(500).json({ success: false, message: 'Server error', requestId: reqId });
  }
});

// ==================== NOTIFICATION ROUTES ====================

// POST /api/notify-creator
app.post('/api/notify-creator', async (req, res) => {
  const { creator_email, creator_name, adv_name, booking_id, dates, slots, total_fee, brief } = req.body;
  const id = req.requestId;
  if (!RESEND_API_KEY || !resend) return res.json({ success: true, skipped: true, requestId: id });

  try {
    const response = await resend.emails.send({
      from: `PostMarket <${FROM_EMAIL}>`,
      to: creator_email,
      subject: `New Booking Request: ${booking_id}`,
      html: `<div style="font-family:system-ui;padding:24px;max-width:600px;"><h2>New Booking Request</h2><p><b>Advertiser:</b> ${adv_name}</p><p><b>ID:</b> ${booking_id}</p><p><b>Dates:</b> ${dates.join(', ')}</p><p><b>Slots:</b> ${slots.join(', ')}</p><p><b>Fee:</b> R${total_fee}</p>${brief ? `<p><b>Brief:</b><br>${brief}</p>` : ''}</div>`
    });
    console.log(`[${id}] ✅ Creator notified: ${creator_email} | ID: ${response?.data?.id}`);
    res.json({ success: true, messageId: response?.data?.id, requestId: id });
  } catch (err) {
    console.error(`[${id}] Notify creator failed:`, err.message);
    res.json({ success: true, warning: 'Notification skipped', requestId: id });
  }
});

// POST /api/notify-status-change
app.post('/api/notify-status-change', async (req, res) => {
  const { adv_email, adv_name, creator_name, booking_id, status } = req.body;
  const id = req.requestId;
  if (!RESEND_API_KEY || !resend) return res.json({ success: true, skipped: true, requestId: id });

  try {
    const response = await resend.emails.send({
      from: `PostMarket <${FROM_EMAIL}>`,
      to: adv_email,
      subject: `Booking Update: ${booking_id} — ${status.toUpperCase()}`,
      html: `<div style="font-family:system-ui;padding:24px;max-width:600px;"><h2>Booking Status Updated</h2><p><b>ID:</b> ${booking_id}</p><p><b>Creator:</b> ${creator_name}</p><p><b>Status:</b> ${status}</p></div>`
    });
    console.log(`[${id}] ✅ Advertiser notified: ${adv_email} | ID: ${response?.data?.id}`);
    res.json({ success: true, messageId: response?.data?.id, requestId: id });
  } catch (err) {
    console.error(`[${id}] Notify status failed:`, err.message);
    res.json({ success: true, warning: 'Notification skipped', requestId: id });
  }
});

// ==================== ERROR HANDLING & STARTUP ====================
app.use((err, req, res, next) => {
  const id = req.requestId || 'unknown';
  console.error(`[${id}] Unhandled exception:`, err.message);
  res.status(500).json({ success: false, message: 'Internal server error', requestId: id });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found', requestId: req.requestId });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ POSTMARKET SERVER ONLINE`);
  console.log(`🌐 Frontend: ${FRONTEND_URL}`);
  console.log(`📧 FROM: ${FROM_EMAIL}`);
  console.log(`🔑 Resend: ${!!RESEND_API_KEY ? 'CONFIGURED' : 'MISSING'}`);
  console.log(`🗄️  Supabase: ${SUPABASE_URL ? 'CONNECTED' : 'MISSING'}\n`);
});

process.on('SIGTERM', () => { console.log('[SHUTDOWN] Graceful exit'); process.exit(0); });
