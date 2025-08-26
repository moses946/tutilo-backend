const express = require('express');
const dotenv = require('dotenv');
const app = express();
const notebookRouter = require('./src/routes/NotebookRoutes');
const authRouter = require('./src/routes/AuthRoutes');
const billingRouter = require('./src/routes/BillingRoutes');
const userRouter = require('./src/routes/UserRoutes');
const chatRouter = require('./src/routes/ChatRoutes');
const quizRouter = require('./src/routes/QuizRoutes');
const flashcardsRouter = require('./src/routes/FlashCardsRoutes');

dotenv.config();
var PORT = process.env.PORT

// Middleware
app.use(express.json());

// Routers
app.use('/api/v1/notebooks', notebookRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/billing', billingRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/chats', chatRouter);
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
