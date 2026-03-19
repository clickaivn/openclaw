# Admin page ClickBot — Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production 2>/dev/null || npm install

# Copy application files
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

# Copy icon/asset files
COPY *.png *.ico *.svg ./

# Create data directory
RUN mkdir -p data/meeting

EXPOSE 3456

CMD ["node", "server.js"]
