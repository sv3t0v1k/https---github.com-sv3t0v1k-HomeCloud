ARG NODE_IMAGE=docker.io/library/node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
FROM ${NODE_IMAGE} AS base

# SHA256 проверяется до запуска npm; установка из архива остаётся offline.
RUN node --input-type=module -e ' \
    import {mkdtempSync, writeFileSync, rmSync} from "node:fs"; \
    import {join} from "node:path"; \
    import {tmpdir} from "node:os"; \
    import {createHash} from "node:crypto"; \
    import {execFileSync} from "node:child_process"; \
    const temporary = mkdtempSync(join(tmpdir(), "homecloud-npm-")); \
    try { \
      const response = await fetch("https://registry.npmjs.org/npm/-/npm-11.21.1.tgz", {signal: AbortSignal.timeout(60000)}); \
      if (!response.ok) throw new Error("npm archive HTTP failure"); \
      const bytes = Buffer.from(await response.arrayBuffer()); \
      if (createHash("sha256").update(bytes).digest("hex") !== "dd77c48eb845f4856c2cdba347cfb52bd877a2655a1ea48ff0c4796e3df9dd7b") throw new Error("npm archive SHA256 mismatch"); \
      const archive = join(temporary, "npm.tgz"); \
      writeFileSync(archive, bytes); \
      execFileSync("npm", ["install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--cache", join(temporary, "cache"), archive], {stdio: "inherit"}); \
      if (execFileSync("npm", ["--version"], {encoding: "utf8"}).trim() !== "11.21.1") throw new Error("npm version mismatch"); \
    } finally { rmSync(temporary, {recursive: true, force: true}); }'

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
