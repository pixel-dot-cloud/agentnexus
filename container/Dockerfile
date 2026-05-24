FROM node:20-slim
WORKDIR /app
COPY dist/ ./dist/
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN touch /heartbeat && chmod 666 /heartbeat
ENTRYPOINT ["node", "/app/dist/runner.js"]
