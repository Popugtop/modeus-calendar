# Stage 1: install all deps once (compiles better-sqlite3 native addon)
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2: compile TypeScript (reuses node_modules, no recompilation)
FROM node:22-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src ./src
RUN node_modules/.bin/tsc --project tsconfig.json

# Stage 3: production image
FROM node:22-slim

WORKDIR /app

# Copy node_modules from deps and prune devDependencies (no recompilation)
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
RUN npm prune --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data
EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
