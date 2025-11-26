import express from 'express';
import { handleUpdateUser } from '../controllers/UserController.js'; // Import the new function
import { handleUpdateTheme } from '../controllers/AuthController.js';

const userRouter = express.Router();

userRouter.get('/', (req, res)=>{});
userRouter.get('/:userId', (req, res)=>{});

// ADD THIS ROUTE
userRouter.patch('/:userId', handleUpdateUser);

userRouter.get('/:userId/preferences', (req, res)=>{});
userRouter.patch('/:userId/preferences', (req, res)=>{});
userRouter.put('/theme', handleUpdateTheme);

export default userRouter;