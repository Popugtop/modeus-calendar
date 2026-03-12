# ─── Stage 1: install production deps (+ compile native addon) ───────────────
FROM node:22-slim AS deps

# better-sqlite3 is a native addon — needs build tools.
# node:22-slim is Debian, so glibc is available and prebuilt binaries may work,
# but we include build tools as a fallback for compilation.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ─── Stage 2: compile TypeScript ─────────────────────────────────────────────
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --project tsconfig.json

# ─── Stage 3: production image ────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Copy production node_modules (with compiled native addon)
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# Copy compiled JS
COPY --from=builder /app/dist ./dist

# Data directory for SQLite — mounted as a volume in docker-compose
RUN mkdir -p /app/data

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/server.js"]
