import admin, {db} from '../services/firebase.js';

export const createQuizQuery = async (chatId, quizData) => {
  const chatRef = db.collection('Chat').doc(chatId);
  const quizPayload = {
    chatID: chatRef,
    questions: quizData,
    dateCreated: admin.firestore.FieldValue.serverTimestamp(),
  };
  const quizRef = await db.collection('Quizzes').add(quizPayload);
  return quizRef;
};

/*
This function executes the creation of the notebook 
Input:notebook:obj,
notebook:{summary, title}
*/
export const createNotebookQuery = async (notebook) => {
    let now = admin.firestore.FieldValue.serverTimestamp();
    let userRef = db.collection('User').doc(notebook.userID);
    const notebookRef = await db.collection('Notebook').add({
        summary: notebook.summary? notebook.summary : '',
        title: notebook.title,
        userID: userRef,
        dateCreated: now,
        dateUpdated: now,
        isDeleted:false,
        materialRefs: [], // Will be populated with material references
        status: 'processing',
        links: Array.isArray(notebook.links) ? notebook.links : [],
        texts: Array.isArray(notebook.texts) ? notebook.texts : []
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

export const createConceptMapQuery = async (result, notebookRef) => {
    console.log("Inside concept map query");
    const conceptMapRef = await db.collection('ConceptMap').add({
        notebookID:notebookRef,
        graphData:{layout:result, progress:{}},
    })
}

/* 
read queries
*/
export const readNotebooksQuery = async (userID) =>{
    let userRef = db.collection('User').doc(userID);
    // Fetch all notebooks where the userID field matches the given userID
    let notebookRefs = await db.collection('Notebook').where('userID', '==', userRef).where('isDeleted', '==',false).get();
    const notebooks = [];
    notebookRefs.forEach(doc => {
        const data = doc.data();
        notebooks.push({
            id: doc.id,
            ...data
        });
    });
    return notebooks;
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

export const updateNotebookMetadata = async (notebookRef, data = {}) => {
    const payload = {
        dateUpdated: admin.firestore.FieldValue.serverTimestamp()
    };

    if (typeof data.title === 'string') {
        payload.title = data.title;
    }

    if (Array.isArray(data.links)) {
        payload.links = data.links;
    }

    if (Array.isArray(data.texts)) {
        payload.texts = data.texts;
    }

    await notebookRef.update(payload);
}

export const removeMaterialFromNotebook = async (notebookRef, materialId) => {
    const notebookSnap = await notebookRef.get();
    if (!notebookSnap.exists) {
        throw new Error('Notebook not found');
    }

    const data = notebookSnap.data();
    const materialRefs = Array.isArray(data.materialRefs) ? data.materialRefs : [];
    const materialDocRef = db.collection('Material').doc(materialId);

    const filtered = materialRefs.filter((ref) => ref.id !== materialId);

    await notebookRef.update({
        materialRefs: filtered,
        dateUpdated: admin.firestore.FieldValue.serverTimestamp()
    });

    await materialDocRef.delete();
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
    
    // Parallel queries for all related data
    const [materialSnaps, flashcardsSnapshot, chatsSnapshot, conceptMapSnapshot] = await Promise.all([
      // Get materials
      Array.isArray(materialRefs) && materialRefs.length > 0
        ? Promise.all(materialRefs.map((ref) => ref.get()))
        : Promise.resolve([]),
      
      // Get flashcards
      db.collection('Flashcard')
        .where('notebookID', '==', notebookRef)
        .get(),
      
      // Get chats
      db.collection('Chat')
        .where('notebookID', '==', notebookRef)
        .get(),
      db.collection('ConceptMap')
      .where('notebookID', '==', notebookRef)
      .get()
    ]);
  
    // Collect chunk refs from materials
    const chunkRefs = materialSnaps.flatMap((snap) => {
      const { chunkRefs = [] } = snap.data() || {};
      return chunkRefs;
    });
  
    // Get all messages for all chats in parallel
    const chatIds = chatsSnapshot.docs.map(doc => doc.id);
    const messageSnapshots = chatIds.length > 0
      ? await Promise.all(
          chatIds.map(chatId =>
            db.collection('Message')
              .where('chatID', '==', chatId)
              .get()
          )
        )
      : [];
  
    // Collect all refs to delete
    const docsToDelete = [
      ...materialRefs,
      ...chunkRefs,
      ...flashcardsSnapshot.docs.map(doc => doc.ref),
      ...chatsSnapshot.docs.map(doc => doc.ref),
      ...conceptMapSnapshot.docs.map(doc => doc.ref),
      ...messageSnapshots.flatMap(snapshot => snapshot.docs.map(doc => doc.ref))
    ];
  
    // Batch delete in chunks of 500
    const BATCH_SIZE = 500;
    const batchPromises = [];
    
    for (let i = 0; i < docsToDelete.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = docsToDelete.slice(i, i + BATCH_SIZE);
      chunk.forEach((docRef) => batch.delete(docRef));
      batchPromises.push(batch.commit());
      
      // Commit batches in parallel groups of 10 to avoid overwhelming Firestore
      if (batchPromises.length >= 10) {
        await Promise.all(batchPromises);
        batchPromises.length = 0;
      }
    }
    
    // Commit any remaining batches
    if (batchPromises.length > 0) {
        console.log(`These are the batch promises:${batchPromises}`);
      await Promise.all(batchPromises);
    }
  
    // Finally, delete the notebook itself
    await notebookRef.delete();
    console.log(`Notebook with ID:${notebookId} has been deleted`);
};

export const deleteChatQuery = async (chatId)=>{
    const chatRef = db.collection('Chat').doc(chatId);
    // get the messages
    let messagesSnaps  = await db.collection('Message').where('chatID', '==', chatId).get();
    let messagesRefs = messagesSnaps.docs.map(doc=>doc.ref)
    const docsToDelete = [...messagesRefs];
    const BATCH_SIZE = 500;
    const batchPromises = [];
    
    for (let i = 0; i < docsToDelete.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = docsToDelete.slice(i, i + BATCH_SIZE);
      chunk.forEach((docRef) => batch.delete(docRef));
      batchPromises.push(batch.commit());
      
      // Commit batches in parallel groups of 10 to avoid overwhelming Firestore
      if (batchPromises.length >= 10) {
        await Promise.all(batchPromises);
        batchPromises.length = 0;
      }
    }
    
    // Commit any remaining batches
    if (batchPromises.length > 0) {
        console.log(`These are the batch promises:${batchPromises.length}`);
      await Promise.all(batchPromises);
    }
  
    // Finally, delete the chat itself
    await chatRef.delete();
    console.log('chat and messages deleted')
}
/*
This function creates a single flashcard document in Firestore containing all flashcards for a notebook
Input: flashcards: Array of flashcard strings, notebookRef: DocumentReference
*/
export const createFlashcardsQuery = async (flashcards, notebookRef) => {
    let now = admin.firestore.FieldValue.serverTimestamp();
    
    // Create a single document containing all flashcards as an array
    const flashcardDoc = await db.collection('Flashcard').add({
        notebookID: notebookRef,
        flashcards: flashcards, // Array of flashcard strings
        numberOfCards: flashcards.length,
        dateCreated: now,
        dateUpdated: now,
        status: 'active'
    });
    
    return flashcardDoc; // Return single document reference
}

/*
This function updates a notebook with flashcard reference
Input: notebookRef: DocumentReference, flashcardRef: DocumentReference
*/
export const updateNotebookWithFlashcards = async (notebookRef, flashcardRef) => {
    await notebookRef.update({
        flashcardRef: flashcardRef, // Single reference instead of array
        dateUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
}

export const createMessageQuery = async (data)=>{
    let aiMessageRef = await db.collection('Message').add({
        chatID:data.chatRef,
        content:JSON.stringify([{text:data.message}]),
        references:[],
        attachments:data.attachments || [],
        role:data.role,
        timestamp:admin.firestore.FieldValue.serverTimestamp()
    })
}

// User collection related routes
export const createUserQuery = async (data)=>{
    let now = admin.firestore.FieldValue.serverTimestamp();
    let userRef = db.collection('User').doc(data.uid);
    
    // Check if user already exists
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
        // Create User document only if it doesn't exist
        await userRef.set({
            // Set the document ID manually using the provided uid (if available)
            dateJoined:now,
            email:data.email,
            firstName:data.firstName,
            lastName:data.lastName,
            lastLogin:now,
            subscription:'free',
            isOnboardingComplete:false
        })
        console.log(`User created with ID: ${userRef.id}`);
    } else {
        // Update lastLogin for existing user
        await userRef.update({
            lastLogin: now,
            email: data.email || userDoc.data().email,
            firstName: data.firstName || userDoc.data().firstName,
            lastName: data.lastName || userDoc.data().lastName,
            isOnboardingComplete:true
        });
        console.log(`User updated with ID: ${userRef.id}`);
    }
    
    // Check if UserProfile already exists for this user
    const existingProfiles = await db.collection('UserProfile')
        .where('userId', '==', userRef)
        .limit(1)
        .get();
    
    if (existingProfiles.empty) {
        // Create UserProfile document only if none exists
        const onboardingData = data.onboardingData || {};
        const userProfileRef = await db.collection('UserProfile').add({
            dateOfBirth: onboardingData.dateOfBirth || null,
            educationLevel: onboardingData.educationLevel || null,
            location: onboardingData.location || null,
            preferences: onboardingData.preferences || {
                appPreferences: {
                    theme: "light" // Default theme if not provided
                }
            },
            profilePictureURL: data.photoURL || "",
            streak: data.streak || {
                count: 0, // Start with 0 streak
                lastDate: now
            },
            userId: userRef // Reference to the User document
        })
        
        console.log(`UserProfile created with ID: ${userProfileRef.id} for User: ${userRef.id}`);
    } else {
        // Update existing UserProfile with new onboarding data if provided
        const existingProfile = existingProfiles.docs[0];
        const onboardingData = data.onboardingData || {};
        
        if (Object.keys(onboardingData).length > 0) {
            await existingProfile.ref.update({
                dateOfBirth: onboardingData.dateOfBirth || existingProfile.data().dateOfBirth,
                educationLevel: onboardingData.educationLevel || existingProfile.data().educationLevel,
                location: onboardingData.location || existingProfile.data().location,
                preferences: {
                    ...existingProfile.data().preferences,
                    ...onboardingData.preferences
                },
                profilePictureURL: data.photoURL || existingProfile.data().profilePictureURL
            });
            console.log(`UserProfile updated with ID: ${existingProfile.id} for User: ${userRef.id}`);
        } else {
            console.log(`UserProfile already exists with ID: ${existingProfile.id} for User: ${userRef.id}`);
        }
    }
    
    return userRef
}
  