import multer from 'multer';
import {bucket} from '../services/firebase.js';
import {ai} from '../models/models.js'
// multer storage
const storage = multer.memoryStorage();
export const upload = multer({ storage });

export const handleFileUpload = (file, path)=>{
    try{
        const blob = bucket.file(path);
        const blobStream = blob.createWriteStream({
            metadata:{
                contentType:file.mimeType,
            },
        })
        blobStream.on('error', (err)=>{
        console.error(`Uploading to bucket error: ${err}`);
        return false
        })
        blobStream.on('finish', ()=>{
            return true
        })
    }catch(err){
        console.log(`Error in handleFileUpload func:${err}`);
    }
}

/*
  Embedding function
  Input:array of objects holding page number and text content
  Output:An array of objects holding metadata and embedding of the text content 

*/
export const handleEmbedding = async (pages)=>{
    console.log('Embedding...');
    console.log(pages[0]);
    pages = pages.map((page ,index)=>page.text)
    console.log(pages[0]);
    const response = await ai.models.embedContent(
        {
            model:'gemini-embedding-exp-03-07',
            contents:pages,
            taskType: 'RETRIEVAL_QUERY',
            outputDimensionality: 256,
        }
    );
    console.log('Embedding:', response.embeddings.length);
    
}
