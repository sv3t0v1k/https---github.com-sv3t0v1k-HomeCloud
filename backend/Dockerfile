ARG NODE_IMAGE=docker.io/library/node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
FROM scratch AS npm-package
ADD --checksum=sha256:dd77c48eb845f4856c2cdba347cfb52bd877a2655a1ea48ff0c4796e3df9dd7b https://registry.npmjs.org/npm/-/npm-11.21.1.tgz /npm.tgz

FROM ${NODE_IMAGE} AS base

# Точный архив проверяется BuildKit до запуска npm; install остаётся offline.
RUN --mount=type=bind,from=npm-package,source=/npm.tgz,target=/tmp/npm.tgz \
    npm install --global --ignore-scripts --no-audit --no-fund --offline --cache /tmp/npm-bootstrap-cache /tmp/npm.tgz \
    && test "$(npm --version)" = 11.21.1 \
    && rm -rf /tmp/npm-bootstrap-cache

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

# Runtime запускает Node напрямую; global npm/npx и их зависимости здесь не нужны.
# Удаляется только tooling базового образа, production node_modules сохраняются.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

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
