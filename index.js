// multi-file formats support
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import url from 'url';
import cron from 'node-cron';

// Routes and middleware imports
import notebookRouter from './src/routes/NotebookRoutes.js';
import authRouter from './src/routes/AuthRoutes.js';
import billingRouter from './src/routes/BillingRoutes.js';
import userRouter from './src/routes/UserRoutes.js';
import chatRouter from './src/routes/ChatRoutes.js';
import quizRouter from './src/routes/QuizRoutes.js';
import flashcardsRouter from './src/routes/FlashCardsRoutes.js';
import analyticsRouter from './src/routes/AnalyticsRoutes.js';
import webhookRouter from './src/routes/Webhooks.js';
import transcriptionRouter from './src/routes/TranscriptionRoute.js';
import { authMiddleWare } from './src/middleware/authMiddleWare.js';
import { handleDeleteFirebaseAuthUser, verifyToken } from './src/services/firebase.js';
import { handleMaterialDownload } from './src/controllers/NotebookController.js';
import { handleBulkDeleteUsers, handleBulkNotebookDeletion, handleBulkNotebookIdRetrieval, handleSearchForDeletedNotebooks, handleSearchForDeletedUsers } from './src/utils/utility.js';
import { logger } from './src/utils/logger.js';
import { handleLiveSession } from './src/services/liveSession.js';

dotenv.config();

const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);

// WebSocket setup
export const clientSocketsMap = new Map();
const wss = new WebSocketServer({ server });
wss.on('connection', async (ws, req) => {
  let token;
  try {
    const parsedUrl = url.parse(req.url, true);
    token = parsedUrl.query?.token;
    
    const mode = parsedUrl.query?.mode;
    const notebookId = parsedUrl.query?.notebookId;


    if (!token) throw new Error('No token parameter');
    const decoded = await verifyToken(token);
    if (!decoded) throw new Error('Unauthorized user');
    
    if (mode === 'live' && notebookId) {
      await handleLiveSession(ws, req, decoded, notebookId);
      return; // Exit main handler, live session takes over this socket
    }

    let socketsSet = clientSocketsMap.get(decoded.uid) || new Set();
    socketsSet.add(ws);
    clientSocketsMap.set(decoded.uid, socketsSet);

    ws.on('message', (message) => {
      console.log(`Received message: ${message.toString()}`);
    });
    ws.on('close', () => {
      console.log('Client disconnected');
      socketsSet.delete(ws);
    });
  } catch (err) {
    console.log(`[WS ERROR]: ${err.message}`);
    ws.close(1002, 'Invalid request');
  }
});

// Middleware
// CORS configuration with allowlist
const allowedOrigins = [
  'http://localhost:3000',           // Local development
  'http://localhost:5173',           // Vite dev server
  'http://localhost:5174',           // Alternative Vite port
  'https://tutilo-beta.web.app',  
  'https://tutilo-beta.firebaseapp.com'   // Production frontend
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log(`[CORS Blocked] Origin: ${origin}`); // Log blocked origins
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, 
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// 1. Apply CORS immediately
app.use(cors(corsOptions));

// 3. Request Logging (Helps debug crashes)
app.use((req, res, next) => {
  // Log the incoming request
  logger.info(`[Request] ${req.method} ${req.url}`, {
    method: req.method,
    url: req.url,
    ip: req.ip
  });
  next();
});

app.use(express.json());

// Routes
app.get('/api/v1/notebooks/:id/materials/:materialId/download', handleMaterialDownload);
app.use('/api/v1/notebooks', authMiddleWare, notebookRouter);
app.use('/api/v1/chats', authMiddleWare, chatRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/billing', authMiddleWare, billingRouter);
app.use('/api/v1/users', authMiddleWare, userRouter);
app.use('/api/v1/quizzes', quizRouter);
app.use('/api/v1/flashcards', flashcardsRouter);
// threat vectore ---------------
app.use('/api/v1/webhooks', webhookRouter);
// -------------------
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/transcription', authMiddleWare, transcriptionRouter);

// Basic route
app.get('/', (req, res) => res.send('Hello, Express + Cloud Run!'));

// Cron job for notebook deletion
cron.schedule('* * * * *', async () => {
  console.log('Cron task running...');
  const notebookIds = await handleSearchForDeletedNotebooks();
  if (!notebookIds) return;
  await handleBulkNotebookDeletion(notebookIds);
  console.log('Cron job finished');
});

let isJobRunning = false;
const MAX_BATCHES = 100; // Safety: Stop after processing ~20,000 users to prevent infinite loops

cron.schedule('0 * * * *', async () => {
  if (isJobRunning) {
    console.log("Previous deletion job still running. Skipping.");
    return;
  }

  isJobRunning = true;
  console.log("Daily Cron for user deletion started...");

  let batchCount = 0;
  let totalDeleted = 0;

  try {
    // START LOOP
    while (true) {
      // 1. Fetch next batch (Ensure this function has .limit(200))
      const userIds = await handleSearchForDeletedUsers();

      // BREAK CONDITION: If no users found, we are done.
      if (!userIds || userIds.length === 0) {
        console.log("No more users to delete. Job complete.");
        break; 
      }

      console.log(`Batch ${batchCount + 1}: Processing ${userIds.length} users...`);

      // 2. Retrieve Notebooks
      const notebookIds = await handleBulkNotebookIdRetrieval(userIds);
      
      if (notebookIds && notebookIds.length > 0) {
        // Handle notebook deletion (assumed to be chunked/safe internally)
        await handleBulkNotebookDeletion(notebookIds);
      }

      // 3. Delete Firebase Auth Users
      // Using Promise.allSettled so one failure doesn't stop the whole batch
      const deleteAuthPromises = userIds.map(id => handleDeleteFirebaseAuthUser(id));
      await Promise.allSettled(deleteAuthPromises);

      // 4. Delete Users from DB
      // CRITICAL: This removes them from the query, so they won't appear in the next loop
      await handleBulkDeleteUsers(userIds);

      totalDeleted += userIds.length;
      batchCount++;

      // SAFETY BRAKE: Prevent infinite loops if DB writes are failing silently
      if (batchCount >= MAX_BATCHES) {
        console.warn(`Hit max batch limit (${MAX_BATCHES}). Stopping safely.`);
        break;
      }
    }
    // END LOOP

    console.log(`Cron summary: Successfully processed ${totalDeleted} users.`);

  } catch (err) {
    console.error(`[ERROR] -- cron user del:`, err);
  } finally {
    isJobRunning = false;
    console.log('Cron job finished');
  }
});
// Start server (Cloud Run requires listen on process.env.PORT)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
