'use strict';
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

async function sendApprovalEmail(org) {
  if (!process.env.MAIL_USER) return;
  try {
    await mailer.sendMail({
      from: '"XerisVote" <' + process.env.MAIL_USER + '>',
      to: org.email,
      subject: '✅ Your XerisVote Organisation Has Been Approved!',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#020408;color:#e2e8f0;padding:32px;border-radius:16px;">
          <h2 style="color:#00b4ff;margin-bottom:8px;">Welcome to XerisVote! ⚡</h2>
          <p style="color:#718096;margin-bottom:24px;">Your organisation <b style="color:#fff;">${org.name}</b> has been approved.</p>
          <div style="background:#070d14;border:1px solid rgba(0,180,255,0.2);border-radius:12px;padding:20px;margin-bottom:24px;">
            <p style="font-size:12px;color:#718096;margin-bottom:8px;">YOUR API KEY</p>
            <p style="font-family:monospace;font-size:16px;color:#00e5ff;word-break:break-all;">${org.apiKey}</p>
          </div>
          <p style="color:#718096;margin-bottom:16px;">Use this key to login to your dashboard:</p>
          <a href="https://xeris-vote-production.up.railway.app/org.html" style="background:linear-gradient(135deg,#00b4ff,#0066ff);color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;">Open Dashboard →</a>
          <p style="color:#4a6080;font-size:12px;margin-top:24px;">Keep your API key safe. Do not share it publicly.</p>
        </div>
      `
    });
    console.log('[Mail] Approval email sent to', org.email);
  } catch(e) {
    console.error('[Mail] Failed to send email:', e.message);
  }
}

const app = express();
app.use(express.json());
app.use(cors());
app.use(require('express').static('public'));

const PORT = process.env.PORT || 3000;
const SUPER_ADMIN_KEY = process.env.ADMIN_KEY || 'xeris-vote-admin-2026';

// ── Schemas ───────────────────────────────────────────────────────────────────
const orgSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  name: String,
  email: String,
  wallet: String,
  description: String,
  website: String,
  apiKey: { type: String, unique: true },
  status: { type: String, enum: ['pending', 'approved', 'suspended'], default: 'pending' },
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
  pollCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const pollSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  orgId: { type: String, default: 'superadmin' },
  orgName: { type: String, default: 'XerisVote' },
  title: String,
  description: String,
  type: { type: String, enum: ['referendum', 'election', 'dao', 'org'] },
  candidates: [{ id: String, name: String, description: String, votes: { type: Number, default: 0 } }],
  tier: { type: String, enum: ['civil', 'dao', 'org'] },
  minTokenBalance: { type: Number, default: 0 },
  tokenAddress: String,
  whitelistedWallets: [String],
  startTime: Date,
  endTime: Date,
  status: { type: String, enum: ['pending', 'active', 'ended'], default: 'pending' },
  createdBy: String,
  totalVotes: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const voteSchema = new mongoose.Schema({
  pollId: String,
  voterWallet: String,
  candidateId: String,
  txHash: String,
  timestamp: { type: Date, default: Date.now },
  tier: String
});

const voterSchema = new mongoose.Schema({
  wallet: { type: String, unique: true },
  tier: { type: String, enum: ['civil', 'dao', 'org'] },
  verified: { type: Boolean, default: false },
  verifiedBy: String,
  orgId: String,
  registeredAt: { type: Date, default: Date.now }
});

const Org = mongoose.model('Org', orgSchema);
const Poll = mongoose.model('Poll', pollSchema);
const Vote = mongoose.model('Vote', voteSchema);
const Voter = mongoose.model('Voter', voterSchema);

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('MongoDB connected'))
  .catch(err => { console.error('MongoDB error:', err.message); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function genId() { return Math.random().toString(36).slice(2, 10); }
function genApiKey() { return 'xv_' + crypto.randomBytes(24).toString('hex'); }

async function getXrsBalance(wallet) {
  try {
    const r = await fetch('http://138.197.116.81:50008/v2/account/' + wallet);
    const d = await r.json();
    return d && d.data ? (d.data.balance_xrs || 0) : 0;
  } catch(e) { return 0; }
}

async function verifyWalletEligibility(wallet, poll) {
  if (poll.tier === 'civil') {
    const voter = await Voter.findOne({ wallet, verified: true });
    return !!voter;
  }
  if (poll.tier === 'dao') {
    const bal = await getXrsBalance(wallet);
    return bal >= (poll.minTokenBalance || 1);
  }
  if (poll.tier === 'org') {
    return poll.whitelistedWallets.includes(wallet);
  }
  return false;
}

// Middleware: verify org API key
async function authOrg(req, res, next) {
  const key = req.headers['x-api-key'] || req.body?.apiKey;
  if (!key) return res.status(401).json({ error: 'API key required' });
  if (key === SUPER_ADMIN_KEY) { req.org = { id: 'superadmin', name: 'XerisVote', isSuperAdmin: true }; return next(); }
  const org = await Org.findOne({ apiKey: key, status: 'approved' });
  if (!org) return res.status(401).json({ error: 'Invalid or unauthorized API key' });
  req.org = org;
  next();
}

// ── PUBLIC ROUTES ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/polls', async (req, res) => {
  try {
    const polls = await Poll.find().sort({ createdAt: -1 });
    res.json(polls);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/polls/:id', async (req, res) => {
  try {
    const poll = await Poll.findOne({ id: req.params.id });
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    res.json(poll);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/polls/:id/results', async (req, res) => {
  try {
    const poll = await Poll.findOne({ id: req.params.id });
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const results = poll.candidates.map(c => ({
      id: c.id, name: c.name, votes: c.votes,
      percentage: poll.totalVotes > 0 ? ((c.votes / poll.totalVotes) * 100).toFixed(1) : '0'
    })).sort((a, b) => b.votes - a.votes);
    res.json({ pollId: poll.id, title: poll.title, totalVotes: poll.totalVotes, results, status: poll.status, orgName: poll.orgName });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/vote', async (req, res) => {
  try {
    const { pollId, voterWallet, candidateId, signature } = req.body;
    if (!pollId || !voterWallet || !candidateId) return res.status(400).json({ error: 'Missing fields' });
    const poll = await Poll.findOne({ id: pollId });
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    if (poll.status !== 'active') return res.status(400).json({ error: 'Poll not active' });
    if (new Date() > poll.endTime) return res.status(400).json({ error: 'Poll ended' });
    const eligible = await verifyWalletEligibility(voterWallet, poll);
    if (!eligible) return res.status(403).json({ error: 'Wallet not eligible to vote' });
    const existing = await Vote.findOne({ pollId, voterWallet });
    if (existing) return res.status(400).json({ error: 'Already voted' });
    const candidate = poll.candidates.find(c => c.id === candidateId);
    if (!candidate) return res.status(400).json({ error: 'Invalid candidate' });
    await Vote.create({ pollId, voterWallet, candidateId, txHash: signature || '', tier: poll.tier });
    await Poll.updateOne(
      { id: pollId, 'candidates.id': candidateId },
      { $inc: { 'candidates.$.votes': 1, totalVotes: 1 } }
    );
    res.json({ success: true, message: 'Vote cast successfully' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/voters/:wallet/eligible/:pollId', async (req, res) => {
  try {
    const poll = await Poll.findOne({ id: req.params.pollId });
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const eligible = await verifyWalletEligibility(req.params.wallet, poll);
    const voted = await Vote.findOne({ pollId: req.params.pollId, voterWallet: req.params.wallet });
    res.json({ eligible, voted: !!voted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ORG REGISTRATION ──────────────────────────────────────────────────────────
app.post('/org/register', async (req, res) => {
  try {
    const { name, email, wallet, description, website } = req.body;
    if (!name || !email || !wallet) return res.status(400).json({ error: 'Name, email and wallet required' });
    const existing = await Org.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const org = new Org({
      id: genId(), name, email, wallet, description, website,
      apiKey: genApiKey(), status: 'pending'
    });
    await org.save();
    res.json({ success: true, message: 'Registration submitted! Await admin approval.', orgId: org.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/org/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });
    const org = await Org.findOne({ apiKey });
    if (!org) return res.status(404).json({ error: 'Invalid API key' });
    if (org.status === 'pending') return res.status(403).json({ error: 'Account pending approval' });
    if (org.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
    res.json({ success: true, org: { id: org.id, name: org.name, email: org.email, status: org.status, plan: org.plan, pollCount: org.pollCount } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ORG POLL MANAGEMENT ───────────────────────────────────────────────────────
app.post('/org/polls', authOrg, async (req, res) => {
  try {
    const { title, description, type, tier, candidates, startTime, endTime,
            minTokenBalance, tokenAddress, whitelistedWallets, creatorWallet } = req.body;
    if (!title || !candidates || !startTime || !endTime) return res.status(400).json({ error: 'Missing required fields' });
    if (candidates.length < 2) return res.status(400).json({ error: 'Need at least 2 candidates' });
    const poll = new Poll({
      id: genId(), orgId: req.org.id, orgName: req.org.name,
      title, description, type, tier, candidates,
      startTime: new Date(startTime), endTime: new Date(endTime),
      minTokenBalance, tokenAddress,
      whitelistedWallets: whitelistedWallets || [],
      status: 'pending', createdBy: creatorWallet
    });
    await poll.save();
    if (!req.org.isSuperAdmin) await Org.updateOne({ id: req.org.id }, { $inc: { pollCount: 1 } });
    res.json({ success: true, poll });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/org/polls', authOrg, async (req, res) => {
  try {
    const filter = req.org.isSuperAdmin ? {} : { orgId: req.org.id };
    const polls = await Poll.find(filter).sort({ createdAt: -1 });
    res.json(polls);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/org/voters/register', authOrg, async (req, res) => {
  try {
    const { wallet, tier } = req.body;
    if (!wallet) return res.status(400).json({ error: 'Wallet required' });
    await Voter.findOneAndUpdate(
      { wallet },
      { wallet, tier: tier || 'civil', verified: true, verifiedBy: req.org.id, orgId: req.org.id },
      { upsert: true }
    );
    res.json({ success: true, message: 'Voter registered' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SUPER ADMIN ROUTES ────────────────────────────────────────────────────────
app.get('/admin/orgs', async (req, res) => {
  try {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const orgs = await Org.find().sort({ createdAt: -1 });
    res.json(orgs);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/orgs/:id/approve', async (req, res) => {
  try {
    const key = req.headers['x-api-key'] || req.body.adminKey;
    if (key !== SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const org = await Org.findOneAndUpdate({ id: req.params.id }, { status: 'approved' }, { new: true });
    if (!org) return res.status(404).json({ error: 'Org not found' });
    await sendApprovalEmail(org);
    res.json({ success: true, apiKey: org.apiKey, org });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/orgs/:id/suspend', async (req, res) => {
  try {
    const key = req.headers['x-api-key'] || req.body.adminKey;
    if (key !== SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    await Org.findOneAndUpdate({ id: req.params.id }, { status: 'suspended' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// backward compat - old admin route still works
app.post('/polls', async (req, res) => {
  try {
    const { adminKey, apiKey, title, description, type, tier, candidates, startTime, endTime,
            minTokenBalance, tokenAddress, whitelistedWallets, creatorWallet } = req.body;
    const key = adminKey || apiKey;
    if (key !== SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const poll = new Poll({
      id: genId(), orgId: 'superadmin', orgName: 'XerisVote',
      title, description, type, tier, candidates,
      startTime: new Date(startTime), endTime: new Date(endTime),
      minTokenBalance, tokenAddress,
      whitelistedWallets: whitelistedWallets || [],
      status: 'pending', createdBy: creatorWallet
    });
    await poll.save();
    res.json({ success: true, poll });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/voters/register', async (req, res) => {
  try {
    const { wallet, tier, adminKey } = req.body;
    if (adminKey !== SUPER_ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    await Voter.findOneAndUpdate(
      { wallet },
      { wallet, tier, verified: true, verifiedBy: 'superadmin' },
      { upsert: true }
    );
    res.json({ success: true, message: 'Voter registered' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AUTO STATUS UPDATE ─────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const now = new Date();
    await Poll.updateMany({ status: 'pending', startTime: { $lte: now } }, { $set: { status: 'active' } });
    await Poll.updateMany({ status: 'active', endTime: { $lte: now } }, { $set: { status: 'ended' } });
  } catch(e) { console.error('Status update error:', e.message); }
}, 30000);

app.listen(PORT, () => console.log('XerisVote running on port ' + PORT));
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err.message); });
process.on('uncaughtException', (err) => { console.error('Uncaught:', err.message); });
