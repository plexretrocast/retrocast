# ── RetroCast ─────────────────────────────────────────────────────────────────
#
# Self-contained: Node.js + ffmpeg are included — nothing to install on the host
# except Docker Desktop (Windows/Mac) or Docker Engine (Linux).
#
# GPU transcoding is configured via the ENCODER env var and matching
# passthrough in docker-compose.yml — see that file for instructions.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-slim

LABEL org.opencontainers.image.title="RetroCast"
LABEL org.opencontainers.image.description="Retro TV Guide for Plex — HLS streaming server"
LABEL org.opencontainers.image.source="https://github.com/plexretrocast/retrocast"

# ffmpeg is the only system dependency
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies (own layer for better cache reuse)
COPY package.json ./
RUN npm install --omit=dev

# Copy application
COPY server.js ./
COPY index.html ./

# /data is where retrocast-data.json lives — mount a volume here
VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_FILE=/data/retrocast-data.json \
    ENCODER=auto

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/state',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
