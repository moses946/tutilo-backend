import express from 'express';
import requestTranscriptionToken from '../controllers/TranscriptionController.js';


const transcriptionRouter = express.Router();

transcriptionRouter.get('/', requestTranscriptionToken);

export default transcriptionRouter;