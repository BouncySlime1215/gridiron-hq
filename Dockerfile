# Self-host image: builds the client, runs the server as a single always-on
# process. node:sqlite (server/db) needs no native compile, so no build stage
# is required for the server itself — only the client's Vite build does.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/client/dist ./client/dist
COPY server ./server
COPY scripts ./scripts

# server/db/index.js reads GRIDIRON_DB_PATH; the Fly volume is mounted at
# /data so the sqlite file survives redeploys instead of living in the
# throwaway container filesystem.
ENV GRIDIRON_DB_PATH=/data/data.sqlite
EXPOSE 5177
CMD ["node", "server/index.js"]
