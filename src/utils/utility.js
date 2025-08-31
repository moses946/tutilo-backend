import multer from 'multer';
import {bucket} from '../services/firebase.js';
import {ai} from '../models/models.js'
import qdrantClient from '../services/qdrant.js'
import {v4} from 'uuid'
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
        return { path: destinationPath, name: file.originalname, size: file.size };
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
        const safeName = `${item.name}.chunks.json`;
        const destination = `${basePath}/${safeName}`;
        const payload = Buffer.from(JSON.stringify(item.chunks), 'utf-8');
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
            taskType: 'RETRIEVAL_QUERY',
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
export const handleChunkEmbeddingAndStorage = async (chunks, chunkRefs, collectionName = 'notebook_chunks') => {
    try {
        console.log(`Creating embeddings for ${chunks.length} chunks...`);
        
        // Extract text content from chunks
        const texts = chunks.map(chunk => chunk.text);
        
        // Create embeddings using Gemini
        const response = await ai.models.embedContent({
            model: 'gemini-embedding-exp-03-07',
            contents: texts,
            taskType: 'RETRIEVAL_QUERY',
            config:{outputDimensionality: 256},
        });
        
        console.log(`Generated ${response.embeddings.length} embeddings`);
        console.log(`Shape: ${response.embeddings[0].values.length}`)
        
        // Prepare points for Qdrant with chunkID in payload
        const points = response.embeddings.map((embedding, index) => ({
            //  Unique ID
            id:v4(),
            vector: embedding.values,
            payload: {
                chunkID: chunkRefs[index].id,
                pageNumber: chunks[index].pageNumber,
                tokenCount: chunks[index].tokenCount,
                text: chunks[index].text.substring(0, 500), // Store first 500 chars for preview
                createdAt: new Date().toISOString()
            }
        }));
        
        // Ensure collection exists
        try {
            await qdrantClient.getCollection(collectionName);
        } catch (error) {
            if (error.status === 404) {
                console.log(`Creating collection: ${collectionName}`);
                await qdrantClient.createCollection(collectionName, {
                    vectors: {
                        size: 256,
                        distance: 'Cosine'
                    }
                });
            } else {
                throw error;
            }
        }
        
        // Upload points to Qdrant in batches
        const batchSize = 100;
        const uploadedPoints = [];
        
        for (let i = 0; i < points.length; i += batchSize) {
            const batch = points.slice(i, i + batchSize);
            const result = await qdrantClient.upsert(collectionName, {
                points: batch
            });
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
