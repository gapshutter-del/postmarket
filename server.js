/**
 * PostMarket Backend — Production Server
 * Handles auth, bookings, notifications, and Resend email delivery
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://postnstatusmarket.co.za';

// Validate critical env vars on startup
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}
if (!RESEND_API_KEY) {
  console.warn('[WARN] RESEND_API_KEY not set — email sending will fail');
}

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// FROM_EMAIL must match your verified sending domain in Resend
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@postnstatusmarket.co.za';

// In-memory OTP store (for demo; use Redis in production)
const otpStore = {};

// ==================== MIDDLEWARE ====================
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Request logging middleware (with request ID for correlation)
app.use((req, res, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  req.requestId = requestId;
  console.log(`[${requestId}] ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    requestId: req.requestId,
    env: {
      SUPABASE_URL: !!SUPABASE_URL,
      RESEND_API_KEY: !!RESEND_API_KEY,
      FROM_EMAIL
    }
  });
});

// ==================== AUTH ENDPOINTS ====================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const requestId = req.requestId;
  const { email, password } = req.body;
  
  console.log(`[${requestId}] Login attempt for: ${email}`);
  
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required', requestId });
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
      console.log(`[${requestId}] Login failed for ${email}: invalid credentials`);
      return res.status(401).json({ success: false, message: 'Invalid email or password', requestId });
    }

    // Remove sensitive fields
    const { password: _, ...safeUser } = user;
    console.log(`[${requestId}] Login successful for ${email}`);
    res.json({ success: true, user: safeUser, requestId });
    
  } catch (err) {
    console.error(`[${requestId}] Login error:`, err.message);
    res.status(500).json({ success: false, message: 'Server error during login', requestId });
  }
});

// POST /api/auth/send-otp — FIXED: awaits Resend, logs everything, returns correct status
app.post('/api/auth/send-otp', async (req, res) => {
  const requestId = req.requestId;
  console.log(`[${requestId}] POST /api/auth/send-otp - Request received`);

  const { email } = req.body;
  console.log(`[${requestId}] Email: ${email}`);

  // 1. Validate the email format
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.log(`[${requestId}] Validation failed`);
    return res.status(400).json({ 
      success: false, 
      error: 'Valid email required', 
      requestId 
    });
  }

  // 2. Generate a 6-digit OTP and store it temporarily
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email.toLowerCase()] = { otp, expires: Date.now() + 600000 };
  console.log(`[${requestId}] OTP generated & stored`);

  // 3. Check if Resend API key is configured correctly
  const hasResendKey = !!process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.startsWith('re_');
  console.log(`[${requestId}] RESEND_API_KEY exists: ${hasResendKey}`);

  if (!hasResendKey) {
    console.error(`[${requestId}] RESEND_API_KEY missing or invalid. Aborting.`);
    return res.status(502).json({ 
      success: false, 
      error: 'Email service misconfigured', 
      requestId 
    });
  }

  // 4. Send the email via Resend (THIS IS THE FIX: await + isolated try/catch)
  try {
    console.log(`[${requestId}] Awaiting resend.emails.send()`);
    
    // This line BLOCKS until Resend responds. No more fire-and-forget.
    const response = await resend.emails.send({
      from: `PostMarket <${FROM_EMAIL}>`,
      to: email,
      subject: 'PostMarket Verification Code',
      html: `
        <div style="font-family:system-ui,sans-serif;padding:24px;max-width:500px;margin:auto;background:#fff;border:1px solid #eee;border-radius:8px;">
          <h2 style="margin:0 0 16px;color:#1A1A1A;">Verify Your Identity</h2>
          <p style="margin:0 0 24px;color:#5A5A5A;">Your verification code:</p>
          <div style="font-size:28px;font-weight:700;letter-spacing:6px;text-align:center;padding:16px;background:#f7f2ea;border-radius:6px;color:#1A1A1A;">${otp}</div>
          <p style="font-size:12px;color:#8E8E8E;margin:16px 0 0;text-align:center;">Valid for 10 minutes. If you did not request this, ignore it.</p>
        </div>`
    });

    // Log Resend's response for debugging
    console.log(`[${requestId}] Resend response: ${JSON.stringify(response)}`);

    // Only return success if Resend gave us a message ID
    if (response?.id) {
      console.log(`[${requestId}] Email queued. Message ID: ${response.id}`);
      return res.json({ 
        success: true, 
        message: 'OTP sent', 
        requestId 
      });
    } else {
      console.error(`[${requestId}] Resend acknowledged but returned no ID.`, response);
      return res.status(502).json({ 
        success: false, 
        error: 'Email service returned unexpected response', 
        requestId 
      });
    }
    
  } catch (err) {
    // Log the exact error from Resend
    console.error(`[${requestId}] Resend API Exception: ${err.name} - ${err.message}`);
    
    return res.status(500).json({
      success: false,
      error: 'Failed to send verification email',
      // Only show error details in non-production to avoid leaking info
      details: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      requestId
    });
  }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  const requestId = req.requestId;
  const { email, otp } = req.body;
  
  console.log(`[${requestId}] OTP verification attempt for: ${email}`);
  
  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP required', requestId });
  }
  
  const key = email.toLowerCase();
  const record = otpStore[key];
  
  if (!record) {
    console.log(`[${requestId}] OTP verification failed for ${email}: no record found`);
    return res.status(400).json({ success: false, message: 'OTP expired or not found', requestId });
  }
  
  if (Date.now() > record.expires) {
    delete otpStore[key];
    console.log(`[${requestId}] OTP verification failed for ${email}: expired`);
    return res.status(400).json({ success: false, message: 'OTP expired', requestId });
  }
  
  if (record.otp !== otp) {
    console.log(`[${requestId}] OTP verification failed for ${email}: mismatch`);
    return res.status(400).json({ success: false, message: 'Invalid OTP', requestId });
  }
  
  // OTP valid — proceed to profile completion (handled by frontend)
  delete otpStore[key];
  console.log(`[${requestId}] OTP verified for ${email}`);
  res.json({ success: true, requestId });
});

// POST /api/auth/signup — Create new user after OTP verification
app.post('/api/auth/signup', async (req, res) => {
  const requestId = req.requestId;
  const { 
    type, email, password, name, 
    // Creator-specific fields
    niche, audience_desc, platforms, total_reach, rate, sa_id, payout_method, wallet_id,
    // Advertiser-specific fields
    company_name
  } = req.body;
  
  console.log(`[${requestId}] Signup attempt for: ${email} (${type})`);
  
  if (!type || !email || !password || !name) {
    return res.status(400).json({ success: false, message: 'Missing required fields', requestId });
  }
  
  // Check for existing user
  const { data: existing } = await supabase
    .from('users')
    .select('ref')
    .eq('email', email.toLowerCase())
    .single();
    
  if (existing) {
    return res.status(409).json({ success: false, message: 'Email already registered', requestId });
  }
  
  // Generate unique reference ID
  const ref = 'usr_' + Math.random().toString(36).substring(2, 10);
  
  // Prepare user record
  const userRecord = {
    ref,
    type,
    email: email.toLowerCase(),
    password, // In production, hash this with bcrypt
    name,
    status: 'active',
    created_at: new Date().toISOString()
  };
  
  // Add creator-specific fields
  if (type === 'creator') {
    if (!sa_id || sa_id.length !== 13) {
      return res.status(400).json({ success: false, message: 'Valid 13-digit SA ID required', requestId });
    }
    if (!platforms || Object.keys(platforms).length === 0) {
      return res.status(400).json({ success: false, message: 'At least one platform required', requestId });
    }
    Object.assign(userRecord, {
      niche,
      audience_desc,
      platforms: JSON.stringify(platforms), // Store as JSONB
      total_reach,
      rate,
      sa_id,
      payout_method,
      wallet_id
    });
  }
  
  // Add advertiser-specific fields
  if (type === 'advertiser' && company_name) {
    userRecord.company_name = company_name;
  }
  
  try {
    const { data: newUser, error } = await supabase
      .from('users')
      .insert([userRecord])
      .select()
      .single();
      
    if (error) {
      console.error(`[${requestId}] Signup error:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to create account', requestId });
    }
    
    // Remove sensitive fields from response
    const { password: _, ...safeUser } = newUser;
    console.log(`[${requestId}] Signup successful for ${email} (ref: ${ref})`);
    res.json({ success: true, user: safeUser, requestId });
    
  } catch (err) {
    console.error(`[${requestId}] Signup exception:`, err.message);
    res.status(500).json({ success: false, message: 'Server error during signup', requestId });
  }
});

// ==================== BOOKING ENDPOINTS ====================

// POST /api/bookings/create
app.post('/api/bookings/create', async (req, res) => {
  const requestId = req.requestId;
  const { 
    creator_ref, advertiser_ref, platforms, slots, dates, 
    total_fee, creator_payout, campaign_brief, campaign_assets 
  } = req.body;
  
  console.log(`[${requestId}] Booking creation attempt`);
  
  if (!creator_ref || !advertiser_ref || !slots?.length || !dates?.length) {
    return res.status(400).json({ success: false, message: 'Missing required booking fields', requestId });
  }
  
  const bookingId = 'BK-' + Date.now().toString(36).toUpperCase();
  
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .insert([{
        id: bookingId,
        creator_ref,
        advertiser_ref,
        platforms: JSON.stringify(platforms),
        slots: JSON.stringify(slots),
        dates: JSON.stringify(dates),
        total_fee,
        creator_payout,
        status: 'provisional',
        campaign_brief,
        campaign_assets,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();
      
    if (error) {
      console.error(`[${requestId}] Create booking error:`, error.message);
      return res.status(500).json({ success: false, message: 'Failed to create booking', requestId });
    }
    
    console.log(`[${requestId}] Created booking ${bookingId} for creator ${creator_ref}`);
    res.json({ success: true, booking, requestId });
    
  } catch (err) {
    console.error(`[${requestId}] Create booking exception:`, err.message);
    res.status(500).json({ success: false, message: 'Server error', requestId });
  }
});

// POST /api/bookings/:id/accept
app.post('/api/bookings/:id/accept', async (req, res) => {
  const requestId = req.requestId;
  const { id } = req.params;
  
  console.log(`[${requestId}] Accept booking attempt: ${id}`);
  
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
      
    if (error || !booking) {
      return res.status(404).json({ success: false, message: 'Booking not found', requestId });
    }
    
    console.log(`[${requestId}] Accepted booking ${id}`);
    res.json({ success: true, booking, requestId });
    
  } catch (err) {
    console.error(`[${requestId}] Accept booking exception:`, err.message);
    res.status(500).json({ success: false, message: 'Server error', requestId });
  }
});

// ==================== NOTIFICATION ENDPOINTS ====================

// POST /api/notify-creator — Called after booking creation
app.post('/api/notify-creator', async (req, res) => {
  const requestId = req.requestId;
  const { creator_email, creator_name, adv_name, booking_id, dates, slots, total_fee, brief } = req.body;
  
  console.log(`[${requestId}] Notify creator attempt: ${creator_email}`);
  
  if (!RESEND_API_KEY || !resend) {
    console.warn(`[${requestId}] Skipping creator notification — Resend not configured`);
    return res.json({ success: true, skipped: true, requestId });
  }
  
  try {
    const response = await resend.emails.send({
      from: `PostMarket <${FROM_EMAIL}>`,
      to: creator_email,
      subject: `New Booking Request: ${booking_id}`,
      html: `
        <div style="font-family: system-ui, sans-serif; padding: 24px; max-width: 600px; margin: auto;">
          <h2 style="color: #1A1A1A;">New Booking Request</h2>
          <p><strong>Advertiser:</strong> ${adv_name}</p>
          <p><strong>Booking ID:</strong> ${booking_id}</p>
          <p><strong>Dates:</strong> ${dates.join(', ')}</p>
          <p><strong>Timeslots:</strong> ${slots.join(', ')}</p>
          <p><strong>Total Fee:</strong> R${total_fee}</p>
          ${brief ? `<p><strong>Brief:</strong><br>${brief}</p>` : ''}
          <p style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee;">
            <a href="${FRONTEND_URL}" style="background: #1A1A1A; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">View in Dashboard</a>
          </p>
        </div>`
    });
    
    console.log(`[${requestId}] Creator notification sent to ${creator_email}. Message ID: ${response?.id}`);
    res.json({ success: true, messageId: response?.id, requestId });
    
  } catch (err) {
    console.error(`[${requestId}] Failed to send creator notification:`, err.message);
    // Don't fail the booking if notification fails
    res.json({ success: true, warning: 'Notification failed but booking created', requestId });
  }
});

// POST /api/notify-status-change — Called when booking status changes
app.post('/api/notify-status-change', async (req, res) => {
  const requestId = req.requestId;
  const { adv_email, adv_name, creator_name, booking_id, status } = req.body;
  
  console.log(`[${requestId}] Notify status change attempt: ${adv_email}`);
  
  if (!RESEND_API_KEY || !resend) {
    console.warn(`[${requestId}] Skipping status notification — Resend not configured`);
    return res.json({ success: true, skipped: true, requestId });
  }
  
  try {
    const response = await resend.emails.send({
      from: `PostMarket <${FROM_EMAIL}>`,
      to: adv_email,
      subject: `Booking Update: ${booking_id} — ${status.toUpperCase()}`,
      html: `
        <div style="font-family: system-ui, sans-serif; padding: 24px; max-width: 600px; margin: auto;">
          <h2 style="color: #1A1A1A;">Booking Status Updated</h2>
          <p><strong>Booking ID:</strong> ${booking_id}</p>
          <p><strong>Creator:</strong> ${creator_name}</p>
          <p><strong>New Status:</strong> <span style="background: #e8f5e9; color: #2e7d32; padding: 4px 8px; border-radius: 4px;">${status}</span></p>
          <p style="margin-top: 24px;">
            <a href="${FRONTEND_URL}" style="background: #1A1A1A; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">View Details</a>
          </p>
        </div>`
    });
    
    console.log(`[${requestId}] Advertiser notification sent to ${adv_email}. Message ID: ${response?.id}`);
    res.json({ success: true, messageId: response?.id, requestId });
    
  } catch (err) {
    console.error(`[${requestId}] Failed to send status notification:`, err.message);
    res.json({ success: true, warning: 'Notification failed', requestId });
  }
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  console.error(`[${requestId}] Unhandled exception:`, err.message);
  res.status(500).json({ success: false, message: 'Internal server error', requestId });
});

// 404 handler
app.use((req, res) => {
  const requestId = req.requestId || 'unknown';
  console.log(`[${requestId}] 404: ${req.method} ${req.path}`);
  res.status(404).json({ success: false, message: 'Endpoint not found', requestId });
});

// ==================== START SERVER ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
  console.log(`📧 FROM_EMAIL: ${FROM_EMAIL}`);
  console.log(`🔑 RESEND_API_KEY configured: ${!!RESEND_API_KEY}`);
  console.log(`🗄️ Supabase URL: ${SUPABASE_URL?.substring(0, 30)}...\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Received SIGTERM, closing server...');
  process.exit(0);
});
