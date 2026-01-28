import express from 'express';
import {
    handleInitTransaction,
    handleTransactionVerification,
    handlePaystackWebhook,
    getSubscriptionDetails,
    cancelSubscription,
    adminCancelSubscription,
    updatePaymentCard,
    verifyCardUpdate
} from '../controllers/BillingController.js';
import { authMiddleWare } from '../middleware/authMiddleWare.js';

const billingRouter = express.Router();

// Transaction endpoints (existing)
billingRouter.post('/transaction/initialize', handleInitTransaction);
billingRouter.post('/verify/:userID', authMiddleWare, handleTransactionVerification);

// Subscription management endpoints
billingRouter.get('/subscription/:userID', authMiddleWare, getSubscriptionDetails);
billingRouter.post('/subscription/cancel/:userID', authMiddleWare, cancelSubscription);

// Admin subscription management (requires admin verification in controller)
billingRouter.post('/admin/cancel-subscription/:targetUserId', authMiddleWare, adminCancelSubscription);

// Card update endpoints
billingRouter.post('/subscription/update-card/:userID', authMiddleWare, updatePaymentCard);
billingRouter.post('/subscription/verify-card/:userID', authMiddleWare, verifyCardUpdate);

// Paystack Webhook - NO AUTH (uses HMAC signature verification)
billingRouter.post('/webhooks/paystack', handlePaystackWebhook);

export default billingRouter;

