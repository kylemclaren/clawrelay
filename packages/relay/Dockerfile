FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY src ./src
COPY tsconfig.json ./
CMD ["bun", "run", "src/index.ts"]
