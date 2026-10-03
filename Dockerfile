# Production image for Fly.io (also works on Railway / Render).
# The SQLite database lives on a mounted volume at /data (see fly.toml).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Throwaway database for the build step only; the real one is on the volume at runtime.
RUN DATABASE_URL="file:/tmp/build.db" npm run build

ENV NODE_ENV=production PORT=3000 DATABASE_URL="file:/data/store.db"
EXPOSE 3000
CMD ["sh", "scripts/start.sh"]
