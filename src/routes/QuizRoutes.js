import express from 'express';

const quizRouter = express.Router();
quizRouter.post('/', (req, res)=>{});
quizRouter.get('/:quizId', (req, res)=>{});
quizRouter.post('/:quizId/attempts', (req, res)=>{});
quizRouter.get('/:quizId/attempts', (req, res)=>{});
quizRouter.get('/:quizId/report', (req, res)=>{});

export default quizRouter;
