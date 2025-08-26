const express = require('express');

const billingRouter = express.Router();
billingRouter.get('/subscription', (req, res)=>{});
billingRouter.post('/subscription', (req, res)=>{});
billingRouter.get('/webhooks', (req, res)=>{});

export default billingRouter