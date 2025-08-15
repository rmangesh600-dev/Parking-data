require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIRM_KEY = process.env.CONFIRM_KEY || '123456';
const SEND_SMS = String(process.env.SEND_SMS || 'false').toLowerCase() === 'true';
const SEND_EMAIL = String(process.env.SEND_EMAIL || 'false').toLowerCase() === 'true';
const EMAIL_TO = process.env.EMAIL_TO || 'rmangesh600@gmail.com';
const DB_FILE = path.join(__dirname, 'db', 'parkings.json');
if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf8');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Twilio
let smsClient = null;
if(SEND_SMS){
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  if(sid && token){ smsClient = twilio(sid, token); } else console.warn('Twilio creds missing.');
}

// Nodemailer
let mailer = null;
if(SEND_EMAIL){
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_PASS;
  if(user && pass){
    mailer = nodemailer.createTransport({service:'gmail', auth:{user, pass}});
  }else console.warn('Gmail creds missing.');
}

// In-memory OTP store (persist to file occasionally)
const OTP_FILE = path.join(__dirname, 'db', 'otps.json');
let otpStore = {};
if(fs.existsSync(OTP_FILE)) try{ otpStore = JSON.parse(fs.readFileSync(OTP_FILE,'utf8')); }catch(e){ otpStore = {}; }

function saveOtps(){ fs.writeFileSync(OTP_FILE, JSON.stringify(otpStore,null,2)); }
function genOtp(){ return String(Math.floor(100000 + Math.random()*900000)); }

// Utilities
function readDB(){ return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); }
function writeDB(data){ fs.writeFileSync(DB_FILE, JSON.stringify(data,null,2)); }

// API: search & list
app.get('/api/parkings', (req,res)=>{
  const q = (req.query.q||'').toLowerCase();
  const data = readDB().filter(r => !q || r.vehicleNo.toLowerCase().includes(q) || r.mobile.includes(q));
  res.json({count:data.length, data});
});

// Export CSV
app.get('/api/export', (req,res)=>{
  const data = readDB();
  const rows = [['id','vehicleNo','mobile','vehicleType','amount','paidAt','expiresAt','note']];
  data.forEach(r => rows.push([r.id,r.vehicleNo,r.mobile,r.vehicleType,r.amount,r.paidAt,r.expiresAt||'',r.note||'']));
  const csv = rows.map(a=>a.map(s=>`"${String(s).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename=parkings.csv');
  res.send(csv);
});

// Season pass QR creation
app.post('/api/season', (req,res)=>{
  const {vehicleNo, mobile} = req.body||{};
  if(!vehicleNo||!mobile) return res.status(400).json({error:'Missing'});
  // create a short token that links to quick-checkin URL
  const token = uuidv4().split('-')[0];
  const qrUrl = `${req.protocol}://${req.get('host')}/season/${token}`;
  // store season info
  const data = readDB();
  const record = { id: 'season-'+token, vehicleNo, mobile, isSeason:true, token };
  // store in separate file season.json
  const seasonFile = path.join(__dirname,'db','season.json');
  let seasons = [];
  if(fs.existsSync(seasonFile)) seasons = JSON.parse(fs.readFileSync(seasonFile,'utf8'));
  seasons = seasons.filter(s=>s.vehicleNo !== vehicleNo); // replace if exists
  seasons.push(record);
  fs.writeFileSync(seasonFile, JSON.stringify(seasons,null,2));
  res.json({ok:true, qrUrl});
});

// Season quick page (pre-fill)
app.get('/season/:token', (req,res)=>{
  const seasonFile = path.join(__dirname,'db','season.json');
  if(!fs.existsSync(seasonFile)) return res.status(404).send('Not found');
  const seasons = JSON.parse(fs.readFileSync(seasonFile,'utf8'));
  const s = seasons.find(x=>x.token === req.params.token);
  if(!s) return res.status(404).send('Not found');
  // serve a tiny HTML that redirects to home with query params
  const redirect = `/index.html?vehicleNo=${encodeURIComponent(s.vehicleNo)}&mobile=${encodeURIComponent(s.mobile)}&season=1`;
  res.send(`<html><head><meta http-equiv="refresh" content="0;url=${redirect}"/></head><body>Redirecting...</body></html>`);
});

// OTP endpoints
app.post('/api/request-otp', async (req,res)=>{
  const {mobile} = req.body||{};
  if(!mobile) return res.status(400).json({error:'Missing mobile'});
  const otp = genOtp();
  otpStore[mobile] = { otp, createdAt: new Date().toISOString(), attempts:0 };
  saveOtps();
  // send via SMS if configured
  if(smsClient){
    try{
      await smsClient.messages.create({ to: '+91'+mobile, from: process.env.TWILIO_FROM, body: `आपला OTP: ${otp}` });
    }catch(e){ console.warn('SMS failed', e.message); }
  }else{
    console.log('OTP for', mobile, otp);
  }
  res.json({ok:true});
});

app.post('/api/verify-otp', async (req,res)=>{
  try{
    const {vehicleNo,mobile,durationHours,vehicleType,amount,otp,note} = req.body||{};
    if(!vehicleNo||!mobile||!vehicleType||!amount||!otp) return res.status(400).json({error:'Missing fields'});
    const entry = otpStore[mobile];
    if(!entry) return res.status(400).json({error:'OTP not requested'});
    if(entry.attempts >= 5) return res.status(429).json({error:'Too many attempts'});
    if(entry.otp !== otp) { entry.attempts = (entry.attempts||0)+1; saveOtps(); return res.status(400).json({error:'Invalid OTP'}); }
    // OTP ok -> create parking record
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (Number(durationHours||1) * 60 * 60 * 1000)).toISOString();
    const rec = { id: uuidv4(), vehicleNo: String(vehicleNo).toUpperCase(), mobile: String(mobile), vehicleType, amount: Number(amount), note: note||'', paidAt: now.toISOString(), expiresAt };
    const data = readDB(); data.push(rec); writeDB(data);
    // send confirmation SMS/WhatsApp
    const msg = 'आपकी गाड़ी सफलतापूर्वक पार्क हो चुकी है, धन्यवाद।';
    if(smsClient){
      try{ await smsClient.messages.create({ to: '+91'+mobile, from: process.env.TWILIO_FROM, body: msg }); }catch(e){ console.warn('SMS send failed', e.message); }
    }else console.log('SMS would be sent:', msg);
    // send email summary
    if(mailer){
      const html = `<p>नवीन पार्किंग नोंद:</p><ul><li>ID: ${rec.id}</li><li>वाहन: ${rec.vehicleNo}</li><li>मोबाईल: ${rec.mobile}</li><li>रक्कम: ₹${rec.amount}</li><li>एक्पायर: ${rec.expiresAt}</li></ul>`;
      try{ await mailer.sendMail({ from: process.env.GMAIL_USER, to: EMAIL_TO, subject: 'नवीन पार्किंग नोंद', html }); }catch(e){ console.warn('Email failed', e.message); }
    }
    // remove otp
    delete otpStore[mobile]; saveOtps();
    res.json({ok:true, record:rec});
  }catch(e){ console.error(e); res.status(500).json({error:'Server error'}); }
});

// send daily report (can be called manually or scheduled)
app.get('/api/send-daily-report', async (req,res)=>{
  const data = readDB();
  const today = new Date().toISOString().slice(0,10);
  const todayRows = data.filter(r => r.paidAt && r.paidAt.startsWith(today));
  const rows = [['ID','Vehicle','Mobile','Type','Amount','PaidAt','ExpiresAt']];
  todayRows.forEach(r => rows.push([r.id,r.vehicleNo,r.mobile,r.vehicleType,r.amount,r.paidAt,r.expiresAt||'']));
  const csv = rows.map(a=>a.map(s=>`"${String(s).replace(/"/g,'""')}"`).join(',')).join('\n');
  // send email with CSV attachment if mailer available
  if(mailer){
    try{
      await mailer.sendMail({ from: process.env.GMAIL_USER, to: EMAIL_TO, subject: `Daily Parking Report - ${today}`, text: 'See attached CSV', attachments:[{filename:`report-${today}.csv`, content: csv}] });
      return res.json({ok:true});
    }catch(e){ console.warn('Daily report email failed', e.message); return res.status(500).json({error:'Email failed'}); }
  }else{
    return res.json({ok:true, csv});
  }
});

// Scheduler: check for upcoming expiries and send reminders (runs each minute)
setInterval(async ()=>{
  try{
    const data = readDB();
    const now = new Date();
    for(const r of data){
      if(r.reminderSent) continue;
      if(!r.expiresAt) continue;
      const exp = new Date(r.expiresAt);
      const diffMin = (exp - now) / (60*1000);
      // send reminder 15 mins before expiry if within window
      if(diffMin <= 15 && diffMin > 0){
        const text = `आपले पार्किंग वेळ ${Math.round(diffMin)} मिनिटात संपत आहे.`;
        if(smsClient){ try{ await smsClient.messages.create({ to:'+91'+r.mobile, from: process.env.TWILIO_FROM, body: text }); r.reminderSent = true; }catch(e){ console.warn('Reminder failed', e.message); } } else { console.log('Reminder:', text); r.reminderSent = true; }
      }
      // send overstay message if expired and not notified
      if(now > exp && !r.overstayNotified){
        const text = `आपले पार्किंग कालावधी संपला आहे. कृपया तुमची गाडी काढा.`;
        if(smsClient){ try{ await smsClient.messages.create({ to:'+91'+r.mobile, from: process.env.TWILIO_FROM, body: text }); r.overstayNotified = true; }catch(e){ console.warn('Overstay failed', e.message); } } else { console.log('Overstay:', text); r.overstayNotified = true; }
      }
    }
    writeDB(data);
  }catch(e){ console.warn('Scheduler error', e.message); }
}, 60*1000);

// Start server
app.listen(PORT, ()=>console.log('Server on', PORT));