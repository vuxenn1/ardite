# Ardite in a container, for servers and NAS boxes (x64 and ARM).
#   docker run -d --name ardite --init --network host --restart unless-stopped \
#     -v ardite-data:/app/data ghcr.io/vuxenn1/ardite
# yt-dlp and ffmpeg are downloaded (and checked) while the image is built; yt-dlp keeps itself
# up to date inside the container. Settings, history and statistics live in /app/data.
FROM node:24-bookworm-slim

ARG VERSION=0.0.0-dev

# xz unpacks the ffmpeg download
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates xz-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js setup.js ardite.js ./
COPY lib lib
COPY public public

RUN sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" package.json \
  && node setup.js \
  && rm -rf data && mkdir data \
  && chown -R node:node /app

USER node
EXPOSE 7878
VOLUME /app/data
HEALTHCHECK --interval=1m --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7878)+'/api/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
