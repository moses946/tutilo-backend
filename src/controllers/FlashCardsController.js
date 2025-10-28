import { db } from "../services/firebase.js";

export async function handleGetFlashCards(req, res){
    try {
        const { notebookId } = req.params;
        const notebookRef = db.collection('Notebook').doc(notebookId);
        const flashcardsSnapshot = await db.collection('Flashcard')
            .where('notebookID', '==', notebookRef)
            .get();
        
        if (flashcardsSnapshot.empty) {
            return res.json({
                notebookId,
                flashcardCount: 0,
                flashcards: []
            });
        }
        
        // Since we now store all flashcards in one document, get the first (and only) one
        const flashcardDoc = flashcardsSnapshot.docs[0];
        const data = flashcardDoc.data();
        
        res.json({
            notebookId,
            flashcardCount: data.numberOfCards || 0,
            flashcards: data.flashcards || [], // Array of flashcard strings
            dateCreated: data.dateCreated,
            status: data.status
        });
    } catch (error) {
        console.error('Error fetching flashcards:', error);
        res.status(500).json({ error: 'Failed to fetch flashcards' });
    }
}
export async function handleGenerateFlashCards(req, res){
    // This endpoint can be used for manual flashcard generation
    res.json({message: 'Use notebook creation/update to generate flashcards automatically'});
}