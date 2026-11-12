# Paradise Reader service (Cloud Run). Build context: reader/
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
