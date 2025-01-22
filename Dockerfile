FROM node:18-alpine AS build
WORKDIR /app
ENV RPC_URLS=""
COPY --link . .
RUN npm install -g pnpm
RUN pnpm install
RUN pnpm build

FROM node:18-alpine
WORKDIR /app
COPY --link --from=build /app/src src
COPY --link --from=build /app/package.json package.json
COPY --link --from=build /app/pnpm-lock.yaml pnpm-lock.yaml
RUN npm install -g pnpm
RUN pnpm install --production
CMD ["node", "src/index.js"]
EXPOSE 3000
