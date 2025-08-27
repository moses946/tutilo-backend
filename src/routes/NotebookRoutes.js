import express from 'express';
import {upload} from '../services/utility.js'


const notebookRouter = express.Router();
notebookRouter.post('/', upload.array('files'), handleNotebookCreation);
notebookRouter.get('/', (req, res)=>{});
notebookRouter.get('/:id', (req, res)=>{});
notebookRouter.patch('/:id', (req, res)=>{});
notebookRouter.delete('/:id', (req, res)=>{});

async function handleNotebookCreation(req, res){
    // Make sure there is an auth middleware that protects this route
    console.log(`Received these files:${req.files}`);
    let data = req.body

    // Should do the file uploads, chunking, embedding creation and storage
}

export default notebookRouter