# Notebook Creation Workflow

This document describes the complete notebook creation workflow implemented in the Tutilo backend.

## Overview

The notebook creation workflow creates a hierarchical structure in Firestore with proper references between notebooks, materials, and chunks. It also creates embeddings for each chunk and stores them in Qdrant vector database for semantic search capabilities.

## Workflow Steps

### 1. Notebook Creation
- Creates a new notebook document in the `Notebook` collection
- Initializes with `status: 'processing'` and empty `materialRefs` array
- Stores user ID, title, summary, and timestamps

### 2. File Upload
- Uploads original files to Firebase Storage under `notebooks/{notebookId}/materials/`
- Maintains file metadata and storage paths

### 3. Material Creation
- Creates material documents in the `Material` collection for each uploaded file
- Links materials to the notebook via `notebookID` reference
- Initializes with empty `chunkRefs` array

### 4. Chunk Processing
- Extracts text chunks from each PDF file using the chunking utility
- Creates chunk documents in the `Chunk` collection
- Each chunk includes:
  - `materialID`: Reference to the parent material
  - `pageNumber`: Page number from the PDF
  - `text`: Extracted text content
  - `tokenCount`: Estimated token count
  - `dateCreated`: Timestamp
  - `qdrantPointId`: Initially null, updated after embedding creation

### 5. Embedding Creation & Vector Storage
- Creates embeddings for each chunk using Google's Gemini embedding model
- Stores embeddings in Qdrant vector database with payload containing:
  - `chunkID`: Reference to the Firestore chunk document
  - `pageNumber`: Page number from the PDF
  - `tokenCount`: Estimated token count
  - `text`: First 500 characters of the chunk text for preview
  - `createdAt`: Timestamp
- Updates chunk documents with their corresponding Qdrant point IDs

### 6. Reference Updates
- Updates material documents with chunk references (`chunkRefs`)
- Updates notebook document with material references (`materialRefs`)
- Sets notebook status to `'completed'`

### 7. Storage Backup
- Uploads chunk data as JSON blobs to Firebase Storage
- Maintains existing functionality for backward compatibility

## Firestore Collections Structure

### Notebook Collection
```javascript
{
  summary: string,
  title: string,
  userID: DocumentReference,
  dateCreated: Timestamp,
  dateUpdated: Timestamp,
  materialRefs: [DocumentReference], // References to Material documents
  status: 'processing' | 'completed'
}
```

### Material Collection
```javascript
{
  notebookID: DocumentReference, // Reference to Notebook document
  name: string, // Original filename
  status: 'processed',
  storagePath: string, // Storage path for original file
  dateCreated: Timestamp,
  dateUpdated: Timestamp,
  chunkRefs: [DocumentReference] // References to Chunk documents
}
```

### Chunk Collection
```javascript
{
  materialID: DocumentReference, // Reference to Material document
  pageNumber: number,
  text: string,
  tokenCount: number,
  dateCreated: Timestamp,
  dateUpdated: Timestamp,
  qdrantPointId: string // Qdrant point ID for this chunk
}
```

## Qdrant Vector Database

### Collection: `notebook_chunks`
- **Vector Size**: 256 dimensions
- **Distance Metric**: Cosine similarity
- **Payload Structure**:
  ```javascript
  {
    chunkID: string,        // Firestore chunk document ID
    pageNumber: number,     // PDF page number
    tokenCount: number,     // Estimated token count
    text: string,          // First 500 characters for preview
    createdAt: string      // ISO timestamp
  }
  ```

## API Endpoint

### POST /notebooks
Creates a new notebook with uploaded materials, processed chunks, and vector embeddings.

**Request:**
- Content-Type: `multipart/form-data`
- Body:
  - `files`: Array of PDF files
  - `title`: Notebook title
  - `summary`: Notebook summary
  - `userID`: User ID

**Response:**
```javascript
{
  notebookId: string,
  notebookStatus: 'completed',
  materials: [
    {
      materialId: string,
      materialName: string,
      chunkCount: number,
      qdrantPointsCount: number
    }
  ],
  storageUploads: {
    materials: Array,
    chunks: Array
  },
  vectorDatabase: {
    collection: 'notebook_chunks',
    totalPoints: number
  },
  message: string
}
```

## Error Handling

The workflow includes comprehensive error handling:
- Validates file uploads
- Handles PDF parsing errors
- Manages Firestore transaction failures
- Handles embedding creation errors
- Manages Qdrant storage failures
- Provides detailed error messages

## Benefits

1. **Data Integrity**: Proper references ensure data consistency
2. **Efficient Querying**: Can easily find all chunks for a material or all materials for a notebook
3. **Semantic Search**: Vector embeddings enable semantic similarity search
4. **Scalability**: Batch operations for multiple files and embeddings
5. **Traceability**: Complete audit trail from notebook to individual chunks and embeddings
6. **Flexibility**: Can query chunks by material, material by notebook, or perform semantic search

## Usage Example

```javascript
const formData = new FormData();
formData.append('title', 'My Study Notes');
formData.append('summary', 'Notes from physics class');
formData.append('userID', 'user123');
formData.append('files', pdfFile1);
formData.append('files', pdfFile2);

const response = await fetch('/notebooks', {
  method: 'POST',
  body: formData
});

const result = await response.json();
console.log('Notebook created:', result.notebookId);
console.log('Total vector points:', result.vectorDatabase.totalPoints);
```

## Environment Variables Required

- `QDRANT_CLUSTER_ENDPOINT`: Qdrant cluster endpoint URL
- `QDRANT_API_KEY`: Qdrant API key for authentication
- `GOOGLE_API_KEY` or `GEMINI_API_KEY`: Google AI API key for embeddings
