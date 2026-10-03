# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

RUN npm install -g corepack@latest && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* .npmrc* ./
RUN corepack prepare pnpm@11.9.0 --activate
RUN pnpm config set confirm-modules-purge false
RUN pnpm install --frozen-lockfile || pnpm install --dangerously-allow-all-builds || pnpm install

COPY . .

EXPOSE 1420

CMD ["pnpm", "dev", "--host", "0.0.0.0"]
