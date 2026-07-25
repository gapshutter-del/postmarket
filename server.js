require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

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
const FROM_EMAIL = 'PostMarket <no-reply@send.postnstatusmarket.co.za>';

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

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.path} from ${req.ip}`);
  next();
});

// ==================== HEALTH CHECK ====================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
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
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
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
      console.log(`[AUTH] Login failed for ${email}: invalid credentials`);
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // Remove sensitive fields
    const { password: _, ...safeUser } = user;
    console.log(`[AUTH] Login successful for ${email}`);
    res.json({ success: true, user: safeUser });
    
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// POST /api/auth/send-otp — HEAVILY INSTRUMENTED FOR DEBUGGING
app.post('/api/auth/send-otp', async (req, res) => {
  console.log(`\n[DEBUG] === OTP REQUEST START ===`);
  console.log(`[DEBUG] Timestamp: ${new Date().toISOString()}`);
  
  const { email } = req.body;
  console.log(`[DEBUG] Received email: ${email}`);
  
  // Validation
  if (!email || !email.includes('@')) {
    console.log(`[DEBUG] Validation failed: invalid email`);
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }
  
  // Generate OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email.toLowerCase()] = { otp, expires: Date.now() + 600000 };
  console.log(`[DEBUG] OTP generated and stored for ${email}`);
  
  // Check Resend API Key
  console.log(`[DEBUG] RESEND_API_KEY exists: ${!!RESEND_API_KEY}`);
  console.log(`[DEBUG] RESEND_API_KEY length: ${RESEND_API_KEY ? RESEND_API_KEY.length : 'N/A'}`);
  if (RESEND_API_KEY) {
    console.log(`[DEBUG] RESEND_API_KEY prefix: ${RESEND_API_KEY.substring(0, 4)}...`);
  }
  
  // Check FROM_EMAIL
  console.log(`[DEBUG] FROM_EMAIL: ${FROM_EMAIL}`);
  
  // If no Resend key, return success but log warning (for local dev)
  if (!RESEND_API_KEY || !resend) {
    console.warn(`[DEBUG] Skipping Resend call — no API key configured`);
    console.log(`[DEBUG] OTP for ${email}: ${otp} (DEV MODE)`);
    return res.json({ 
      success: true, 
      devMode: true, 
      message: 'OTP generated (Resend not configured)' 
    });
  }
  
  // Prepare email payload
  const emailPayload = {
    from: FROM_EMAIL,
    to: email,
    subject: 'PostMarket Verification Code',
    html: `
      <div style="font-family: system-ui, sans-serif; padding: 24px; max-width: 500px; margin: auto; background: #fff; border: 1px solid #eee; border-radius: 8px;">
        <h2 style="margin: 0 0 16px; color: #1A1A1A;">Verify Your Identity</h2>
        <p style="margin: 0 0 24px; color: #5A5A5A;">Use this code to continue:</p>
        <div style="font-size: 28px; font-weight: 700; letter-spacing: 6px; text-align: center; padding: 16px; background: #f7f2ea; border-radius: 6px; color: #1A1A1A; margin-bottom: 24px;">${otp}</div>
        <p style="font-size: 12px; color: #8E8E8E; margin: 0; text-align: center;">Valid for 10 minutes. If you did not request this, please ignore.</p>
      </div>`
  };
  
  console.log(`[DEBUG] Email payload prepared.`);
  console.log(`[DEBUG] From: ${emailPayload.from}`);
  console.log(`[DEBUG] To: ${emailPayload.to}`);
  console.log(`[DEBUG] Subject: ${emailPayload.subject}`);
  
  // Attempt to send via Resend
  console.log(`[DEBUG] Calling resend.emails.send()...`);
  
  try {
    const response = await resend.emails.send(emailPayload);
    
    console.log(`[DEBUG] Resend API call completed`);
    console.log(`[DEBUG] Response type: ${typeof response}`);
    console.log(`[DEBUG] Full response: ${JSON.stringify(response, null, 2)}`);
    
    // Check for error property in response (Resend v2+ returns errors in response body)
    if (response && response.error) {
      console.error(`[DEBUG] Resend response contained error:`, response.error);
      return res.status(500).json({ 
        success: false, 
        message: 'Email service error',
        debug: { error: response.error }
      });
    }
    
    // Success: response should contain an `id`
    if (response && response.id) {
      console.log(`[DEBUG] Resend accepted email. Message ID: ${response.id}`);
      console.log(`[DEBUG] OTP sent successfully to ${email}`);
      return res.json({ success: true, messageId: response.id });
    }
    
    // Fallback: if no error and no id, log and return success
    console.warn(`[DEBUG] Resend call completed but response format unexpected:`, response);
    console.log(`[DEBUG] Assuming success for ${email}`);
    return res.json({ success: true });
    
  } catch (err) {
    console.error(`[DEBUG] Exception while sending email:`, err);
    console.error(`[DEBUG] Error name: ${err.name}`);
    console.error(`[DEBUG] Error message: ${err.message}`);
    if (err.stack) {
      console.error(`[DEBUG] Error stack: ${err.stack}`);
    }
    
    // Return helpful error to frontend
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to send verification email',
      debug: { 
        errorName: err.name, 
        errorMessage: err.message,
        // Only include stack in non-production
        errorStack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
      }
    });
  } finally {
    console.log(`[DEBUG] === OTP REQUEST END ===\n`);
  }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP required' });
  }
  
  const key = email.toLowerCase();
  const record = otpStore[key];
  
  if (!record) {
    console.log(`[AUTH] OTP verification failed for ${email}: no record found`);
    return res.status(400).json({ success: false, message: 'OTP expired or not found' });
  }
  
  if (Date.now() > record.expires) {
    delete otpStore[key];
    console.log(`[AUTH] OTP verification failed for ${email}: expired`);
    return res.status(400).json({ success: false, message: 'OTP expired' });
  }
  
  if (record.otp !== otp) {
    console.log(`[AUTH] OTP verification failed for ${email}: mismatch`);
    return res.status(400).json({ success: false, message: 'Invalid OTP' });
  }
  
  // OTP valid — proceed to profile completion (handled by frontend)
  delete otpStore[key];
  console.log(`[AUTH] OTP verified for ${email}`);
  res.json({ success: true });
});

// POST /api/auth/signup — Create new user after OTP verification
app.post('/api/auth/signup', async (req, res) => {
  const { 
    type, email, password, name, 
    // Creator-specific fields
    niche, audience_desc, platforms, total_reach, rate, sa_id, payout_method, wallet_id,
    // Advertiser-specific fields
    company_name
  } = req.body;
  
  if (!type || !email || !password || !name) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  
  // Check for existing user
  const { data: existing } = await supabase
    .from('users')
    .select('ref')
    .eq('email', email.toLowerCase())
    .single();
    
  if (existing) {
    return res.status(409).json({ success: false, message: 'Email already registered' });
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
      return res.status(400).json({ success: false, message: 'Valid 13-digit SA ID required' });
    }
    if (!platforms || Object.keys(platforms).length === 0) {
      return res.status(400).json({ success: false, message: 'At least one platform required' });
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
      console.error('[AUTH] Signup error:', error);
      return res.status(500).json({ success: false, message: 'Failed to create account' });
    }
    
    // Remove sensitive fields from response
    const { password: _, ...safeUser } = newUser;
    console.log(`[AUTH] Signup successful for ${email} (ref: ${ref})`);
    res.json({ success: true, user: safeUser });
    
  } catch (err) {
    console.error('[AUTH] Signup exception:', err);
    res.status(500).json({ success: false, message: 'Server error during signup' });
  }
});

// ==================== BOOKING ENDPOINTS ====================

// POST /api/bookings/create
app.post('/api/bookings/create', async (req, res) => {
  const { 
    creator_ref, advertiser_ref, platforms, slots, dates, 
    total_fee, creator_payout, campaign_brief, campaign_assets 
  } = req.body;
  
  if (!creator_ref || !advertiser_ref || !slots?.length || !dates?.length) {
    return res.status(400).json({ success: false, message: 'Missing required booking fields' });
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
      console.error('[BOOKING] Create error:', error);
      return res.status(500).json({ success: false, message: 'Failed to create booking' });
    }
    
    console.log(`[BOOKING] Created ${bookingId} for creator ${creator_ref}`);
    res.json({ success: true, booking });
    
  } catch (err) {
    console.error('[BOOKING] Create exception:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/bookings/:id/accept
app.post('/api/bookings/:id/accept', async (req, res) => {
  const { id } = req.params;
  
  try {
    const { data: booking, error } = await supabase
      .from('bookings')
      .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
      
    if (error || !booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    
    console.log(`[BOOKING] Accepted ${id}`);
    res.json({ success: true, booking });
    
  } catch (err) {
    console.error('[BOOKING] Accept exception:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== NOTIFICATION ENDPOINTS ====================

// POST /api/notify-creator — Called after booking creation
app.post('/api/notify-creator', async (req, res) => {
  const { creator_email, creator_name, adv_name, booking_id, dates, slots, total_fee, brief } = req.body;
  
  if (!RESEND_API_KEY || !resend) {
    console.warn('[NOTIFY] Skipping creator notification — Resend not configured');
    return res.json({ success: true, skipped: true });
  }
  
  try {
    const response = await resend.emails.send({
      from: FROM_EMAIL,
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
    
    console.log(`[NOTIFY] Creator notification sent to ${creator_email}. Message ID: ${response?.id}`);
    res.json({ success: true, messageId: response?.id });
    
  } catch (err) {
    console.error('[NOTIFY] Failed to send creator notification:', err.message);
    // Don't fail the booking if notification fails
    res.json({ success: true, warning: 'Notification failed but booking created' });
  }
});

// POST /api/notify-status-change — Called when booking status changes
app.post('/api/notify-status-change', async (req, res) => {
  const { adv_email, adv_name, creator_name, booking_id, status } = req.body;
  
  if (!RESEND_API_KEY || !resend) {
    console.warn('[NOTIFY] Skipping status notification — Resend not configured');
    return res.json({ success: true, skipped: true });
  }
  
  try {
    const response = await resend.emails.send({
      from: FROM_EMAIL,
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
    
    console.log(`[NOTIFY] Advertiser notification sent to ${adv_email}. Message ID: ${response?.id}`);
    res.json({ success: true, messageId: response?.id });
    
  } catch (err) {
    console.error('[NOTIFY] Failed to send status notification:', err.message);
    res.json({ success: true, warning: 'Notification failed' });
  }
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('[ERROR] Unhandled exception:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  console.log(`[404] ${req.method} ${req.path}`);
  res.status(404).json({ success: false, message: 'Endpoint not found' });
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
