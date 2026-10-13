# Chit browser service: Chromium + Puppeteer, one incognito context per chat.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji fonts-noto-cjk ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs frames.mjs ./
ENV NODE_ENV=production CHROME_PATH=/usr/bin/chromium PORT=8080
EXPOSE 8080
# Chromium runs as a non-root user.
RUN useradd -m browser && chown -R browser /app
USER browser
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.mjs"]
