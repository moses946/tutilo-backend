/**
 * Background Job: Reprocess Borrowed Materials
 * 
 * Finds materials that borrowed chunks from other documents and
 * reprocesses them to create the user's own chunks.
 * 
 * This job should be run periodically (e.g., every 5 minutes via Cloud Scheduler).
 */

import { db, bucket } from '../services/firebase.js';
import extractContent, { hashBuffer } from './chunking.js';
import { createChunksQuery, updateChunksWithQdrantIds, updateMaterialWithChunks } from '../models/query.js';
import { handleBulkChunkUpload, handleChunkEmbeddingAndStorage } from './utility.js';
import { registerDocumentFingerprint } from './fingerprinting.js';

const BATCH_SIZE = 10; // Process 10 materials per run to avoid overloading

/**
 * Find and reprocess materials that have borrowed chunks.
 * This converts borrowed references into owned chunks.
 */
export async function reprocessBorrowedMaterials() {
    try {
        // Find materials with borrowedFrom field
        const materialsSnapshot = await db.collection('Material')
            .where('borrowedFrom', '!=', null)
            .limit(BATCH_SIZE)
            .get();

        if (materialsSnapshot.empty) {
            console.log('[Reprocess] No borrowed materials to process');
            return { processed: 0 };
        }

        console.log(`[Reprocess] Found ${materialsSnapshot.size} borrowed materials to reprocess`);

        let processed = 0;
        let failed = 0;

        for (const materialDoc of materialsSnapshot.docs) {
            try {
                const materialRef = materialDoc.ref;
                const materialData = materialDoc.data();
                const materialId = materialDoc.id;

                // Get notebook ID from materialData.notebookRef or parse from storage path
                const notebookRef = materialData.notebookID;
                const notebookId = notebookRef?.id || notebookRef;

                if (!notebookId) {
                    console.warn(`[Reprocess] Cannot determine notebookId for material ${materialId}`);
                    continue;
                }

                // Download and reprocess the file
                const storagePath = `notebooks/${notebookId}/materials/${materialData.storagePath}`;

                let fileBuffer;
                try {
                    const [downloadedBuffer] = await bucket.file(storagePath).download();
                    fileBuffer = downloadedBuffer;
                } catch (downloadErr) {
                    console.error(`[Reprocess] Failed to download ${storagePath}:`, downloadErr.message);
                    failed++;
                    continue;
                }

                const fileObj = {
                    buffer: fileBuffer,
                    mimetype: 'application/pdf',
                    originalname: materialData.name
                };

                // Extract content
                const chunks = await extractContent(fileObj);
                if (!chunks || chunks.length === 0) {
                    console.warn(`[Reprocess] No text extracted for material ${materialId}`);
                    failed++;
                    continue;
                }

                // Delete old borrowed chunk references
                const oldChunkRefs = materialData.chunkRefs || [];
                if (oldChunkRefs.length > 0) {
                    const batch = db.batch();
                    oldChunkRefs.forEach(chunkRef => {
                        if (chunkRef && chunkRef.id) {
                            batch.delete(db.collection('Chunk').doc(chunkRef.id));
                        }
                    });
                    await batch.commit();
                }

                // Create new owned chunks
                const chunkRefs = await createChunksQuery(chunks, materialRef);
                const chunkBasePath = `notebooks/${notebookId}/chunks`;
                const chunkItems = chunks.map((chunk, index) => ({ ...chunk, name: chunkRefs[index].id }));

                await Promise.all([
                    handleBulkChunkUpload(chunkItems, chunkBasePath),
                    updateMaterialWithChunks(materialRef, chunkRefs)
                ]);

                // Create embeddings in Qdrant
                const qdrantPointIds = await handleChunkEmbeddingAndStorage(chunks, chunkRefs, notebookId, 256);
                await updateChunksWithQdrantIds(chunkRefs, qdrantPointIds);

                // Register fingerprint (now with owned chunks)
                const contentHash = hashBuffer(fileBuffer);
                const chunkIds = chunkRefs.map(ref => ref.id);
                const userId = materialData.userId || 'unknown';
                await registerDocumentFingerprint(contentHash, notebookId, materialId, userId, chunkIds);

                // Clear borrowedFrom flag
                await materialRef.update({
                    borrowedFrom: null,
                    reprocessedAt: new Date()
                });

                console.log(`[Reprocess] Successfully reprocessed material ${materialId}`);
                processed++;

            } catch (materialErr) {
                console.error(`[Reprocess] Error processing material ${materialDoc.id}:`, materialErr);
                failed++;
            }
        }

        console.log(`[Reprocess] Completed: ${processed} processed, ${failed} failed`);
        return { processed, failed };

    } catch (err) {
        console.error('[Reprocess] Job failed:', err);
        throw err;
    }
}

export default reprocessBorrowedMaterials;
