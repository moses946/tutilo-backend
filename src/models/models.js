import 'dotenv/config';
import { GoogleGenAI, Type } from "@google/genai";
import { createFlashcardsQuery } from './query.js';
import { db } from '../services/firebase.js';

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
  /*
  The prompt intent Engine needs all these
  - notebook summary
  - conversation history
  - currently retrieved chunks (to prevent unneeded retrieval)  
  */
  let summary = (await db.collection('Notebook').doc(data.notebookID).get()).data().summary;
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
        ${JSON.stringify(chatObj.history.slice(0, chatObj.history.length))}
        </CONVERSATION_HISTORY>
        <CURRENTLY_RETRIEVED_CHUNKS>
        ${JSON.stringify(chatObj.chunks || '')}
        </CURRENTLY_RETRIEVED_CHUNKS>
        YOUR TASK:
        Based on all the provided context, perform the following steps:
        Domain Analysis: Determine if the <USER_PROMPT> is relevant to the topics described in the <NOTEBOOK_SUMMARY>.
        Retrieval Analysis: If the prompt is in-domain, decide if new information needs to be retrieved. A prompt does not need retrieval if the answer is likely already present in the <CONVERSATION_HISTORY> or <CURRENTLY_RETRIEVED_CHUNKS>.
        Query Formulation: If retrieval is needed, formulate a concise and self-contained rag_query. This query should be optimized for a vector database search and should incorporate necessary context from the conversation history.
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
  }
}