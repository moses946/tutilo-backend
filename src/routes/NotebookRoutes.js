import express from 'express';
import {upload} from '../utils/utility.js'
import { planLimits } from '../config/plans.js';

import { handleConceptChatCreate, handleConceptDetail, handleConceptList, handleConceptMapRetrieval, handleMaterialDownload, handleNotebookCreation, handleNotebookDeletion, handleNotebookEditFetch, handleNotebookFetch, handleNotebookRead, handleNotebookUpdate, handleUserProgressUpdate, handleChunkFetch, handleNotebookStatus, handleNotebookProcessing } from '../controllers/NotebookController.js';


// Helper to convert MB to bytes
const MB_TO_BYTES = (mb) => mb * 1024 * 1024;
async function validateUploads(req, res, next) {
    // This assumes an authentication middleware has already run and populated req.user
    if (!req.user || !req.user.subscription) {
        return res.status(401).json({ error: 'Authentication required.' });
    }

    const subscription = req.user.subscription; // 'free' or 'plus'
    const limits = planLimits[subscription];

    if (!limits) {
        return res.status(403).json({ error: 'Invalid subscription plan.' });
    }

    const files = req.files;

    // 1. Check file count
    if (files.length > limits.maxFiles) {
        return res.status(413).json({
            error: 'File count limit exceeded.',
            message: `Your '${subscription}' plan allows up to ${limits.maxFiles} files per upload. You tried to upload ${files.length}.`
        });
    }

    // 2. Check individual file sizes
    const maxFileSizeInBytes = MB_TO_BYTES(limits.maxFileSizeMB);
    for (const file of files) {
        if (file.size > maxFileSizeInBytes) {
            return res.status(413).json({
                error: 'File size limit exceeded.',
                message: `The file "${file.originalname}" is too large. Your '${subscription}' plan allows files up to ${limits.maxFileSizeMB} MB.`
            });
        }
    }
    // If all checks pass, proceed to the main handler
    next();
}
const notebookRouter = express.Router();
notebookRouter.post('/', upload.array('files'),validateUploads, handleNotebookCreation);
// [INSERT] New Async processing routes
notebookRouter.post('/:id/process', handleNotebookProcessing);
notebookRouter.get('/:id/status', handleNotebookStatus);

notebookRouter.delete('/:id', handleNotebookDeletion);
notebookRouter.put('/:id', upload.array('files'), validateUploads,handleNotebookUpdate)
notebookRouter.get('/', handleNotebookRead);
notebookRouter.get('/:id', handleNotebookFetch);
notebookRouter.get('/:id/edit', handleNotebookEditFetch);
notebookRouter.delete('/:id', handleNotebookDeletion);
notebookRouter.get('/:id/conceptMap', handleConceptMapRetrieval);
notebookRouter.get('/:id/concepts', handleConceptList);
notebookRouter.get('/:id/concepts/:conceptId', handleConceptDetail);
notebookRouter.post('/:id/concepts/:conceptId/chat', handleConceptChatCreate);
notebookRouter.get('/:id/materials/:materialId/download', handleMaterialDownload);
notebookRouter.put('/:id/concepts/:conceptId/progress', handleUserProgressUpdate);
notebookRouter.get('/chunks/:chunkId', handleChunkFetch); 
export default notebookRouter