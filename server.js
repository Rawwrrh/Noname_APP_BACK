// noname-backend/server.js

const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const { RekognitionClient, DetectLabelsCommand } = require('@aws-sdk/client-rekognition');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { Client, Databases, Query, ID, Storage } = require('node-appwrite'); // SDK de Appwrite
const { InputFile } = require('node-appwrite/file');
console.log({ Client, Databases, Query, ID, Storage, InputFile });

// Notificaciones push (OneSignal) + geofencing
const { sendPush } = require('./push');
const { rMaxKm, distanceKm } = require('./searchRadius');

const app = express();
// App Runner (y otros hosts) inyectan el puerto por env. En local cae a 5000.
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- INICIALIZACIÓN DE CLIENTES ---
// Cliente de AWS Rekognition
const rekognitionClient = new RekognitionClient({ /* ...config... */ });

// Cliente de AWS Bedrock (embeddings de imagen — Etapa B)
// Bedrock toma las credenciales de las mismas env vars que Rekognition.
const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
});
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-image-v1';
const EMBEDDING_LENGTH = 1024; // debe ser igual en creación, backfill y búsqueda

// Cliente de Appwrite
const appwriteClient = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(appwriteClient);
const appwriteStorage = new Storage(appwriteClient);

// Colección de usuarios (para el geofencing). Override por env; fallback al ID conocido.
const USER_COLLECTION_ID =
  process.env.APPWRITE_USER_COLLECTION_ID || '6647e0a00035cf6b1518';

// Avisa por push a los usuarios cuya ubicación cae dentro de la zona de búsqueda
// (R_max) de una mascota recién reportada como perdida. Best-effort: si falla
// (faltan atributos lat/lng o índices en Users), no rompe la creación del post.
async function notifyNearbyUsers({ lat, lng, factors, postId, mascota, creatorId }) {
  try {
    const r = rMaxKm(factors); // km
    if (!r || r <= 0) return;
    const dLat = r / 111;
    const dLng = r / (111 * Math.cos((lat * Math.PI) / 180));

    const users = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      USER_COLLECTION_ID,
      [
        Query.between('lat', lat - dLat, lat + dLat),
        Query.between('lng', lng - dLng, lng + dLng),
        Query.limit(500),
      ]
    );

    const targets = users.documents
      .filter(
        (u) =>
          u.$id !== creatorId &&
          typeof u.lat === 'number' &&
          typeof u.lng === 'number' &&
          distanceKm(lat, lng, u.lat, u.lng) <= r
      )
      .map((u) => u.$id);

    if (targets.length === 0) {
      console.log('Geofencing: sin usuarios en rango.');
      return;
    }
    await sendPush(targets, {
      title: 'Mascota perdida cerca de ti 🐾',
      body: `Se perdió ${mascota || 'una mascota'} en tu zona. ¿La has visto?`,
      data: { postId, type: 'lost_nearby' },
    });
    console.log(`Geofencing: avisados ${targets.length} usuario(s) en ~${r.toFixed(1)}km.`);
  } catch (e) {
    console.log('notifyNearbyUsers (geofencing) omitido:', e.message);
  }
}

const ANIMAL_RELATED_TAGS = [
  'Animal', 'Pet', 'Dog', 'Puppy', 'Cat', 'Kitten', 'Mammal',
  'Canine', 'Feline', // Categorías generales
  // Puedes añadir aquí razas comunes si lo deseas
  'Golden Retriever', 'Labrador Retriever', 'German Shepherd', 'Poodle', 'Bulldog',
  'Siamese Cat', 'Persian Cat', 'Maine Coon', 'Tabby Cat'
];

// Mapa a especie "canónica": permite saber si dos animales son del MISMO tipo.
// Incluye términos en inglés (de Rekognition) y en español (campo `especie` de los posts).
const SPECIES_MAP = {
  // Categorías nuevas (Canina/Felina/Ave/Roedor) + términos en inglés de Rekognition
  // + valores antiguos (perro/gato/...) para compatibilidad con posts viejos.
  dog: 'dog', puppy: 'dog', canine: 'dog', perro: 'dog', canina: 'dog',
  cat: 'cat', kitten: 'cat', feline: 'cat', gato: 'cat', felina: 'cat',
  bird: 'bird', ave: 'bird', pajaro: 'bird',
  // Roedor agrupa roedores; incluimos conejo (coloquialmente en esa categoría).
  rodent: 'rodent', roedor: 'rodent', hamster: 'rodent', rat: 'rodent', mouse: 'rodent',
  rabbit: 'rodent', bunny: 'rodent', conejo: 'rodent',
};

// Colores básicos que devuelve Rekognition (SimplifiedColor) y que usamos como etiqueta.
const COLOR_TAGS = new Set([
  'black', 'white', 'gray', 'grey', 'brown', 'red', 'orange',
  'yellow', 'green', 'blue', 'purple', 'pink', 'tan', 'cream', 'beige', 'gold', 'silver',
]);

// Devuelve la especie canónica encontrada en una lista de términos (o null).
function canonicalSpecies(terms = []) {
  for (const t of terms) {
    const key = String(t).toLowerCase();
    if (SPECIES_MAP[key]) return SPECIES_MAP[key];
  }
  return null;
}

// Llama a Rekognition UNA vez y devuelve labels (con parents) + colores dominantes.
async function analyzeImage(buffer) {
  const command = new DetectLabelsCommand({
    Image: { Bytes: buffer },
    MaxLabels: 15,
    MinConfidence: 70,
    Features: ['GENERAL_LABELS', 'IMAGE_PROPERTIES'],
    Settings: { ImageProperties: { MaxDominantColors: 5 } },
  });
  const response = await rekognitionClient.send(command);

  const labels = (response.Labels || []).map((l) => ({
    name: l.Name,
    confidence: Number((l.Confidence || 0).toFixed(2)),
    parents: (l.Parents || []).map((p) => p.Name),
  }));

  const colors = (response.ImageProperties?.DominantColors || [])
    .map((c) => (c.SimplifiedColor || '').toLowerCase())
    .filter((c) => COLOR_TAGS.has(c));

  return { labels, colors: [...new Set(colors)] };
}

// Construye los ai_tags normalizados (especie + raza + color) de una imagen analizada.
function buildAiTags({ labels, colors }) {
  const animal = labels
    .filter(
      (l) =>
        ANIMAL_RELATED_TAGS.includes(l.name) ||
        l.parents.some((p) => ANIMAL_RELATED_TAGS.includes(p))
    )
    .map((l) => l.name.toLowerCase());
  return [...new Set([...animal, ...colors])];
}

// ============================================================
// EMBEDDINGS (Etapa B) — "huella visual" para comparar individuos
// ============================================================

// Devuelve el vector (array de floats) de una imagen vía Titan Multimodal Embeddings.
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
  const response = await bedrockClient.send(command);
  const json = JSON.parse(new TextDecoder().decode(response.body));
  return json.embedding; // array de EMBEDDING_LENGTH floats
}

// Similitud coseno entre dos vectores → -1..1 (1 = casi idénticos).
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- ENDPOINTS DE LA API ---

// Endpoint para ANALIZAR la imagen (se mantiene igual)
app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se ha subido ningún archivo.' });

    try {
        const { labels, colors } = await analyzeImage(req.file.buffer);

        // Para la búsqueda reenviamos solo lo relevante (especie/raza/color), normalizado.
        const aiTags = buildAiTags({ labels, colors });
        const searchLabels = aiTags.map((name) => ({ name, confidence: 100 }));

        console.log("Análisis de Rekognition completado:", { aiTags, colors });
        res.status(200).json({
            message: 'Análisis completado con éxito.',
            labels: searchLabels, // mismo formato que antes: [{ name, confidence }]
            colors,
        });
    } catch (error) {
        console.error("Error al analizar la imagen:", error);
        res.status(500).json({ error: 'Error en el servidor al analizar la imagen.' });
    }
});
// ==========================================================
// === NUEVO ENDPOINT PARA CREAR UN POST Y ANALIZAR LA IMAGEN ===
// ==========================================================
// Comunas de la Región del Biobío (MVP). Detecta la "zona" dentro del texto
// libre de ubicación de Google Places para guardarla en el post. Debe quedar
// alineado con el front (src/constants/biobioComunas.ts).
const BIOBIO_COMUNAS = [
    "Concepción", "Coronel", "Chiguayante", "Florida", "Hualpén", "Hualqui",
    "Lota", "Penco", "San Pedro de la Paz", "Santa Juana", "Talcahuano", "Tomé",
    "Los Ángeles", "Antuco", "Cabrero", "Laja", "Mulchén", "Nacimiento",
    "Negrete", "Quilaco", "Quilleco", "San Rosendo", "Santa Bárbara",
    "Tucapel", "Yumbel", "Alto Biobío",
    "Lebu", "Arauco", "Cañete", "Contulmo", "Curanilahue", "Los Álamos", "Tirúa",
];
const _normComuna = (s) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const _COMUNA_LOOKUP = new Map(BIOBIO_COMUNAS.map((c) => [_normComuna(c), c]));
function detectComuna(location) {
    if (!location) return "";
    for (const part of String(location).split(",")) {
        // El reverse-geocode de Google pega el código postal a la comuna -> quitar dígitos.
        const cleaned = _normComuna(part).replace(/\d+/g, " ").replace(/\s+/g, " ").trim();
        const hit = _COMUNA_LOOKUP.get(cleaned);
        if (hit) return hit;
    }
    return "";
}

// Hasta 3 imágenes por publicación. La PRIMERA se usa para el análisis de IA.
// Push directo a un usuario (ej: "alguien vio tu mascota"). Lo llama el front
// después de crear la notificación in-app, con el $id del destinatario.
app.post('/api/send-push', async (req, res) => {
  try {
    const { externalUserIds, userId, title, body, data } = req.body || {};
    const ids = Array.isArray(externalUserIds)
      ? externalUserIds
      : userId
      ? [userId]
      : [];
    await sendPush(ids, {
      title: title || 'Camada',
      body: body || '',
      data: data || {},
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('send-push error:', e.message);
    res.status(500).json({ error: 'No se pudo enviar el push.' });
  }
});

app.post('/api/create-post-with-analysis', upload.array('imageFiles', 3), async (req, res) => {
    try {
        const imageFiles = req.files;
        if (!imageFiles || imageFiles.length === 0) {
            return res.status(400).json({ error: 'No se ha subido ningún archivo de imagen.' });
        }
        const primary = imageFiles[0]; // la imagen principal alimenta la IA

        console.log(`Analizando imagen principal (de ${imageFiles.length}) de la nueva publicación...`);
        const { labels, colors } = await analyzeImage(primary.buffer);
        const ai_tags = buildAiTags({ labels, colors });

       console.log("Etiquetas de IA generadas (especie/raza/color):", ai_tags);

        // Embedding visual (Etapa B). Si Bedrock falla, seguimos sin él: NO debe
        // bloquear la creación del post. Se guarda más abajo con un update aparte.
        let embedding = null;
        try {
            embedding = JSON.stringify(await getImageEmbedding(primary.buffer));
            console.log("Embedding generado ✔");
        } catch (e) {
            console.error("Embedding no generado (se crea el post igual):", e.message);
        }

        // --- Subir TODAS las imágenes a Appwrite Storage ---
        console.log(`Subiendo ${imageFiles.length} imagen(es) a Appwrite Storage...`);
        const imageIds = [];
        const imageUrls = [];
        for (const f of imageFiles) {
            const fileToUpload = InputFile.fromBuffer(f.buffer, f.originalname);
            const uploaded = await appwriteStorage.createFile(
                process.env.APPWRITE_STORAGE_BUCKET_ID,
                ID.unique(),
                fileToUpload
            );
            imageIds.push(uploaded.$id);
            imageUrls.push(
                `${process.env.APPWRITE_ENDPOINT}/storage/buckets/${process.env.APPWRITE_STORAGE_BUCKET_ID}/files/${uploaded.$id}/view?project=${process.env.APPWRITE_PROJECT_ID}`
            );
        }
        console.log(`   => ${imageUrls.length} URL(s) generada(s)`);

        const postData = {
            creator: req.body.creator,
            caption: req.body.caption,
            location: req.body.location,
            comuna: detectComuna(req.body.location), // zona (comuna del Biobío)
            mascota: req.body.mascota,
            especie: req.body.especie,
            sexo: req.body.sexo,
            color: req.body.color,
            size: req.body.size,
            contacto: req.body.contacto,
            tags: [req.body.tags], // Este es el estado: "encontrado", "perdido", etc.
            imageIds,
            imageUrls,
            ai_tags: ai_tags,
        };
        console.log("Creando documento principal en 'Posts'...");
        const newPost = await databases.createDocument(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_POST_COLLECTION_ID,
            ID.unique(),
            postData
        );
        console.log("Post principal creado con éxito:", newPost.$id);

        // Guardamos el embedding en un update aparte: si el atributo no existe
        // o Bedrock falló, el post YA quedó creado igual (no se rompe nada).
        if (embedding) {
            try {
                await databases.updateDocument(
                    process.env.APPWRITE_DATABASE_ID,
                    process.env.APPWRITE_POST_COLLECTION_ID,
                    newPost.$id,
                    { embedding }
                );
                console.log("Embedding guardado en el post ✔");
            } catch (e) {
                console.error("No se pudo guardar el embedding en el post:", e.message);
            }
        }

        // 2. Preparamos el documento para la colección 'PostDetails'
        const postDetailsData = {
            post: newPost.$id, // Enlazamos con el post recién creado
            reward: req.body.reward,
            foundCondition: req.body.foundCondition,
            adoptionRequirements: req.body.adoptionRequirements,
            // Appwrite maneja bien los números enviados como string desde FormData
            adoptionFee: req.body.adoptionFee ? Number(req.body.adoptionFee) : null, 
            fosterStart: req.body.fosterStart,
            fosterEnd: req.body.fosterEnd,
            fosterRequirements: req.body.fosterRequirements,
        };

        console.log("Creando documento de detalles en 'PostDetails'...");
        await databases.createDocument(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_DETAILS_COLLECTION_ID, // Usamos el ID de la colección de detalles
            ID.unique(),
            postDetailsData
        );
        console.log("Detalles del post guardados con éxito.");
        res.status(201).json(newPost);

        // Geofencing (best-effort, tras responder): si es PERDIDO y trae coords,
        // avisamos por push a los usuarios cuya ubicación cae en la zona de búsqueda.
        if (String(req.body.tags).toLowerCase() === 'perdido' && req.body.lat && req.body.lng) {
            notifyNearbyUsers({
                lat: Number(req.body.lat),
                lng: Number(req.body.lng),
                factors: {
                    especie: req.body.especie,
                    size: req.body.size,
                    sexo: req.body.sexo,
                    esterilizado: req.body.esterilizado === 'true',
                    temperamento: req.body.temperamento,
                    terreno: req.body.terreno,
                    dob: req.body.dob,
                },
                postId: newPost.$id,
                mascota: req.body.mascota,
                creatorId: req.body.creator,
            }).catch((e) => console.log('geofencing fire-and-forget:', e.message));
        }

    } catch (error) {
        console.error("Error al crear la publicación:", error);
        res.status(500).json({ error: 'Error interno del servidor al crear la publicación.' });
    }
});

// === NUEVO ENDPOINT PARA BUSCAR MASCOTAS POR ETIQUETAS DE IA ===
app.post('/api/search-by-tags', async (req, res) => {
  // `targetStatuses` (opcional): p.ej. ["perdido","vista"] para comparar una foto
  // de "encontrado" SOLO contra reportes de mascotas perdidas.
  const { labels, targetStatuses } = req.body;

  if (!labels || labels.length === 0) {
    return res.status(400).json({ error: 'No se proporcionaron etiquetas.' });
  }

  // Clasificamos los términos buscados en especie / color / raza-otros.
  const terms = [...new Set(labels.map((l) => String(l.name).toLowerCase()))];
  const searchedSpecies = canonicalSpecies(terms);
  const searchedColors = terms.filter((t) => COLOR_TAGS.has(t));
  const searchedBreeds = terms.filter((t) => !COLOR_TAGS.has(t) && !SPECIES_MAP[t]);
  console.log('Buscando →', { searchedSpecies, searchedBreeds, searchedColors });

  try {
    // Traemos todos los posts (en lotes de 100, límite de Appwrite)
    let allPosts = [];
    let lastId = null;
    let keepFetching = true;

    while (keepFetching) {
      const queries = [Query.limit(100)];
      if (lastId) queries.push(Query.cursorAfter(lastId));

      const response = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_POST_COLLECTION_ID,
        queries
      );

      allPosts = allPosts.concat(response.documents);

      if (response.documents.length < 100) {
        keepFetching = false;
      } else {
        lastId = response.documents[response.documents.length - 1].$id;
      }
    }

    console.log(`Total posts traídos: ${allPosts.length}`);

    // Puntuación ponderada: especie pesa fuerte, raza media, color bajo.
    const results = allPosts
      .map((post) => {
        const tags = Array.isArray(post.ai_tags)
          ? post.ai_tags.map((t) => String(t).toLowerCase())
          : [];
        // Especie del post: priorizamos el campo `especie` (dueño) y caemos a los ai_tags.
        const postSpecies = canonicalSpecies([
          String(post.especie || '').toLowerCase(),
          ...tags,
        ]);

        // GATE por especie: si ambas se conocen y son distintas, no es coincidencia.
        if (searchedSpecies && postSpecies && searchedSpecies !== postSpecies) {
          return { ...post, relevance_score: 0 };
        }

        const postColors = tags.filter((t) => COLOR_TAGS.has(t));
        const postBreeds = tags.filter((t) => !COLOR_TAGS.has(t) && !SPECIES_MAP[t]);

        const breedMatches = searchedBreeds.filter((b) => postBreeds.includes(b)).length;
        const colorMatches = searchedColors.filter((c) => postColors.includes(c)).length;

        let score = 0;
        if (searchedSpecies && postSpecies && searchedSpecies === postSpecies) score += 50;
        score += Math.min(breedMatches * 15, 30); // hasta +30 por raza/rasgos
        score += Math.min(colorMatches * 10, 20);  // hasta +20 por color

        return { ...post, relevance_score: Math.min(score, 100) };
      })
      .filter((post) => {
        if (post.relevance_score <= 0) return false;
        // Filtro opcional por estado (tags[0] guarda "perdido"/"encontrado"/...).
        if (Array.isArray(targetStatuses) && targetStatuses.length) {
          const status = Array.isArray(post.tags)
            ? String(post.tags[0]).toLowerCase()
            : '';
          return targetStatuses.includes(status);
        }
        return true;
      })
      .sort((a, b) => b.relevance_score - a.relevance_score);

    console.log(`Posts con coincidencias: ${results.length}`);
    res.status(200).json(results);

  } catch (error) {
    console.error('Error en search-by-tags:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================================
// === BÚSQUEDA POR SIMILITUD VISUAL (Etapa B — embeddings) ===
// ==========================================================
app.post('/api/search-by-embedding', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se ha subido ninguna imagen.' });
  }

  // Estados a comparar (por defecto, solo reportes "perdido").
  const statuses = (req.body.targetStatuses
    ? String(req.body.targetStatuses).split(',')
    : ['perdido']
  ).map((s) => s.trim().toLowerCase());

  try {
    // 1) Analizamos la foto (especie/color para el gate y para el fallback).
    const { labels, colors } = await analyzeImage(req.file.buffer);
    const queryTerms = buildAiTags({ labels, colors });
    const searchedSpecies = canonicalSpecies(queryTerms);
    const searchedColors = queryTerms.filter((t) => COLOR_TAGS.has(t));
    const searchedBreeds = queryTerms.filter(
      (t) => !COLOR_TAGS.has(t) && !SPECIES_MAP[t]
    );

    // 2) Intentamos el embedding visual. Si Bedrock no está disponible (p. ej.
    //    Titan aún sin aprobar), seguimos con el scoring por tags (Etapa A).
    let queryVector = null;
    try {
      queryVector = await getImageEmbedding(req.file.buffer);
    } catch (e) {
      console.error('Bedrock no disponible, uso fallback por tags:', e.message);
    }

    // 3) Traemos todos los posts (lotes de 100).
    let allPosts = [];
    let lastId = null;
    let keepFetching = true;
    while (keepFetching) {
      const queries = [Query.limit(100)];
      if (lastId) queries.push(Query.cursorAfter(lastId));
      const response = await databases.listDocuments(
        process.env.APPWRITE_DATABASE_ID,
        process.env.APPWRITE_POST_COLLECTION_ID,
        queries
      );
      allPosts = allPosts.concat(response.documents);
      if (response.documents.length < 100) keepFetching = false;
      else lastId = response.documents[response.documents.length - 1].$id;
    }

    const anyEmbeddings = allPosts.some((p) => p.embedding);
    const useEmbeddings = !!queryVector && anyEmbeddings;
    console.log('Búsqueda →', {
      searchedSpecies,
      statuses,
      modo: useEmbeddings ? 'visual (embeddings)' : 'tags (fallback)',
    });

    // 4) Puntuamos cada post. Preferimos similitud visual; si el post no tiene
    //    vector (o no hay Bedrock), caemos a scoring por tags. Nada se oculta.
    const results = allPosts
      .map((post) => {
        const tags = Array.isArray(post.ai_tags)
          ? post.ai_tags.map((t) => String(t).toLowerCase())
          : [];
        const postSpecies = canonicalSpecies([
          String(post.especie || '').toLowerCase(),
          ...tags,
        ]);

        // Gate por especie (en ambos modos): descarta cruces perro↔gato.
        if (searchedSpecies && postSpecies && searchedSpecies !== postSpecies) {
          return null;
        }

        let score = 0;
        let mode = 'tags';

        let vec = null;
        if (useEmbeddings && post.embedding) {
          try { vec = JSON.parse(post.embedding); } catch { vec = null; }
        }

        if (vec) {
          score = Math.max(0, Math.round(cosineSimilarity(queryVector, vec) * 100));
          mode = 'visual';
        } else {
          // Fallback Etapa A: especie + raza + color.
          const postColors = tags.filter((t) => COLOR_TAGS.has(t));
          const postBreeds = tags.filter((t) => !COLOR_TAGS.has(t) && !SPECIES_MAP[t]);
          const breedMatches = searchedBreeds.filter((b) => postBreeds.includes(b)).length;
          const colorMatches = searchedColors.filter((c) => postColors.includes(c)).length;
          if (searchedSpecies && postSpecies && searchedSpecies === postSpecies) score += 50;
          score += Math.min(breedMatches * 15, 30);
          score += Math.min(colorMatches * 10, 20);
          score = Math.min(score, 100);
        }

        return { ...post, relevance_score: score, match_mode: mode };
      })
      .filter(Boolean)
      .filter((post) => {
        const status = Array.isArray(post.tags)
          ? String(post.tags[0]).toLowerCase()
          : '';
        return statuses.includes(status);
      })
      .filter((post) => post.relevance_score > 0)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 20);

    console.log(`Coincidencias: ${results.length}`);
    res.status(200).json(results);
  } catch (error) {
    console.error('Error en search-by-embedding:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check para App Runner (y monitoreo). Debe responder 200 rápido.
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/', (req, res) => res.status(200).send('noname backend ok'));

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en el puerto ${PORT}`);
});