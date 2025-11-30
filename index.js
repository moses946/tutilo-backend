// feature/optimization
import express from 'express';
import dotenv from 'dotenv';
import notebookRouter from './src/routes/NotebookRoutes.js';
import authRouter from './src/routes/AuthRoutes.js';
import billingRouter from './src/routes/BillingRoutes.js';
import userRouter from './src/routes/UserRoutes.js';
import chatRouter from './src/routes/ChatRoutes.js';
import quizRouter from './src/routes/QuizRoutes.js';
import flashcardsRouter from './src/routes/FlashCardsRoutes.js';
import analyticsRouter from './src/routes/AnalyticsRoutes.js';
import cors from 'cors';
import { authMiddleWare } from './src/middleware/authMiddleWare.js';
import webhookRouter from './src/routes/Webhooks.js';
import http from "http";
import { WebSocketServer } from 'ws';
import url from "url";
import { verifyToken } from './src/services/firebase.js';
import { handleMaterialDownload } from './src/controllers/NotebookController.js';
import cron from 'node-cron';
import { handleBulkNotebookDeletion, handleSearchForDeletedNotebooks } from './src/utils/utility.js';


dotenv.config();
var PORT = process.env.PORT

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Schedule a task to run every minute.
cron.schedule('* * * * *', async () => {
  console.log('This task runs every minute.');
  let notebookIds = await handleSearchForDeletedNotebooks()
  if (!notebookIds) {
    console.log('No job for the cronny, womp womp');
    return
  }
  await handleBulkNotebookDeletion(notebookIds);
  console.log('cron job has finished')
});

export var clientSocketsMap = new Map();
// web socket code
wss.on('connection', async (ws, req) => {
  var token;
  try {
    // Retrieve the query string and parse token parameter properly
    // url.parse(req.url, true) yields .query as an object
    const parsedUrl = url.parse(req.url, true);
    token = parsedUrl.query && parsedUrl.query.token;
    if (!token) {
      console.log('No token parameter')
      ws.close(1002, 'Invalid request')
      return
    }

  } catch (err) {
    console.log(`[ERROR]:${err}`)
    ws.close(1002, 'Invalid request')
  }
  const decoded = await verifyToken(token)
  if (!decoded) {
    ws.close(1002, 'Unauthorized user')
    return
  }
  console.log(`Decoded has been successful`)
  // setting the websocket
  let socketsSet = clientSocketsMap.get(decoded.uid);
  if (!socketsSet) {
    socketsSet = new Set();
    clientSocketsMap.set(decoded.uid, socketsSet);
    console.log(`Set the client socket map with key:${decoded.uid}`)
  }
  socketsSet.add(ws);
  ws.on('message', (message) => {
    console.log(`Received message:${message.toString()}`);
  })
  ws.on('close', () => {
    console.log('client disconnected')
  })
})

app.use(cors({ origin: true }));

// Middleware
app.use(express.json());

// Routers
// Handle multipart/form-data routes before express.json()
app.get('/api/v1/notebooks/:id/materials/:materialId/download', handleMaterialDownload);
app.use('/api/v1/notebooks', authMiddleWare, notebookRouter);
app.use('/api/v1/chats', authMiddleWare, chatRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/billing', authMiddleWare, billingRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/quizzes', quizRouter);
app.use('/api/v1/flashcards', flashcardsRouter);
app.use('/api/v1/webhooks', webhookRouter)
app.use('/api/v1/analytics', analyticsRouter);


// Basic route
app.get('/', (req, res) => {
  res.send('Hello, Express!');
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
