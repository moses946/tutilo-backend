import multer from 'multer';
import admin, {bucket, db} from '../services/firebase.js';
import {ai} from '../models/models.js'
import qdrantClient from '../services/qdrant.js'
import {v4} from 'uuid'
import { deleteChatQuery, deleteNotebookQuery, updateNotebookWithNewMaterialQuery } from '../models/query.js';
// multer storage
const storage = multer.memoryStorage();
export const upload = multer({ storage });

export const handleFileUpload = async (file, path)=>{
    try{
        const destinationPath = `${path}`;
        const blob = bucket.file(path);
        await blob.save(file.buffer, {
            metadata: {
                contentType: file.mimetype,
            },
            resumable: false,
        });
        await blob.makePublic()
        return { mediaUrl: blob.publicUrl(), name: file.originalname, size: file.size, type:file.mimetype};
    }catch(err){
        console.log(`Error in handleFileUpload func:${err}`);
        throw err;
    }
}

export const handleBulkFileUpload = async (files, basePath)=>{
    const uploads = files.map((file)=>{
        const safeName = file.originalname;
        const destination = `${basePath}/${safeName}`;
        return handleFileUpload(file, destination);
    });
    return Promise.all(uploads);
}
 
export const handleBulkChunkUpload = async (chunks, basePath)=>{
    // chunks: Array<{ name: string, chunks: Array<{pageNumber:number, text:string, tokenCount:number}> }>
    const uploads = chunks.map(async (item)=>{
        const safeName = `${item.name}.json`;
        const destination = `${basePath}/${safeName}`;
        const payload = Buffer.from(JSON.stringify(item.text), 'utf-8');
        const blob = bucket.file(destination);
        await blob.save(payload, {
            metadata: { contentType: 'application/json' },
            resumable: false,
        });
        return { path: destination, name: safeName, size: payload.length };
    });
    return Promise.all(uploads);
}
/*
function to retrieve a chunk
*/
export const handleChunkRetrieval = async (path) => {
    try {
        const file = bucket.file(path);
        const [exists] = await file.exists();
        if (!exists) {
            throw new Error(`Chunk file not found at path: ${path}`);
        }
        const [contents] = await file.download();
        // Try to parse as JSON, fallback to string if not JSON
        try {
            return JSON.parse(contents.toString('utf-8'));
        } catch (err) {
            // Not JSON, return as string
            return contents.toString('utf-8');
        }
    } catch (err) {
        console.error(`Error retrieving chunk at ${path}:`, err);
        throw err;
    }
}

export const handleBulkChunkRetrieval = async (paths)=>{
    // Given an array of storage paths, retrieve all chunk contents in parallel
    // Returns: Array of chunk contents (parsed JSON or string)
    try {
        const retrievals = paths.map(path => handleChunkRetrieval(path));
        return await Promise.all(retrievals);
    } catch (err) {
        console.error('Error in handleBulkChunkRetrieval:', err);
        throw err;
    }
}

export const generateSignedUrl = async (path, expiresInSeconds = 3600) => {
    try {
        const file = bucket.file(path);
        const [exists] = await file.exists();
        if (!exists) {
            throw new Error(`File not found at path: ${path}`);
        }

        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + expiresInSeconds * 1000,
        });

        return url;
    } catch (err) {
        console.error(`Error generating signed URL for ${path}:`, err);
        throw err;
    }
}

/*
  Embedding function
  Input:array of objects holding page number and text content
  Output:An array of objects holding metadata and embedding of the text content 

*/
export const handleEmbedding = async (pages)=>{
    pages = pages.map((page ,index)=>page.text)
    const response = await ai.models.embedContent(
        {
            model:'gemini-embedding-exp-03-07',
            contents:pages,
            taskType: 'RETRIEVAL_DOCUMENT',
            outputDimensionality: 256,
        }
    );
    return response.embeddings
    
}

/*
  Create embeddings for chunks and store in Qdrant
  Input: chunks: Array of chunk objects with text content, chunkRefs: Array of chunk document references
  Output: Array of Qdrant point IDs
*/
export const handleChunkEmbeddingAndStorage = async (chunks, chunkRefs, collectionName = 'notebook_chunks', vectorDim=256) => {
    try { 
        // Extract text content from chunks
        // Batch functionality: process up to 100 chunks per embedding request
        const texts = chunks.map(chunk => chunk.text);
        let embeddingBatchSize = 100;
        let allEmbeddings = [];
        for (let i = 0; i < texts.length; i += embeddingBatchSize) {
            const batchTexts = texts.slice(i, i + embeddingBatchSize);
            embeddingBatchSize = Math.min(embeddingBatchSize, texts.length - i);
            const response = await ai.models.embedContent({
                model: 'gemini-embedding-exp-03-07',
                contents: batchTexts,
                taskType: 'RETRIEVAL_DOCUMENT',
                config: { outputDimensionality: vectorDim },
            });
            if (response && response.embeddings) {
                allEmbeddings = allEmbeddings.concat(response.embeddings);
            }
        }
        // For downstream code compatibility, mimic the original response object
        const response = { embeddings: allEmbeddings };        
        // Prepare points for Qdrant with chunkID in payload
        const points = response.embeddings.map((embedding, index) => ({
            //  Unique ID
            id:v4(),
            vector: embedding.values,
            payload: {
                chunkID: chunkRefs[index].id,
                createdAt: new Date().toISOString()
            }
        }));
        
        // Ensure collection exists
        try {
            let collection = await qdrantClient.getCollection(collectionName);
            if(!collection){
                await qdrantClient.createCollection(collectionName, {
                    vectors: {
                        size: vectorDim,
                        distance: 'Cosine'
                    }
                });
            }
        } catch (error) {
            if (error.status === 404) {
                await qdrantClient.createCollection(collectionName, {
                    vectors: {
                        size: vectorDim,
                        distance: 'Cosine'
                    }
                });
            } else {
                throw error;
            }
        }
        
        // Upload points to Qdrant in batches
        let batchSize = 100;
        const uploadedPoints = [];
        
        for (let i = 0; i < points.length; i += batchSize) {
            const batch = points.slice(i, i + batchSize);
            const result = await qdrantClient.upsert(collectionName, {
                points: batch
            });
            // Making the batch size dynamic
            batchSize = Math.min(batchSize, points.length - i);
            uploadedPoints.push(...batch.map(point => point.id));
        }
        return uploadedPoints;
        
    } catch (error) {
        console.error('Error in handleChunkEmbeddingAndStorage:', error);
        throw error;
    }
}

export const handleNotebookUpdate = async(notebookID, materialRefs)=>{
    const notebookRef = db.collection('Notebook').doc(notebookID);
  
    await updateNotebookWithNewMaterialQuery(notebookRef, materialRefs);
}

export const handleNotebookDeletion = async (notebookId)=>{
    try{

        // get the chats and bulk delete
        let chatSnaps = await db.collection('Chat').where('notebookID', '==', notebookId).get();
        let chatIds = chatSnaps.docs.map((doc)=>doc.id);
        await handleBulkDeleteChat(notebookId, chatIds);
        await bucket.deleteFiles({prefix:`notebooks/${notebookId}/`});
        await bucket.deleteFiles({prefix:`videos/${notebookId}/`})
        // delete the qdrant collection
        await qdrantClient.deleteCollection(notebookId);
        await deleteNotebookQuery(notebookId);
    }catch(err){
        // switch it back to isDeleted false
        console.error('Notebook deletion failed:', err);
    }
}

export const handleBulkNotebookDeletion = async (notebookIDs) =>{
    try{
        await Promise.all(notebookIDs.map((id)=>handleNotebookDeletion(id)));
    }catch (err){
        console.log(`Error in bulk deletions`);
    }
}

export const handleSearchForDeletedNotebooks = async ()=>{
    /**
     * This function is to be used by the cron job to scan for deleted notebooks and pass the ids to the bulk deletion helper function
     */
    let notebookSnaps = await db.collection('Notebook').where('isDeleted', '==', true).get()
    let notebookIds = notebookSnaps.docs.map((doc)=>doc.id);
    return notebookIds

}

export const handleSearchForDeletedUsers = async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // OPTIMIZATION: Added .limit(200)
    // It is better to process 200 users every minute successfully 
    // than try to process 5000 and crash.
    const userSnaps = await db
        .collection('User')
        .where('isDeleted', '==', true)
        .where('deletedAt', '<=', oneDayAgo)
        .limit(200) 
        .get();

    return userSnaps.docs.map(doc => doc.id);
};

export const handleDeleteUser = async (userId) => {
    // Use a batch to delete user and profile efficiently
    const batch = db.batch();
    const userRef = db.collection('User').doc(userId);
    const userProfileRef = db.collection('UserProfile').doc(userId);
    batch.delete(userRef);
    batch.delete(userProfileRef);
    // Promise is returned directly for better chaining/awaiting
    return batch.commit();
};

export const handleBulkDeleteUsers = async (userIds = []) => {
    if (!userIds.length) return;

    // OPTIMIZATION: Create one batch for all users
    // Note: If userIds.length > 250, you must chunk this loop 
    // because Firestore allows max 500 ops per batch (250 users * 2 ops = 500).
    // Assuming the search limit is 200, this is safe.
    
    const batch = db.batch();

    userIds.forEach(userId => {
        const userRef = db.collection('User').doc(userId);
        const userProfileRef = db.collection('UserProfile').doc(userId);

        batch.delete(userRef);
        batch.delete(userProfileRef);
    });

    // One single network request to delete everyone
    await batch.commit();
};

// Helper to chunk arrays
const chunkArray = (arr, size) => 
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
      arr.slice(i * size, i * size + size)
);
  
export const handleBulkNotebookIdRetrieval = async (userIds = []) => {
    if (!userIds.length) return [];

    // 1. Chunk userIds into groups of 10 (Firestore 'IN' query limit)
    const chunks = chunkArray(userIds, 10);

    const retrievalPromises = chunks.map(chunk => {
        // Convert string IDs to Document References because your original code
        // compared 'userID' == db.collection('User').doc(userId)
        const userRefs = chunk.map(id => db.collection('User').doc(id));

        return db.collection('Notebook')
            .where('userID', 'in', userRefs) // OPTIMIZATION: One query for 10 users
            .get();
    });

    const snaps = await Promise.all(retrievalPromises);
    
    // Flatten results
    return snaps.flatMap(snap => snap.docs.map(doc => doc.id));
};
export const handleDeleteChat = async (notebookId, chatId)=>{
     // delete chat related stuff on db
     await deleteChatQuery(chatId);
     await bucket.deleteFiles({prefix:`notebooks/${notebookId}/chats/${chatId}/`})
}

export const handleBulkDeleteChat = async (notebookId, chatIds)=>{
    try{
        await Promise.all(
            chatIds.map(async (chatId)=>{
                await handleDeleteChat(notebookId, chatId)
            })
        )
    }catch(err){
        console.log(`[ERROR]:Bulk delete chat:${err}`);
    }
}

export const handleSendToVideoGen = async (data)=>{
    const response = await fetch('https://video-gen-1088390451754.us-east4.run.app/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data.args, userID: data.uid, chatID: data.chatId })
      });
    return response
}

/*
  Generate a detailed summary of a notebook by accessing all chunks
  Input: notebookId: string
  Output: string - A comprehensive summary explaining every concept present in the notebook
*/
export const handleNotebookDetailedSummary = async (notebookId) => {
    try {
        // 1. Get the notebook document
        const notebookRef = db.collection('Notebook').doc(notebookId);
        const notebookSnap = await notebookRef.get();
        
        if (!notebookSnap.exists) {
            throw new Error(`Notebook with ID ${notebookId} not found`);
        }

        const notebookData = notebookSnap.data();
        const materialRefs = notebookData.materialRefs || [];

        if (materialRefs.length === 0) {
            return 'This notebook does not contain any materials yet.';
        }

        // 2. Collect all chunk references from all materials
        const allChunkRefs = [];
        const chunkMetadata = [];

        // Fetch all materials in parallel for better performance
        const materialSnaps = await Promise.all(materialRefs.map(ref => ref.get()));
        
        for (let i = 0; i < materialSnaps.length; i++) {
            const materialSnap = materialSnaps[i];
            if (!materialSnap.exists) continue;

            const materialData = materialSnap.data();
            const chunkRefs = materialData.chunkRefs || [];

            // Get chunk documents to retrieve metadata
            if (chunkRefs.length > 0) {
                const chunkSnaps = await db.getAll(...chunkRefs);
                chunkSnaps.forEach((chunkSnap, index) => {
                    if (chunkSnap.exists) {
                        const chunkData = chunkSnap.data();
                        allChunkRefs.push(chunkRefs[index]);
                        chunkMetadata.push({
                            chunkId: chunkSnap.id,
                            pageNumber: chunkData.pageNumber || null,
                            materialName: materialData.name || 'Unknown Material'
                        });
                    }
                });
            }
        }

        if (allChunkRefs.length === 0) {
            return 'This notebook does not contain any processed chunks yet.';
        }

        // 3. Retrieve all chunk texts from storage
        const chunkBasePath = `notebooks/${notebookId}/chunks/`;
        const chunkPaths = allChunkRefs.map(chunkRef => `${chunkBasePath}${chunkRef.id}.json`);
        
        const chunkContents = await handleBulkChunkRetrieval(chunkPaths);

        // 4. Format chunks with metadata for the AI model
        // Combine chunk text with metadata for better context
        const formattedChunks = chunkContents.map((chunkContent, index) => {
            const metadata = chunkMetadata[index];
            // Handle different chunk content formats
            let text;
            if (typeof chunkContent === 'string') {
                text = chunkContent;
            } else if (typeof chunkContent === 'object' && chunkContent !== null) {
                // If it's an object, try to extract text property or stringify
                text = chunkContent.text || chunkContent.content || JSON.stringify(chunkContent);
            } else {
                text = String(chunkContent);
            }
            return `[Material: ${metadata.materialName}, Page: ${metadata.pageNumber || 'N/A'}]\n${text}`;
        });

        // Combine all chunks into a single text for processing
        const allChunksText = formattedChunks.join('\n\n---\n\n');

        // 5. Generate detailed summary using AI model
        const summaryPrompt = `
        **TASK:** Synthesize the provided notebook content into a comprehensive, spoken-word lecture script. 
        The content consists of multiple chunks; you must weave them into a single, cohesive narrative without redundancy.

        **CRITICAL FORMATTING RULES (STRICT):**
        1.  **NO MARKDOWN:** Do not use bold (**), italics (*), headers (#), or bullet points. This text will be read by a Text-to-Speech engine.
        2.  **SPOKEN FLOW:** Use natural punctuation (commas, periods) to control the pacing. 
        3.  **FORMULAS:** If math or technical notation is present, write it phonetically (e.g., write "squared" instead of "^2", "alpha" instead of "α").

        **REQUIRED STRUCTURE:**
        Your response must flow logically through these four sections:

        1.  **The Introduction:**
            * Greet the student as Professor Mwai.
            * Provide a high-level "Roadmap" of what will be covered in this session.

        2.  **The Deep Dive (Key Concepts):**
            * Identify every major theory, principle, or topic.
            * For each concept, provide a clear definition followed immediately by a concrete, real-world analogy suitable for a university student.
            * Explain how these concepts relate to one another (connect the dots).

        3.  **Practical Application:**
            * Explain *why* this matters. How is this applied in the real world?

        4.  **The Conclusion:**
            * Briefly recap the main takeaways.
            * End with an encouraging sign-off.

        **CONTENT TO ANALYZE:**
        ${allChunksText}

        **Generate the lecture script now:**
        `;
        // Define the System Instruction (The Persona)
        // This sets the behavior for the entire interaction
        const systemInstruction = {
            role: 'system',
            parts: [{ 
                text: `You are Professor Mwai, an expert educational content analyzer. 
                Your persona is warm, authoritative, and engaging. 
                You specialize in synthesizing complex educational content into clear, spoken-word style lectures for university students. 
                You prioritize accuracy and clarity over jargon.` 
            }]
        };

        // Define the Generation Config (The Settings)
        const generationConfig = {
            temperature: 0.3, // Lowered for factual consistency
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 8192, // Ensure enough space for long summaries
        };

        // Make the Call
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            systemInstruction: systemInstruction, // Moved out of config
            generationConfig: generationConfig,   // Renamed for clarity
            contents: [{ 
                role: 'user', 
                parts: [{ text: summaryPrompt }] 
            }]
        });

        const summary = response.text || 'Unable to generate summary.';
        return summary;

    } catch (err) {
        console.error(`Error in handleNotebookDetailedSummary for notebook ${notebookId}:`, err);
        throw err;
    }
}