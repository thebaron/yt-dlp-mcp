FROM node:25.9-alpine AS build

WORKDIR /app

COPY package*.json tsconfig*.json ./
COPY src ./src
RUN npm ci && npm prune --omit=dev

FROM node:25.9-alpine

WORKDIR /app

# ffmpeg merges video+audio streams, extracts audio and trims clips
RUN apk add --no-cache python3 uv ffmpeg \
 && uv pip install --system --break-system-packages "yt-dlp[default]"

# yt-dlp needs a JavaScript runtime for YouTube; reuse the image's Node.
# This is a system-wide config file, so YTDLP_IGNORE_CONFIG=1 also skips it.
RUN printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib

ENV NODE_ENV=production \
    YTDLP_MCP_TRANSPORT=http \
    YTDLP_MCP_HOST=0.0.0.0 \
    YTDLP_MCP_PORT=3000 \
    YTDLP_DOWNLOADS_DIR=/data \
    YTDLP_DEFAULT_RESOLUTION=1080p \
    YTDLP_DEFAULT_AUDIO_FORMAT=m4a \
    YTDLP_DEFAULT_SUBTITLE_LANG=en

RUN mkdir -p /data && chown node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["node", "lib/index.mjs"]
