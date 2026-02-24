FROM nvidia/cuda:12.3.1-runtime-ubuntu22.04

LABEL org.opencontainers.image.title="RetroCast"
LABEL org.opencontainers.image.description="Retro TV Guide for Plex — HLS streaming server"
LABEL org.opencontainers.image.source="https://github.com/plexretrocast/retrocast"

# Install Node.js 20 + ffmpeg
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl \
      ffmpeg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY index.html ./

VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE=/data/retrocast-data.json \
    ENCODER=auto \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=video,compute,utility

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/state',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
