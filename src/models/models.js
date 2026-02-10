import 'dotenv/config';
import { FunctionCallingConfigMode, GoogleGenAI, Type } from "@google/genai";
import { createFlashcardsQuery, createMessageQuery, createQuizQuery } from './query.js';
import admin, { db } from '../services/firebase.js';
import qdrantClient from '../services/qdrant.js';
import { handleBulkChunkRetrieval, handleSendToVideoGen } from '../utils/utility.js';
import { agentPrompt, chatNamingPrompt, conceptMapPrompt, flashcardPrompt, videoGenFunctionDeclaration, chatSummarizationPrompt } from '../config/types.js';
import { getModelConfig } from '../config/plans.js';
import { performance } from 'perf_hooks';
import { userMap } from '../middleware/authMiddleWare.js';
import { logTokenUsage } from '../utils/utility.js';
import { sendStatusToUser } from '../../index.js';

// google genai handler (prefer GOOGLE_API_KEY, fallback to GEMINI_API_KEY)
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("Google GenAI API key not set. Define GOOGLE_API_KEY or GEMINI_API_KEY in your environment (.env).");
}

export const ai = new GoogleGenAI({
  apiKey
});

const retrievalToolDeclaration = {
  name: 'search_notebook',
  description: `Search the user's uploaded study materials (PDFs, notes, documents) in this notebook. 
Use this tool FIRST before answering any question about the notebook topic. 
Returns relevant text chunks with IDs that MUST be cited in your response using [chunkID] format.
If no relevant results are found, you may fall back to general knowledge but must clarify this to the user.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'A semantic search query. Use keywords and concepts from the user question. For best results, rephrase as a statement rather than a question (e.g., "photosynthesis process in plants" instead of "what is photosynthesis?")'
      }
    },
    required: ['query']
  }
};

const declineQueryToolDeclaration = {
  name: 'decline_query',
  description: 'Use this tool ONLY when the user asks a question completely unrelated to the notebook topic. This politely refuses to answer off-topic questions like weather, sports, cooking, general chat, etc.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      reason: {
        type: Type.STRING,
        description: 'Brief explanation of why this is off-topic (e.g., "weather is not related to Biology")',
      },
      suggestedTopic: {
        type: Type.STRING,
        description: 'A suggested on-topic question the user could ask instead'
      }
    },
    required: ['reason']
  }
};


// handle concept map generation 
export const handleConceptMapGeneration = async (chunkRefs, chunks, userId) => {
  const texts = chunkRefs.map((ref, idx) => `<chunkID: ${ref.id}>\n[${chunks[idx].text}]`).join('\n');
  const modelName = 'gemini-2.5-flash';
  const response = await ai.models.generateContent({
    model: modelName,
    contents: texts,
    config: {
      systemInstruction: conceptMapPrompt,
      responseMimeType: 'application/json',
      responseSchema: {
        // ... schema definition ...
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          graph: {
            type: Type.OBJECT,
            properties: {
              nodes: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    data: {
                      type: Type.OBJECT,
                      properties: {
                        label: { type: Type.STRING },
                        chunkIds: { type: Type.ARRAY, items: { type: Type.STRING } },
                      },
                      required: ["label", "chunkIds"],
                    },
                  },
                  required: ["id", "data"],
                },
              },
              edges: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    source: { type: Type.STRING },
                    target: { type: Type.STRING },
                  },
                  required: ["id", "source", "target"],
                },
              },
            },
            required: ["nodes", "edges"],
          },
        },
        required: ["summary", "graph"],
      }
    }
  });

  // [INSERT] Log token usage
  await logTokenUsage(userId, modelName, response.usageMetadata, 'concept_map_generation');

  return response.text
}
export const handleFlashcardGeneration = async (chunkRefs, chunks, notebookRef, flashcardModel, userId) => {
  const texts = chunkRefs.map((ref, idx) => `<chunkID: ${ref.id}>\n[${chunks[idx].text}]`).join('\n');
  const response = await ai.models.generateContent({
    model: flashcardModel,
    systemInstruction: flashcardPrompt(),
    contents: texts,
    config: {
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
      // ... schema ...
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          numberOfCards: { type: Type.NUMBER },
          flashcards: {
            type: Type.ARRAY,
            maxItems: 20,
            items: {
              type: Type.OBJECT,
              properties: {
                type: { type: Type.STRING },
                front: { type: Type.STRING },
                back: { type: Type.STRING, nullable: true }
              },
              required: ["type", "front"]
            }
          },
        },
      },
      propertyOrdering: ["numberOfCards", "flashcards"],
    }
  });

  // [INSERT] Log token usage
  await logTokenUsage(userId, flashcardModel, response.usageMetadata, 'flashcard_generation');

  try {
    const responseData = JSON.parse(response.text);
    if (responseData.flashcards && responseData.flashcards.length > 0 && notebookRef) {
      const flashcardRefs = await createFlashcardsQuery(responseData.flashcards, notebookRef);
      return flashcardRefs;
    } else {
      return [];
    }
  } catch (error) {
    console.error('Error parsing flashcard response or storing in database:', error);
    return [];
  }
}

export const handleChatSummarization = async (existingSummary, messagesToSummarize, userId) => {
  try {
    const conversationText = messagesToSummarize.map(m => {
      const content = m.parts && m.parts[0] && m.parts[0].text ? m.parts[0].text : '[Media/System Message]';
      return `${m.role.toUpperCase()}: ${content}`;
    }).join('\n');

    const prompt = chatSummarizationPrompt(existingSummary, conversationText);
    const modelName = 'gemini-2.5-flash-lite';

    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING }
          }
        },
        thinkingConfig: { thinkingBudget: 0 }
      }
    });

    // [INSERT] Log token usage
    await logTokenUsage(userId, modelName, response.usageMetadata, 'chat_summarization');

    const result = JSON.parse(response.text);
    return result.summary;
  } catch (error) {
    console.error('Error summarizing chat:', error);
    return existingSummary;
  }
}


const executeNotebookSearch = async (notebookId, query, vectorDim, borrowedCollectionIds = []) => {
  try {
    let embedding = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: [query],
      taskType: 'RETRIEVAL_QUERY', // Optimized task type
      config: { outputDimensionality: vectorDim },
    });
    let queryVector = embedding.embeddings[0].values;

    // Search the notebook's own collection + any borrowed collections
    const collectionsToSearch = [notebookId, ...borrowedCollectionIds];
    const allResults = [];

    for (const collectionId of collectionsToSearch) {
      try {
        const qdrantResults = await qdrantClient.search(collectionId, {
          vector: queryVector,
          limit: 5,
          with_payload: true,
        });
        if (qdrantResults && qdrantResults.length > 0) {
          // Tag results with their source collection
          allResults.push(...qdrantResults.map(r => ({ ...r, sourceCollection: collectionId })));
        }
      } catch (collectionErr) {
        // Collection might not exist yet (e.g., new notebook with only borrowed content)
        console.warn(`[Search] Collection ${collectionId} not found or empty`);
      }
    }

    if (allResults.length === 0) return [];

    // Sort by score and take top 5 across all collections
    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, 5);

    // For each result, get chunk from the appropriate notebook's storage
    const chunkDocRefs = topResults.map(r => db.collection('Chunk').doc(r.payload.chunkID));
    const chunkDocs = await db.getAll(...chunkDocRefs);

    // Build chunk paths - use source collection for borrowed chunks
    const chunkPaths = topResults.map((result, index) => {
      const sourceNotebookId = result.sourceCollection;
      return `notebooks/${sourceNotebookId}/chunks/${result.payload.chunkID}.json`;
    });

    const chunksContent = await handleBulkChunkRetrieval(chunkPaths);

    return chunksContent.map((content, index) => {
      const chunkId = topResults[index]?.payload?.chunkID;
      const docData = chunkDocs[index].exists ? chunkDocs[index].data() : {};
      const text = typeof content === 'string' ? content : JSON.stringify(content);

      return {
        chunkId,
        text,
        metadata: {
          pageNumber: docData.pageNumber,
          materialId: docData.materialID?.id,
          tokenCount: docData.tokenCount
        }
      };
    });
  } catch (err) {
    console.error("Retrieval failed:", err);
    return [];
  }
};


export const handleRunAgent = async (req, data, chatObj, chatRef, existingSummary, onChunk) => {
  try {
    const userId = req.user.uid; // Extract ID
    let plan = req.user.subscription;
    var modelLimits = getModelConfig(plan);

    // naming the chat
    if (chatObj.history.length > 1 && chatRef) {
      const chatDoc = await chatRef.get();
      if (chatDoc.exists) {
        const data = chatDoc.data();
        if (data.title === "New") {
          // const startTime = performance.now();
          const namingModel = 'gemini-2.0-flash';
          let title = await ai.models.generateContent({
            model: namingModel,
            contents: JSON.stringify(chatObj.history),
            config: {
              systemInstruction: chatNamingPrompt(chatObj)
            }
          });

          // [INSERT] Log token usage for naming
          await logTokenUsage(userId, namingModel, title.usageMetadata, 'chat_naming');

          // const endTime = performance.now();
          if (title && title.text && typeof title.text === "string") {
            const newTitle = title.text.trim().replace(/^"|"$/g, '');
            await chatRef.update({ title: newTitle });
          }
        }
      }
    }

    // ... [EXISTING CODE: setup context, notebookDoc, summary, inlineData] ...
    chatObj.history = chatObj.history || [];
    chatObj.chunks = chatObj.chunks || {};

    let inlineData;
    if (req.files.length > 0) {
      inlineData = req.files.map((file) => ({ mimeType: file.mimetype, data: Buffer.from(file.buffer).toString('base64') }));
      inlineData = inlineData.map((data) => ({ inlineData: data }));
    }

    let userMessageContent = [{ text: data.text }];
    if (inlineData) {
      userMessageContent = userMessageContent.concat(inlineData);
    }


    var agentResponse = await agentLoop(
      req.user.uid,
      chatObj,
      chatRef,
      userMessageContent,
      existingSummary,
      data.notebookID, // Pass notebookID for the tool
      onChunk // Pass the streaming callback
    );

    return agentResponse;
  } catch (err) {
    console.log(`[ERROR]: handleAgent:${err}`);
    throw Error(err);
  }
}


export const handleQuizGeneration = async (chatId, chunks, userId) => { // Added userId
  try {
    const texts = chunks.map(chunk => {
      const chunkText = chunk.text || (chunk.content && chunk.content[0] && chunk.content[0].text) || '';
      return `<chunkID: ${chunk.chunkId}>\n[${chunkText}]`;
    }).join('\n\n');
    const prompt = `Based on the following text, generate a 10-question multiple-choice quiz.
---
CONTEXT:
${texts}
---
RULES:
1. Output Format:
   Return a JSON array of exactly 10 objects...
   [ ... ]
`;
    // ... rest of prompt ...

    const modelName = 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: `You are an AI quiz generator.`,
        responseMimeType: 'application/json',
        responseSchema: {
          // ... schema ...
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              choices: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                minItems: 4,
                maxItems: 4
              },
              answer: { type: Type.STRING }
            },
            required: ['question', 'choices', 'answer']
          },
          minItems: 10,
          maxItems: 10
        }
      }
    });

    // [INSERT] Log token usage
    if (userId) {
      await logTokenUsage(userId, modelName, response.usageMetadata, 'quiz_generation');
    }

    const quizData = JSON.parse(response.text);

    if (quizData && quizData.length > 0) {
      const quizRef = await createQuizQuery(chatId, quizData);
      return quizRef;
    } else {
      return null;
    }
  } catch (error) {
    console.error('Error generating or storing quiz:', error);
    return null;
  }
};

/**
 * {
 * userId:userObj
 * }
 * 
 * userObj:{
 *  plan:string
 * }
 * 
 * @param {function} onChunk - Optional callback for streaming: (textChunk) => void
 */

export async function agentLoop(userId, chatObj, chatRef, messageContent = [], summary = '', notebookId, onChunk) {
  var userObj = userMap.get(userId);
  var plan = userObj.plan;
  var modelLimits = getModelConfig(plan);
  // 1. Construct Context
  // We include previous chunks in the system prompt area so the model knows what it already has
  const retrievedChunkText = Object.values(chatObj.chunks).join("\n\n");

  // DEBUG LOGGING - Check if prompt data is populated
  console.log(`[Agent Debug] Summary: "${summary || 'EMPTY'}"`);
  console.log(`[Agent Debug] UserObj:`, JSON.stringify({
    firstName: userObj?.firstName,
    plan: userObj?.plan,
    learningPreferences: userObj?.learningPreferences
  }));

  let systemPromptText = agentPrompt(userObj, summary);
  if (retrievedChunkText) {
    systemPromptText += `\n\n<PREVIOUSLY_RETRIEVED_CONTEXT>\n${retrievedChunkText}\n</PREVIOUSLY_RETRIEVED_CONTEXT>`;
  }

  // 2. Prepare History
  // Gemini expects history to alternate User/Model. 
  // We slice off the last element if it's the current user message (caller handles pushing current message usually, but let's standardize)
  // In `ChatController`, we pushed the user message to history. So `chatObj.history` contains the latest message at the end.
  // We need to separate it for `generateContent` which takes `contents` (history + new msg).

  const historyForModel = chatObj.history.slice(0, -1); // All except last
  const currentTurn = [{ role: 'user', parts: messageContent }]; // The last message

  const tools = [
    { functionDeclarations: [retrievalToolDeclaration, videoGenFunctionDeclaration, declineQueryToolDeclaration] }
  ];

  let turnCount = 0;
  const MAX_TURNS = 100; // Prevent infinite loops
  let finalResponseText = "";
  let isMedia = false;
  let aiMessageRef;
  let collectedMetadata = {}; // To send back to UI for citations

  // Start the ReAct Loop
  let currentContents = [...historyForModel, ...currentTurn];

  while (turnCount < MAX_TURNS) {
    // Force tool call on first turn to ensure notebook search happens
    const toolConfig = turnCount === 0 ? {
      functionCallingConfig: {
        mode: FunctionCallingConfigMode.AUTO,
        // allowedFunctionNames: ['search_notebook', 'video_gen', 'decline_query']
      }
    } : undefined;

    // Use generateContentStream for streaming
    const streamingResult = await ai.models.generateContentStream({
      model: modelLimits.agentModel,
      contents: currentContents,
      config: {
        temperature: 0.7,
        tools: tools,
        toolConfig: toolConfig,
        thinkingConfig: {
          thinkingBudget: modelLimits.thinkingBudget
        },
        systemInstruction: systemPromptText,
      }
    });

    console.log('[DEBUG] streamingResult type:', typeof streamingResult);
    console.log('[DEBUG] streamingResult keys:', Object.keys(streamingResult || {}));
    if (streamingResult && streamingResult.stream) {
      console.log('[DEBUG] streamingResult.stream type:', typeof streamingResult.stream);
    } else {
      console.log('[DEBUG] streamingResult.stream is UNDEFINED');
    }

    let aggregatedResponse = {
      candidates: [{
        content: {
          parts: [],
          role: 'model' // Default
        }
      }],
      usageMetadata: {}
    };

    let textBuffer = ""; // To accumulate text chunks for this turn

    // Determine the iterator
    let streamIterator;
    if (streamingResult.stream) {
      streamIterator = streamingResult.stream;
    } else if (streamingResult && typeof streamingResult[Symbol.asyncIterator] === 'function') {
      // console.log('[DEBUG] streamingResult is directly iterable');
      streamIterator = streamingResult;
    } else {
      // console.warn('[WARNING] No stream iterator found. Falling back.');
    }

    let finalResponseMetadata = {};
    let aggregatedFunctionCalls = [];

    // Process the stream if available
    if (streamIterator) {
      try {
        for await (const chunk of streamIterator) {
          let chunkText = '';
          if (chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts) {
            const parts = chunk.candidates[0].content.parts;
            if (parts.length > 0) {
              if (parts[0].text) {
                chunkText = parts[0].text;
              }
              // Check for function calls in this chunk and preserve them
              for (const part of parts) {
                if (part.functionCall) {
                  aggregatedFunctionCalls.push(part);
                }
              }
            }
          }

          if (chunkText) {
            textBuffer += chunkText;
            if (onChunk) {
              onChunk(chunkText); // Stream to client immediately
            }
          }
          // Capture metadata from the last chunk if present
          if (chunk.usageMetadata) {
            finalResponseMetadata.usageMetadata = chunk.usageMetadata;
          }
        }
      } catch (err) {
        console.error('[ERROR] Error iterating stream:', err);
      }
    }

    // After iteration, we construct the 'response' object expected by the rest of the code
    const response = {
      candidates: [{
        content: {
          role: 'model',
          parts: []
        }
      }],
      usageMetadata: finalResponseMetadata.usageMetadata || {}
    };

    // Reconstruct parts from buffer and collected function calls
    if (textBuffer) {
      response.candidates[0].content.parts.push({ text: textBuffer });
    }
    if (aggregatedFunctionCalls.length > 0) {
      response.candidates[0].content.parts.push(...aggregatedFunctionCalls);
    }



    // [INSERT] Log token usage
    if (response.usageMetadata) {
      await logTokenUsage(userId, modelLimits.agentModel, response.usageMetadata, 'agent_chat_loop');
    }

    const responseContent = response.candidates?.[0]?.content;
    if (!responseContent) {
      // Should not happen if successful
      console.error('No content in response candidates');
      break;
    }
    const responseParts = responseContent.parts || [];

    // Add model's thought/call to history for next iteration
    currentContents.push(responseContent);

    // Check for Function Calls
    // (Existing logic continues...)
    const functionCalls = responseParts.filter(part => part.functionCall);


    if (functionCalls.length > 0) {
      const functionResponses = [];
      for (const call of functionCalls) {
        const fn = call.functionCall;
        console.log(`[Agent] Calling Tool: ${fn.name}`);

        // Log tool usage to DB (visible in chat)
        await createMessageQuery({ content: fn, role: 'model', chatRef });

        if (fn.name === 'search_notebook') {
          sendStatusToUser(userId, 'Searching your notes...');
          const query = fn.args.query;

          // Fetch borrowed collection IDs from notebook materials
          let borrowedCollectionIds = [];
          try {
            const notebookRef = db.collection('Notebook').doc(notebookId);
            const notebookSnap = await notebookRef.get();
            if (notebookSnap.exists) {
              const materialRefs = notebookSnap.data().materialRefs || [];
              if (materialRefs.length > 0) {
                const materialSnaps = await db.getAll(...materialRefs);
                borrowedCollectionIds = materialSnaps
                  .filter(snap => snap.exists && snap.data().borrowedFromNotebookId)
                  .map(snap => snap.data().borrowedFromNotebookId);
                // Deduplicate
                borrowedCollectionIds = [...new Set(borrowedCollectionIds)];
              }
            }
          } catch (err) {
            console.warn('[Search] Failed to fetch borrowed collections:', err.message);
          }

          const results = await executeNotebookSearch(notebookId, query, modelLimits.vectorDim, borrowedCollectionIds);
          sendStatusToUser(userId, 'Analyzing results...');

          // Store results in chatObj for persistence
          results.forEach(r => {
            chatObj.chunks[r.chunkId] = r.text;
            collectedMetadata[r.chunkId] = r.metadata;
          });

          const resultText = results.length > 0
            ? `SEARCH RESULTS (Use these to answer and CITE them as [chunkID]):\n\n` +
            results.map(r => `--- SOURCE START (ID: ${r.chunkId}) ---\n${r.text}\n--- SOURCE END ---`).join('\n\n')
            : "No relevant information found in the notebook.";
          functionResponses.push({
            functionResponse: {
              name: 'search_notebook',
              response: { result: resultText }
            }
          });
        }
        else if (fn.name === 'video_gen') {
          try {
            if (plan === 'free') {
              functionResponses.push({
                functionResponse: { name: 'video_gen', response: { result: "Failed: Free tier." } }
              });
            } else {
              let data = { args: fn.args, uid: userId, chatId: chatRef.id };
              const vidRes = await handleSendToVideoGen(data);
              if (vidRes.ok) isMedia = true;
              functionResponses.push({
                functionResponse: { name: 'video_gen', response: { result: vidRes.ok ? "Video generation started." : "Server Error" } }
              });
            }
          } catch (e) {
            functionResponses.push({
              functionResponse: { name: 'video_gen', response: { result: `Error: ${e.message}` } }
            });
          }
        } else if (fn.name === 'decline_query') {
          // Agent chose to decline the off-topic query
          const reason = fn.args.reason || 'This question is outside the scope of your notebook.';
          const suggestion = fn.args.suggestedTopic ? ` Try asking about: "${fn.args.suggestedTopic}"` : '';
          finalResponseText = `I'm here to help you with your study material! ${reason}${suggestion}`;

          // Stream this response as well if needed, though strictly it might not have been streamed in the loop above if it came as a tool call args (unlikely for text response).
          // If the model called decline_query, it didn't output text yet. We are fabricating the text here.
          // We should stream it to the user.
          if (onChunk) onChunk(finalResponseText);

          aiMessageRef = await createMessageQuery({ content: [{ text: finalResponseText }], role: 'model', chatRef });
          // Exit the loop immediately - no need for function response
          return {
            message: finalResponseText,
            media: false,
            messageRef: aiMessageRef,
            chunkMetadata: {}
          };
        }
      }

      // Add Function Responses to history
      const toolMessage = { role: 'tool', parts: functionResponses };
      currentContents.push(toolMessage);

      // Log system response to DB
      // Note: We stringify strictly to ensure it stores in Firestore
      await createMessageQuery({
        content: JSON.parse(JSON.stringify(functionResponses)),
        role: 'system',
        chatRef
      });

    } else {
      // No function calls -> Final Answer
      // Check if we already streamed the text (Yes, via textBuffer in the loop)
      // Accumulate final text for DB storage
      sendStatusToUser(userId, 'Generating response...');

      // Note: responseParts might contain thought trace (if enabled) + text.
      // We only want the text for finalResponseText usually?
      // With generateContentStream, text() returns the text.
      // Let's assume textBuffer is the "visible" content we care about for the user message.
      // BUT responseParts is what we save to DB and history.

      // If textBuffer is empty but responseContent exists (maybe only thought?), handle that?
      // Usually, if no tools, it's the answer.
      finalResponseText = textBuffer; // Use the accumulated streamed text

      aiMessageRef = await createMessageQuery({ content: [{ text: finalResponseText }], role: 'model', chatRef });
      sendStatusToUser(userId, null); // Clear status
      break; // Exit loop
    }

    turnCount++;
  }

  return {
    message: !isMedia ? finalResponseText : 'Your video is being created, ready in a bit',
    media: isMedia,
    messageRef: aiMessageRef,
    chunkMetadata: collectedMetadata // Return new citations
  };
}

export const handleComprehensiveQuizGeneration = async (conceptsWithChunks, userId, numberOfQuestions = 10, difficultyLevel = 'medium') => {
  try {
    const contextString = conceptsWithChunks.map(c =>
      `<CONCEPT_ID: ${c.conceptId}>\n<TOPIC: ${c.conceptName}>\n[CONTENT: ${c.text}]`
    ).join('\n\n');

    const prompt = "...";
    const promptText = `
Generate a multiple-choice quiz based on the provided concepts, strictly adhering to the specified difficulty and quantity constraints.

INPUT DATA:
   - CONTEXT: ${contextString}
   - TARGET_DIFFICULTY: ${difficultyLevel}
   - TARGET_QUESTION_COUNT: ${numberOfQuestions}

DIFFICULTY GUIDELINES:
   - If TARGET_DIFFICULTY is "Easy": Focus on direct recall, definitions, and basic identification of facts found explicitly in the text.
   - If TARGET_DIFFICULTY is "Medium": Focus on application, interpretation, and connecting two related ideas within the text.
   - If TARGET_DIFFICULTY is "Hard": Focus on analysis, edge cases, inference, and "best fit" scenarios where distractors are plausible but incorrect.

RULES:
   1. Concept Coverage: Ideally, generate at least one question per CONCEPT_ID. 
      - If TARGET_QUESTION_COUNT is less than the number of concepts, prioritize the most information-dense concepts. 
      - If TARGET_QUESTION_COUNT allows, generate multiple questions for complex concepts to reach the target.
   2. Quantity Control: The output array must contain exactly ${numberOfQuestions} items.
   3. Output Format: Return ONLY a valid JSON array. Do not include Markdown formatting or conversational text.
   4. JSON Structure: Each object in the array must strictly follow this schema:
      {
         "question": "The question string",
         "choices": ["Option A", "Option B", "Option C", "Option D"],
         "answer": "The exact string of the correct choice",
         "conceptId": "The exact CONCEPT_ID this question tests"
      }
   5. Distractor Quality: Ensure incorrect choices (distractors) are relevant to the context but clearly wrong based on the TARGET_DIFFICULTY.
`;

    const modelName = 'gemini-2.5-flash-lite';
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          // ... schema ...
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              choices: { type: Type.ARRAY, items: { type: Type.STRING } },
              answer: { type: Type.STRING },
              conceptId: { type: Type.STRING }
            },
            required: ['question', 'choices', 'answer', 'conceptId']
          }
        },
        thinkingConfig: {
          thinkingBudget: -1
        },
      }
    });

    // [INSERT] Log token usage
    if (userId) {
      await logTokenUsage(userId, modelName, response.usageMetadata, 'comprehensive_quiz_generation');
    }

    return JSON.parse(response.text);
  } catch (error) {
    console.error('Error generating comprehensive quiz:', error);
    return [];
  }
};