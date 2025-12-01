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
import webhookRouter from './src/routes/Webhooks.js';
import { authMiddleWare } from './src/middleware/authMiddleWare.js';
import { verifyToken } from './src/services/firebase.js';
import { handleMaterialDownload } from './src/controllers/NotebookController.js';
import { handleBulkNotebookDeletion, handleSearchForDeletedNotebooks } from './src/utils/utility.js';

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
    if (!token) throw new Error('No token parameter');
    const decoded = await verifyToken(token);
    if (!decoded) throw new Error('Unauthorized user');

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
  'https://tutilo-beta.web.app',     // Production frontend (no trailing slash)
  // Add more allowed origins here
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // If you need to support cookies/auth headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json());

// Routes
app.get('/api/v1/notebooks/:id/materials/:materialId/download', handleMaterialDownload);
app.use('/api/v1/notebooks', authMiddleWare, notebookRouter);
app.use('/api/v1/chats', authMiddleWare, chatRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/billing', authMiddleWare, billingRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/quizzes', quizRouter);
app.use('/api/v1/flashcards', flashcardsRouter);
app.use('/api/v1/webhooks', webhookRouter);

// Basic route
app.get('/', (req, res) => res.send('Hello, Express + Cloud Run!'));

// Cron job
cron.schedule('* * * * *', async () => {
  console.log('Cron task running...');
  const notebookIds = await handleSearchForDeletedNotebooks();
  if (!notebookIds) return;
  await handleBulkNotebookDeletion(notebookIds);
  console.log('Cron job finished');
});

// Start server (Cloud Run requires listen on process.env.PORT)
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
