import express from 'express';
import {
    handleFeedbackSubmission,
    handleSessionLog,
    handleGetTokenUsageSummary,
    handleGetAllUsersStats,
    handleGetTransactionHistory,
    handleGetPlatformStats,
    handleGetRevenueMetrics
} from '../controllers/AnalyticsController.js';
import { authMiddleWare } from '../middleware/authMiddleWare.js';
import { adminMiddleware } from '../middleware/adminMiddleware.js';

const analyticsRouter = express.Router();

// Route to submit feedback
analyticsRouter.post('/feedback', authMiddleWare, handleFeedbackSubmission);

// Route to log session duration (sent on app close/unmount)
analyticsRouter.post('/session', authMiddleWare, handleSessionLog);

// ============================================
// ADMIN ROUTES (Requires authMiddleWare + adminMiddleware)
// ============================================

// Get aggregated token usage by user
analyticsRouter.get('/admin/tokens', authMiddleWare, adminMiddleware, handleGetTokenUsageSummary);

// Get all users with stats
analyticsRouter.get('/admin/users', authMiddleWare, adminMiddleware, handleGetAllUsersStats);

// Transaction history
analyticsRouter.get('/admin/transactions', authMiddleWare, adminMiddleware, handleGetTransactionHistory);

// Platform-wide content and subscription stats
analyticsRouter.get('/admin/platform-stats', authMiddleWare, adminMiddleware, handleGetPlatformStats);

// Revenue metrics
analyticsRouter.get('/admin/revenue', authMiddleWare, adminMiddleware, handleGetRevenueMetrics);

export default analyticsRouter;