import express from 'express';
import {upload} from '../utils/utility.js'
import extractPdfText from '../utils/chunking.js'
import fs from "fs";
import { promises as fsp } from 'fs';

const notebookRouter = express.Router();
notebookRouter.post('/', upload.array('files'), handleNotebookCreation);
notebookRouter.get('/', async (req, res)=>{
    try{
        let file = await fsp.readFile('./src/routes/notes.pdf');
        let pages = await extractPdfText(file);
        res.json(pages);
    }catch(err){
        console.error('PDF parse error:', err);
        res.status(500).json({error: 'Failed to parse PDF'});
    }
});
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