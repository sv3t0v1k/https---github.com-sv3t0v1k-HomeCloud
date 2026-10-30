ARG NODE_IMAGE=docker.io/library/node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG NGINX_IMAGE=docker.io/library/nginx:1.30.6-alpine3.24@sha256:0e52bd054126cdc040b1276c0af347aeb02a41b9cfe305d6094767ac30e97949
FROM ${NODE_IMAGE} AS npm-base
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

FROM npm-base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

FROM npm-base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

FROM ${NGINX_IMAGE} AS runner
# Адресные security patches совместимых библиотек; base digest сохраняется.
RUN apk add --no-cache --upgrade \
    brotli-libs=1.2.1-r0 \
    curl=8.23.0-r0 \
    libcurl=8.23.0-r0 \
    libx11=1.8.14-r0 \
    libexpat=2.9.0-r0 \
    pcre2=10.49-r0 \
    tiff=4.7.2-r0
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
