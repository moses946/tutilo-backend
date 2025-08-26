import express from 'express';

const notebookRouter = express.Router();
notebookRouter.post('/', (req, res)=>{});
notebookRouter.get('/', (req, res)=>{});
notebookRouter.get('/:id', (req, res)=>{});
notebookRouter.patch('/:id', (req, res)=>{});
notebookRouter.delete('/:id', (req, res)=>{});

export default notebookRouter