const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);

const PORT = process.env.PORT || 3500;

// Cached connection handling
let cachedConnection = null;
let isConnecting = false;

async function connectToDatabase() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  // Prevent multiple simultaneous connection attempts
  if (isConnecting) {
    const waitForConnection = new Promise((resolve) => {
      const checkConnection = setInterval(() => {
        if (cachedConnection) {
          clearInterval(checkConnection);
          resolve(cachedConnection);
        }
      }, 100);
    });
    return waitForConnection;
  }

  try {
    isConnecting = true;

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }

    // Optimized connection options for serverless
    const connectionOptions = {
      maxPoolSize: 1,
      minPoolSize: 1,
      socketTimeoutMS: 10000,
      serverSelectionTimeoutMS: 10000,
      maxIdleTimeMS: 10000,
      autoCreate: false,
      bufferCommands: false
    };

    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/email-tracker';
    const connection = await mongoose.connect(MONGODB_URI, connectionOptions);
    
    cachedConnection = connection;

    // Reset connection on errors
    mongoose.connection.on('error', (error) => {
      console.error('MongoDB connection error:', error);
      cachedConnection = null;
    });

    return cachedConnection;
  } catch (error) {
    console.error('Database connection failed:', error);
    throw error;
  } finally {
    isConnecting = false;
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
  responseDetails: {
    lastOpened: Date,
    userAgent: String,
    ip: String,
    openHistory: [{
      timestamp: Date,
      userAgent: String,
      ip: String
    }]
  },
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

function realIP(request, cfProxy = false) {
  const headers = request.headers;
  const FALLBACK_IP_ADDRESS = '0.0.0.0';

  if (cfProxy && headers['cf-connecting-ip']) {
    return headers['cf-connecting-ip'];
  }

  if (headers['x-real-ip']) {
    return headers['x-real-ip'];
  }

  if (headers['x-forwarded-for']) {
    return headers['x-forwarded-for'].split(',')[0].trim();
  }

  if (headers['x-vercel-forwarded-for']) {
    return headers['x-vercel-forwarded-for'];
  }

  if (headers['x-vercel-proxied-for']) {
    return headers['x-vercel-proxied-for'];
  }

  return request.ip ?? FALLBACK_IP_ADDRESS;
}

// Tracking pixel endpoint with proper cursor handling
app.get('/icon/:trackingId', async (req, res) => {
  const startTime = Date.now();
  
  // Send pixel immediately
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Length': '43',
  });
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));

  const { trackingId } = req.params;
  if (!trackingId) return;

  let session = null;

  try {
    const conn = await connectToDatabase();
    session = await conn.startSession();

    await session.withTransaction(async () => {
      const userAgent = req.headers['user-agent'] || 'unknown';
      const ip = realIP(req, true);
      const timestamp = new Date();

      const updateResult = await Email.findOneAndUpdate(
        { trackingId },
        {
          $set: {
            status: 'opened',
            'responseDetails.lastOpened': timestamp,
            'responseDetails.userAgent': userAgent,
            'responseDetails.ip': ip,
          },
          $push: {
            'responseDetails.openHistory': {
              timestamp,
              userAgent,
              ip
            }
          },
          $inc: { 'metadata.openCount': 1 },
        },
        { 
          new: true,
          session,
          maxTimeMS: 5000
        }
      ).lean();

      if (!updateResult) {
        console.warn(`No email found for trackingId: ${trackingId}`);
      }
    });

    console.log(`Successfully processed tracking for ${trackingId} in ${Date.now() - startTime}ms`);
  } catch (error) {
    console.error('Error processing tracking:', {
      trackingId,
      error: error.message,
      duration: Date.now() - startTime
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
});

// Health check endpoint
app.get('/ping', (req, res) => {
  res.json({ 
    success: true, 
    timestamp: new Date().toISOString(),
    connectionState: mongoose.connection.readyState 
  });
});

app.listen(PORT, () => {
  console.log(`Development server running on port ${PORT}`);
});