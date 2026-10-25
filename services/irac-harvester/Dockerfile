FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY src ./src
CMD ["npm","start"]
# trigger isolated service build
