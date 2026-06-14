# Imagen de contenedor para el backend de noname (ECS Express Mode / cualquier host de contenedores)
# Usamos el mirror oficial en Amazon ECR Public en vez de Docker Hub para evitar
# el rate limit de pulls anónimos (429 toomanyrequests) en CodeBuild.
FROM public.ecr.aws/docker/library/node:18-alpine

# Carpeta de trabajo dentro del contenedor
WORKDIR /app

# Instalamos dependencias primero (mejor caché de capas)
COPY package*.json ./
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . .

# El backend escucha en este puerto (server.js usa process.env.PORT)
ENV PORT=8080
EXPOSE 8080

# Comando de arranque
CMD ["node", "server.js"]
