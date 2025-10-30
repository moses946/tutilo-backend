import 'dotenv/config';
import { GoogleGenAI, Type } from "@google/genai";
import { createFlashcardsQuery, createQuizQuery } from './query.js';
import admin, { db } from '../services/firebase.js';
import qdrantClient from '../services/qdrant.js';
import { handleBulkChunkRetrieval, handleChunkRetrieval } from '../utils/utility.js';
import { agentPrompt, chatNamingPrompt, conceptMapPrompt, flashcardPrompt, intentPrompt } from '../config/types.js';
import { text } from 'express';
import { getModelConfig } from '../config/plans.js';

// google genai handler (prefer GOOGLE_API_KEY, fallback to GEMINI_API_KEY)
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

if(!apiKey){
    throw new Error("Google GenAI API key not set. Define GOOGLE_API_KEY or GEMINI_API_KEY in your environment (.env).");
}

export const ai = new GoogleGenAI({
    apiKey
});



// handle concept map generation 
export const handleConceptMapGeneration = async (chunkRefs, chunks)=>{
    // Build a single string with all chunks in the format:
    // <chunkID>
    // chunk text
    // (separated by two newlines)
    const texts = chunkRefs.map((ref, idx) => `<chunkID: ${ref.id}>\n[${chunks[idx].text}]`).join('\n');
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: texts,
        config:{
            systemInstruction:conceptMapPrompt,
            responseMimeType:'application/json',
            responseSchema:{
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
                            position: {
                              type: Type.OBJECT,
                              properties: {
                                x: { type: Type.NUMBER },
                                y: { type: Type.NUMBER },
                              },
                              required: ["x", "y"],
                            },
                          },
                          required: ["id", "data", "position"],
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
    console.log(response.text)
    return response.text
}

export const handleFlashcardGeneration = async (chunkRefs, chunks, notebookRef, flashcardModel)=>{
    const texts = chunkRefs.map((ref, idx) => `<chunkID: ${ref.id}>\n[${chunks[idx].text}]`).join('\n');
    const response = await ai.models.generateContent({
        model: flashcardModel,
        systemInstruction: flashcardPrompt(),
        contents: texts,
        config: {
        thinkingConfig:{
          thinkingBudget:0
        },
        responseMimeType: 'application/json',
        responseSchema: {
            type: Type.OBJECT,
            properties: {
                numberOfCards: { type: Type.NUMBER },
                flashcards: { 
                  type: Type.ARRAY, 
                  // minItems: 5, 
                  maxItems: 20 ,
                  items: { type: Type.STRING } },
            },
        },
        propertyOrdering: ["numberOfCards", "flashcards"],
    }});    
    try {
        const responseData = JSON.parse(response.text);
        console.log('Generated flashcards:', responseData);
        
        if (responseData.flashcards && responseData.flashcards.length > 0 && notebookRef) {
            // Store flashcards in Firestore
            const flashcardRefs = await createFlashcardsQuery(responseData.flashcards, notebookRef);
            console.log(`Stored ${flashcardRefs.length} flashcards in Firestore for notebook ${notebookRef.id}`);
            return flashcardRefs;
        } else {
            console.log('No flashcards generated or notebook reference missing');
            return [];
        }
    } catch (error) {
        console.error('Error parsing flashcard response or storing in database:', error);
        return [];
    }
}

export const handleRunAgent = async (req, data, chatObj, chatRef)=>{
  // prompt intent engine
  // console.log("running agent");
  // console.log(JSON.stringify(chatObj))
  // getting the model config according to plan
  let plan = req.user.subscription
  var modelLimits = getModelConfig(plan);
  
  // naming the chat
  if (chatObj.history.length > 1 && chatRef) {
    // Get the document snapshot
    const chatDoc = await chatRef.get();
  
    if (chatDoc.exists) {
      const data = chatDoc.data();
  
      if (data.title === "default") {
        
        let title = await ai.models.generateContent({
          model:'gemini-2.0-flash',
          contents:JSON.stringify(chatObj.history),
          config:{
            systemInstruction:chatNamingPrompt(chatObj)
          }
        })
      // Update the chatRef title field with the new title
      if (title && title.text && typeof title.text === "string") {
        const newTitle = title.text.trim().replace(/^"|"$/g, ''); // Remove surrounding quotes if present
        await chatRef.update({ title: newTitle });
        console.log(`Chat title updated to: ${newTitle}`);
      }
      }
    }
  }
  /*
  The prompt intent Engine needs all these
  - notebook summary
  - conversation history
  - currently retrieved chunks (to prevent unneeded retrieval)  
  */
  // Ensure required structures exist on chatObj
  chatObj.history = chatObj.history || [];
  chatObj.chunks = chatObj.chunks || {};
  let notebookDoc = await db.collection('Notebook').doc(data.notebookID).get();
  let summary = notebookDoc.exists ? notebookDoc.data().summary : '';
  // console.log(JSON.stringify(chatObj.history))
  // console.log(summary)
  // format the files in the right way for Gemini.
  let inlineData;
  var isMedia;
  if(req.files.length>0){
    console.log(`There are files:${req.files}`);
    inlineData = req.files.map((file)=>({mimeType:file.mimetype, data:Buffer.from(file.buffer).toString('base64')}));
    inlineData = inlineData.map((data)=>({inlineData:data}));
    console.log("Finished packaging inlineData");
  }
  let message = [{text:data.text}];
  if(inlineData){
    message = message.concat(inlineData);
    console.log("concated text and inlinedata");
  }
  message = [{role:'user', parts:message}];
  let response = await ai.models.generateContent({
    model:'gemini-2.5-flash-lite',
    contents:message,
    config:{
      systemInstruction:intentPrompt(chatObj, summary),
      responseMimeType:'application/json',
      responseSchema:{
        type: Type.OBJECT,
        properties:{
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
  })
  // console.log(response.text);
  let intentResult = JSON.parse(response.text);
  var aiMessageRef = db.collection('Message').doc()
  // To retrieve or not to retrieve
  if(!intentResult.isInDomain && intentResult.messageIfOutOfDomain){
    console.log(`Message out of domain:${intentResult.messageIfOutOfDomain}`)
    chatObj.history.push({
      role: "model",
      parts: [
        {
          text: intentResult.messageIfOutOfDomain,
        },
      ],
    });
    aiMessageRef.set({
      chatID:chatRef,
      content:JSON.stringify([{text:intentResult.messageIfOutOfDomain}]),
      references:[],
      attachments:[],
      role:'model',
      timestamp:admin.firestore.FieldValue.serverTimestamp()
    })
    let agentResponse = {message:intentResult.messageIfOutOfDomain}
    return agentResponse
  }
  console.log('Prompt is in Domain');
  // check if retrieval is needed
  if(intentResult.retrievalNeeded){
    // pass to the retrieval component
    let embedding = await ai.models.embedContent({
      model: 'gemini-embedding-exp-03-07',
      contents: [intentResult.ragQuery],
      taskType: 'RETRIEVAL_QUERY',
      config: { outputDimensionality: modelLimits.vectorDim },
    });
    // Use the embedding from the intentResult.ragQuery for vector search in Qdrant
    // Assume embedding variable is the result of ai.models.embedContent for the query
    // embedding.embeddings[0].values is the vector for the query
    let queryVector = embedding.embeddings[0].values;
    // console.log(`Here is the notebookID:${data.notebookID}`)
    // Perform vector search in Qdrant
    let qdrantResults = await qdrantClient.search(data.notebookID, {
      vector: queryVector,
      limit: 5, // You can adjust the number of results as needed
      with_payload: true
    });
    // console.log(qdrantResults);
    let chunkBasePath = `notebooks/${data.notebookID}/chunks/`;
    let chunkPaths = qdrantResults.map((result)=>(`${chunkBasePath}${result.payload.chunkID}.json`))
    //let chunk = await handleChunkRetrieval(`notebooks/${data.notebookID}/chunks/${qdrantResults[0].payload.chunkID}.json`)
    let chunks = await handleBulkChunkRetrieval(chunkPaths);
    // console.log(chunks);
    // get the chunks

    // Add the chunks to the chat obj
    chunks.forEach((chunk, index)=>{
      const chunkId = qdrantResults[index]?.payload?.chunkID;
      if(chunkId){
        const text = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
        chatObj.chunks[chunkId] = text.slice(0,500);
      }
    })

  }

  // Always proceed to the Agent phase (with or without new retrieval)
  let prompt = agentPrompt(chatObj);
  let videoGenFunctionDeclaration = {
    name: 'video_gen',
    description: 'Generates a video for math concept explanations',
    parameters: {
        type: Type.OBJECT,
        properties:{
          className:{
            type:Type.STRING,
            description:'The name of the class to be passed to manim command to render the scene'
          },
          code:{
            type:Type.STRING,
            description:'The manim code written in python, properly formatted obeying Python syntax'
          },
        },
        required:['className', 'code']       
    }
  };
  let agentResponse;
  console.log(`This is the agentModel:${modelLimits.agentModel}`)
  while (true) {
    agentResponse = await ai.models.generateContent({
      model: modelLimits.agentModel,
      contents: message,
      config: {
        thinkingConfig:{
          thinkingBudget:modelLimits.thinkingBudget
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
      const functionCall = agentResponse.functionCalls[0]; // Assuming one function call
      console.log(`Function to call: ${functionCall.name}`);
      console.log(`Arguments: ${functionCall.args.code}`);
      // You may want to process the function call here and update `message` accordingly
      // For now, just return the function call as before
      // Send the functionCall to http://172.30.182.137:8000
      var functionResponsePart;
      try {
        const response = await fetch('http://172.30.182.137:8000/render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({...functionCall.args, userID:req.user.uid, messageID:aiMessageRef.id})
        });
        if (!response.ok) {
          functionResponsePart = {
            name: functionCall.name,
            response: {
              result: "video generation failed, internal server error",
            },
          }
          console.error("Error sending function call to video gen server:", response.status, response.statusText);
        } else {
          const data = await response.json();
          isMedia = true;
          console.log("Video generation server responded:", data);
          functionResponsePart = {
            name: functionCall.name,
            response: {
              result: "video generation has been generated",
            },
          }
        }
      } catch (err) {
        functionResponsePart = {
          name: functionCall.name,
          response: {
            result: `video generation failed. [ERROR]:${err}`,
          },
        }
        console.error("Failed to send function call to video gen server:", err);
      }
      chatObj.history.push({
        role: "model",
        parts: [
          {
            functionCall: functionCall,
          },
        ],
      });
      chatObj.history.push({
        role: "system",
        parts: [
          {
            functionResponse: functionResponsePart,
          },
        ],
      });
      // save the ai response to the db
      let aiFunctionCallRef = await db.collection('Message').add({
        chatID:chatRef,
        content:JSON.stringify(functionCall),
        references:[],
        attachments:[],
        role:'model',
        timestamp:admin.firestore.FieldValue.serverTimestamp()
      })
      let functionResponse = await db.collection('Message').add({
        chatID:chatRef,
        content:JSON.stringify(functionResponsePart),
        references:[],
        attachments:[],
        role:'system',
        timestamp:admin.firestore.FieldValue.serverTimestamp()
    })
        // Update the message variable to include the function call result and call
      let messagefunc = [
        agentResponse.candidates[0].content,
        {
          role: "system",
          parts: [
            {
              functionResponse: functionResponsePart,
            },
          ],
        },
      ];
      message.push(...messagefunc)
      // return functionCall;
    } else {
      chatObj.history.push({role:"model", parts:[{text:agentResponse.text}]})
      // console.log(JSON.stringify(chatObj.history));
      // return agentResponse
      break;
    }
  }
  // console.log(agentResponse.text)
  // save to db
  aiMessageRef.set({
    chatID:chatRef,
    content:JSON.stringify([{text:agentResponse.text}]),
    references:[],
    attachments:[],
    role:'model',
    timestamp:admin.firestore.FieldValue.serverTimestamp()
  })
  return {message:agentResponse.text, media:isMedia}
}


export const handleQuizGeneration = async (chatId, chunks) => {
  try {
    // Extract chunk texts for the AI model
    const texts = chunks.map(chunk => {
      const chunkText = chunk.text || (chunk.content && chunk.content[0] && chunk.content[0].text) || '';
      return `<chunkID: ${chunk.chunkId}>\n[${chunkText}]`;
    }).join('\n\n');

    console.log(`Here ye texts: ${texts}`);
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
      console.log(`Stored quiz ${quizRef.id} in Firestore for chat ${chatId}`);
      return quizRef;
    } else {
      console.log('No quiz data generated.');
      return null;
    }
  } catch (error) {
    console.error('Error generating or storing quiz:', error);
    return null;
  }
};