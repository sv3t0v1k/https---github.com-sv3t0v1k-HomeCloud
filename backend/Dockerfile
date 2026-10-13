FROM node:20-alpine AS base

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
