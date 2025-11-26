import express from 'express';
import { handleUpdateTheme } from '../controllers/AuthController.js';

const userRouter = express.Router();
userRouter.get('/', (req, res)=>{});
userRouter.get('/:userId', (req, res)=>{});
userRouter.patch('/:userId', (req, res)=>{});
userRouter.get('/:userId/preferences', (req, res)=>{});
userRouter.patch('/:userId/preferences', (req, res)=>{});
userRouter.put('/theme', handleUpdateTheme);

export default userRouter