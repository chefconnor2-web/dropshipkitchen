# Production image for Fly.io and Railway (also works on Render).
# The SQLite database lives on a volume mounted at /data (fly.toml [mounts]; on Railway, attach a volume at /data).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Throwaway database for the build step only; the real one is on the volume at runtime.
RUN DATABASE_URL="file:/tmp/build.db" npm run build

# /data exists even without a volume, so a first boot works anywhere (the data is then lost on redeploy).
RUN mkdir -p /data
ENV NODE_ENV=production PORT=3000 DATABASE_URL="file:/data/store.db?socket_timeout=30&connection_limit=1"
EXPOSE 3000
CMD ["sh", "scripts/start.sh"]
