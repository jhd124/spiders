# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run web:build

FROM node:20-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SPIDERS_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "web/server/index.ts"]
