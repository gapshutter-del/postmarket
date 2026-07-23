   require('dotenv').config();
   const express = require('express');
   const cors = require('cors');
   const { createClient } = require('@supabase/supabase-js');
   const axios = require('axios');
   const crypto = require('crypto');

   const app = express();
   app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
   app.use(express.json());
   app.use(express.urlencoded({ extended: true })); // Required for PayFast ITN

   // Initialize Supabase with SERVICE ROLE KEY
   const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

   // In-memory OTP store (Use Redis/DB for high-scale production)
   const otpStore = {};

   // ==========================================
   // 1. WHATSAPP OTP ENDPOINTS
   // ==========================================
   app.post('/api/auth/send-otp', async (req, res) => {
     const { phone } = req.body;
     if (!phone) return res.status(400).json({ success: false, message: "Phone number required" });

     const otp = Math.floor(100000 + Math.random() * 900000).toString();
     otpStore[phone] = { code: otp, expires: Date.now() + 300000 }; // 5 min expiry

     try {
       await axios.post(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
         messaging_product: "whatsapp",
         to: phone,
         type: "template",
         template: {
           name: "postmarket_otp", 
           language: { code: "en" },
           components: [{ type: "body", parameters: [{ type: "text", text: otp }] }]
         }
       }, {
         headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` }
       });
       res.json({ success: true, message: "OTP sent via WhatsApp API." });
     } catch (error) {
       console.error("Meta API Error:", error.response?.data || error.message);
       res.status(500).json({ success: false, message: "Failed to send WhatsApp message." });
     }
   });

   app.post('/api/auth/verify-otp', (req, res) => {
     const { phone, otp } = req.body;
     const stored = otpStore[phone];

     if (!stored) return res.json({ success: false, message: "Please request a new code." });
     if (Date.now() > stored.expires) {
       delete otpStore[phone];
       return res.json({ success: false, message: "Code has expired." });
     }
     if (stored.code !== otp) return res.json({ success: false, message: "Invalid code." });

     delete otpStore[phone];
     res.json({ success: true, message: "Verified successfully." });
   });

   // ==========================================
   // 2. PAYFAST ITN WEBHOOK
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
         const { error } = await supabase
           .from('bookings')
           .update({ status: 'confirmed', paid_at: new Date().toISOString() })
           .eq('id', bookingRef);
         if (error) throw error;
         console.log(`Payment confirmed for booking: ${bookingRef}`);
       } catch (err) {
         console.error("Database update error:", err);
       }
     }
     res.status(200).send('OK');
   });

   // ==========================================
   // 3. HEALTH CHECK
   // ==========================================
   app.get('/api/health', (req, res) => {
     res.json({ status: 'alive', message: 'PostMarket Backend is running' });
   });

   const PORT = process.env.PORT || 3000;
   app.listen(PORT, () => {
     console.log(`PostMarket Backend running on port ${PORT}`);
   });
