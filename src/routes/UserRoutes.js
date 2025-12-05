import express from 'express';
import { handleDeleteUser, handleUpdateUser } from '../controllers/UserController.js'; // Import the new function
import { handleUpdateTheme } from '../controllers/AuthController.js';

const userRouter = express.Router();

userRouter.get('/', (req, res)=>{});
userRouter.get('/:userId', (req, res)=>{});
userRouter.delete('/:userId', handleDeleteUser);

// ADD THIS ROUTE
userRouter.patch('/:userId', handleUpdateUser);

userRouter.get('/:userId/preferences', (req, res)=>{});
userRouter.patch('/:userId/preferences', (req, res)=>{});
userRouter.put('/theme', handleUpdateTheme);

export default userRouter;