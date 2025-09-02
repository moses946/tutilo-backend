import admin, {db} from '../services/firebase.js';

/*
This function executes the creation of the notebook 
Input:notebook:obj,
notebook:{summary, title}
*/
export const createNotebookQuery = async (notebook) => {
    let now = admin.firestore.FieldValue.serverTimestamp();
    let userRef = db.collection('User').doc(notebook.userID);
    const notebookRef = await db.collection('Notebook').add({
        summary: notebook.summary,
        title: notebook.title,
        userID: userRef,
        dateCreated: now,
        dateUpdated: now,
        materialRefs: [], // Will be populated with material references
        status: 'processing'
    });
    return notebookRef
}

/*
This function executes the creation of the material entry
Input:notebookRef: DocumentReference, materials: Array of file objects
*/
export const createMaterialQuery = async (notebookRef, materials) => {
    let now = admin.firestore.FieldValue.serverTimestamp();   
    const materialRefs = [];
    
    if(materials.length == 1){
        const materialRef = await db.collection('Material').add({
            notebookID: notebookRef,
            name: materials[0].originalname || materials[0].name,
            status: 'processed',
            storagePath: materials[0].originalname || materials[0].name,
            dateCreated: now,
            chunkRefs: [] // Will be populated with chunk references
        });
        materialRefs.push(materialRef);
        console.log('Material added successfully');
    } else {
        const batch = db.batch();
        materials.forEach((material) => {
            const materialRef = db.collection('Material').doc();
            const materialDoc = {
                notebookID: notebookRef,
                name: material.originalname || material.name,
                status: 'processed',
                storagePath: material.originalname || material.name,
                dateCreated: now,
                
            };
            batch.set(materialRef, materialDoc);
            materialRefs.push(materialRef);
        });
        await batch.commit();
        console.log('Batch documents uploaded successfully');
    }
    
    return materialRefs;
}

/*
This function creates chunk documents in Firestore
Input: chunks: Array of chunk objects, materialRef: DocumentReference
*/
export const createChunksQuery = async (chunks, materialRef) => {
    let now = admin.firestore.FieldValue.serverTimestamp();
    const chunkRefs = [];
    
    if(chunks.length == 1){
        const chunkRef = await db.collection('Chunk').add({
            materialID: materialRef,
            pageNumber: chunks[0].pageNumber,
            tokenCount: chunks[0].tokenCount,
            dateCreated: now,
            qdrantPointId: null // Will be updated after embedding creation
        });
        chunkRefs.push(chunkRef);
    } else {
        const batch = db.batch();
        chunks.forEach((chunk) => {
            const chunkRef = db.collection('Chunk').doc();
            const chunkDoc = {
                materialID: materialRef,
                pageNumber: chunk.pageNumber,
                tokenCount: chunk.tokenCount,
                dateCreated: now,
                qdrantPointId: null // Will be updated after embedding creation
            };
            batch.set(chunkRef, chunkDoc);
            chunkRefs.push(chunkRef);
        });
        await batch.commit();
    }
    
    return chunkRefs;
}

/*
This function updates the notebook with material references
Input: notebookRef: DocumentReference, materialRefs: Array of DocumentReferences
*/
export const updateNotebookWithMaterials = async (notebookRef, materialRefs) => {
    await notebookRef.update({
        materialRefs: materialRefs,
        status: 'completed',
        dateUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
}

/*
This function updates a material with chunk references
Input: materialRef: DocumentReference, chunkRefs: Array of DocumentReferences
*/
export const updateMaterialWithChunks = async (materialRef, chunkRefs) => {
    await materialRef.update({
        chunkRefs: chunkRefs,
        dateUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
}

/*
This function updates chunk documents with their Qdrant point IDs
Input: chunkRefs: Array of DocumentReferences, qdrantPointIds: Array of strings
*/
export const updateChunksWithQdrantIds = async (chunkRefs, qdrantPointIds) => {
    if (chunkRefs.length !== qdrantPointIds.length) {
        throw new Error('Mismatch between chunk references and Qdrant point IDs');
    }
    
    const batch = db.batch();
    
    chunkRefs.forEach((chunkRef, index) => {
        batch.update(chunkRef, {
            qdrantPointId: qdrantPointIds[index],
            dateUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
    });
    
    await batch.commit();
    console.log(`Updated ${chunkRefs.length} chunks with Qdrant point IDs`);
}

/*
This function updates a notebook with a new material reference
Input: notebookRef: DocumentReference, materialRef: DocumentReference
*/
export const updateNotebookWithNewMaterialQuery = async (notebookRef, materialRef) => {
    await notebookRef.update({
        materialRefs: [...notebookRef.data().materialRefs, materialRef],
        status: 'completed',
        dateUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
}

// Delete a notebook and all its associated materials and chunks
export const deleteNotebookQuery = async (notebookId) => {
    const notebookRef = db.collection("Notebook").doc(notebookId);
    const notebookSnap = await notebookRef.get();
  
    if (!notebookSnap.exists) {
      throw new Error(`Notebook with id ${notebookId} does not exist.`);
    }
  
    const { materialRefs = [] } = notebookSnap.data();
    if (!Array.isArray(materialRefs) || materialRefs.length === 0) {
      // No materials → just delete the notebook
      await notebookRef.delete();
      return;
    }
  
    // materialRefs are already DocumentReferences
    const materialSnaps = await Promise.all(materialRefs.map((ref) => ref.get()));
  
    // Collect all chunkRefs from materials
    const chunkRefs = materialSnaps.flatMap((snap) => {
      const { chunkRefs = [] } = snap.data() || {};
      return chunkRefs; // These should also be DocumentReferences
    });
  
    // Prepare all docs to delete: materials + chunks
    const docsToDelete = [...materialRefs, ...chunkRefs];
  
    // Firestore batch limit = 500 → chunk if needed
    let BATCH_SIZE = 500;
    for (let i = 0; i < docsToDelete.length; i += BATCH_SIZE) {
      const batch = db.batch();
      docsToDelete.slice(i, i + BATCH_SIZE).forEach((doc) => batch.delete(doc));
      BATCH_SIZE = Math.min(BATCH_SIZE, docsToDelete.length - i);
      await batch.commit();
    }
  
    // Finally, delete the notebook itself
    await notebookRef.delete();
    console.log(`Notebook with ID:${notebookId} has been deleted`);
  };
  