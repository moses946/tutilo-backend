import multer from 'multer';
import {bucket, db} from '../services/firebase.js';
import {ai} from '../models/models.js'
import qdrantClient from '../services/qdrant.js'
import {v4} from 'uuid'
import { updateNotebookWithNewMaterialQuery } from '../models/query.js';
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
        console.log(`This is the destination:${destination}`)
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
    console.log('Embedding...');
    console.log(pages[0]);
    pages = pages.map((page ,index)=>page.text)
    console.log(pages[0]);
    const response = await ai.models.embedContent(
        {
            model:'gemini-embedding-exp-03-07',
            contents:pages,
            taskType: 'RETRIEVAL_DOCUMENT',
            outputDimensionality: 256,
        }
    );
    console.log('Embedding:', response.embeddings.length);
    return response.embeddings
    
}

/*
  Create embeddings for chunks and store in Qdrant
  Input: chunks: Array of chunk objects with text content, chunkRefs: Array of chunk document references
  Output: Array of Qdrant point IDs
*/
export const handleChunkEmbeddingAndStorage = async (chunks, chunkRefs, collectionName = 'notebook_chunks', vectorDim=256) => {
    try {
        console.log(`Creating embeddings for ${chunks.length} chunks...`);
        
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
        
        console.log(`Generated ${response.embeddings.length} embeddings`);
        console.log(`Shape: ${response.embeddings[0].values.length}`)
        
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
                console.log(`Creating collection, there was none: ${collectionName}`);
                await qdrantClient.createCollection(collectionName, {
                    vectors: {
                        size: vectorDim,
                        distance: 'Cosine'
                    }
                });
            }
        } catch (error) {
            if (error.status === 404) {
                console.log(`Creating collection: ${collectionName}`);
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
            console.log(`Uploaded batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(points.length / batchSize)}`);
        }
        
        console.log(`Successfully uploaded ${uploadedPoints.length} points to Qdrant`);
        return uploadedPoints;
        
    } catch (error) {
        console.error('Error in handleChunkEmbeddingAndStorage:', error);
        throw error;
    }
}

export const handleNotebookUpdate = async(notebookID, materialRefs)=>{
    const notebookRef = db.collection('Notebook').doc(notebookID);
  
    await updateNotebookWithNewMaterialQuery(notebookRef, materialRefs);
    console.log('Notebook updated with new material references');
}
