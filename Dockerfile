# Imagen de contenedor para el backend de noname (ECS Express Mode / cualquier host de contenedores)
FROM node:18-alpine

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
