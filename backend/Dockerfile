ARG NODE_IMAGE=docker.io/library/node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
FROM ${NODE_IMAGE} AS base

WORKDIR /app

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

FROM base AS deps
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS builder
RUN apk add --no-cache gcc musl-dev linux-headers
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN sh native/build.sh && npm run build

FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/native/secure-fs.node ./native/secure-fs.node
COPY --from=builder /app/package.json ./

# Новый named volume получает UID/mode через Docker copy-up. Existing volumes не chown.
# Bind mounts на Linux оператор готовит отдельно; VOLUME намеренно не объявляется (D1).
RUN mkdir -p /storage/.tmp && chown -R 1001:1001 /storage && chmod 700 /storage /storage/.tmp
COPY docker ./docker

EXPOSE 3000

USER nextjs

ENTRYPOINT ["sh", "docker/entrypoint.sh"]
CMD ["node", "dist/main.js"]
