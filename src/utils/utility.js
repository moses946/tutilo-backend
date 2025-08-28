import multer from 'multer';
import {bucket} from '../services/firebase.js';
import {ai} from '../models/models.js'
// multer storage
const storage = multer.memoryStorage();
export const upload = multer({ storage });

export const handleFileUpload = async (file, path)=>{
    try{
        const destinationPath = `${path}`;
        const blob = bucket.file(destinationPath);
        await blob.save(file.buffer, {
            metadata: {
                contentType: file.mimetype,
            },
            resumable: false,
        });
        return { path: destinationPath, name: file.originalname, size: file.size };
    }catch(err){
        console.log(`Error in handleFileUpload func:${err}`);
        throw err;
    }
}

export const handleBulkFileUpload = async (files, basePath)=>{
    const uploads = files.map((file)=>{
        const safeName = file.originalname;
        const destination = `${basePath}/${safeName}`;
        return handleFileUpload(file, destination);
    });
    return Promise.all(uploads);
}
 
export const handleBulkChunkUpload = async (chunks, basePath)=>{
    // chunks: Array<{ name: string, chunks: Array<{pageNumber:number, text:string, tokenCount:number}> }>
    const uploads = chunks.map(async (item)=>{
        const safeName = `${item.name}.chunks.json`;
        const destination = `${basePath}/${safeName}`;
        const payload = Buffer.from(JSON.stringify(item.chunks), 'utf-8');
        const blob = bucket.file(destination);
        await blob.save(payload, {
            metadata: { contentType: 'application/json' },
            resumable: false,
        });
        return { path: destination, name: safeName, size: payload.length };
    });
    return Promise.all(uploads);
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
    return response.embeddings
    
}
