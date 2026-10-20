FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY test ./test
RUN npm run check && npm test && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3005

COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3005
CMD ["node", "dist/index.js"]
