import express from 'express';
import dotenv from 'dotenv';
import notebookRouter from './src/routes/NotebookRoutes.js';
import authRouter from './src/routes/AuthRoutes.js';
import billingRouter from './src/routes/BillingRoutes.js';
import userRouter from './src/routes/UserRoutes.js';
import chatRouter from './src/routes/ChatRoutes.js';
import quizRouter from './src/routes/QuizRoutes.js';
import flashcardsRouter from './src/routes/FlashCardsRoutes.js';
import cors from 'cors';
import { authMiddleWare } from './src/middleware/authMiddleWare.js';
const app = express();

dotenv.config();
var PORT = process.env.PORT


app.use(cors({origin:true}));


// Middleware
app.use(express.json());

// Routers
app.use('/api/v1/notebooks', notebookRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/billing', billingRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/chats', authMiddleWare, chatRouter);
app.use('/api/v1/quizzes', quizRouter);
app.use('/api/v1/flashcards', flashcardsRouter);



// Basic route
app.get('/', (req, res) => {
  res.send('Hello, Express!'); 
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
