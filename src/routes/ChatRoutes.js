import express from 'express';
import { handleCreateChat, handleCreateMessage, handleDeleteChat, handleQuizRetrieval, handleReadChats, handleReadMessages } from '../controllers/ChatController.js';

const chatRouter = express.Router();
chatRouter.get('/', handleReadChats);
chatRouter.post('/', handleCreateChat);
chatRouter.get('/:chatID/messages', handleReadMessages);
chatRouter.post('/:chatID/messages', upload.array('files'),handleCreateMessage);
chatRouter.delete('/:chatID/messages', handleDeleteChat)
chatRouter.get('/:chatID/quiz', handleQuizRetrieval);
chatRouter.patch('/:chatID/messages/:messageId', (req, res)=>{});
chatRouter.delete('/:chatID/messages/:messageId', (req, res)=>{});



export default chatRouter

