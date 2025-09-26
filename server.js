// noname-backend/server.js

const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const { RekognitionClient, DetectLabelsCommand } = require('@aws-sdk/client-rekognition');
const { Client, Databases, Query, ID, Storage } = require('node-appwrite'); // SDK de Appwrite
const { InputFile } = require('node-appwrite/file');
console.log({ Client, Databases, Query, ID, Storage, InputFile });

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- INICIALIZACIÓN DE CLIENTES ---
// Cliente de AWS Rekognition
const rekognitionClient = new RekognitionClient({ /* ...config... */ });

// Cliente de Appwrite
const appwriteClient = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(appwriteClient);
const appwriteStorage = new Storage(appwriteClient);

const ANIMAL_RELATED_TAGS = [
  'Animal', 'Pet', 'Dog', 'Puppy', 'Cat', 'Kitten', 'Mammal',
  'Canine', 'Feline', // Categorías generales
  // Puedes añadir aquí razas comunes si lo deseas
  'Golden Retriever', 'Labrador Retriever', 'German Shepherd', 'Poodle', 'Bulldog',
  'Siamese Cat', 'Persian Cat', 'Maine Coon', 'Tabby Cat'
];

// --- ENDPOINTS DE LA API ---

// Endpoint para ANALIZAR la imagen (se mantiene igual)
app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se ha subido ningún archivo.' });
    
    try {
        const params = { Image: { Bytes: req.file.buffer }, MaxLabels: 10, MinConfidence: 75 };
        
        // ===> LA LÍNEA QUE FALTABA ESTÁ AQUÍ <===
        const command = new DetectLabelsCommand(params);
        
        const response = await rekognitionClient.send(command);
        const labels = response.Labels.map(label => ({ name: label.Name, confidence: label.Confidence.toFixed(2) }));
        
        console.log("Análisis de Rekognition completado:", labels);
        res.status(200).json({ message: 'Análisis completado con éxito.', labels });
    } catch (error) {
        console.error("Error al analizar la imagen:", error);
        res.status(500).json({ error: 'Error en el servidor al analizar la imagen.' });
    }
});
// ==========================================================
// === NUEVO ENDPOINT PARA CREAR UN POST Y ANALIZAR LA IMAGEN ===
// ==========================================================
app.post('/api/create-post-with-analysis', upload.single('imageFile'), async (req, res) => {
    try {
        const imageFile = req.file;
        if (!imageFile) {
            return res.status(400).json({ error: 'No se ha subido ningún archivo de imagen.' });
        }

        console.log("Analizando imagen de la nueva publicación...");
        const params = { Image: { Bytes: imageFile.buffer }, MaxLabels: 10, MinConfidence: 75 };
        const command = new DetectLabelsCommand(params);
        const rekognitionResponse = await rekognitionClient.send(command);
        const ai_tags = rekognitionResponse.Labels
        .filter(label => 
            ANIMAL_RELATED_TAGS.includes(label.Name) || 
            label.Parents.some(parent => ANIMAL_RELATED_TAGS.includes(parent.Name))
        )
        .map(label => label.Name);

       console.log("Etiquetas de IA generadas (SOLO RELEVANTES):", ai_tags);

        // --- Subir la imagen a Appwrite Storage ---
        console.log("Subiendo imagen a Appwrite Storage...");
        // 3. Creamos un archivo a partir del buffer de la imagen
        // El nuevo método es más simple: pasamos el buffer y el nombre directamente.
        const fileToUpload = InputFile.fromBuffer(
            imageFile.buffer,
            imageFile.originalname
        );
        
        // 4. Subimos el archivo al bucket
        const uploadedFile = await appwriteStorage.createFile(
            process.env.APPWRITE_STORAGE_BUCKET_ID,
            ID.unique(), // Appwrite genera un ID único para el archivo
            fileToUpload
        );
        console.log("Archivo subido con éxito:", uploadedFile);
        
        // 5. Obtenemos la URL pública para ver la imagen
        const imageUrlResult = appwriteStorage.getFileView(
            process.env.APPWRITE_STORAGE_BUCKET_ID,
            uploadedFile.$id // Usamos el ID del archivo que acabamos de subir
        );
        const imageUrl = `${process.env.APPWRITE_ENDPOINT}/storage/buckets/${process.env.APPWRITE_STORAGE_BUCKET_ID}/files/${uploadedFile.$id}/view?project=${process.env.APPWRITE_PROJECT_ID}`;
        console.log("   => URL generada:", imageUrl);
        
        const postData = {
            creator: req.body.creator,
            caption: req.body.caption,
            location: req.body.location,
            mascota: req.body.mascota,
            especie: req.body.especie,
            sexo: req.body.sexo,
            color: req.body.color,
            size: req.body.size,
            contacto: req.body.contacto,
            tags: [req.body.tags], // Este es el estado: "encontrado", "perdido", etc.
            imageIds: [uploadedFile.$id],
            imageUrls: [imageUrl],
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

    } catch (error) {
        console.error("Error al crear la publicación:", error);
        res.status(500).json({ error: 'Error interno del servidor al crear la publicación.' });
    }
});

// === NUEVO ENDPOINT PARA BUSCAR MASCOTAS POR ETIQUETAS DE IA ===
app.post('/api/search-by-tags', async (req, res) => {
    const { labels } = req.body; // Recibimos las etiquetas del frontend

    if (!labels || labels.length === 0) {
        return res.status(400).json({ error: 'No se proporcionaron etiquetas para la búsqueda.' });
    }

    const searchTerms = labels.map(label => label.name);
    console.log('Buscando mascotas con los términos:', searchTerms);

    try {
        // 1. Buscamos en Appwrite todos los posts que contengan CUALQUIERA de las etiquetas.
        const promise = await databases.listDocuments(
            process.env.APPWRITE_DATABASE_ID,
            process.env.APPWRITE_POST_COLLECTION_ID,
            [ Query.search('ai_tags', searchTerms.join(' ')) ] // Query.search busca en arrays de strings
        );

        const initialResults = promise.documents;
        console.log(`Appwrite encontró ${initialResults.length} resultados iniciales.`);

        // 2. Calculamos la puntuación de relevancia manualmente
        const scoredResults = initialResults.map(post => {
            let matchCount = 0;
            // Contamos cuántas de las etiquetas de búsqueda están en las ai_tags del post
            searchTerms.forEach(term => {
                if (post.ai_tags.includes(term)) {
                    matchCount++;
                }
            });
            const relevance_score = (matchCount / searchTerms.length) * 100; // Puntuación en porcentaje
            return { ...post, relevance_score };
        });

        // 3. Ordenamos los resultados por la puntuación de relevancia
        const sortedResults = scoredResults.sort((a, b) => b.relevance_score - a.relevance_score);

        // 4. Devolvemos los resultados ordenados al frontend
        res.status(200).json(sortedResults);

    } catch (error) {
        console.error("Error al buscar en la base de datos de Appwrite:", error);
        res.status(500).json({ error: 'Error interno del servidor durante la búsqueda.' });
    }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor backend escuchando en http://localhost:${PORT}`);
});