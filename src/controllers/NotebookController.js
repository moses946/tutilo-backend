import { getModelConfig, planLimits } from "../config/plans.js";
import { handleConceptMapGeneration, handleFlashcardGeneration, handleQuizGeneration } from "../models/models.js";
import { createChunksQuery, createConceptMapQuery, createMaterialQuery, createNotebookQuery, deleteNotebookQuery, readNotebooksQuery, removeMaterialFromNotebook, updateChunksWithQdrantIds, updateMaterialWithChunks, updateNotebookWithFlashcards, updateNotebookWithMaterials } from "../models/query.js";
import admin, { bucket, db } from "../services/firebase.js";
import { convertImageToPdf, convertTextToPdf } from "../utils/pdfConverter.js";
import extractPdfText from "../utils/chunking.js";
import { handleBulkChunkRetrieval, handleBulkChunkUpload, handleBulkFileUpload, handleChunkEmbeddingAndStorage } from "../utils/utility.js";
import extractContent from "../utils/chunking.js";


const preprocessFileForPdfSimple = async (file) => {
    let pdfBuffer;
    let newFilename = file.originalname;
    let newMimetype = 'application/pdf';

    if (file.mimetype === 'application/pdf') {
        pdfBuffer = file.buffer;
    } else if (file.mimetype.startsWith('image/')) {
        pdfBuffer = await convertImageToPdf(file.buffer, file.mimetype);
        newFilename = file.originalname.replace(/\.[^/.]+$/, "") + ".pdf";
    } else {
        // Fallback: Convert text-based formats to PDF so the viewer works
        // This does a quick extraction just for the PDF visual, NOT for RAG chunks yet
        try {
            const chunks = await extractContent(file);
            const fullText = chunks.map(c => c.text).join('\n\n');
            pdfBuffer = await convertTextToPdf(fullText);
            newFilename = file.originalname.replace(/\.[^/.]+$/, "") + ".pdf";
        } catch (e) {
            console.error("Simple PDF conversion failed", e);
            // Fallback: store original if conversion fails, let background job handle extraction
            // Note: Viewer might fail for this file until processed
            return {
                originalFile: file,
                pdfBuffer: file.buffer, // Save original
                newFilename: file.originalname,
                newMimetype: file.mimetype
            };
        }
    }

    return {
        originalFile: file,
        pdfBuffer,
        newFilename,
        newMimetype
    };
};

export async function handleNotebookCreation(req, res){
    const { uid, subscription } = req.user;
    const limits = planLimits[subscription];
    
    // ... Limit check logic (lines 43-57) remains the same ...
    if (subscription === 'free') {
        try {
            const notebooksQuery = db.collection('notebooks').where('userId', '==', uid);
            const snapshot = await notebooksQuery.count().get();
            const currentNotebookCount = snapshot.data().count;

            if (currentNotebookCount >= limits.maxNotebooks) {
                return res.status(403).json({
                    error: 'Notebook limit reached.',
                    message: `Your 'free' plan allows a maximum of ${limits.maxNotebooks} notebooks.`
                });
            }
        } catch (dbError) {
            console.error('Failed to query notebook count:', dbError);
        }
    }

    let data = req.body;
    const files = req.files || [];

    try {
        // Create Notebook Document immediately with 'processing' status
        let notebookRef = await createNotebookQuery({ ...data, status: 'processing' });  
        
        // Preprocess files (Convert images to PDF, etc.)
        // This is synchronous/await, so large files will take a moment to upload, 
        // but this is necessary to ensure valid files exist for the background job.
        const processedFiles = [];
        for (const file of files) {
            processedFiles.push(await preprocessFileForPdfSimple(file));
        }

        const filesToUpload = processedFiles.map(pf => ({
            ...pf.originalFile,
            originalname: pf.newFilename, 
            mimetype: pf.newMimetype,
            buffer: pf.pdfBuffer
        }));      
        
        // Upload to Storage
        const noteBookBasePath = `notebooks/${notebookRef.id}/materials`;
        await handleBulkFileUpload(filesToUpload, noteBookBasePath);

        // Create Material Records
        const materialRefs = await createMaterialQuery(notebookRef, filesToUpload);
        await updateNotebookWithMaterials(notebookRef, materialRefs);

        // Respond immediately. The Frontend will redirect to NotebookPage, which triggers /process
        res.status(201).json({
            notebookId: notebookRef.id,
            status: 'processing',
            message: 'Notebook created. Processing started in background.'
        });

    } catch (err) {
        console.error('Notebook creation failed:', err);
        res.status(500).json({ error: 'Notebook creation failed', details: err.message });
    }
}

export async function handleNotebookProcessing(req, res) {
    const { id: notebookId } = req.params;
    const { subscription } = req.user;
    
    // We do NOT send a response immediately anymore. 
    // We keep the request open so Cloud Run keeps the CPU allocated.
    
    try {
        const notebookRef = db.collection('Notebook').doc(notebookId);
        const notebookSnap = await notebookRef.get();
        
        // Idempotency: If already completed, return success immediately
        if (notebookSnap.exists && notebookSnap.data().status === 'completed') {
            return res.json({ status: 'completed', message: 'Already processed' });
        }

        const modelLimits = getModelConfig(subscription);
        const vectorDim = modelLimits.vectorDim;
        const materialRefs = notebookSnap.data().materialRefs || [];
        
        let chunkRefsCombined = [];
        let chunksCombined = [];

        // Process materials
        for (const materialRef of materialRefs) {
            const materialSnap = await materialRef.get();
            if (!materialSnap.exists) continue;
            
            const materialData = materialSnap.data();
            
            // Skip if already chunked
            if (materialData.chunkRefs && materialData.chunkRefs.length > 0) continue; 

            // Retrieve file from storage
            const storagePath = `notebooks/${notebookId}/materials/${materialData.storagePath}`;
            const fileBuffer = await bucket.file(storagePath).download();
            
            const fileObj = {
                buffer: fileBuffer[0],
                mimetype: 'application/pdf', // Default assumption or store mime in metadata
                originalname: materialData.name
            };

            // Extract & Chunk
            const chunks = await extractContent(fileObj);
            const chunkRefs = await createChunksQuery(chunks, materialRef);
            
            const chunkBasePath = `notebooks/${notebookId}/chunks`;
            const chunkItems = chunks.map((chunk, index) => {
                return { ...chunk, name: chunkRefs[index].id };
            })
            
            // Parallelize uploads for speed
            await Promise.all([
                handleBulkChunkUpload(chunkItems, chunkBasePath),
                updateMaterialWithChunks(materialRef, chunkRefs)
            ]);

            chunkRefsCombined.push(...chunkRefs);
            chunksCombined.push(...chunks);

            // Embed (this is the heavy part)
            const qdrantPointIds = await handleChunkEmbeddingAndStorage(chunks, chunkRefs, notebookId, vectorDim);
            await updateChunksWithQdrantIds(chunkRefs, qdrantPointIds);
        }

        // Generate AI Assets (Mindmap & Flashcards)
        if (chunkRefsCombined.length > 0) {
            let result = await handleConceptMapGeneration(chunkRefsCombined, chunksCombined);
            try {
                // Sanitize JSON string if AI added markdown blocks
                if (typeof result === 'string') {
                    result = result.replace(/```json/g, '').replace(/```/g, '').trim();
                }
                const parsedResult = JSON.parse(result);
                await notebookRef.update({ summary: parsedResult.summary });
                await createConceptMapQuery(parsedResult, notebookRef);
            } catch(e) {
                console.error("Concept map parsing error", e);
                // Don't fail the whole request just for the map
            }

            const flashcardRef = await handleFlashcardGeneration(chunkRefsCombined, chunksCombined, notebookRef, modelLimits.flashcardModel);
            if (flashcardRef) {
                await updateNotebookWithFlashcards(notebookRef, flashcardRef);
            }
        }

        await notebookRef.update({ status: 'completed' });
        
        // NOW we send the response
        res.json({ status: 'completed', message: 'Processing finished' });

    } catch (err) {
        console.error(`[Processing] Failed for ${notebookId}:`, err);
        const notebookRef = db.collection('Notebook').doc(notebookId);
        await notebookRef.update({ status: 'failed' }); 
        res.status(500).json({ error: 'Processing failed', details: err.message });
    }
}


// [INSERT NEW FUNCTION] Simple status check
export async function handleNotebookStatus(req, res) {
    const { id } = req.params;
    try {
        const notebookRef = db.collection('Notebook').doc(id);
        const doc = await notebookRef.get();
        if (!doc.exists) return res.status(404).json({ error: 'Not found' });
        
        const data = doc.data();
        res.json({ 
            status: data.status || 'processing',
            // Send summary if ready, so we can show it immediately upon completion
            summary: data.summary || null 
        });
    } catch (err) {
        console.error("Status check failed:", err);
        res.status(500).json({ error: 'Failed to fetch status' });
    }
}

export async function handleNotebookDeletion(req, res) {
    const { id } = req.params;
    try {
        // get the notebook reference and update the isDeleted to true then cron job will do the deletion
        let noteookRef = db.collection('Notebook').doc(id)
        await noteookRef.update({ isDeleted: true });
        res.status(200).json({ message: 'Notebook deleted successfully' });
    } catch (err) {
        console.error('Notebook deletion failed:', err);
        res.status(500).json({error: 'Notebook deletion failed'});
    }
}


export async function handleNotebookUpdate(req, res) {
    try {
        const { id: notebookId } = req.params;
        const notebookRef = db.collection('Notebook').doc(notebookId);

        const files = req.files || [];
        const { deletedMaterialIds: deletedMaterialIdsJson, links: linksJson, texts: textsJson } = req.body;

        // Handle deletions
        if (deletedMaterialIdsJson) {
            const deletedMaterialIds = JSON.parse(deletedMaterialIdsJson);
            if (Array.isArray(deletedMaterialIds) && deletedMaterialIds.length > 0) {
                const deletePromises = deletedMaterialIds.map(materialId =>
                    removeMaterialFromNotebook(notebookRef, materialId)
                );
                await Promise.all(deletePromises);
            }
        }

        // Handle new file additions
        if (files.length > 0) {
            const processedFiles = [];
             for (const file of files) {
                 processedFiles.push(await preprocessFileForPdf(file));
             }
 
             const filesToUpload = processedFiles.map(pf => ({
                 ...pf.originalFile,
                 originalname: pf.newFilename,
                 mimetype: pf.newMimetype,
                 buffer: pf.pdfBuffer
             }));
            const noteBookBasePath = `notebooks/${notebookRef.id}/materials`;
            await handleBulkFileUpload(files, noteBookBasePath);
            const materialRefs = await createMaterialQuery(notebookRef, filesToUpload);
            let newChunkRefsCombined = [];
            let newChunksCombined = [];
            
            for (let i = 0; i < filesToUpload.length; i++) {
                const file = filesToUpload[i];
                const materialRef = materialRefs[i];

                const chunks = await extractContent(file);
                newChunksCombined.push(...chunks);

                const chunkRefs = await createChunksQuery(chunks, materialRef);
                newChunkRefsCombined.push(...chunkRefs);

                const qdrantPointIds = await handleChunkEmbeddingAndStorage(chunks, chunkRefs, notebookId);

                await updateChunksWithQdrantIds(chunkRefs, qdrantPointIds);
                await updateMaterialWithChunks(materialRef, chunkRefs);
            }

            await updateNotebookWithMaterials(notebookRef, materialRefs);
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

export async function handleConceptMapRetrieval(req, res) {
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
            graph: conceptMapData.graphData.layout.graph,
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

export async function fetchConceptMapDoc(notebookRef) {
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

export const normalizeString = (value) => (value || '').toString().trim().toLowerCase();

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

    // OPTIMIZATION: Use getAll for batch retrieval instead of Promise.all mapping
    const chunkRefs = chunkIds.map(id => db.collection('Chunk').doc(id));
    let chunkSnaps = [];
    if (chunkRefs.length > 0) {
        chunkSnaps = await db.getAll(...chunkRefs);
    }

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

        if (materialId && !materialMap.has(materialId)) {
            materialMap.set(materialId, materialRef);
        }
    }

    // Retrieve chunk text content from storage at the very end
    const chunkFilePaths = chunks.map(chunk => `notebooks/${notebookId}/chunks/${chunk.chunkId}.json`);

    const chunkContents = await handleBulkChunkRetrieval(chunkFilePaths);

    chunks.forEach((chunk, index) => {
        chunk.text = chunkContents[index];
    });
    // Return chunks sorted by page number for logical navigation
    chunks.sort((a, b) => a.pageNumber - b.pageNumber);

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

export async function handleConceptList(req, res) {
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

export async function handleConceptDetail(req, res) {
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

export async function handleConceptChatCreate(req, res) {
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
        const resolvedUserId = userId
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
        res.json({
            chatId: chatRef.id,
            conceptId,
            conceptName: conceptContext.conceptName,
            // conceptSummary: conceptContext.summary || '',
            references: conceptContext.materials,
            chunks: conceptContext.chunks,
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
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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

export async function handleNotebookFetch(req, res) {
    try {
        const { id } = req.params;
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

        // --- INSERT START ---
        // Resolve Material References
        let materialsData = [];
        if (Array.isArray(notebookData.materialRefs) && notebookData.materialRefs.length > 0) {
            try {
                // Fetch all referenced material documents
                const materialSnapshots = await Promise.all(notebookData.materialRefs.map(ref => ref.get()));

                materialsData = materialSnapshots
                    .filter(snap => snap.exists)
                    .map(snap => {
                        const data = snap.data();
                        return {
                            id: snap.id,
                            name: data.name || data.storagePath || 'Untitled Material',
                            storagePath: data.storagePath,
                            // Include other fields if necessary
                        };
                    });
            } catch (error) {
                console.warn("Failed to resolve material refs", error);
            }
        }
        // --- INSERT END ---


        // Fetch concept map data for the notebook
        const [conceptMapSnapshot, flashcardsSnapshot] = await Promise.all([
            db.collection('ConceptMap').where('notebookID', '==', notebookRef).get(),
            db.collection('Flashcard').where('notebookID', '==', notebookRef).get()
        ]);


        let conceptMapData = null;
        if (!conceptMapSnapshot.empty) {
            conceptMapData = conceptMapSnapshot.docs[0].data();

            // Progress is stored directly on the concept map
            conceptMapData.progress = conceptMapData.progress || {};
        }

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
            materials: materialsData,
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

export async function handleChunkFetch(req, res) {
    try {
        const { chunkId } = req.params;

        if (!chunkId) {
            return res.status(400).json({ error: 'Chunk ID is required' });
        }

        // 1. Get the Chunk Document
        const chunkRef = db.collection('Chunk').doc(chunkId);
        const chunkSnap = await chunkRef.get();

        if (!chunkSnap.exists) {
            return res.status(404).json({ error: 'Chunk not found' });
        }

        const chunkData = chunkSnap.data();

        // 2. Get the associated Material Document
        // The chunk contains a reference to the material
        const materialRef = chunkData.materialID;
        if (!materialRef) {
            return res.status(404).json({ error: 'Material reference missing in chunk' });
        }

        const materialSnap = await materialRef.get();
        if (!materialSnap.exists) {
            return res.status(404).json({ error: 'Associated material not found' });
        }

        const materialData = materialSnap.data();

        // 3. Return combined metadata needed for navigation
        res.json({
            chunkId: chunkId,
            pageNumber: chunkData.pageNumber,
            materialId: materialRef.id,
            materialName: materialData.name,
            storagePath: materialData.storagePath,
            tokenCount: chunkData.tokenCount,
            notebookId: materialData.notebookID?.id // Useful if we need to cross-check context
        });

    } catch (err) {
        console.error('Error fetching chunk metadata:', err);
        res.status(500).json({ error: 'Failed to fetch chunk details' });
    }
}

export async function handleNotebookEditFetch(req, res) {
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

export async function handleUserProgressUpdate(req, res) {
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

export async function handleNotebookRead(req, res) {
    try {
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
    } catch (err) {
        res.status(500).json({
            error: 'Failed to fetch notebooks',
            details: err.message
        });
    }
}
