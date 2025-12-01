import express from 'express';
import { handleFeedbackSubmission, handleSessionLog } from '../controllers/AnalyticsController.js';
import { authMiddleWare } from '../middleware/authMiddleWare.js';

const analyticsRouter = express.Router();

// Route to submit feedback
analyticsRouter.post('/feedback', authMiddleWare, handleFeedbackSubmission);

// Route to log session duration (sent on app close/unmount)
analyticsRouter.post('/session', authMiddleWare, handleSessionLog);

export default analyticsRouter;