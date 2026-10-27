FROM node:25.9-alpine 

WORKDIR /app

ENV YTDLP_DOWNLOADS_DIR=/data
ENV YTDLP_DEFAULT_RESOLUTION=1080p
ENV YTDLP_DEFAULT_AUDIO_FORMAT=m4a
ENV YTDLP_DEFAULT_SUBTITLE_LANG=en 

COPY package*.json ./
COPY tsconfig*.json ./
COPY src ./src

RUN apk add --no-cache python3 uv
RUN uv pip install --system --break-system-packages yt-dlp
RUN npm install

VOLUME ["/data"]

ENTRYPOINT ["npx", "-y", "."]


