import express from 'express';
import {upload, handleEmbedding, handleFileUpload, handleBulkFileUpload, handleBulkChunkUpload} from '../utils/utility.js'
import extractPdfText from '../utils/chunking.js'
import fs from "fs";
import { promises as fsp } from 'fs';
import { createNotebookQuery } from '../models/query.js';

const notebookRouter = express.Router();
notebookRouter.post('/', upload.array('files'), handleNotebookCreation);
notebookRouter.get('/', async (req, res)=>{
    try{
        let file = await fsp.readFile('./src/routes/notes.pdf');
        let pages = await extractPdfText(file);
        handleEmbedding(pages);
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
    let data = req.body;
    let files = req.files;
    // Should do the file uploads, chunking, embedding creation and storage
    //create a notebook first
    let notebookRef = await createNotebookQuery(data);
    try{
        const noteBookBasePath = `notebooks/${notebookRef.id}`;
        // upload original files
        const uploaded = await handleBulkFileUpload(files, noteBookBasePath);
        // extract chunks per file sequentially to maintain mapping
        const chunkItems = [];
        for(const file of files){
            const extracts = await extractPdfText(file.buffer);
            chunkItems.push({ name: file.originalname, chunks: extracts });
        }
        // upload chunks as JSON blobs under chunks subfolder
        const uploadedChunks = await handleBulkChunkUpload(chunkItems, `${noteBookBasePath}/chunks`);
        res.status(201).json({
            notebookId: notebookRef.id,
            uploaded,
            uploadedChunks,
        });
    }catch(err){
        console.error('Bulk upload failed:', err);
        res.status(500).json({error: 'Bulk upload failed'});
    }
    
}

export default notebookRouter