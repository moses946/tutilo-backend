import express from 'express';
import {upload, handleEmbedding, handleFileUpload, handleBulkFileUpload, handleBulkChunkUpload, handleChunkEmbeddingAndStorage} from '../utils/utility.js'
import extractPdfText from '../utils/chunking.js'
import { 
    createMaterialQuery, 
    createNotebookQuery, 
    createChunksQuery, 
    updateNotebookWithMaterials, 
    updateMaterialWithChunks,
    updateChunksWithQdrantIds,
    deleteNotebookQuery,
    readNotebooksQuery,
    createConceptMapQuery,
    updateNotebookWithFlashcards

} from '../models/query.js';
import { bucket, db } from '../services/firebase.js';
import { handleConceptMapGeneration, handleFlashcardGeneration } from '../models/models.js';



const notebookRouter = express.Router();
notebookRouter.post('/', upload.array('files'), handleNotebookCreation);
notebookRouter.delete('/:id', handleNotebookDeletion);
notebookRouter.put('/:id', upload.array('files'),handleNotebookUpdate)
notebookRouter.get('/', async (req, res)=>{
    try{
        // change this later to use req.user
        let userID = req.body.id;
        let result = await readNotebooksQuery(userID);
        res.json(result);
    }catch(err){
        console.log(`Error while fetching notebooks:${err}`);
        res.json(err);
    }
});
notebookRouter.get('/:id', (req, res)=>{});
notebookRouter.patch('/:id', (req, res)=>{});
notebookRouter.delete('/:id', (req, res)=>{});

async function handleNotebookCreation(req, res){
    // Make sure there is an auth middleware that protects this route
    console.log(`Received these files:${req.files}--${req.files[0].originalname}`);
        
    let data = req.body;
    const files = req.files;
    
    try {
        // Step 1: Create a new notebook reference in Firestore
        let notebookRef = await createNotebookQuery(data);
        console.log('Notebook created with ID:', notebookRef.id);
        
        // Step 2: Upload original files to storage
        const noteBookBasePath = `notebooks/${notebookRef.id}/materials`;
        const uploaded = await handleBulkFileUpload(files, noteBookBasePath);
        console.log('Files uploaded to storage');
        
        // Step 3: Create material documents in Firestore and get references
        const materialRefs = await createMaterialQuery(notebookRef, files);
        console.log('Material documents created');
        
        // Step 4: Process each file into chunks and create chunk documents
        const materialChunkMappings = [];
        let chunkRefsCombined = [];
        let chunksCombined = [];
        for(let i = 0; i < files.length; i++) {
            const file = files[i];
            const materialRef = materialRefs[i];
            
            // Extract chunks from the file
            const chunks = await extractPdfText(file.buffer);
            console.log(`Extracted ${chunks.length} chunks from ${file.originalname || file.name}`);
            
            // Create chunk documents in Firestore
            const chunkRefs = await createChunksQuery(chunks, materialRef);
            chunkRefsCombined.push(...chunkRefs)
            chunksCombined.push(...chunks)
            console.log(`Created ${chunkRefs.length} chunk documents for material ${materialRef.name}`);
            const chunkBasePath = `notebooks/${notebookRef.id}/chunks`;
            const chunkItems = chunks.map((chunk, index)=>{
                const chunkRef = chunkRefs[index];
                const chunkPath = chunkRef.id;
                return {...chunk, name: chunkPath};
            })
            await handleBulkChunkUpload(chunkItems, chunkBasePath);

            // Step 5: Create embeddings and store in Qdrant
            const qdrantPointIds = await handleChunkEmbeddingAndStorage(chunks, chunkRefs, notebookRef.id);
            console.log(`Created embeddings and stored ${qdrantPointIds.length} points in Qdrant`);
            
            // Step 6: Update chunk documents with Qdrant point IDs
            await updateChunksWithQdrantIds(chunkRefs, qdrantPointIds);
            console.log(`Updated chunk documents with Qdrant point IDs`);
            
            // Update material with chunk references
            await updateMaterialWithChunks(materialRef, chunkRefs);
            console.log(`Updated material ${materialRef.id} with chunk references`);
            
            materialChunkMappings.push({
                materialId: materialRef.id,
                materialName: file.originalname || file.name,
                chunkCount: chunks.length,
                chunkRefs: chunkRefs,
                qdrantPointIds: qdrantPointIds
            });
        }
        
        // Step 7: Update notebook with material references
        await updateNotebookWithMaterials(notebookRef, materialRefs);
        console.log('Updated notebook with material references');
        let result = await handleConceptMapGeneration(chunkRefsCombined, chunksCombined);

        result = JSON.parse(result)
        let concepts = result.concept_map
        let chunkConceptMap = {}
        concepts.map((concept)=>(
            concept.chunkIds.map((chunkId)=>{
                chunkConceptMap[chunkId]=concept.concept
            })
        ))
        await notebookRef.update({summary:result.summary})
        await createConceptMapQuery(chunkConceptMap, result, notebookRef)
      


        const flashcardRef = await handleFlashcardGeneration(chunkRefsCombined, chunksCombined, notebookRef);
        if (flashcardRef) {
            await updateNotebookWithFlashcards(notebookRef, flashcardRef);
            console.log('Updated notebook with flashcard reference');
        }

        // // Step 8: Upload chunks as JSON blobs to storage (keeping existing functionality)
        // const chunkItems = [];
        // for(const file of files){
        //     const extracts = await extractPdfText(file.buffer);
        //     chunkItems.push({ name: file.originalname || file.name, chunks: extracts });
        // }
        // const chunkBasePath = `notebooks/${notebookRef.id}/chunks`;
        // const uploadedChunks = await handleBulkChunkUpload(chunkItems, chunkBasePath);
        
        // Step 9: Return success response with all created references
        res.status(201).json({
            notebookId: notebookRef.id,
            notebookStatus: 'completed',
            materials: materialChunkMappings.map(mapping => ({
                materialId: mapping.materialId,
                materialName: mapping.materialName,
                chunkCount: mapping.chunkCount,
                qdrantPointsCount: mapping.qdrantPointIds.length
            })),
            storageUploads: {
                materials: uploaded,
                chunks: 'uploadedChunks'
            },
            vectorDatabase: {
                collection: 'notebook_chunks',
                totalPoints: materialChunkMappings.reduce((sum, mapping) => sum + mapping.qdrantPointIds.length, 0)
            },
            flashcards: {
                generated: flashcardRef ? 1 : 0,
                status: flashcardRef ? 'completed' : 'failed'
            },
            message: 'Notebook created successfully with all materials, chunks, embeddings, and flashcards processed'
        });
    } catch(err) {
        console.error('Notebook creation failed:', err);
        res.status(500).json({
            error: 'Notebook creation failed',
            details: err.message
        });
    }
}

async function handleNotebookDeletion(req, res){
    const {id} = req.params;
    try{
        await deleteNotebookQuery(id);
        await bucket.deleteFiles({prefix:`notebooks/${id}/`});
        //await bucket.deleteFiles({ prefix: `notebooks/${id}/` });
        res.json({message: 'Notebook deleted successfully'});
    }catch(err){
        console.error('Notebook deletion failed:', err);
        res.status(500).json({error: 'Notebook deletion failed'});
    }
}

async function handleNotebookUpdate(req, res){
    try{
        console.log(`Received these files:${req.files}--${req.files[0].originalname}`);
        const files = req.files;
        const notebookID = req.params.id;
        const notebookRef = db.collection('Notebook').doc(notebookID);
        // upload the materials to the object store
        const noteBookBasePath = `notebooks/${notebookRef.id}/materials`;
        const uploaded = await handleBulkFileUpload(files, noteBookBasePath);
        
        //Create material documents in Firestore and get references
        const materialRefs = await createMaterialQuery(notebookRef, files);
        console.log('Material documents created');
        // Step 4: Process each file into chunks and create chunk documents
        const materialChunkMappings = [];
        // chunking the materials
        for(let i = 0; i < files.length; i++) {
            const file = files[i];
            const materialRef = materialRefs[i];
            
            // Extract chunks from the file
            const chunks = await extractPdfText(file.buffer);
            console.log(`Extracted ${chunks.length} chunks from ${file.originalname || file.name}`);
            
            // Create chunk documents in Firestore
            const chunkRefs = await createChunksQuery(chunks, materialRef);
            console.log(`Created ${chunkRefs.length} chunk documents for material ${materialRef.id}`);
            const chunkBasePath = `notebooks/${notebookRef.id}/chunks`;
            const chunkItems = chunks.map((chunk, index)=>{
                const chunkRef = chunkRefs[index];
                const chunkPath = chunkRef.id;
                return {...chunk, name: chunkPath};
            })
            await handleBulkChunkUpload(chunkItems, chunkBasePath);

            // Step 5: Create embeddings and store in Qdrant
            const qdrantPointIds = await handleChunkEmbeddingAndStorage(chunks, chunkRefs);
            console.log(`Created embeddings and stored ${qdrantPointIds.length} points in Qdrant`);
            
            // Step 6: Update chunk documents with Qdrant point IDs
            await updateChunksWithQdrantIds(chunkRefs, qdrantPointIds);
            console.log(`Updated chunk documents with Qdrant point IDs`);
            
            // Update material with chunk references
            await updateMaterialWithChunks(materialRef, chunkRefs);
            console.log(`Updated material ${materialRef.id} with chunk references`);
            
            materialChunkMappings.push({
                materialId: materialRef.id,
                materialName: file.originalname || file.name,
                chunkCount: chunks.length,
                chunkRefs: chunkRefs,
                qdrantPointIds: qdrantPointIds
            });
        }
        
    
        await updateNotebookWithMaterials(notebookRef, materialRefs);
        console.log('Updated notebook with new material references'); 
        
        // Generate concept map and flashcards for the new materials
        await handleConceptMapGeneration(chunkRefsCombined, chunksCombined);
        const flashcardRef = await handleFlashcardGeneration(chunkRefsCombined, chunksCombined, notebookRef);
        if (flashcardRef) {
            await updateNotebookWithFlashcards(notebookRef, flashcardRef);
            console.log('Updated notebook with new flashcard reference');
        }
        
        res.json({materialChunkMappings})
    }catch(err){
        console.error('Notebook creation failed:', err);
        res.status(500).json({
            error: 'Notebook creation failed',
            details: err.message
        });
    }
}

export default notebookRouter