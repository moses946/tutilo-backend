import express from 'express';
import { handleCreateChat, handleCreateMessage, handleDeleteChat, handleQuizRetrieval, handleReadChats, handleReadMessages, handleGetChat, handleUpdateChat } from '../controllers/ChatController.js';
import { upload } from '../utils/utility.js';

const chatRouter = express.Router();
chatRouter.get('/', handleReadChats);
chatRouter.post('/', handleCreateChat);
chatRouter.get('/:chatID/messages', handleReadMessages);
chatRouter.post('/:chatID/messages', upload.array('files'),handleCreateMessage);
chatRouter.delete('/:chatID/messages', handleDeleteChat)
chatRouter.get('/:chatID/quiz', handleQuizRetrieval);
chatRouter.patch('/:chatID/messages/:messageId', (req, res)=>{});
chatRouter.delete('/:chatID/messages/:messageId', (req, res)=>{});
// NEW ROUTES
chatRouter.get('/:chatID', handleGetChat); // Get specific chat metadata
chatRouter.patch('/:chatID', handleUpdateChat); // Update chat metadata (canvas)


export default chatRouter

