# XFeed Paradise built-in scoring service (Cloud Run). No npm dependencies.
# Node 22.23.3 (released 2026-09-23); bump only to releases at least a month old.
FROM node:22.23.3-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json index.js ./
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "index.js"]
