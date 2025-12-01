import { handleRunAgent } from "../models/models.js";
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

// handle reading messages
export async function handleCreateMessage(req, res) {
    let result;
    try {// get the chat Id
        let now = admin.firestore.FieldValue.serverTimestamp();
        let data = req.body;
        let chatID = req.params.chatID;
        let chatRef = db.collection('Chat').doc(chatID);
        // take the attachments and save in cloud storage
        // OPTIMIZATION: Fetch chat doc to get existing summary
        const chatDocSnap = await chatRef.get();
        const chatData = chatDocSnap.data();
        let existingSummary = chatData.summary || '';

        let files;
        if (req.files) {
            files = req.files;
            let attachmentBasePath = `notebooks/${data.notebookID}/chats/${chatID}`
            files = await handleBulkFileUpload(files, attachmentBasePath);
        }
        // create a message ref and add attachements
        createMessageQuery({ chatRef, content: [{ text: data.text }], role: 'user', attachments: files })
        // store the history text only, Will build the attachments for Gemini from the files field in the request
        let message = { role: 'user', parts: [{ text: data.text }] };
        // adding the message to history, because even if the AI generation fails the message will still be seen in history
        if (!chatMap.has(chatID)) {
            chatMap.set(chatID, { history: [], chunks: {} })
        };
        let chatObj = chatMap.get(chatID);
        if (!Array.isArray(chatObj.history)) {
            chatObj.history = [];
            chatMap.set(chatID, chatObj);
        }

        // OPTIMIZATION: Chat Summarization Logic
        // If history is too long (e.g., > 10 turns), summarize the older part
        // We keep the last 10 messages for immediate context + the summary
        const CONTEXT_WINDOW_SIZE = 10;
        chatObj.history.push(message);
        if (chatObj.history.length > CONTEXT_WINDOW_SIZE * 2) {
            // Extract messages to summarize (everything except last CONTEXT_WINDOW_SIZE)
            const messagesToSummarize = chatObj.history.slice(0, chatObj.history.length - CONTEXT_WINDOW_SIZE);
            // Keep the recent ones
            const recentMessages = chatObj.history.slice(chatObj.history.length - CONTEXT_WINDOW_SIZE);

            // Generate new summary asynchronously
            const newSummary = await handleChatSummarization(existingSummary, messagesToSummarize);

            // Update Firestore with new summary
            await chatRef.update({ summary: newSummary });
            existingSummary = newSummary;

            // Update in-memory history: [System Summary, ...Recent Messages]
            // We represent summary as a system message for the Agent context
            chatObj.history = recentMessages;
        }
        // Inject summary into the context passed to the agent if it exists
        // We create a temporary object for the agent so we don't pollute the actual message history array with system prompts repeatedly
        let agentContextObj = {
            ...chatObj,
            history: [...chatObj.history]
        };

        if (existingSummary) {
            agentContextObj.history.unshift({
                role: 'user', // Using user role to ensure model pays attention, or 'model' as preamble
                parts: [{ text: `[CONTEXT SUMMARY]: The following is a summary of the conversation so far: ${existingSummary}` }]
            });
        }
        // run the AI agent to get the response
        result = await handleRunAgent(req, data, agentContextObj, chatRef);
        if (result.message) {
            chatObj.history.push({ role: 'model', parts: [{ text: result.message }] });
        }
    } catch (err) {
        console.log(`ERROR--creating message:${err}`);
        res.status(500).json('Error while creating message');
    }

    res.json(result)

}

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
