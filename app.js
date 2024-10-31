const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3500;

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/email-tracker', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

const emailSchema = new mongoose.Schema({
  to: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  status: {
    type: String,
    enum: ['sent', 'bounced', 'opened'],
    default: 'sent',
  },
  trackingId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  messageId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  sentAt: { type: Date, default: Date.now },
  bounceDetails: { type: Object, default: {} },
  responseDetails: { type: Object, default: {} },
  metadata: {
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    timestamp: { type: Date, default: Date.now },
    openCount: { type: Number, default: 0 },
  },
});

const Email = mongoose.model('Email', emailSchema);

app.get('/ping', (req, res) => res.json({ success: true }));

app.get('/icon/:trackingId', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Length': '43',
  });
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));

  // Update email status if found
  const { trackingId } = req.params;
  if (trackingId) {
    try {
      await Email.findOneAndUpdate(
        { trackingId },
        {
          status: 'opened',
          responseDetails: {
            timestamp: new Date(),
            userAgent: req.headers['user-agent'] || 'unknown',
            ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
          },
          $inc: { 'metadata.openCount': 1 },
        },
        { new: true }
      );
    } catch (error) {
      console.error('Error updating tracking status:', error);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
