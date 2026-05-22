FROM node:20-slim
WORKDIR /app
COPY dist/ ./dist/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
ENTRYPOINT ["node", "dist/runner.js"]
