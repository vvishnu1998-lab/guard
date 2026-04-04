FROM node:20-alpine AS builder
WORKDIR /app

# Install ALL deps (devDeps needed for TypeScript compiler)
COPY package.json ./
RUN npm install

# Compile TypeScript → dist/
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/ ./dist/db/

COPY package.json ./
RUN npm install --omit=dev

EXPOSE 3001
CMD ["node", "dist/index.js"]
