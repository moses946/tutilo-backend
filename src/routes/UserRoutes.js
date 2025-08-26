import express from 'express';

const userRouter = express.Router();
userRouter.get('/', (req, res)=>{});
userRouter.get('/:userId', (req, res)=>{});
userRouter.patch('/:userId', (req, res)=>{});
userRouter.get('/:userId/preferences', (req, res)=>{});
userRouter.patch('/:userId/preferences', (req, res)=>{});

export default userRouter