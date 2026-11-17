FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY . .
RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "src/index.ts"]
