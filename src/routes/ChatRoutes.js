import express from 'express';

const chatRouter = express.Router();
chatRouter.get('/', (req, res)=>{});
chatRouter.post('/', (req, res)=>{});
chatRouter.get('/:chatId', (req, res)=>{});
chatRouter.get('/:chatId/messages', (req, res)=>{});
chatRouter.post('/:chatId/messages', (req, res)=>{});
chatRouter.patch('/:chatId/messages/:messageId', (req, res)=>{});
chatRouter.delete('/:chatId/messages/:messageId', (req, res)=>{});

export default chatRouter

