import 'dotenv/config';
import { GoogleGenAI, Type } from "@google/genai";
import { createFlashcardsQuery, createMessageQuery, createQuizQuery } from './query.js';
import admin, { db } from '../services/firebase.js';
import qdrantClient from '../services/qdrant.js';
import { handleBulkChunkRetrieval, handleChunkRetrieval, handleSendToVideoGen } from '../utils/utility.js';
import { agentPrompt, chatNamingPrompt, conceptMapPrompt, flashcardPrompt, intentPrompt, promptPrefix, videoGenFunctionDeclaration, chatSummarizationPrompt } from '../config/types.js';
import { getModelConfig } from '../config/plans.js';
import { performance } from 'perf_hooks';
import { userMap } from '../middleware/authMiddleWare.js';


// google genai handler (prefer GOOGLE_API_KEY, fallback to GEMINI_API_KEY)
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("Google GenAI API key not set. Define GOOGLE_API_KEY or GEMINI_API_KEY in your environment (.env).");
}

export const ai = new GoogleGenAI({
  apiKey
});



// handle concept map generation 
export const handleConceptMapGeneration = async (chunkRefs, chunks) => {
  // Build a single string with all chunks in the format:
  // <chunkID>
  // chunk text
  // (separated by two newlines)
  const texts = chunkRefs.map((ref, idx) => `<chunkID: ${ref.id}>\n[${chunks[idx].text}]`).join('\n');
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: texts,
    config: {
      systemInstruction: conceptMapPrompt,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
          },
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
                        chunkIds: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
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
  return response.text
}

export const handleFlashcardGeneration = async (chunkRefs, chunks, notebookRef, flashcardModel) => {
  const texts = chunkRefs.map((ref, idx) => `<chunkID: ${ref.id}>\n[${chunks[idx].text}]`).join('\n');
  const response = await ai.models.generateContent({
    model: flashcardModel,
    systemInstruction: flashcardPrompt(),
    contents: texts,
    config: {
      thinkingConfig: {
        thinkingBudget: 0
      },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          numberOfCards: { type: Type.NUMBER },
          flashcards: {
            type: Type.ARRAY,
            // minItems: 5, 
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
  try {
    const responseData = JSON.parse(response.text);
    if (responseData.flashcards && responseData.flashcards.length > 0 && notebookRef) {
      // Store flashcards in Firestore
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

export const handleChatSummarization = async (existingSummary, messagesToSummarize) => {
  try {
    // Convert message objects to a clean text transcript
    const conversationText = messagesToSummarize.map(m => {
      const content = m.parts && m.parts[0] && m.parts[0].text ? m.parts[0].text : '[Media/System Message]';
      return `${m.role.toUpperCase()}: ${content}`;
    }).join('\n');

    // Use the refined prompt factory
    const prompt = chatSummarizationPrompt(existingSummary, conversationText);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING }
          }
        },
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    });

    const result = JSON.parse(response.text);
    return result.summary;
  } catch (error) {
    console.error('Error summarizing chat:', error);
    return existingSummary; // Fallback to old summary if fail
  }
}


export const handleRunAgent = async (req, data, chatObj, chatRef) => {
  try {
    let plan = req.user.subscription;
    var modelLimits = getModelConfig(plan);
    let history = chatObj.history.slice(0, chatObj.history.length - 1);
    let intentCompleteMessage = promptPrefix(history, chatObj.chunks);
    // naming the chat
    if (chatObj.history.length > 1 && chatRef) {
      const chatDoc = await chatRef.get();
      if (chatDoc.exists) {
        const data = chatDoc.data();
        if (data.title === "New") {
          const startTime = performance.now();
          let title = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: JSON.stringify(chatObj.history),
            config: {
              systemInstruction: chatNamingPrompt(chatObj)
            }
          });
          const endTime = performance.now();
          if (title && title.text && typeof title.text === "string") {
            const newTitle = title.text.trim().replace(/^"|"$/g, '');
            await chatRef.update({ title: newTitle });
          }
        }
      }
    }

    chatObj.history = chatObj.history || [];
    chatObj.chunks = chatObj.chunks || {};
    let chunkMetadata = {};
    let notebookDoc = await db.collection('Notebook').doc(data.notebookID).get();
    let summary = notebookDoc.exists ? notebookDoc.data().summary : '';

    let inlineData;
    var isMedia;
    if (req.files.length > 0) {
      inlineData = req.files.map((file) => ({ mimeType: file.mimetype, data: Buffer.from(file.buffer).toString('base64') }));
      inlineData = inlineData.map((data) => ({ inlineData: data }));
    }

    let message = [{ text: data.text }];
    if (inlineData) {
      message = message.concat(inlineData);
    }
    message = [{ role: 'user', parts: message }];

    let response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: intentCompleteMessage.concat(message),
      config: {
        thinkingConfig: {
          thinkingBudget: 0
        },
        systemInstruction: intentPrompt(summary),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isInDomain: { type: Type.BOOLEAN },
            messageIfOutOfDomain: { type: Type.STRING },
            retrievalNeeded: { type: Type.BOOLEAN },
            ragQuery: { type: Type.STRING }
          },
          propertyOrdering: [
            'isInDomain',
            'messageIfOutOfDomain',
            'retrievalNeeded',
            'ragQuery'
          ]
        }
      }
    });
    let intentResult = JSON.parse(response.text);
    var aiMessageRef = db.collection('Message').doc();

    if (!intentResult.isInDomain && intentResult.messageIfOutOfDomain) {
      chatObj.history.push({
        role: "model",
        parts: [
          {
            text: intentResult.messageIfOutOfDomain,
          },
        ],
      });
      aiMessageRef.set({
        chatID: chatRef,
        content: JSON.stringify([{ text: intentResult.messageIfOutOfDomain }]),
        references: [],
        attachments: [],
        role: 'model',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      let agentResponse = { message: intentResult.messageIfOutOfDomain };
      return agentResponse;
    }

    if (intentResult.retrievalNeeded) {
      let embedding = await ai.models.embedContent({
        model: 'gemini-embedding-exp-03-07',
        contents: [intentResult.ragQuery],
        taskType: 'QUESTION_ANSWERING',
        config: { outputDimensionality: modelLimits.vectorDim },
      });
      let queryVector = embedding.embeddings[0].values;
      let qdrantResults = await qdrantClient.search(data.notebookID, {
        vector: queryVector,
        limit: 5,
        with_payload: true,
      });

      let chunkBasePath = `notebooks/${data.notebookID}/chunks/`;
      let chunkPaths = qdrantResults.map((result) => (`${chunkBasePath}${result.payload.chunkID}.json`));
      // OPTIMIZATION: Fetch Chunk Metadata from Firestore in parallel with Storage retrieval
      // We need Page Number and Material ID to navigate the PDF on the frontend
      const chunkDocRefs = qdrantResults.map(r => db.collection('Chunk').doc(r.payload.chunkID));
      let [chunks, chunkDocs] = await Promise.all([
        handleBulkChunkRetrieval(chunkPaths),
        db.getAll(...chunkDocRefs) // Batch fetch from Firestore
      ]);
      chunks.forEach((chunkText, index) => {
        const chunkId = qdrantResults[index]?.payload?.chunkID;
        const chunkDoc = chunkDocs[index];

        if (chunkId && chunkDoc.exists) {
          const docData = chunkDoc.data();
          const text = typeof chunkText === 'string' ? chunkText : JSON.stringify(chunkText);
          chatObj.chunks[chunkId] = text.slice(0, 500);

          // Populate metadata for frontend
          chunkMetadata[chunkId] = {
            chunkId: chunkId,
            pageNumber: docData.pageNumber,
            materialId: docData.materialID.id, // Assuming reference
            tokenCount: docData.tokenCount
          };
        }
      });
    }

    var agentResponse = await agentLoop(req.user.uid, chatObj, chatRef, message, summary);

    // Return metadata combined with message
    return { ...agentResponse, chunkMetadata };
  } catch (err) {
    console.log(`[ERROR]: handleAgent:${err}`);
    throw Error(err);
  }
}


export const handleQuizGeneration = async (chatId, chunks) => {
  try {
    // Extract chunk texts for the AI model
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
   Return a JSON array of exactly 10 objects, where each object has the following structure:
   [
     {
       "question": "Question text here",
       "choices": ["Option A", "Option B", "Option C", "Option D"],
       "answer": "Correct answer text here"
     }
   ]

2. Question Requirements:
   - Each question must be derived directly from the provided text context.
   - Each question should test key facts, concepts, or insights from the text.
   - Avoid vague, trivial, or overly broad questions.
   - Ensure the questions are clear, concise, and grammatically correct.

3. Choices and Answers:
   - Each question must have exactly four unique choices.
   - The correct answer must be one of the four choices.
   - Distractors (incorrect options) should be plausible but clearly incorrect upon understanding the context.

4. Diversity:
   - Include a mix of factual, conceptual, and inferential questions.
   - Avoid repeating the same question style or phrasing.

5. Output Only JSON:
   - Do not include any explanations, markdown formatting, or introductory text.
   - Output must be valid JSON following this exact format.
`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: `You are an AI quiz generator.`,
        responseMimeType: 'application/json',
        responseSchema: {
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
 */

export async function agentLoop(userId, chatObj, chatRef, message = [], summary = '') {
  /**
   * This function should handle running the agent, Takes the chat history and runs inference
   */
  var userObj = userMap.get(userId);
  var plan = userObj.plan;
  var modelLimits = getModelConfig(plan);
  let prompt = agentPrompt(userObj, summary);
  let completeMessage = promptPrefix(chatObj.history.slice(0, chatObj.history.length - 1), chatObj.chunks, summary);
  var agentResponse;
  var isMedia = false;
  var aiMessageRef;
  while (true) {
    agentResponse = await ai.models.generateContent({
      model: modelLimits.agentModel,
      contents: completeMessage.concat(message),
      config: {
        thinkingConfig: {
          thinkingBudget: modelLimits.thinkingBudget
        },
        systemInstruction: prompt,
        tools: [
          {
            functionDeclarations: [videoGenFunctionDeclaration]
          }
        ]
      }
    });
    if (agentResponse.functionCalls && agentResponse.functionCalls.length > 0) {
      const functionCall = agentResponse.functionCalls[0];
      var functionResponsePart;
      if (functionCall.name == 'video_gen') {
        try {
          if (plan == 'free') {
            functionResponsePart = {
              name: functionCall.name,
              response: {
                result: "video generation failed, free tier cannot generate videos",
              },
            };
            chatObj.history.push({
              role: "system",
              parts: [
                {
                  functionResponse: functionResponsePart,
                },
              ],
            });
            message.push({
              role: "system",
              parts: [
                {
                  functionResponse: functionResponsePart,
                },
              ],
            },)
            await createMessageQuery({ content: functionResponsePart, role: 'system', chatRef })
            continue

          }
          let data = { args: functionCall.args, uid: userId, chatId: chatRef.id }
          const response = await handleSendToVideoGen(data);
          if (!response.ok) {
            functionResponsePart = {
              name: functionCall.name,
              response: {
                result: "video generation failed, internal server error",
              },
            };
            console.error("Error sending function call to video gen server:", response.status, response.statusText);
          } else {
            const data = await response.json();
            isMedia = true;
          }
        } catch (err) {
          functionResponsePart = {
            name: functionCall.name,
            response: {
              result: `video generation failed. [ERROR]:${err}`,
            },
          };
          console.error("Failed to send function call to video gen server:", err);
        }

      }
      chatObj.history.push({
        role: "model",
        parts: [
          {
            functionCall: functionCall,
          },
        ],
      });
      await createMessageQuery({ content: functionCall, role: 'model', chatRef })
      let messagefunc = [
        agentResponse.candidates[0].content
      ]
      if (functionResponsePart) {
        chatObj.history.push({
          role: "system",
          parts: [
            {
              functionResponse: functionResponsePart,
            },
          ],
        });
        messagefunc.push({
          role: "system",
          parts: [
            {
              functionResponse: functionResponsePart,
            },
          ],
        },)
        await createMessageQuery({ content: functionResponsePart, role: 'system', chatRef })
      } else {
        break;
      }

      message.push(...messagefunc);


    } else {
      chatObj.history.push({ role: "model", parts: [{ text: agentResponse.text }] });
      aiMessageRef = await createMessageQuery({ content: [{ text: agentResponse.text }], role: 'model', chatRef })
      break;
    }
  }
  return { message: !isMedia ? agentResponse.text : 'Your video is being created, ready in a bit', media: isMedia, messageRef: aiMessageRef };

}

export const handleComprehensiveQuizGeneration = async (conceptsWithChunks, numberOfQuestions = 10, difficultyLevel = 'medium') => {
  try {
    // conceptsWithChunks is array of { conceptId: string, conceptName: string, text: string }
    const contextString = conceptsWithChunks.map(c => 
      `<CONCEPT_ID: ${c.conceptId}>\n<TOPIC: ${c.conceptName}>\n[CONTENT: ${c.text}]`
    ).join('\n\n');

    const prompt = `
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

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
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

    return JSON.parse(response.text);
  } catch (error) {
    console.error('Error generating comprehensive quiz:', error);
    return [];
  }
};