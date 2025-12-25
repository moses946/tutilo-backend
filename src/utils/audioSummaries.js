import * as sdk from "microsoft-cognitiveservices-speech-sdk";


// CONSTANTS
const MAX_CHUNK_SIZE = 2800; // Keep slightly below 3000 to be safe with SSML overhead

// HELPER: Split text into chunks without breaking sentences
function chunkText(text, maxLength) {
    if (text.length <= maxLength) return [text];

    const chunks = [];
    let currentChunk = "";
    
    // Split by sentence delimiters but keep the delimiter
    const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];

    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > maxLength) {
            if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());
            currentChunk = sentence; // Start new chunk
        } else {
            currentChunk += sentence;
        }
    }
    if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());
    
    return chunks;
}

// HELPER: Generate Audio for a Single Chunk
async function synthesizeChunk(text, speechConfig) {
    return new Promise((resolve, reject) => {
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
        
        synthesizer.speakTextAsync(
            text,
            (result) => {
                if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                    const buffer = Buffer.from(result.audioData);
                    synthesizer.close();
                    resolve(buffer);
                } else {
                    synthesizer.close();
                    console.error("Chunk failed:", result.errorDetails);
                    reject(new Error("Synthesis failed"));
                }
            },
            (err) => {
                synthesizer.close();
                reject(err);
            }
        );
    });
}

// --- MAIN ENDPOINT ---
export const generateAudio = async (text) => {

    if (!text) {
        throw new Error("Text is required");
    }

    try {
        const speechConfig = sdk.SpeechConfig.fromSubscription(
            process.env.AZURE_SPEECH_KEY, 
            process.env.AZURE_SPEECH_REGION
        );
        // speechConfig.speechSynthesisVoiceName = "en-US-AndrewMultilingualNeural"; 
        speechConfig.speechSynthesisVoiceName = "en-US-Bree:DragonHDLatestNeural"; 
        // speechConfig.speechSynthesisVoiceName = "en-US-Serena:DragonHDLatestNeural"; 

        speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

        // 1. Chunk the text
        const textChunks = chunkText(text, MAX_CHUNK_SIZE);
        console.log(`Processing ${textChunks.length} chunk(s) for text length: ${text.length}`);

        // 2. Process all chunks in parallel (faster) or series (safer for ordering)
        // We use Promise.all to fetch them quickly, then concat in order.
        const audioBuffers = await Promise.all(
            textChunks.map(chunk => synthesizeChunk(chunk, speechConfig))
        );

        // 3. Concatenate all Buffers
        const finalAudio = Buffer.concat(audioBuffers);

        // 4. Send the single merged file
        return finalAudio;

    } catch (e) {
        console.error("Audio Generation Error:", e);
        throw new Error("Audio Generation Error: " + e.message);
    }
};