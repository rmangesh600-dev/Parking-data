Updated Railway Parking System
Features:
- OTP-based verification for parking confirmation
- Season-pass QR generation: prefill entry form via /season/:token
- Parking duration stored; reminder 15 min before expiry via SMS (if Twilio configured)
- Overstay notification via SMS
- Admin dashboard with CSV export & manual daily report trigger
- Daily report endpoint /api/send-daily-report which emails CSV if SMTP configured

Run:
1. npm install
2. copy .env.example to .env and fill credentials (TWILIO, GMAIL) if needed
3. npm start
