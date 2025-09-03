import 'dotenv/config';
import { GoogleGenAI, Type } from "@google/genai";
import { createFlashcardsQuery } from './query.js';

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
        responseMimeType: 'application/json',
        responseSchema: {
            type: Type.OBJECT,
            properties: {
                notebookName: { type: Type.STRING },
                numberOfCards: { type: Type.NUMBER },
                flashcards: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
        },
        propertyOrdering: ["notebookName", "numberOfCards", "flashcards"],
    });
    console.log(response.text)
    
    // try {
    //     const responseData = JSON.parse(response.text);
    //     console.log('Generated flashcards:', responseData);
        
    //     if (responseData.flashcards && responseData.flashcards.length > 0 && notebookRef) {
    //         // Store flashcards in Firestore
    //         const flashcardRefs = await createFlashcardsQuery(responseData.flashcards, notebookRef);
    //         console.log(`Stored ${flashcardRefs.length} flashcards in Firestore for notebook ${notebookRef.id}`);
    //         return flashcardRefs;
    //     } else {
    //         console.log('No flashcards generated or notebook reference missing');
    //         return [];
    //     }
    // } catch (error) {
    //     console.error('Error parsing flashcard response or storing in database:', error);
    //     return [];
    // }
}