import express from 'express';
import { handleInitTransaction, handleTransactionVerification } from '../controllers/BillingController.js';

const billingRouter = express.Router();
billingRouter.get('/subscription', (req, res)=>{});
billingRouter.post('/transaction/initialize', handleInitTransaction);
billingRouter.post('/verify/:userID', handleTransactionVerification);
billingRouter.get('/webhooks', (req, res)=>{});

export default billingRouter

