import { handleChatSummarization, handleRunAgent } from "../models/models.js";
import { createMessageQuery, deleteChatQuery } from "../models/query.js";
import admin, { bucket, db } from "../services/firebase.js";
import { handleBulkFileUpload } from "../utils/utility.js";
import { LRUCache } from "../utils/lruCache.js";
// In memory chat map store
/* 
{
 [chatID]:chatObj
}
 chatObj -> {
    history:messages[],
    chunks:chunksObj
 }
 chunksObj -> {
    chunkID:concept
 }
*/
// export var chatMap = new Map();
export var chatMap = new LRUCache(500);

export async function handleCreateChat(req, res) {
    try {
        const notebookID = req.body && req.body.notebookID ? req.body.notebookID : req.query?.notebookID;
        if (!notebookID) {
            return res.status(400).json({
                error: 'Notebook ID is required',
                message: 'Please provide notebookID in the body or query parameters',
            });
        }

        let now = admin.firestore.FieldValue.serverTimestamp();
        const userId = req.user.uid;
        const notebookRef = db.collection('Notebook').doc(notebookID);
        const userRef = db.collection('User').doc(userId);
        const chatRef = await db.collection('Chat').add({
            dateCreated: now,
            dateUpdated: now,
            notebookID: notebookRef,
            userID: userRef,
            title: 'New',
            summary: ''
        });

        const createdChat = await chatRef.get();
        res.json({ id: chatRef.id, ...createdChat.data() });
    } catch (error) {
        console.error('Error creating chat:', error);
        res.status(500).json({ error: 'Failed to create chat', message: error.message });
    }
}

export async function handleReadChats(req, res) {
    try {
        // NOTE: MAKE SURE TO CHANGE THIS WHEN AUTH IS IMPLEMENTED
        // TODO: Replace with actual authentication middleware to set req.user
        const notebookID = req.query.notebookID;
        if (!notebookID) {
            return res.status(400).json({
                error: 'Notebook ID is required',
                message: 'Please provide notebookID in the query parameters',
            });
        }
        const notebookRef = db.collection('Notebook').doc(notebookID);
        const chatsRef = db.collection('Chat')
            .where('notebookID', '==', notebookRef)
            .orderBy('dateUpdated', 'desc');
        const chatsSnapshot = await chatsRef.get();

        const chats = chatsSnapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data()
        }));
        res.json(chats);
    } catch (error) {
        console.error('Error fetching chats:', error);
        res.status(500).json({ error: 'Failed to fetch chats', message: error.message });
    }
}

export async function handleDeleteChat(req, res) {
    try {
        let chatID = req.params.chatID;
        let { notebookID } = req.body;
        if (!notebookID) {
            return res.status(400).json({ message: 'womp womp' })
        }
        // delete chat related stuff on db
        await deleteChatQuery(chatID);
        chatMap.delete(chatID);
        await bucket.deleteFiles({ prefix: `notebooks/${notebookID}/chats/${chatID}/` })
        res.status(200).json({ message: 'Chat deleted successfully' });
    } catch (err) {
        console.log(`[ERROR]:${err}`);
        return res.status(500).json({ message: 'Woopsies!' });
    }
}

export async function handleQuizRetrieval(req, res) {
    try {
        const { chatID } = req.params;
        const chatRef = db.collection('Chat').doc(chatID);
        const quizSnapshot = await db.collection('Quizzes')
            .where('chatID', '==', chatRef)
            .limit(1)
            .get();

        if (quizSnapshot.empty) {
            return res.status(404).json({
                error: 'Quiz not found',
                message: `No quiz found for chat ID: ${chatID}`
            });
        }

        const quizDoc = quizSnapshot.docs[0];
        res.json(quizDoc.data());
    } catch (err) {
        console.error('Error retrieving quiz:', err);
        res.status(500).json({
            error: 'Failed to retrieve quiz',
            details: err.message
        });
    }
}


export async function handleCreateMessage(req, res) {
    let result;
    try {
        let now = admin.firestore.FieldValue.serverTimestamp();
        let data = req.body;
        let chatID = req.params.chatID;
        let chatRef = db.collection('Chat').doc(chatID);
        const uid = req.user.uid; // Get UID from middleware

        // ... [EXISTING CODE: fetch summary, handle files] ...
        const chatDocSnap = await chatRef.get();
        const chatData = chatDocSnap.data();
        let existingSummary = chatData.summary || '';

        let files;
        if (req.files) {
            files = req.files;
            let attachmentBasePath = `notebooks/${data.notebookID}/chats/${chatID}`
            files = await handleBulkFileUpload(files, attachmentBasePath);
        }
        
        createMessageQuery({ chatRef, content: [{ text: data.text }], role: 'user', attachments: files })
        let message = { role: 'user', parts: [{ text: data.text }] };
        
        if (!chatMap.has(chatID)) {
            chatMap.set(chatID, { history: [], chunks: {} })
        };
        let chatObj = chatMap.get(chatID);
        if (!Array.isArray(chatObj.history)) {
            chatObj.history = [];
            chatMap.set(chatID, chatObj);
        }

        const CONTEXT_WINDOW_SIZE = 10;
        chatObj.history.push(message);

        if (chatObj.history.length > CONTEXT_WINDOW_SIZE * 2) {
            console.log(`[ChatController] Summarizing chat ${chatID}...`);
            const cutOffIndex = chatObj.history.length - CONTEXT_WINDOW_SIZE;
            const messagesToSummarize = chatObj.history.slice(0, cutOffIndex);
            const recentMessages = chatObj.history.slice(cutOffIndex);
            
            // [MODIFIED CALL]
            const newSummary = await handleChatSummarization(existingSummary, messagesToSummarize, uid);

            await chatRef.update({ summary: newSummary });
            existingSummary = newSummary;
            chatObj.history = recentMessages;
            
            console.log(`[ChatController] Summary updated.`);
        }

        let agentContextObj = {
            ...chatObj,
            history: [...chatObj.history] 
        };

        // Note: handleRunAgent accesses req.user.uid internally
        result = await handleRunAgent(req, data, agentContextObj, chatRef, existingSummary);
        
        if (result.message) {
            chatObj.history.push({ role: 'model', parts: [{ text: result.message }] });
        }
    } catch (err) {
        console.log(`ERROR--creating message:${err}`);
        res.status(500).json('Error while creating message');
    }

    res.json(result)
}

// handle reading messages
export async function handleReadMessages(req, res) {
    // build cache
    let chatID = req.params.chatID;
    let limit = parseInt(req.query.limit) || 20; // OPTIMIZATION: Default limit for lazy loading
    let beforeTimestamp = req.query.before; // ISO String for pagination
    // fetch the messages related to this ID
    let chatRef = db.collection('Chat').doc(chatID);
    let query = db.collection('Message')
        .where('chatID', '==', chatRef)
        .orderBy('timestamp', 'desc') // Get newest first
        .limit(limit);
    if (beforeTimestamp) {
        const timestampDate = new Date(beforeTimestamp);
        const firestoreTimestamp = admin.firestore.Timestamp.fromDate(timestampDate);
        query = query.startAfter(firestoreTimestamp);
    }
    let messageRefs = await query.get();

    // Convert to array and reverse to chronological order (Oldest -> Newest) for frontend display
    let messages = [];
    messageRefs.forEach((doc) => {
        const data = doc.data();
        messages.push({
            id: doc.id,
            role: data.role,
            parts: JSON.parse(data.content),
            attachments: data.attachments,
            timestamp: data.timestamp ? data.timestamp.toDate() : new Date()
        });
    });
    messages.reverse();
    // Update Cache (only if we are fetching the most recent page)
    if (!beforeTimestamp) {
        let chatObj = chatMap.get(chatID);
        // Only cache the raw "history" format expected by Gemini
        const historyForCache = messages.map(m => ({
            role: m.role,
            parts: m.parts
        }));

        if (chatObj) {
            chatObj.history = historyForCache;
        } else {
            chatMap.set(chatID, { history: historyForCache, chunks: {} });
        }
    }
    let messagesUser = messages.filter((message) => message.role !== 'system');
    res.json(messagesUser);
}

export async function handleGetChat(req, res) {
    try {
        const { chatID } = req.params;
        const chatRef = db.collection('Chat').doc(chatID);
        const doc = await chatRef.get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Chat not found' });
        }

        res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
        console.error("Error fetching chat details:", err);
        res.status(500).json({ error: 'Failed to fetch chat details' });
    }
}

// NEW: Update chat (used for autosaving canvas)
export async function handleUpdateChat(req, res) {
    try {
        const { chatID } = req.params;
        const updates = req.body; // { canvasData: string }

        const chatRef = db.collection('Chat').doc(chatID);

        // Only allow updating specific fields to prevent overwriting critical data
        const safeUpdates = {};
        if (updates.canvasData !== undefined) safeUpdates.canvasData = updates.canvasData;
        if (updates.title !== undefined) safeUpdates.title = updates.title;

        if (Object.keys(safeUpdates).length > 0) {
            safeUpdates.dateUpdated = admin.firestore.FieldValue.serverTimestamp();
            await chatRef.update(safeUpdates);
        }

        res.status(200).json({ message: 'Chat updated successfully' });
    } catch (err) {
        console.error("Error updating chat:", err);
        res.status(500).json({ error: 'Failed to update chat' });
    }
}
