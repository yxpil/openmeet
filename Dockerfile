# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /repo
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build:server

FROM node:24-alpine
ENV NODE_ENV=production \
    OPENMEET_DATA_DIR=/var/lib/openmeet \
    OPENMEET_HOST=:: \
    OPENMEET_PORT=8787
WORKDIR /app
RUN addgroup -S openmeet && adduser -S openmeet -G openmeet \
    && mkdir -p /var/lib/openmeet && chown -R openmeet:openmeet /var/lib/openmeet
COPY --from=build /repo/packages/server/dist ./dist
COPY --from=build /repo/node_modules/ws ./node_modules/ws
USER openmeet
EXPOSE 8787
EXPOSE 3478/udp
VOLUME /var/lib/openmeet
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENMEET_PORT||8787)+'/api/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.mjs"]
