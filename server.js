require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend'); // NEW: Email provider
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY); // NEW: Initialize Resend

const otpStore = {};

// ==========================================
// 1. EMAIL OTP ENDPOINTS (REPLACED WHATSAPP)
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body; // CHANGED: Now expects email
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: "Valid email required" });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = { code: otp, expires: Date.now() + 600000 }; // 10 min expiry

  try {
    // Send the email via Resend
    const { data, error } = await resend.emails.send({
      from: 'PostMarket <onboarding@resend.dev>', // Resend's default sandbox sender
      to: email,
      subject: 'Your PostMarket Verification Code',
      html: `
        <div style="font-family: sans-serif; padding: 20px; max-width: 500px; margin: auto; border: 1px solid #eee; border-radius: 8px;">
          <h2 style="color: #4F46E5;">PostMarket</h2>
          <p>Welcome to PostMarket! Use the following 6-digit code to verify your account:</p>
          <h1 style="font-size: 32px; letter-spacing: 5px; text-align: center; background: #F1F5F9; padding: 20px; border-radius: 8px;">${otp}</h1>
          <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes. If you didn't request this, please ignore this email.</p>
        </div>
      `
    });

    if (error) {
      console.error("Resend Error:", error);
      return res.status(500).json({ success: false, message: "Failed to send email." });
    }

    // DEV MODE LOG (Keep this just in case)
    console.log(`\n\n🚨 [DEV MODE] The OTP for ${email} is: ${otp} 🚨\n\n`);
    
    res.json({ success: true, message: "OTP sent via Email." });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body; // CHANGED: Now expects email
  const stored = otpStore[email];

  if (!stored) return res.json({ success: false, message: "Please request a new code." });
  if (Date.now() > stored.expires) {
    delete otpStore[email];
    return res.json({ success: false, message: "Code has expired." });
  }
  if (stored.code !== otp) return res.json({ success: false, message: "Invalid code." });

  delete otpStore[email];
  res.json({ success: true, message: "Verified successfully." });
});

// ==========================================
// 2. PAYFAST ITN WEBHOOK (UNCHANGED)
// ==========================================
app.post('/api/payfast/itn', async (req, res) => {
  const data = req.body;
  const paramString = Object.keys(data)
    .filter(key => key !== 'signature')
    .sort()
    .map(key => `${key}=${encodeURIComponent(data[key]).replace(/%20/g, '+')}`)
    .join('&');
  
  const generatedSignature = crypto.createHash('md5').update(paramString + (process.env.PAYFAST_PASSPHRASE || '')).digest('hex');
  
  if (generatedSignature !== data.signature) {
    console.error("PayFast Signature Mismatch!");
    return res.status(400).send('Invalid signature');
  }

  if (data.payment_status === 'COMPLETE') {
    const bookingRef = data.m_payment_id; 
    try {
      await supabase.from('bookings').update({ status: 'confirmed', paid_at: new Date().toISOString() }).eq('id', bookingRef);
      console.log(`Payment confirmed for booking: ${bookingRef}`);
    } catch (err) {
      console.error("Database update error:", err);
    }
  }
  res.status(200).send('OK');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'alive', message: 'PostMarket Backend is running via Email OTP' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PostMarket Backend running on port ${PORT}`);
});
