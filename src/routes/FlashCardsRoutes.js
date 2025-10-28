import express from 'express';
import { db } from '../services/firebase.js';
import { handleGenerateFlashCards, handleGetFlashCards } from '../controllers/FlashCardsController.js';

const flashCardsRouter = express.Router();

// Generate flashcards for a specific notebook
flashCardsRouter.post('/generate', handleGenerateFlashCards);

// Get all flashcards for a specific notebook
flashCardsRouter.get('/notebook/:notebookId', handleGetFlashCards);


export default flashCardsRouter