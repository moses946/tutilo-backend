import { handleChatSummarization, handleRunAgent } from "../models/models.js";
import { createMessageQuery, deleteChatQuery } from "../models/query.js";
import admin, { bucket, db } from "../services/firebase.js";
import { handleBulkFileUpload, handleContextHydration } from "../utils/utility.js";
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
            return res.status(400).json({ message: 'Notebook ID is required' })
        }
        // delete chat related stuff on db
        await deleteChatQuery(chatID);
        chatMap.delete(chatID);
        await bucket.deleteFiles({ prefix: `notebooks/${notebookID}/chats/${chatID}/` })
        res.status(200).json({ message: 'Chat deleted successfully' });
    } catch (err) {
        console.log(`[ERROR]:${err}`);
        return res.status(500).json({ message: 'Failed to delete chat' });
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
        const uid = req.user.uid;

        // 1. Fetch Chat Metadata
        const chatDocSnap = await chatRef.get();
        if (!chatDocSnap.exists) {
            return res.status(404).json({ error: "Chat not found" });
        }
        const chatData = chatDocSnap.data();

        // Fetch notebook summary from the Notebook document (not Chat)
        let notebookSummary = '';
        if (chatData.notebookID) {
            const notebookDoc = await chatData.notebookID.get();
            if (notebookDoc.exists) {
                notebookSummary = notebookDoc.data().summary || '';
            }
        }
        let existingSummary = notebookSummary;

        // 2. STATE HYDRATION STRATEGY
        // If this container doesn't have the chat in memory, fetch history from DB
        if (!chatMap.has(chatID)) {
            console.log(`[State] Hydrating context for chat: ${chatID}`);
            const hydratedContext = await handleContextHydration(chatID, chatRef);
            chatMap.set(chatID, hydratedContext);
        }

        let chatObj = chatMap.get(chatID);

        // Safety check if hydration returned malformed data
        if (!Array.isArray(chatObj.history)) {
            chatObj.history = [];
            chatMap.set(chatID, chatObj);
        }

        // ... [Handle Files Logic - Keep Existing] ...
        let files;
        if (req.files) {
            files = req.files;
            let attachmentBasePath = `notebooks/${data.notebookID}/chats/${chatID}`
            files = await handleBulkFileUpload(files, attachmentBasePath);
        }

        // 3. Save User Message to DB
        await createMessageQuery({ chatRef, content: [{ text: data.text }], role: 'user', attachments: files });

        // 4. Update In-Memory State
        let message = { role: 'user', parts: [{ text: data.text }] };
        chatObj.history.push(message);

        // --- Token-Based Summarization Logic ---
        const MAX_CONTEXT_TOKENS = 100000;   // Trigger summarization above this
        const TARGET_CONTEXT_TOKENS = 50000; // Trim down to approximately this
        const CHARS_PER_TOKEN = 4;           // Approximation for token estimation

        const countTokens = (history) => {
            let charCount = 0;
            for (const msg of history) {
                const text = msg.parts?.[0]?.text || '';
                charCount += text.length;
            }
            return Math.ceil(charCount / CHARS_PER_TOKEN);
        };

        const currentTokens = countTokens(chatObj.history);

        if (currentTokens > MAX_CONTEXT_TOKENS) {
            console.log(`[Summarization] Chat ${chatID}: Triggering summarization. Current tokens: ${currentTokens} (limit: ${MAX_CONTEXT_TOKENS})`);

            // Find cutoff point to get below TARGET_CONTEXT_TOKENS
            let tokensToRemove = currentTokens - TARGET_CONTEXT_TOKENS;
            let cutOffIndex = 0;
            let removedTokens = 0;

            for (let i = 0; i < chatObj.history.length; i++) {
                const msgText = chatObj.history[i].parts?.[0]?.text || '';
                removedTokens += Math.ceil(msgText.length / CHARS_PER_TOKEN);
                cutOffIndex = i + 1;
                if (removedTokens >= tokensToRemove) break;
            }

            const messagesToSummarize = chatObj.history.slice(0, cutOffIndex);
            const recentMessages = chatObj.history.slice(cutOffIndex);

            console.log(`[Summarization] Chat ${chatID}: Summarizing ${messagesToSummarize.length} messages (~${removedTokens} tokens). Keeping ${recentMessages.length} recent messages.`);

            const newSummary = await handleChatSummarization(existingSummary, messagesToSummarize, uid);

            await chatRef.update({ summary: newSummary });
            existingSummary = newSummary;

            // Update the in-memory history
            chatObj.history = recentMessages;
            chatMap.set(chatID, chatObj);

            const newTokens = countTokens(chatObj.history);
            console.log(`[Summarization] Chat ${chatID}: Complete. New token count: ${newTokens}. Summary length: ${newSummary?.length || 0} chars.`);
        }

        // 5. Run Agent
        // Pass a copy of history to avoid mutation issues during async operations
        let agentContextObj = {
            ...chatObj,
            history: [...chatObj.history]
        };

        result = await handleRunAgent(req, data, agentContextObj, chatRef, existingSummary);

        // 6. Update History with AI Response
        if (result.message) {
            chatObj.history.push({ role: 'model', parts: [{ text: result.message }] });
            // Update LRU freshness
            chatMap.set(chatID, chatObj);
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
        const historyForCache = messages
            .filter(m => m.role !== 'system') // Filter out system messages
            .map(m => ({
                role: m.role === 'user' ? 'user' : 'model', // Normalize role
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
