import {QdrantClient} from '@qdrant/js-client-rest'

const qdrantClient = new QdrantClient(
    {
        host:process.env.QDRANT_CLUSTER_ENDPOINT,
        apiKey:process.env.QDRANT_API_KEY
    }
);

export default qdrantClient