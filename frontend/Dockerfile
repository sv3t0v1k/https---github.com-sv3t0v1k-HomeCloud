ARG NODE_IMAGE=docker.io/library/node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG NGINX_IMAGE=docker.io/library/nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
FROM scratch AS npm-package
ADD --checksum=sha256:dd77c48eb845f4856c2cdba347cfb52bd877a2655a1ea48ff0c4796e3df9dd7b https://registry.npmjs.org/npm/-/npm-11.21.1.tgz /npm.tgz

FROM ${NODE_IMAGE} AS npm-base
# Точный архив проверяется BuildKit до запуска npm; install остаётся offline.
RUN --mount=type=bind,from=npm-package,source=/npm.tgz,target=/tmp/npm.tgz \
    npm install --global --ignore-scripts --no-audit --no-fund --offline --cache /tmp/npm-bootstrap-cache /tmp/npm.tgz \
    && test "$(npm --version)" = 11.21.1 \
    && rm -rf /tmp/npm-bootstrap-cache

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
RUN apk add --no-cache --upgrade libexpat=2.8.5-r0 pcre2=10.49-r0 tiff=4.7.2-r0
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
