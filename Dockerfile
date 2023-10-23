FROM node:18-alpine AS build
WORKDIR /app
ENV RPC_URLS ""
COPY --link . .
RUN yarn install
RUN yarn build

FROM node:18-alpine
WORKDIR /app
COPY --link --from=build /app/src src
COPY --link --from=build /app/package.json package.json
COPY --link --from=build /app/yarn.lock yarn.lock
RUN yarn install --production
CMD ["node", "src/index.js"]
EXPOSE 3000
