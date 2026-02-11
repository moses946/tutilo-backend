import speech from "@google-cloud/speech";

const speechClient = new speech.SpeechClient();

/**
 * Handles a Speech-to-Text streaming session over WebSocket.
 * @param {WebSocket} clientWs - The client WebSocket connection.
 */
export function handleSpeechToTextSession(clientWs) {
    console.log("[STT] Starting Google Speech-to-Text session");

    const request = {
        config: {
            encoding: "WEBM_OPUS",
            sampleRateHertz: 48000,
            languageCode: "en-US",
            enableAutomaticPunctuation: true,
        },
        interimResults: true, // Get partial results
    };

    const recognizeStream = speechClient
        .streamingRecognize(request)
        .on("error", (err) => {
            console.error("[STT] Google API Error:", err);
            if (clientWs.readyState === clientWs.OPEN) {
                clientWs.send(JSON.stringify({ type: "error", content: err.message }));
            }
        })
        .on("data", (data) => {
            if (data.results[0] && data.results[0].alternatives[0]) {
                const transcript = data.results[0].alternatives[0].transcript;
                const isFinal = data.results[0].isFinal;

                if (clientWs.readyState === clientWs.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: isFinal ? "recognized" : "recognizing",
                        transcript: transcript,
                    }));
                }
            }
        })
        .on("end", () => {
            console.log("[STT] Google recognize stream ended");
        });

    // When client sends audio data
    clientWs.on("message", (message) => {
        // Message should be a Buffer of audio data
        if (Buffer.isBuffer(message)) {
            recognizeStream.write(message);
        } else {
            // Handle control messages if needed
            try {
                const control = JSON.parse(message.toString());
                if (control.type === "stop") {
                    recognizeStream.end();
                }
            } catch (e) {
                // Not JSON, try treating as audio
                recognizeStream.write(message);
            }
        }
    });

    clientWs.on("close", () => {
        console.log("[STT] Client disconnected, ending stream");
        recognizeStream.end();
    });

    clientWs.on("error", (err) => {
        console.error("[STT] Client WebSocket error:", err);
        recognizeStream.end();
    });

    // Notify client we're ready
    if (clientWs.readyState === clientWs.OPEN) {
        clientWs.send(JSON.stringify({ type: "status", content: "connected" }));
    }
}
