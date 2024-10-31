const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3500;

// Add request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log({
      method: req.method,
      path: req.path,
      params: req.params,
      duration: `${duration}ms`,
      status: res.statusCode
    });
  });
  next();
});

// Improved database connection with connection status tracking
let cachedDb = null;
let isConnecting = false;

async function connectToDatabase() {
  if (cachedDb && mongoose.connection.readyState === 1) {
    return cachedDb;
  }

  if (isConnecting) {
    // Wait for existing connection attempt to complete
    await new Promise(resolve => setTimeout(resolve, 100));
    return connectToDatabase();
  }

  isConnecting = true;
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/email-tracker';
  
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    const client = await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 30000,
      connectTimeoutMS: 10000,
      keepAlive: true,
      keepAliveInitialDelay: 300000
    });
    
    cachedDb = client.connection;
    
    cachedDb.on('error', (error) => {
      console.error('MongoDB connection error:', error);
      cachedDb = null;
    });

    cachedDb.on('disconnected', () => {
      console.log('MongoDB disconnected');
      cachedDb = null;
    });
    
    isConnecting = false;
    return cachedDb;
  } catch (error) {
    console.error('MongoDB connection failed:', error);
    isConnecting = false;
    cachedDb = null;
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

// Health check endpoint with detailed status
app.get('/ping', async (req, res) => {
  try {
    const conn = await connectToDatabase();
    res.json({ 
      success: true, 
      timestamp: new Date().toISOString(),
      dbStatus: mongoose.connection.readyState,
      poolSize: mongoose.connection.config?.maxPoolSize || 1
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Database connection failed',
      details: error.message
    });
  }
});

// Improved tracking pixel endpoint with proper error handling
app.get('/icon/:trackingId', async (req, res) => {
  const startTime = Date.now();
  const { trackingId } = req.params;

  // Send tracking pixel immediately
  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Length': '43',
  });
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));

  if (!trackingId) {
    console.error('No trackingId provided');
    return;
  }

  const updatePromise = (async () => {
    try {
      await connectToDatabase();
      
      const userAgent = req.headers['user-agent'] || 'unknown';
      const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
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
          maxTimeMS: 5000,
          upsert: false
        }
      ).lean();

      if (!updateResult) {
        console.warn(`No email found for trackingId: ${trackingId}`);
        return;
      }

      const duration = Date.now() - startTime;
      console.log(`Successfully updated tracking for ${trackingId} in ${duration}ms`);
    } catch (error) {
      console.error('Error updating tracking status:', {
        trackingId,
        error: error.message,
        stack: error.stack,
        duration: Date.now() - startTime
      });
    }
  })();

  // Set a timeout to ensure the update doesn't hang
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Update operation timed out'));
    }, 5000);
  });

  try {
    await Promise.race([updatePromise, timeoutPromise]);
  } catch (error) {
    console.error('Tracking update failed:', error.message);
  }
});

  app.listen(PORT, () => {
    console.log(`Development server running on port ${PORT}`);
  });
