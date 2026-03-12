# Stage 1: install all deps + compile native modules once
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci

# Stage 2: build TypeScript
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx tsc

# Stage 3: production image — copy pre-built binaries, prune devDeps (no recompilation)
FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
RUN npm prune --omit=dev
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/index.js"]
