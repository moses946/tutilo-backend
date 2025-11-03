import express from 'express';
import admin, { bucket, db } from '../services/firebase.js';
import {upload, handleEmbedding, handleFileUpload, handleBulkFileUpload, handleBulkChunkUpload, handleChunkEmbeddingAndStorage, generateSignedUrl, handleBulkChunkRetrieval} from '../utils/utility.js'
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
    updateNotebookWithFlashcards,
    updateNotebookMetadata,
    removeMaterialFromNotebook

} from '../models/query.js';
import { handleConceptMapGeneration, handleFlashcardGeneration, handleQuizGeneration } from '../models/models.js';



const notebookRouter = express.Router();
notebookRouter.post('/', upload.array('files'), handleNotebookCreation);
notebookRouter.delete('/:id', handleNotebookDeletion);
notebookRouter.put('/:id', upload.array('files'),handleNotebookUpdate)
notebookRouter.get('/', async (req, res)=>{
    try{
        // change this later to use req.user
        let userID = req.query.id || req.body.id;
        
        if (!userID) {
            return res.status(400).json({
                error: 'User ID is required',
                message: 'Please provide user ID as query parameter or in request body'
            });
        }
        
        let result = await readNotebooksQuery(userID);
        res.json(result);
    }catch(err){
        console.log(`Error while fetching notebooks:${err}`);
        res.status(500).json({
            error: 'Failed to fetch notebooks',
            details: err.message
        });
    }
});
notebookRouter.get('/:id', handleNotebookFetch);
notebookRouter.get('/:id/edit', handleNotebookEditFetch);
// notebookRouter.get('/:id/materials', handleNotebookMaterialsList);
// notebookRouter.delete('/:id/materials/:materialId', handleMaterialDeletion);
notebookRouter.patch('/:id', (req, res)=>{});
notebookRouter.delete('/:id', handleNotebookDeletion);
notebookRouter.get('/:id/conceptMap', handleConceptMapRetrieval);
notebookRouter.get('/:id/concepts', handleConceptList);
notebookRouter.get('/:id/concepts/:conceptId', handleConceptDetail);
notebookRouter.post('/:id/concepts/:conceptId/chat', handleConceptChatCreate);
notebookRouter.get('/:id/materials/:materialId/download', handleMaterialDownload);

notebookRouter.put('/:id/concepts/:conceptId/progress', handleUserProgressUpdate);

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
        await notebookRef.update({summary:result.summary})
        await createConceptMapQuery(result, notebookRef)
      


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
        res.status(200).json({message: 'Notebook deleted successfully'});
    }catch(err){
        console.error('Notebook deletion failed:', err);
        res.status(500).json({error: 'Notebook deletion failed'});
    }
}

async function handleNotebookUpdate(req, res) {
    try {
        const { id: notebookId } = req.params;
        const notebookRef = db.collection('Notebook').doc(notebookId);

        const files = req.files || [];
        const { deletedMaterialIds: deletedMaterialIdsJson, links: linksJson, texts: textsJson } = req.body;

        // Handle deletions
        if (deletedMaterialIdsJson) {
            const deletedMaterialIds = JSON.parse(deletedMaterialIdsJson);
            if (Array.isArray(deletedMaterialIds) && deletedMaterialIds.length > 0) {
                console.log(`Deleting ${deletedMaterialIds.length} materials from notebook ${notebookId}`);
                const deletePromises = deletedMaterialIds.map(materialId => 
                    removeMaterialFromNotebook(notebookRef, materialId)
                );
                await Promise.all(deletePromises);
                console.log('Finished deleting materials.');
            }
        }

        // Handle new file additions
        if (files.length > 0) {
            console.log(`Adding ${files.length} new files to notebook ${notebookId}`);
            const noteBookBasePath = `notebooks/${notebookRef.id}/materials`;
            await handleBulkFileUpload(files, noteBookBasePath);

            const materialRefs = await createMaterialQuery(notebookRef, files);
            console.log('New material documents created');

            let newChunkRefsCombined = [];
            let newChunksCombined = [];
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const materialRef = materialRefs[i];
                
                const chunks = await extractPdfText(file.buffer);
                newChunksCombined.push(...chunks);
                console.log(`Extracted ${chunks.length} chunks from ${file.originalname || file.name}`);
                
                const chunkRefs = await createChunksQuery(chunks, materialRef);
                newChunkRefsCombined.push(...chunkRefs);
                console.log(`Created ${chunkRefs.length} chunk documents for material ${materialRef.id}`);

                const qdrantPointIds = await handleChunkEmbeddingAndStorage(chunks, chunkRefs, notebookId);
                console.log(`Created embeddings and stored ${qdrantPointIds.length} points in Qdrant`);
                
                await updateChunksWithQdrantIds(chunkRefs, qdrantPointIds);
                await updateMaterialWithChunks(materialRef, chunkRefs);
            }
            
            await updateNotebookWithMaterials(notebookRef, materialRefs);
            console.log('Updated notebook with new material references');

            {/* Handle generating a new concept map and new flashcards once new material is added to the notebook */}

            // let result = await handleConceptMapGeneration(newChunkRefsCombined, newChunksCombined);

            // result = JSON.parse(result)
            // let concepts = result.concept_map
            // let chunkConceptMap = {}
            // concepts.map((concept)=>(
            //     concept.chunkIds.map((chunkId)=>{
            //         chunkConceptMap[chunkId]=concept.concept
            //     })
            // ))
            // await notebookRef.update({summary:result.summary})
            // await createConceptMapQuery(chunkConceptMap, result, notebookRef)
        


            // const flashcardRef = await handleFlashcardGeneration(newChunkRefsCombined, newChunksCombined, notebookRef);
            // if (flashcardRef) {
            //     await updateNotebookWithFlashcards(notebookRef, flashcardRef);
            //     console.log('Updated notebook with flashcard reference');
            // }
            
        }

        // Handle new links and texts
        const links = linksJson ? JSON.parse(linksJson) : [];
        const texts = textsJson ? JSON.parse(textsJson) : [];
        
        if (links.length > 0 || texts.length > 0) {
            const notebookSnap = await notebookRef.get();
            const notebookData = notebookSnap.data();
    
            const existingLinks = notebookData.links || [];
            const existingTexts = notebookData.texts || [];
    
            const mergedLinks = [...new Set([...existingLinks, ...links])];
            const mergedTexts = [...new Set([...existingTexts, ...texts])];
            
            await notebookRef.update({
                links: mergedLinks,
                texts: mergedTexts,
            });
        }

        console.log(`Notebook ${notebookId} updated successfully.`);
        res.status(200).json({
            message: 'Notebook updated successfully',
            notebookId: notebookId,
        });

    } catch (err) {
        console.error(`Notebook update failed for ID ${req.params.id}:`, err);
        res.status(500).json({
            error: 'Notebook update failed',
            details: err.message
        });
    }
}

async function handleConceptMapRetrieval(req, res){
    console.log('Retrieval of concept map')
    try {
        const notebookId = req.params.id;
        if (!notebookId) {
            return res.status(400).json({
                error: 'Notebook ID is required',
                message: 'Please provide a notebook ID in the URL'
            });
        }

        // Query the conceptMap collection for the document with this notebookId
        const notebookRef = db.collection('Notebook').doc(notebookId);
        const conceptMapSnapshot = await db
            .collection('ConceptMap')
            .where('notebookID', '==', notebookRef)
            .limit(1)
            .get();

        if (conceptMapSnapshot.empty) {
            return res.status(404).json({
                error: 'Concept map not found',
                message: `No concept map found for notebook ID: ${notebookId}`
            });
        }

        // There should be only one concept map per notebook
        const conceptMapDoc = conceptMapSnapshot.docs[0];
        const conceptMapData = conceptMapDoc.data();

        res.json({
            id: conceptMapDoc.id,
            graph:conceptMapData.graphData.layout.graph,
            // ...conceptMapData
        });
    } catch (err) {
        console.error('Error retrieving concept map:', err);
        res.status(500).json({
            error: 'Failed to retrieve concept map',
            details: err.message
        });
    }
}

async function fetchConceptMapDoc(notebookRef) {
    const conceptMapSnapshot = await db
        .collection('ConceptMap')
        .where('notebookID', '==', notebookRef)
        .limit(1)
        .get();

    if (conceptMapSnapshot.empty) {
        return null;
    }

    const conceptMapDoc = conceptMapSnapshot.docs[0];
    return {
        doc: conceptMapDoc,
        data: conceptMapDoc.data(),
    };
}

const normalizeString = (value) => (value || '').toString().trim().toLowerCase();

function buildConceptListing(conceptMapData) {
    if (!conceptMapData?.graphData?.layout) {
        return [];
    }

    const graphNodes = conceptMapData.graphData.layout?.graph?.nodes || [];

    return graphNodes.map((node) => {
        return {
            conceptId: node.id,
            conceptName: node.data?.label || node.label || node.id,
            chunkIds: node.data?.chunkIds || [],
        };
    });
}



export async function resolveConceptContext({ notebookId, conceptId }) {
    const notebookRef = db.collection('Notebook').doc(notebookId);
    const conceptMapDoc = await fetchConceptMapDoc(notebookRef);

    if (!conceptMapDoc) {
        return null;
    }

    const conceptMapData = conceptMapDoc.data;
    const layout = conceptMapData?.graphData?.layout;
    const graphNodes = layout?.graph?.nodes || [];
    const summary = layout?.summary || '';

    const node = graphNodes.find((n) => n.id === conceptId);
    if (!node) {
        return { exists: false };
    }
    const chunkIds = node.data?.chunkIds || [];

    const chunkSnaps = await Promise.all(
        chunkIds.map((chunkId) => db.collection('Chunk').doc(chunkId).get())
    );

    const materialMap = new Map();
    const chunks = [];

    for (let i = 0; i < chunkSnaps.length; i++) {
        const chunkSnap = chunkSnaps[i];
        if (!chunkSnap.exists) {
            continue;
        }

        const chunkId = chunkSnap.id;
        const chunkData = chunkSnap.data();
        const materialRef = chunkData.materialID;
        const materialId = materialRef?.id;

        if (chunkId) {
            chunks.push({
                chunkId,
                materialId,
                pageNumber: chunkData.pageNumber ?? null,
                tokenCount: chunkData.tokenCount ?? null,
                storagePath: chunkData.storagePath || null,
            });
        }

        if (!materialId) {
            continue;
        }

        if (!materialMap.has(materialId)) {
            materialMap.set(materialId, materialRef);
        }
    }
    
    // Retrieve chunk text content from storage at the very end
    const chunkFilePaths = chunks.map(chunk => `notebooks/${notebookId}/chunks/${chunk.chunkId}.json`);

    const chunkContents = await handleBulkChunkRetrieval(chunkFilePaths);
    
    chunks.forEach((chunk, index) => {
        chunk.text = chunkContents[index];
    });

    const materials = [];

    const appendMaterialFromRef = async (materialRef) => {
        if (!materialRef) return;

        const materialSnap = await materialRef.get();
        if (!materialSnap.exists) {
            return;
        }

        const materialId = materialSnap.id;
        const materialData = materialSnap.data();
        const storagePath = materialData.storagePath;
        const materialName = materialData.name || storagePath || materialId;
        const filePath = storagePath
            ? `notebooks/${notebookId}/materials/${storagePath}`
            : null;

        materials.push({
            materialId,
            materialName,
            storagePath,
            filePath,
        });
    };

    for (const materialRef of materialMap.values()) {
        await appendMaterialFromRef(materialRef);
    }

    if (materials.length === 0) {
        const notebookSnap = await notebookRef.get();
        const notebookData = notebookSnap.data();
        const materialRefs = Array.isArray(notebookData?.materialRefs) ? notebookData.materialRefs : [];

        for (const materialRef of materialRefs) {
            await appendMaterialFromRef(materialRef);
        }
    }

    return {
        notebookId,
        exists: true,
        conceptId,
        conceptName: node.data?.label || node.label || node.id,
        chunkIds,
        summary,
        materials,
        chunks,
    };
}

async function handleConceptList(req, res) {
    try {
        const { id: notebookId } = req.params;
        if (!notebookId) {
            return res.status(400).json({
                error: 'Notebook ID is required',
                message: 'Please provide a valid notebook ID',
            });
        }

        const notebookRef = db.collection('Notebook').doc(notebookId);
        const conceptMapDoc = await fetchConceptMapDoc(notebookRef);

        if (!conceptMapDoc) {
            return res.status(404).json({
                error: 'Concept map not found',
                message: `No concept map found for notebook ID: ${notebookId}`,
            });
        }

        const concepts = buildConceptListing(conceptMapDoc.data);
        res.json({ concepts });
    } catch (err) {
        console.error('Error retrieving concept list:', err);
        res.status(500).json({
            error: 'Failed to retrieve concept list',
            details: err.message,
        });
    }
}

async function handleConceptDetail(req, res) {
    try {
        const { id: notebookId, conceptId } = req.params;
        if (!notebookId || !conceptId) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'Notebook ID and concept ID are required',
            });
        }

        const context = await resolveConceptContext({ notebookId, conceptId });

        if (!context) {
            return res.status(404).json({
                error: 'Concept map not found',
                message: `No concept map found for notebook ID: ${notebookId}`,
            });
        }

        if (!context.exists) {
            return res.status(404).json({
                error: 'Concept not found',
                message: `No concept node found with ID: ${conceptId}`,
            });
        }

        res.json(context);
    } catch (err) {
        console.error('Error retrieving concept detail:', err);
        res.status(500).json({
            error: 'Failed to retrieve concept detail',
            details: err.message,
        });
    }
}

async function handleConceptChatCreate(req, res) {
    try {
        const { id: notebookId, conceptId } = req.params;
        if (!notebookId || !conceptId) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'Notebook ID and concept ID are required',
            });
        }

        const conceptContext = await resolveConceptContext({ notebookId, conceptId });

        if (!conceptContext) {
            return res.status(404).json({
                error: 'Concept map not found',
                message: `No concept map found for notebook ID: ${notebookId}`,
            });
        }

        if (!conceptContext.exists) {
            return res.status(404).json({
                error: 'Concept not found',
                message: `No concept node found with ID: ${conceptId}`,
            });
        }

        const notebookRef = db.collection('Notebook').doc(notebookId);
        const now = admin.firestore.FieldValue.serverTimestamp();

        const userId = req.user && req.user.uid ? req.user.uid : req.body?.userID;
        const fallbackUserId = '7VMHj733cBO0KTSGsSPFlylJaHx1';
        const resolvedUserId = userId || fallbackUserId;
        const userRef = db.collection('User').doc(resolvedUserId);

        const existingChatSnapshot = await db
            .collection('Chat')
            .where('notebookID', '==', notebookRef)
            .where('conceptId', '==', conceptId)
            .limit(1)
            .get();

        let chatRef;
        const referenceMaterialsPayload = conceptContext.materials.map((material) => ({
            materialId: material.materialId,
            materialName: material.materialName,
            storagePath: material.storagePath,
            filePath: material.filePath,
        }));

        if (!existingChatSnapshot.empty) {
            chatRef = existingChatSnapshot.docs[0].ref;
            await chatRef.update({
                dateUpdated: now,
                conceptName: conceptContext.conceptName,
                // conceptSummary: conceptContext.summary || '',
                referenceMaterials: referenceMaterialsPayload,
                conceptChunks: conceptContext.chunks,
            });
        } else {
            const payload = {
                dateCreated: now,
                dateUpdated: now,
                notebookID: notebookRef,
                userID: userRef,
                title: conceptContext.conceptName || 'Concept Chat',
                conceptId,
                conceptName: conceptContext.conceptName,
                // conceptSummary: conceptContext.summary || '',
                // conceptType: 'concept-map',
                referenceMaterials: referenceMaterialsPayload,
                conceptChunks: conceptContext.chunks,
            };

            chatRef = await db.collection('Chat').add(payload);

            // Check if a quiz already exists before generating a new one
            const quizSnapshot = await db.collection('Quizzes')
                .where('chatID', '==', chatRef)
                .limit(1)
                .get();

            if (quizSnapshot.empty) {
                // Generate and store the quiz for the concept only if it doesn't exist
                await handleQuizGeneration(chatRef.id, conceptContext.chunks);
            }
        }

        console.log('Concept chat reference materials:', referenceMaterialsPayload);

        const chunksByMaterial = (conceptContext.chunks || []).reduce((acc, chunk) => {
            const materialId = chunk.materialId?.toString();
            if (materialId) {
                if (!acc[materialId]) {
                    acc[materialId] = [];
                }
                acc[materialId].push(chunk);
            }
            return acc;
        }, {});

        const referencesWithChunks = (conceptContext.materials || []).map(material => ({
            ...material,
            chunks: chunksByMaterial[material.materialId?.toString()] || [],
        }));

        res.json({
            chatId: chatRef.id,
            conceptId,
            conceptName: conceptContext.conceptName,
            // conceptSummary: conceptContext.summary || '',
            references: referencesWithChunks,
        });
    } catch (err) {
        console.error('Error creating concept chat:', err);
        res.status(500).json({
            error: 'Failed to create concept chat',
            details: err.message,
        });
    }
}

export async function handleMaterialDownload(req, res) {
    try {
        const { id: notebookId, materialId } = req.params;
        if (!notebookId || !materialId) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'Notebook ID and material ID are required',
            });
        }

        const materialRef = db.collection('Material').doc(materialId);
        const materialSnap = await materialRef.get();

        if (!materialSnap.exists) {
            return res.status(404).json({
                error: 'Material not found',
                message: `No material found with ID: ${materialId}`,
            });
        }

        const materialData = materialSnap.data();
        const notebookRef = db.collection('Notebook').doc(notebookId);

        if (!materialData.notebookID || materialData.notebookID.id !== notebookRef.id) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Material does not belong to the specified notebook',
            });
        }

        const storagePath = materialData.storagePath;
        if (!storagePath) {
            return res.status(400).json({
                error: 'Storage path missing',
                message: 'Material does not have an associated storage path',
            });
        }

        const normalizedPath = storagePath.startsWith('notebooks/')
            ? storagePath
            : `notebooks/${notebookId}/materials/${storagePath}`;

        const file = bucket.file(normalizedPath);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({
                error: 'File not found',
                message: `No file found at path: ${normalizedPath}`,
            });
        }

        const [metadata] = await file.getMetadata();
        const contentType = metadata?.contentType || 'application/octet-stream';
        const fileName = materialData.name || metadata?.name || storagePath;

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);

        const stream = file.createReadStream();
        stream.on('error', (error) => {
            console.error('Error streaming material file:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: 'Failed to stream material',
                    message: error.message,
                });
            }
        });

        stream.pipe(res);
    } catch (err) {
        console.error('Error downloading material:', err);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Failed to download material',
                details: err.message,
            });
        }
    }
}

async function handleNotebookFetch(req, res) {
    try {
        const { id } = req.params;
        const userId = req.user?.uid;

        if (!id) {
            return res.status(400).json({
                error: 'Notebook ID is required',
                message: 'Please provide a valid notebook ID'
            });
        }

        // Fetch notebook data
        const notebookRef = db.collection('Notebook').doc(id);
        const notebookSnap = await notebookRef.get();

        if (!notebookSnap.exists) {
            return res.status(404).json({
                error: 'Notebook not found',
                message: 'No notebook found with the provided ID'
            });
        }

        const notebookData = notebookSnap.data();
        // Fetch concept map data for the notebook
        const conceptMapSnapshot = await db.collection('ConceptMap')
            .where('notebookID', '==', notebookRef)
            .get();


        let conceptMapData = null;
        if (!conceptMapSnapshot.empty) {
            conceptMapData = conceptMapSnapshot.docs[0].data();
            
            // Progress is stored directly on the concept map
            conceptMapData.progress = conceptMapData.progress || {};
        }

        // Fetch flashcards if they exist
        const flashcardsSnapshot = await db.collection('Flashcard')
            .where('notebookID', '==', notebookRef)
            .get();

        let flashcardsData = null;
        if (!flashcardsSnapshot.empty) {
            flashcardsData = flashcardsSnapshot.docs[0].data();
        }

        res.json({
            notebook: {
                id: notebookSnap.id,
                ...notebookData
            },
            mindmap: conceptMapData,
            flashcards: flashcardsData,
            message: 'Notebook data retrieved successfully'
        });

    } catch (err) {
        console.error('Failed to fetch notebook data:', err);
        res.status(500).json({
            error: 'Failed to fetch notebook data',
            details: err.message
        });
    }
}

async function handleNotebookEditFetch(req, res) {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({
                error: 'Notebook ID is required',
                message: 'Please provide a valid notebook ID'
            });
        }

        const notebookRef = db.collection('Notebook').doc(id);
        const notebookSnap = await notebookRef.get();

        if (!notebookSnap.exists) {
            return res.status(404).json({
                error: 'Notebook not found',
                message: 'No notebook found with the provided ID'
            });
        }

        const notebookData = notebookSnap.data();
        const materialRefs = notebookData.materialRefs || [];
        
        const materials = [];
        for (const materialRef of materialRefs) {
            const materialSnap = await materialRef.get();
            if (materialSnap.exists) {
                const materialData = materialSnap.data();
                const file = bucket.file(`notebooks/${id}/materials/${materialData.storagePath}`);
                const [metadata] = await file.getMetadata();
                const fileSize = metadata.size;

                materials.push({
                    materialId: materialSnap.id,
                    materialName: materialData.name,
                    fileSize: fileSize || 0
                });
            }
        }

        res.json({
            notebookName: notebookData.title,
            materials: materials
        });

    } catch (err) {
        console.error('Failed to fetch notebook data for editing:', err);
        res.status(500).json({
            error: 'Failed to fetch notebook data for editing',
            details: err.message
        });
    }
}

async function handleUserProgressUpdate(req, res) {
    const { id: notebookId, conceptId: nodeId } = req.params;
    const userId = req.user?.uid; // For authorization
    const progressData = req.body;

    if (!userId) {
        return res.status(403).json({ error: 'Authentication required.' });
    }
    
    if (!progressData || (progressData.isVisited === undefined && progressData.quizStatus === undefined)) {
        return res.status(400).json({ error: 'Invalid progress data.' });
    }

    try {
        const notebookRef = db.collection('Notebook').doc(notebookId);
        const conceptMapSnapshot = await db.collection('ConceptMap')
            .where('notebookID', '==', notebookRef)
            .limit(1)
            .get();

        if (conceptMapSnapshot.empty) {
            return res.status(404).json({ error: 'Concept map not found.' });
        }

        const conceptMapRef = conceptMapSnapshot.docs[0].ref;
        
        const updatePayload = {};
        if (progressData.isVisited !== undefined) {
            updatePayload[`progress.${nodeId}.isVisited`] = progressData.isVisited;
        }
        if (progressData.quizStatus) {
            updatePayload[`progress.${nodeId}.quizStatus`] = progressData.quizStatus;
        }
        
        await conceptMapRef.update(updatePayload);

        res.status(200).json({
            message: 'Progress updated successfully',
            notebookId,
            nodeId,
        });
    } catch (err) {
        console.error('Failed to update user progress:', err);
        res.status(500).json({
            error: 'Failed to update user progress',
            details: err.message,
        });
    }
}


export default notebookRouter