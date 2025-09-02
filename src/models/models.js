import 'dotenv/config';
import { GoogleGenAI, Type } from "@google/genai";

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
}

