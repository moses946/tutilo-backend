/**
 * Fingerprinting Utilities
 * 
 * Provides document fingerprinting for shared index reuse.
 * Enables instant search by borrowing chunks from identical documents.
 */

import crypto from 'crypto';
import { db } from '../services/firebase.js';

const FINGERPRINT_COLLECTION = 'DocumentFingerprint';

/**
 * Compute SHA-1 hash of a file buffer.
 * @param {Buffer} buffer - File buffer
 * @returns {string} Hex-encoded SHA-1 hash
 */
export function computeDocumentFingerprint(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

/**
 * Find an existing document with the same fingerprint.
 * Returns the first match found (any user's document).
 * 
 * @param {string} contentHash - SHA-1 hash of file content
 * @returns {Promise<Object|null>} Fingerprint record or null
 */
export async function findSimilarDocument(contentHash) {
    try {
        const snapshot = await db.collection(FINGERPRINT_COLLECTION)
            .where('contentHash', '==', contentHash)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return null;
        }

        const doc = snapshot.docs[0];
        return {
            id: doc.id,
            ...doc.data()
        };
    } catch (err) {
        console.error('[Fingerprinting] Error finding similar document:', err);
        return null;
    }
}

/**
 * Register a new document fingerprint after processing.
 * 
 * @param {string} contentHash - SHA-1 hash of file content
 * @param {string} notebookId - Owner notebook ID
 * @param {string} materialId - Owner material ID
 * @param {string} userId - Owner user ID
 * @param {string[]} chunkIds - Array of chunk document IDs
 * @returns {Promise<string>} Created fingerprint document ID
 */
export async function registerDocumentFingerprint(contentHash, notebookId, materialId, userId, chunkIds) {
    try {
        const docRef = await db.collection(FINGERPRINT_COLLECTION).add({
            contentHash,
            notebookId,
            materialId,
            userId,
            chunkIds,
            createdAt: new Date()
        });

        console.log(`[Fingerprinting] Registered fingerprint ${contentHash.substring(0, 8)}... for material ${materialId}`);
        return docRef.id;
    } catch (err) {
        console.error('[Fingerprinting] Error registering fingerprint:', err);
        throw err;
    }
}

/**
 * Delete fingerprint records for a specific material.
 * Called when a material is deleted or reprocessed.
 * 
 * @param {string} materialId - Material ID to remove fingerprints for
 */
export async function removeDocumentFingerprint(materialId) {
    try {
        const snapshot = await db.collection(FINGERPRINT_COLLECTION)
            .where('materialId', '==', materialId)
            .get();

        if (!snapshot.empty) {
            const batch = db.batch();
            snapshot.docs.forEach(doc => batch.delete(doc.ref));
            await batch.commit();
            console.log(`[Fingerprinting] Removed ${snapshot.size} fingerprint(s) for material ${materialId}`);
        }
    } catch (err) {
        console.error('[Fingerprinting] Error removing fingerprint:', err);
    }
}
