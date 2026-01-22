import { WebSocket } from 'ws';
import admin, { db } from './firebase.js';
import { logTokenUsage } from '../utils/utility.js';

// const GEMINI_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const GEMINI_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export async function handleLiveSession(ws, req, decodedToken, notebookId) {
    const userId = decodedToken.uid;
    console.log(`[LiveSession] Starting for user: ${userId}, Notebook: ${notebookId}`);

    // 1. Fetch Notebook Context
    let summary = "General Knowledge";
    try {
        const notebookDoc = await db.collection('Notebook').doc(notebookId).get();
        if (notebookDoc.exists && notebookDoc.data().summary) {
            summary = notebookDoc.data().summary;
        }
    } catch (e) {
        console.error("[LiveSession] Error fetching notebook:", e);
    }

    // 2. Setup Chat Logging
    let currentChatId = null;
    const getChatRef = async () => {
        if (currentChatId) return db.collection('Chat').doc(currentChatId);

        // Try to find the most recent active chat for this user/notebook
        const chats = await db.collection('Chat')
            .where('notebookID', '==', db.collection('Notebook').doc(notebookId))
            .where('userID', '==', db.collection('User').doc(userId))
            .orderBy('dateUpdated', 'desc')
            .limit(1)
            .get();

        if (!chats.empty) {
            currentChatId = chats.docs[0].id;
            return chats.docs[0].ref;
        }

        // Fallback: Create a new chat session for logs
        const newChat = await db.collection('Chat').add({
            notebookID: db.collection('Notebook').doc(notebookId),
            userID: db.collection('User').doc(userId),
            title: 'Live Tutor Session',
            dateCreated: admin.firestore.FieldValue.serverTimestamp(),
            dateUpdated: admin.firestore.FieldValue.serverTimestamp(),
            summary: ''
        });
        currentChatId = newChat.id;
        return newChat;
    };

    // 3. Connect to Gemini
    const googleWs = new WebSocket(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`);
    // const googleWs = new WebSocket(`${GEMINI_URL}`);

    googleWs.on('open', () => {
        console.log("[LiveSession] Connected to Gemini");

        const systemPrompt = `
        # ROLE: You are an expert AI Tutor having a voice conversation with a student.
        # CONTEXT SUMMARY: "${summary}"
        
        # CAPABILITIES:
        - You can "see" the user's screen (Canvas drawings or Document text) if they provide context.
        - You can hear the user and respond with voice.

        # PEDAGOGICAL INSTRUCTIONS:
        1. **Socratic Method:** Guide the user with probing questions. Do not just lecture.
        2. **Check Understanding:** Before explaining complex topics, ask what they already know.
        3. **Visual Awareness:** If the user sends a drawing or text, refer to it specifically (e.g., "I see you've drawn a circle...").
        4. **Proactive:** If the user is silent for a while after an explanation, ask a checking question.
        5. **Conciseness:** Keep spoken responses relatively short and conversational.
        `;

        const setupMessage = {
            setup: {
                // model: "gemini-2.0-flash-exp",
                model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
                },
                systemInstruction: { parts: [{ text: systemPrompt }] },
                // Enable audio transcription to save to DB
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                // Enable context window compression to save tokens/memory
                contextWindowCompression: { slidingWindow: {} }
            }
        };
        googleWs.send(JSON.stringify(setupMessage));

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'status', content: 'connected' }));
        }
    });

    googleWs.on('message', async (data) => {
        try {
            const strMsg = data.toString();
            const response = JSON.parse(strMsg);

            // Forward raw message to client (audio playback)
            if (ws.readyState === WebSocket.OPEN) {
                // console.log("[LiveSession] Received Audio Response from Gemini"); // LOG ADDED
                console.log("[LiveSession] Received Audio Response from Gemini");
                ws.send(strMsg);
            }

            // --- LOGGING & ANALYTICS ---

            // 1. Log Token Usage & Notify Client
            if (response.usageMetadata) {
                // Log to DB
                logTokenUsage(userId, "gemini-live-tutor", response.usageMetadata, "tutor_mode");

                // Send specific event to Frontend for developer visibility
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'token_usage',
                        content: response.usageMetadata
                    }));
                }
            }

            // 2. Save User Transcript
            if (response.serverContent?.inputTranscription) {
                // ... (existing transcript logic remains same)
                const text = response.serverContent.inputTranscription.text;
                if (text) {
                    console.log(`[Transcript User]: ${text}`);
                    const chatRef = await getChatRef();
                    await db.collection('Message').add({
                        chatID: chatRef,
                        content: JSON.stringify([{ text }]),
                        role: 'user',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        isTranscript: true
                    });
                }
            }

            // 3. Save Model Transcript
            if (response.serverContent?.outputTranscription) {
                // ... (existing transcript logic remains same)
                const text = response.serverContent.outputTranscription.text;
                if (text) {
                    console.log(`[Transcript Model]: ${text}`);
                    const chatRef = await getChatRef();
                    await db.collection('Message').add({
                        chatID: chatRef,
                        content: JSON.stringify([{ text }]),
                        role: 'model',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        isTranscript: true
                    });
                }
            }

        } catch (e) {
            console.error("[LiveSession] Error processing message:", e);
        }
    });
    googleWs.on('error', (err) => {
        console.error("[LiveSession] Google WS Error:", err);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', content: 'Connection to AI failed' }));
        }
    });

    googleWs.on('close', (data) => {
        console.log("[LiveSession] Google WS Closed", data);
        ws.close();
    });

    // Handle messages FROM Client
    ws.on('message', (message) => {
        try {
            const str = message.toString();

            // Simple check if it looks like JSON (Context updates or Control signals)
            if (str.trim().startsWith('{')) {
                const parsed = JSON.parse(str);

                // FIX: Map camelCase (Frontend) to snake_case (Gemini API)

                // 1. Context Updates
                if (parsed.clientContent) {
                    console.log("[LiveSession] Forwarding Context Update");
                    const formattedMessage = {
                        client_content: {
                            turns: parsed.clientContent.turns,
                            turn_complete: parsed.clientContent.turnComplete
                        }
                    };
                    if (googleWs.readyState === WebSocket.OPEN) {
                        googleWs.send(JSON.stringify(formattedMessage));
                    }
                    return;
                }

                // 2. Realtime Audio Input (if sent as JSON wrapper)
                if (parsed.realtimeInput) {
                    const formattedMessage = {
                        realtime_input: {
                            media_chunks: parsed.realtimeInput.mediaChunks
                        }
                    };
                    if (googleWs.readyState === WebSocket.OPEN) {
                        googleWs.send(JSON.stringify(formattedMessage));
                    }
                    return;
                }
            }
        } catch (e) {
            // Not JSON, likely binary audio chunk. Ignore parsing errors.
        }

        // Forward raw binary data (audio) directly to Gemini
        if (googleWs.readyState === WebSocket.OPEN) {
            // console.log(`[LiveSession] Forwarding Audio Chunk to Gemini (${message.length} bytes)`); // LOG ADDED
            console.log(`[LiveSession] Forwarding Audio Chunk to Gemini (${message.length} bytes)`);
            googleWs.send(message);
        }
    });

    ws.on('close', () => {
        console.log("[LiveSession] Client disconnected");
        if (googleWs.readyState === WebSocket.OPEN) {
            googleWs.close();
        }
    });
}