const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3500;

// MongoDB connection with connection pooling
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/email-tracker';
  
  try {
    const client = await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 1, // Optimize for serverless
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
    });
    
    cachedDb = client.connection;
    
    cachedDb.on('error', (error) => {
      console.error('MongoDB connection error:', error);
      cachedDb = null;
    });
    
    return cachedDb;
  } catch (error) {
    console.error('MongoDB connection failed:', error);
    throw error;
  }
}

const emailSchema = new mongoose.Schema({
  to: { type: String, required: true },
  subject: { type: String, required: true },
  body: { type: String, required: true },
  status: {
    type: String,
    enum: ['sent', 'bounced', 'opened'],
    default: 'sent',
    index: true,
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
  sentAt: { type: Date, default: Date.now, index: true },
  bounceDetails: { type: Object, default: {} },
  responseDetails: { type: Object, default: {} },
  metadata: {
    ipAddress: String,
    userAgent: String,
    timestamp: { type: Date, default: Date.now },
    openCount: { type: Number, default: 0 },
  },
}, {
  timestamps: true,
});

emailSchema.index({ trackingId: 1, status: 1 });

const Email = mongoose.model('Email', emailSchema);

app.get('/ping', async (req, res) => {
  try {
    await connectToDatabase();
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Database connection failed' });
  }
});


app.get('/icon/:trackingId', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Length': '43',
  });
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));

  const { trackingId } = req.params;
  if (trackingId) {
    try {
      await connectToDatabase();
      const updateResult = await Email.findOneAndUpdate(
        { trackingId },
        {
          $set: {
            status: 'opened',
            'responseDetails.lastOpened': new Date(),
            'responseDetails.userAgent': req.headers['user-agent'] || 'unknown',
            'responseDetails.ip': req.ip || req.headers['x-forwarded-for'] || 'unknown',
          },
          $inc: { 'metadata.openCount': 1 },
        },
        { 
          new: true,
          maxTimeMS: 5000, 
        }
      ).lean();

      if (!updateResult) {
        console.warn(`No email found for trackingId: ${trackingId}`);
      }
    } catch (error) {
      console.error('Error updating tracking status:', {
        trackingId,
        error: error.message,
        stack: error.stack
      });
    }
  }
});

  app.listen(PORT, () => {
    console.log(`Development server running on port ${PORT}`);
  });

