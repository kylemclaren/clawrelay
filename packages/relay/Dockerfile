FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY src ./src
COPY tsconfig.json ./
CMD ["npx", "tsx", "src/index.ts"]
