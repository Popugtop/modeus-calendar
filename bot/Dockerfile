# node:22-slim (Debian/glibc) — better-sqlite3 downloads a prebuilt binary
# instead of compiling from C++, so no build tools needed.

# Stage 1: install all deps (prebuilt binary, fast)
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2: build TypeScript
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN node_modules/.bin/tsc

# Stage 3: production image
FROM node:22-slim AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
RUN npm prune --omit=dev
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
