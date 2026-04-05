'use strict';
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(require('express').static('public'));

const PORT = process.env.PORT || 3000;

const pollSchema = new mongoose.Schema({
  id: { type: String, unique: true },
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
  registeredAt: { type: Date, default: Date.now }
});

const Poll = mongoose.model('Poll', pollSchema);
const Vote = mongoose.model('Vote', voteSchema);
const Voter = mongoose.model('Voter', voterSchema);

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log('MongoDB connected'))
  .catch(err => { console.error('MongoDB error:', err.message); process.exit(1); });

function genId() { return Math.random().toString(36).slice(2, 10); }

async function getXrsBalance(wallet) {
  try {
    const r = await fetch('http://138.197.116.81:50008/v2/account/' + wallet);
    const d = await r.json();
    const bal = d && d.data ? (d.data.balance_xrs || 0) : 0;
    console.log('[Balance]', wallet.slice(0,8), bal, 'XRS');
    return bal;
  } catch(e) {
    console.error('[Balance error]', e.message);
    return 0;
  }
}

async function verifyWalletEligibility(wallet, poll) {
  if (poll.tier === 'civil') {
    const voter = await Voter.findOne({ wallet, tier: 'civil', verified: true });
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

app.post('/polls', async (req, res) => {
  try {
    const { title, description, type, tier, candidates, startTime, endTime,
            minTokenBalance, tokenAddress, whitelistedWallets, adminKey, creatorWallet } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const poll = new Poll({
      id: genId(), title, description, type, tier, candidates,
      startTime: new Date(startTime), endTime: new Date(endTime),
      minTokenBalance, tokenAddress,
      whitelistedWallets: whitelistedWallets || [],
      status: 'pending', createdBy: creatorWallet
    });
    await poll.save();
    res.json({ success: true, poll });
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

app.get('/polls/:id/results', async (req, res) => {
  try {
    const poll = await Poll.findOne({ id: req.params.id });
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    const results = poll.candidates.map(c => ({
      id: c.id, name: c.name, votes: c.votes,
      percentage: poll.totalVotes > 0 ? ((c.votes / poll.totalVotes) * 100).toFixed(1) : '0'
    })).sort((a, b) => b.votes - a.votes);
    res.json({ pollId: poll.id, title: poll.title, totalVotes: poll.totalVotes, results, status: poll.status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/voters/register', async (req, res) => {
  try {
    const { wallet, tier, adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    await Voter.findOneAndUpdate(
      { wallet },
      { wallet, tier, verified: true, verifiedBy: 'admin' },
      { upsert: true }
    );
    res.json({ success: true, message: 'Voter registered' });
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

setInterval(async () => {
  try {
    const now = new Date();
    await Poll.updateMany({ status: 'pending', startTime: { $lte: now } }, { $set: { status: 'active' } });
    await Poll.updateMany({ status: 'active', endTime: { $lte: now } }, { $set: { status: 'ended' } });
  } catch(e) { console.error('Status update error:', e.message); }
}, 30000);

app.listen(PORT, () => console.log('XerisVote running on port ' + PORT));
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err.message); });
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err.message); });
