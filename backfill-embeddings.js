// backfill-embeddings.js
// Genera el embedding visual de los posts que aún no lo tienen (Etapa B).
// Se ejecuta UNA vez (o cuando queden posts sin vector):  node backfill-embeddings.js
//
// Requisitos: mismas env vars que el server (AWS + Appwrite) y acceso a Titan en Bedrock.

require('dotenv').config();
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { Client, Databases, Query } = require('node-appwrite');

const EMBEDDING_MODEL_ID = 'amazon.titan-embed-image-v1';
const EMBEDDING_LENGTH = 1024; // debe coincidir con server.js

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

const appwrite = new Client()
  .setEndpoint(process.env.APPWRITE_ENDPOINT)
  .setProject(process.env.APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const databases = new Databases(appwrite);

async function getImageEmbedding(buffer) {
  const command = new InvokeModelCommand({
    modelId: EMBEDDING_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inputImage: buffer.toString('base64'),
      embeddingConfig: { outputEmbeddingLength: EMBEDDING_LENGTH },
    }),
  });
  const response = await bedrock.send(command);
  const json = JSON.parse(new TextDecoder().decode(response.body));
  return json.embedding;
}

async function run() {
  let processed = 0, skipped = 0, failed = 0;
  let lastId = null;
  let keepFetching = true;

  console.log('Iniciando backfill de embeddings...');

  while (keepFetching) {
    const queries = [Query.limit(100)];
    if (lastId) queries.push(Query.cursorAfter(lastId));

    const page = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      process.env.APPWRITE_POST_COLLECTION_ID,
      queries
    );

    for (const post of page.documents) {
      // Saltar los que ya tienen embedding o no tienen imagen.
      if (post.embedding) { skipped++; continue; }
      const url = Array.isArray(post.imageUrls) ? post.imageUrls[0] : null;
      if (!url) { skipped++; continue; }

      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`fetch imagen ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());

        const vector = await getImageEmbedding(buffer);

        await databases.updateDocument(
          process.env.APPWRITE_DATABASE_ID,
          process.env.APPWRITE_POST_COLLECTION_ID,
          post.$id,
          { embedding: JSON.stringify(vector) }
        );
        processed++;
        console.log(`✔ ${post.$id} (${post.mascota || 'sin nombre'})`);
      } catch (e) {
        failed++;
        console.error(`✗ ${post.$id}: ${e.message}`);
      }
    }

    if (page.documents.length < 100) keepFetching = false;
    else lastId = page.documents[page.documents.length - 1].$id;
  }

  console.log(`\nListo. Generados: ${processed} · Saltados: ${skipped} · Fallidos: ${failed}`);
}

run().catch((e) => {
  console.error('Backfill falló:', e);
  process.exit(1);
});
