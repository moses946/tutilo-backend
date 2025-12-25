import { getModelConfig, planLimits } from "../config/plans.js";
import { handleConceptMapGeneration, handleFlashcardGeneration, handleQuizGeneration } from "../models/models.js";
import { createChunksQuery, createConceptMapQuery, createMaterialQuery, createNotebookQuery, deleteNotebookQuery, readNotebooksQuery, removeMaterialFromNotebook, updateChunksWithQdrantIds, updateMaterialWithChunks, updateNotebookWithFlashcards, updateNotebookWithMaterials } from "../models/query.js";
import admin, { bucket, db } from "../services/firebase.js";
import { convertImageToPdf, convertTextToPdf } from "../utils/pdfConverter.js";
import extractContent from "../utils/chunking.js";
import { handleBulkChunkRetrieval, handleBulkChunkUpload, handleBulkFileUpload, handleChunkEmbeddingAndStorage } from "../utils/utility.js";
import { handleComprehensiveQuizGeneration } from "../models/models.js";


export async function handleGenerateNotebookQuiz(req, res) {
    const { id: notebookId } = req.params;
    try {
        const notebookRef = db.collection('Notebook').doc(notebookId);
        
        // 1. Fetch Concept Map
        const conceptMapDoc = await fetchConceptMapDoc(notebookRef);
        if (!conceptMapDoc) {
            return res.status(404).json({ error: 'Concept map not found' });
        }

        // 2. Select Concepts (Randomly pick up to 10 to avoid token limits)
        const nodes = conceptMapDoc.data.graphData?.layout?.graph?.nodes || [];
        if (nodes.length === 0) return res.json({ questions: [] });

        // Shuffle and slice
        const selectedNodes = nodes.sort(() => 0.5 - Math.random()).slice(0, 10);

        // 3. Prepare Data for AI (Fetch 1 chunk per concept)
        const conceptsForAi = [];
        
        // We need to resolve chunks. To avoid N+1 queries, we'll gather all paths first.
        // For simplicity in this context, we take the first chunkId of each node.
        const chunkIdsToFetch = [];
        const nodeMap = new Map(); // chunkId -> node info

        selectedNodes.forEach(node => {
            if (node.data.chunkIds && node.data.chunkIds.length > 0) {
                const targetChunkId = node.data.chunkIds[0];
                chunkIdsToFetch.push(targetChunkId);
                nodeMap.set(targetChunkId, { id: node.id, label: node.data.label });
            }
        });

        const chunkPaths = chunkIdsToFetch.map(cId => `notebooks/${notebookId}/chunks/${cId}.json`);
        
        // Parallel fetch from storage
        const chunkTexts = await handleBulkChunkRetrieval(chunkPaths);

        chunkTexts.forEach((text, index) => {
            const cId = chunkIdsToFetch[index];
            const nodeInfo = nodeMap.get(cId);
            
            // Clean text (parse if JSON)
            let cleanText = typeof text === 'string' ? text : JSON.stringify(text);
            
            conceptsForAi.push({
                conceptId: nodeInfo.id,
                conceptName: nodeInfo.label,
                text: cleanText.substring(0, 1000) // Truncate to save context window
            });
        });

        // 4. Generate Quiz
        const quizData = await handleComprehensiveQuizGeneration(conceptsForAi);

        res.json({ questions: quizData });

    } catch (err) {
        console.error("Error generating notebook quiz:", err);
        res.status(500).json({ error: 'Failed to generate quiz' });
    }
}

// Helper to preprocess files safely
const preprocessFileForPdfSimple = async (file) => {
    try {
        let pdfBuffer;
        let newFilename = file.originalname;
        let newMimetype = 'application/pdf';

        if (file.mimetype === 'application/pdf') {
            pdfBuffer = file.buffer;
        } else if (file.mimetype.startsWith('image/')) {
            pdfBuffer = await convertImageToPdf(file.buffer, file.mimetype);
            newFilename = file.originalname.replace(/\.[^/.]+$/, "") + ".pdf";
        } else {
            // Fallback: Convert text-based formats to PDF
            try {
                const chunks = await extractContent(file);
                const fullText = chunks.map(c => c.text).join('\n\n');
                pdfBuffer = await convertTextToPdf(fullText);
                newFilename = file.originalname.replace(/\.[^/.]+$/, "") + ".pdf";
            } catch (e) {
                console.error("Simple PDF conversion failed for file:", file.originalname, e);
                // Return original if conversion fails, don't crash
                return {
                    originalFile: file,
                    pdfBuffer: file.buffer,
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
    } catch (err) {
        console.error("Critical error in preprocessing:", err);
        throw err;
    }
};

export async function handleNotebookCreation(req, res){
    console.log("Starting notebook creation...");
    try {
        const { uid, subscription } = req.user;
        const limits = planLimits[subscription];
        
        // 1. Check Limits
        if (subscription === 'free') {
            try {
                // Use the user reference for the query
                const userRef = db.collection('User').doc(uid);
                const notebooksQuery = db.collection('Notebook')
                    .where('userID', '==', userRef)
                    .where('isDeleted', '==', false);
                
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
                // Continue despite count error to avoid blocking user
            }
        }

        let data = req.body;
        const files = req.files || [];

        // 2. Create Notebook Document
        let notebookRef = await createNotebookQuery({ ...data, status: 'processing' });  
        
        // 3. Process Files (Convert to PDF)
        const processedFiles = [];
        for (const file of files) {
            try {
                const result = await preprocessFileForPdfSimple(file);
                processedFiles.push(result);
            } catch (e) {
                console.error(`Failed to preprocess file ${file.originalname}:`, e);
                // Skip failed file or handle gracefully
            }
        }

        const filesToUpload = processedFiles.map(pf => ({
            ...pf.originalFile,
            originalname: pf.newFilename, 
            mimetype: pf.newMimetype,
            buffer: pf.pdfBuffer
        }));      
        
        // 4. Upload to Storage
        const noteBookBasePath = `notebooks/${notebookRef.id}/materials`;
        await handleBulkFileUpload(filesToUpload, noteBookBasePath);

        // 5. Create Database Records
        const materialRefs = await createMaterialQuery(notebookRef, filesToUpload);
        await updateNotebookWithMaterials(notebookRef, materialRefs);

        console.log(`Notebook ${notebookRef.id} created successfully.`);
        res.status(201).json({
            notebookId: notebookRef.id,
            status: 'processing',
            message: 'Notebook created. Processing started in background.'
        });

    } catch (err) {
        console.error('Notebook creation CRITICAL FAILURE:', err);
        // Ensure we send a JSON response even on crash so CORS headers are applied
        if (!res.headersSent) {
            res.status(500).json({ error: 'Notebook creation failed', details: err.message });
        }
    }
}

export async function handleNotebookProcessing(req, res) {
    const { id: notebookId } = req.params;
    const { subscription } = req.user;
    
    try {
        const notebookRef = db.collection('Notebook').doc(notebookId);
        const notebookSnap = await notebookRef.get();
        
        if (notebookSnap.exists && notebookSnap.data().status === 'completed') {
            return res.json({ status: 'completed', message: 'Already processed' });
        }

        const modelLimits = getModelConfig(subscription);
        const vectorDim = modelLimits.vectorDim;
        const materialRefs = notebookSnap.data().materialRefs || [];
        
        let chunkRefsCombined = [];
        let chunksCombined = [];

        for (const materialRef of materialRefs) {
            const materialSnap = await materialRef.get();
            if (!materialSnap.exists) continue;
            
            const materialData = materialSnap.data();
            if (materialData.chunkRefs && materialData.chunkRefs.length > 0) continue; 

            const storagePath = `notebooks/${notebookId}/materials/${materialData.storagePath}`;
            const fileBuffer = await bucket.file(storagePath).download();
            
            const fileObj = {
                buffer: fileBuffer[0],
                mimetype: 'application/pdf', 
                originalname: materialData.name
            };

            const chunks = await extractContent(fileObj);
            const chunkRefs = await createChunksQuery(chunks, materialRef);
            
            const chunkBasePath = `notebooks/${notebookId}/chunks`;
            const chunkItems = chunks.map((chunk, index) => {
                return { ...chunk, name: chunkRefs[index].id };
            })
            
            await Promise.all([
                handleBulkChunkUpload(chunkItems, chunkBasePath),
                updateMaterialWithChunks(materialRef, chunkRefs)
            ]);

            chunkRefsCombined.push(...chunkRefs);
            chunksCombined.push(...chunks);

            const qdrantPointIds = await handleChunkEmbeddingAndStorage(chunks, chunkRefs, notebookId, vectorDim);
            await updateChunksWithQdrantIds(chunkRefs, qdrantPointIds);
        }

        if (chunkRefsCombined.length > 0) {
            let result = await handleConceptMapGeneration(chunkRefsCombined, chunksCombined);
            try {
                if (typeof result === 'string') {
                    result = result.replace(/```json/g, '').replace(/```/g, '').trim();
                }
                const parsedResult = JSON.parse(result);
                await notebookRef.update({ summary: parsedResult.summary });
                await createConceptMapQuery(parsedResult, notebookRef);
            } catch(e) {
                console.error("Concept map parsing error", e);
            }

            const flashcardRef = await handleFlashcardGeneration(chunkRefsCombined, chunksCombined, notebookRef, modelLimits.flashcardModel);
            if (flashcardRef) {
                await updateNotebookWithFlashcards(notebookRef, flashcardRef);
            }
        }

        await notebookRef.update({ status: 'completed' });
        res.json({ status: 'completed', message: 'Processing finished' });

    } catch (err) {
        console.error(`[Processing] Failed for ${notebookId}:`, err);
        const notebookRef = db.collection('Notebook').doc(notebookId);
        await notebookRef.update({ status: 'failed' }); 
        if (!res.headersSent) {
            res.status(500).json({ error: 'Processing failed', details: err.message });
        }
    }
}

export async function handleNotebookStatus(req, res) {
    const { id } = req.params;
    try {
        const notebookRef = db.collection('Notebook').doc(id);
        const doc = await notebookRef.get();
        if (!doc.exists) return res.status(404).json({ error: 'Not found' });
        
        const data = doc.data();
        res.json({ 
            status: data.status || 'processing',
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

        if (deletedMaterialIdsJson) {
            const deletedMaterialIds = JSON.parse(deletedMaterialIdsJson);
            if (Array.isArray(deletedMaterialIds) && deletedMaterialIds.length > 0) {
                const deletePromises = deletedMaterialIds.map(materialId =>
                    removeMaterialFromNotebook(notebookRef, materialId)
                );
                await Promise.all(deletePromises);
            }
        }

        if (files.length > 0) {
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

        const conceptMapDoc = conceptMapSnapshot.docs[0];
        const conceptMapData = conceptMapDoc.data();

        res.json({
            id: conceptMapDoc.id,
            graph: conceptMapData.graphData.layout.graph,
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

    const chunkFilePaths = chunks.map(chunk => `notebooks/${notebookId}/chunks/${chunk.chunkId}.json`);
    const chunkContents = await handleBulkChunkRetrieval(chunkFilePaths);

    chunks.forEach((chunk, index) => {
        chunk.text = chunkContents[index];
    });
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
        const context = await resolveConceptContext({ notebookId, conceptId });

        if (!context) {
            return res.status(404).json({
                error: 'Concept map not found',
            });
        }

        if (!context.exists) {
            return res.status(404).json({
                error: 'Concept not found',
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
                referenceMaterials: referenceMaterialsPayload,
                conceptChunks: conceptContext.chunks,
            };

            chatRef = await db.collection('Chat').add(payload);
        }

        let quizQuestions = [];
        const quizSnapshot = await db.collection('Quizzes')
            .where('chatID', '==', chatRef)
            .limit(1)
            .get();

        if (!quizSnapshot.empty) {
            quizQuestions = quizSnapshot.docs[0].data().questions;
        } else {
            const quizRef = await handleQuizGeneration(chatRef.id, conceptContext.chunks);
            if (quizRef) {
                const newQuizDoc = await quizRef.get();
                quizQuestions = newQuizDoc.data().questions;
            }
        }

        res.json({
            chatId: chatRef.id,
            conceptId,
            conceptName: conceptContext.conceptName,
            references: conceptContext.materials,
            chunks: conceptContext.chunks,
            quiz: quizQuestions
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
        const materialRef = db.collection('Material').doc(materialId);
        const materialSnap = await materialRef.get();

        if (!materialSnap.exists) {
            return res.status(404).json({ error: 'Material not found' });
        }

        const materialData = materialSnap.data();
        const storagePath = materialData.storagePath;
        const normalizedPath = storagePath.startsWith('notebooks/')
            ? storagePath
            : `notebooks/${notebookId}/materials/${storagePath}`;

        const file = bucket.file(normalizedPath);
        const [exists] = await file.exists();
        if (!exists) {
            return res.status(404).json({ error: 'File not found' });
        }

        const [metadata] = await file.getMetadata();
        const contentType = metadata?.contentType || 'application/octet-stream';
        const fileName = materialData.name || metadata?.name || storagePath;

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
        const stream = file.createReadStream();
        stream.pipe(res);
    } catch (err) {
        console.error('Error downloading material:', err);
        res.status(500).json({ error: 'Failed to download material' });
    }
}

export async function handleNotebookFetch(req, res) {
    try {
        const { id } = req.params;
        const notebookRef = db.collection('Notebook').doc(id);
        const notebookSnap = await notebookRef.get();

        if (!notebookSnap.exists) {
            return res.status(404).json({ error: 'Notebook not found' });
        }

        const notebookData = notebookSnap.data();
        let materialsData = [];
        if (Array.isArray(notebookData.materialRefs) && notebookData.materialRefs.length > 0) {
            try {
                const materialSnapshots = await Promise.all(notebookData.materialRefs.map(ref => ref.get()));
                materialsData = materialSnapshots
                    .filter(snap => snap.exists)
                    .map(snap => {
                        const data = snap.data();
                        return {
                            id: snap.id,
                            name: data.name || data.storagePath || 'Untitled Material',
                            storagePath: data.storagePath,
                        };
                    });
            } catch (error) {
                console.warn("Failed to resolve material refs", error);
            }
        }

        const [conceptMapSnapshot, flashcardsSnapshot] = await Promise.all([
            db.collection('ConceptMap').where('notebookID', '==', notebookRef).get(),
            db.collection('Flashcard').where('notebookID', '==', notebookRef).get()
        ]);

        let conceptMapData = null;
        if (!conceptMapSnapshot.empty) {
            conceptMapData = conceptMapSnapshot.docs[0].data();
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
        const chunkRef = db.collection('Chunk').doc(chunkId);
        const chunkSnap = await chunkRef.get();

        if (!chunkSnap.exists) {
            return res.status(404).json({ error: 'Chunk not found' });
        }

        const chunkData = chunkSnap.data();
        const materialRef = chunkData.materialID;
        const materialSnap = await materialRef.get();
        const materialData = materialSnap.data();

        res.json({
            chunkId: chunkId,
            pageNumber: chunkData.pageNumber,
            materialId: materialRef.id,
            materialName: materialData.name,
            storagePath: materialData.storagePath,
            tokenCount: chunkData.tokenCount,
            notebookId: materialData.notebookID?.id
        });

    } catch (err) {
        console.error('Error fetching chunk metadata:', err);
        res.status(500).json({ error: 'Failed to fetch chunk details' });
    }
}

export async function handleNotebookEditFetch(req, res) {
    try {
        const { id } = req.params;
        const notebookRef = db.collection('Notebook').doc(id);
        const notebookSnap = await notebookRef.get();

        if (!notebookSnap.exists) {
            return res.status(404).json({ error: 'Notebook not found' });
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
    const progressData = req.body;

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
        let userID = req.query.id || req.body.id;
        let result = await readNotebooksQuery(userID);
        res.json(result);
    } catch (err) {
        res.status(500).json({
            error: 'Failed to fetch notebooks',
            details: err.message
        });
    }
}