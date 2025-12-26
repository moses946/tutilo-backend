import { WebSocket } from 'ws';
import { db } from './firebase.js';
import { feynmanPrompt } from '../config/types.js';

const GEMINI_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export async function handleLiveSession(ws, req, decodedToken, notebookId) {
    console.log(`[LiveSession] Starting for user: ${decodedToken.uid}, Notebook: ${notebookId}`);

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

    // 2. Connect to Google Gemini Live API
    const googleWs = new WebSocket(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`);

    // 3. Setup Handshake when Google connects
    googleWs.on('open', () => {
        console.log("[LiveSession] Connected to Gemini");
        
        // Initial Setup Message
        const setupMessage = {
            setup: {
                model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
                },
                systemInstruction: { parts: [{ text: feynmanPrompt(summary) }] },
            }
        };
        googleWs.send(JSON.stringify(setupMessage));
        
        // Notify Client we are ready
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'status', content: 'connected' }));
        }
    });

    googleWs.on('message', (data) => {
        // Forward raw messages from Google to Client
        // Google sends Blob/Binary data or JSON text. 
        // We pass it through.
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    googleWs.on('error', (err) => {
        console.error("[LiveSession] Google WS Error:", err);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', content: 'Connection to AI failed' }));
        }
    });

    googleWs.on('close', () => {
        console.log("[LiveSession] Google WS Closed");
        ws.close();
    });

    // 4. Handle Client Messages
    ws.on('message', (message) => {
        // Message is likely a Buffer (audio) or JSON string
        if (googleWs.readyState === WebSocket.OPEN) {
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