# noname.app — Backend

Servicio de **análisis de imágenes con IA** para noname.app. Es un servidor Express
que usa **AWS Rekognition** para detectar qué animal aparece en una foto, y
**Appwrite** para guardar/buscar publicaciones.

Es el complemento del frontend: 👉 [Noname_APP_FRONT](https://github.com/Rawwrrh/Noname_APP_FRONT).

> El front habla **directo con Appwrite** para auth/DB/storage. Este backend existe
> solo para lo que Appwrite no hace: la IA de reconocimiento visual.

---

## Stack

- Node.js + Express 5
- AWS Rekognition (`@aws-sdk/client-rekognition`)
- Appwrite (server SDK `node-appwrite`)
- multer (subida de archivos en memoria) · cors · dotenv

---

## Endpoints

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/analyze-image` | Recibe una imagen (campo `image`) y devuelve etiquetas detectadas por Rekognition |
| `POST` | `/api/create-post-with-analysis` | Recibe una imagen (campo `imageFile`) + datos del post; analiza, sube a Storage y crea la publicación con etiquetas IA |
| `POST` | `/api/search-by-tags` | Recibe `{ labels }` y devuelve publicaciones ordenadas por coincidencia |

El servidor escucha en el puerto **5000** (`http://localhost:5000`).

---

## Requisitos

- **Node.js 18+** y npm
- Una cuenta de **AWS** con acceso a **Rekognition** (access key + secret + región)
- Un proyecto de **Appwrite** con una **API key** (server) con permisos de DB y Storage

---

## Instalación

```bash
# 1. Clonar
git clone https://github.com/Rawwrrh/Noname_APP_BACK.git
cd Noname_APP_BACK

# 2. Instalar dependencias
npm install

# 3. Configurar variables de entorno
cp .env.example .env     # luego edita .env con tus valores reales

# 4. Levantar
npm start                # http://localhost:5000
```

---

## Variables de entorno

Copia `.env.example` a `.env` y completa los valores. **El `.env` nunca se sube al repo**
(contiene claves secretas).

### Appwrite

| Variable | Descripción |
|---|---|
| `APPWRITE_ENDPOINT` | Endpoint de Appwrite (ej. `https://cloud.appwrite.io/v1`) |
| `APPWRITE_PROJECT_ID` | ID del proyecto |
| `APPWRITE_API_KEY` | **API key secreta** (server) con permisos de DB y Storage |
| `APPWRITE_DATABASE_ID` | ID de la base de datos |
| `APPWRITE_POST_COLLECTION_ID` | Colección de publicaciones |
| `APPWRITE_DETAILS_COLLECTION_ID` | Colección de detalles de publicación |
| `APPWRITE_STORAGE_BUCKET_ID` | ID del bucket de Storage donde se suben las imágenes |

### AWS Rekognition

| Variable | Descripción |
|---|---|
| `AWS_REGION` | Región de AWS (ej. `us-east-1`) |
| `AWS_ACCESS_KEY_ID` | Access key del usuario IAM con permiso `rekognition:DetectLabels` |
| `AWS_SECRET_ACCESS_KEY` | Secret access key |

> El cliente de Rekognition se inicializa sin config explícita: toma las credenciales
> automáticamente de estas variables de entorno (estándar del AWS SDK).

---

## Scripts

| Comando | Qué hace |
|---|---|
| `npm start` | Inicia el servidor (`node server.js`) |

---

## Deploy (Render)

Está pensado para desplegarse en **Render** (u otro host de Node):

- **Build command:** `npm install`
- **Start command:** `npm start`
- Cargar todas las variables de entorno en el panel del servicio.
- La URL pública resultante es la que va en `VITE_BACKEND_URL` del frontend.

> ⚠️ En el plan gratuito, Render **suspende el servicio por inactividad**. La primera
> petición tras un rato tarda ~30–50 s en responder mientras el servicio "despierta".

---

## Seguridad

- **Nunca** subas el `.env` ni las claves de AWS/Appwrite al repo.
- La `APPWRITE_API_KEY` y las credenciales de AWS deben vivir **solo** en este backend,
  jamás en el frontend.
