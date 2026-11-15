FROM node:24-alpine

# yt-dlp (descargas de YouTube) en un entorno virtual propio, para poder actualizarlo sin root.
# ffmpeg extrae el audio e incrusta la carátula; Node (ya en la imagen) resuelve los retos JS de YouTube.
# ytmusicapi busca canciones (el audio oficial) en YouTube Music; el plugin de bgutil pide PO tokens al
# contenedor bgutil-provider para que YouTube no pida "confirmar que no eres un bot".
RUN apk add --no-cache ffmpeg python3 \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]" ytmusicapi bgutil-ytdlp-pot-provider \
 && chown -R node:node /opt/yt-dlp
ENV YTDLP_BIN=/opt/yt-dlp/bin/yt-dlp \
    YTMUSIC_PYTHON=/opt/yt-dlp/bin/python \
    YTDLP_UPDATE_CMD="/opt/yt-dlp/bin/pip install --no-cache-dir --quiet --upgrade yt-dlp[default] ytmusicapi bgutil-ytdlp-pot-provider"

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# El usuario "node" de la imagen tiene uid 1000, igual que el primer usuario del servidor.
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
