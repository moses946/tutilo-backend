import 'dotenv/config';
import { GoogleGenAI, Type } from "@google/genai";
import { createFlashcardsQuery } from './query.js';
import { db } from '../services/firebase.js';
import qdrantClient from '../services/qdrant.js';
import { handleBulkChunkRetrieval, handleChunkRetrieval } from '../utils/utility.js';

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
            systemInstruction:`You are an AI agent in an educational study tool called Tutilo. You take in text chunks from study materials uploaded by a user. Your task is to:

Generate a clear and concise summary of the material.

Build a concept map where each concept links to the relevant chunkIDs.

Construct a graph representation (nodes and edges) showing the relationships between concepts.
Always return a valid JSON object.

Input Example:

<chunkID: 1>
[Photosynthesis is the process by which green plants make food using sunlight.]

<chunkID: 2>
[Chlorophyll is the pigment responsible for capturing light energy in plants.]


Response Example:

{
  "summary": "The material explains photosynthesis, highlighting the role of chlorophyll in capturing sunlight to produce food in plants.",
  "concept_map": {
    "Photosynthesis": [1],
    "Chlorophyll": [2]
  },
  "graph": {
    "nodes": [
      { "id": "1", "data": { "label": "Photosynthesis" }, "position": { "x": 0, "y": 0 } },
      { "id": "2", "data": { "label": "Chlorophyll" }, "position": { "x": 200, "y": 100 } }
    ],
    "edges": [
      { "id": "e1-2", "source": "1", "target": "2" }
    ]
  }
}`,
            responseMimeType:'application/json',
            responseSchema:{
                type: Type.OBJECT,
                properties: {
                  summary: {
                    type: Type.STRING,
                  },
                  concept_map: {
                    // Represent dynamic key/value pairs as an array of entries
                    // to satisfy OBJECT "properties" non-empty requirement
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        concept: { type: Type.STRING },
                        chunkIds: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                      },
                      propertyOrdering: ["concept", "chunkIds"],
                    },
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
                              },
                              propertyOrdering: ["label"],
                            },
                            position: {
                              type: Type.OBJECT,
                              properties: {
                                x: { type: Type.NUMBER },
                                y: { type: Type.NUMBER },
                              },
                              propertyOrdering: ["x", "y"],
                            },
                          },
                          propertyOrdering: ["id", "data", "position"],
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
                          propertyOrdering: ["id", "source", "target"],
                        },
                      },
                    },
                    propertyOrdering: ["nodes", "edges"],
                  },
                },
                propertyOrdering: ["summary", "concept_map", "graph"],
              }
        }
    });
    console.log(response.text)
    return response.text
}

export const handleFlashcardGeneration = async (chunkRefs, chunks, notebookRef)=>{
    const texts = chunkRefs.map((ref, idx) => `<chunkID: ${ref.id}>\n[${chunks[idx].text}]`).join('\n');
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        systemInstruction: `You are a helpful study assistant named Tutilo.  
Your main task is to take in chunks of text from reference material, analyze them, and extract the most important concepts, facts, and definitions that a student would need for quick review. Convert this knowledge into concise, note-focused flashcards in bullet or short sentence form, not Q&A.  

The output must always be in JSON with the following fields:  
- "notebookName": the name of the notebook or topic.  
- "numberOfCards": the total number of flashcards generated.  
- "flashcards": a list of strings, each string representing one flashcard written in **notes style** (e.g., "Photosynthesis: process by which plants convert light into chemical energy").  

The flashcards should:  
- Be concise and easy to scan as refresher notes.  
- Focus only on essential knowledge.  
- Avoid long explanations, questions, or unnecessary detail.  
- Maximum number of flashcards: 20

NOTE: Flashcards should not be questions or a quiz but in the form of just short notes or in the form of short notes ie What is an information system: This is a system used to store information.

Response Example: 
{
  "notebookName": "Biology Basics",
  "numberOfCards": 3,
  "flashcards": [
    "Cell: basic structural and functional unit of life",
    "Mitochondria: powerhouse of the cell, generates ATP",
    "Photosynthesis: plants convert sunlight into chemical energy"
  ]
}
`,
        contents: texts,
        config: {
        responseMimeType: 'application/json',
        responseSchema: {
            type: Type.OBJECT,
            properties: {
                notebookName: { type: Type.STRING },
                numberOfCards: { type: Type.NUMBER },
                flashcards: { 
                  type: Type.ARRAY, 
                  // minItems: 5, 
                  maxItems: 20 ,
                  items: { type: Type.STRING } },
            },
        },
        propertyOrdering: ["notebookName", "numberOfCards", "flashcards"],
    }});
    console.log(response.text);
    
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

export const handleRunAgent = async (req, data, chatObj)=>{
  // prompt intent engine
  console.log("running agent");
  console.log(JSON.stringify(chatObj))
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
  console.log(summary)
  // format the files in the right way for Gemini.
  let inlineData;
  if(req.files){
    console.log("Inside run Agent before creating inlineData");
    inlineData = req.files.map((file)=>({mimeType:file.mimetype, data:Buffer.from(file.buffer).toString('base64')}));
    inlineData = inlineData.map((data)=>({inlineData:data}));
    console.log("Finished packaging inlineData");
  }
  let message = [{text:data.text}];
  if(inlineData){
    message = message.concat(inlineData);
    console.log("concated text and inlinedata");
  }
  message = {role:'user', parts:message};
  let response = await ai.models.generateContent({
    model:'gemini-2.5-flash-lite',
    contents:message,
    config:{
      systemInstruction:`You are a hyper-efficient Prompt Intent Engine. Your purpose is to analyze a user's prompt in the context of a conversation and determine how to process it. Your analysis must be fast and your output must be a single, clean JSON object with no additional text or explanations.
        CONTEXT:
        <NOTEBOOK_SUMMARY>
        ${summary}
        </NOTEBOOK_SUMMARY>
        <CONVERSATION_HISTORY>
        ${JSON.stringify(chatObj.history.slice(0, chatObj.history.length - 1))}
        </CONVERSATION_HISTORY>
        <CURRENTLY_RETRIEVED_CHUNKS>
        ${JSON.stringify(chatObj.chunks || '')}
        </CURRENTLY_RETRIEVED_CHUNKS>
        YOUR TASK:
        Based on all the provided context, perform the following steps:
        Domain Analysis: Determine if the <USER_PROMPT> is relevant to the topics described in the <NOTEBOOK_SUMMARY>.
        Retrieval Analysis: If the prompt is in-domain, determine whether new information must be retrieved to answer it. 
        Retrieval is NOT needed if the answer to the prompt can be fully found in either the <CONVERSATION_HISTORY> or <CURRENTLY_RETRIEVED_CHUNKS>.
        Retrieval IS needed if the prompt is in-domain and the answer is NOT already present in <CONVERSATION_HISTORY> or <CURRENTLY_RETRIEVED_CHUNKS>.
        Query Formulation: If retrieval is needed, formulate a concise and self-contained rag_query. This query should be optimized for a vector database search and should incorporate necessary context from the conversation history.
        NOTE:the ragQuery cannot be given when retrievalNeeded is false
        JSON Output: Generate a single JSON object with the results of your analysis.
        example JSON: {
          "isInDomain": true,
          "messageIfOutOfDomain": null,
          "retrievalNeeded": true,
          "ragQuery": "What is the price of RTX 4090"
        }
        `,
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
  console.log(response.text);
  let intentResult = JSON.parse(response.text);
  // To retrieve or not to retrieve
  if(!intentResult.isInDomain && intentResult.messageIfOutOfDomain){
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
      config: { outputDimensionality: 256 },
    });
    // Use the embedding from the intentResult.ragQuery for vector search in Qdrant
    // Assume embedding variable is the result of ai.models.embedContent for the query
    // embedding.embeddings[0].values is the vector for the query
    let queryVector = embedding.embeddings[0].values;
    // Perform vector search in Qdrant
    let qdrantResults = await qdrantClient.search(data.notebookID, {
      vector: queryVector,
      limit: 5, // You can adjust the number of results as needed
      with_payload: true
    });
    console.log(qdrantResults);
    let chunkBasePath = `notebooks/${data.notebookID}/chunks/`;
    let chunkPaths = qdrantResults.map((result)=>(`${chunkBasePath}${result.payload.chunkID}.json`))
    //let chunk = await handleChunkRetrieval(`notebooks/${data.notebookID}/chunks/${qdrantResults[0].payload.chunkID}.json`)
    let chunks = await handleBulkChunkRetrieval(chunkPaths);
    console.log(chunks);
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
  let agentPrompt = `
    You are the Agent LLM inside Tutilo, a study companion app.
    Your job is to take user messages, the conversation history, and currently retrieved chunks, then decide whether to:

    Call a tool as per the declarations given.

    Synthesize a direct text response for the user.

    Rules

    If a tool call is needed → output a structured tool call JSON.

    If no tool call is required to answer the question then respond with text

    Always cite retrieved chunks if you use them. Format citations like this:
    'AI is a growing field <chunkID>'

    Never invent chunkIDs. Only cite chunks included in <CURRENTLY_RETRIEVED_CHUNKS>.

    Respect the conversation history to maintain coherence.

    Keep outputs concise, clear, and helpful for learning.

    Inputs
    <CONVERSATION_HISTORY>
    ${JSON.stringify(chatObj.history.slice(0, chatObj.history.length))}
    </CONVERSATION_HISTORY>

    <CURRENTLY_RETRIEVED_CHUNKS>
    ${JSON.stringify(chatObj.chunks || '')}
    </CURRENTLY_RETRIEVED_CHUNKS>

    Outputs
    If text response:
    A direct, conversational answer with citations (if chunks are referenced).
  `
  let videoGenFunctionDeclaration = {
    name: 'video_gen',
    description: 'Generates a video for math concept explanations',
    parameters: {
      type: Type.OBJECT,
      properties: {
        script: {
          type: Type.STRING,
          description: 'python code using manim to create the explanation'
        }
      },
      required: ['script']
    }
  };
  let agentResponse;
  while (true) {
    agentResponse = await ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: message,
      config: {
        systemInstruction: agentPrompt,
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
      console.log(`Arguments: ${JSON.stringify(functionCall.args)}`);
      // You may want to process the function call here and update `message` accordingly
      // For now, just return the function call as before
      const functionResponsePart = {
        name: functionCall.name,
        response: {
          result: "video has been generated",
        },
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
        role: "user",
        parts: [
          {
            functionResponse: functionResponsePart,
          },
        ],
      });
      return functionCall;
    } else {
      chatObj.history = [...chatObj.history, agentResponse.candidates[0].content]
      console.log(JSON.stringify(chatObj.history));
      break;
    }
  }
  console.log(agentResponse.text)
  return agentResponse.text
}