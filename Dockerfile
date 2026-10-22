# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY vendor/bonk ./vendor/bonk
COPY vendor/manifold-server ./vendor/manifold-server
COPY evidence/original/gameframe-release.html ./evidence/original/gameframe-release.html
COPY evidence/protocol/native-catalog.json evidence/protocol/builtin-maps.json ./evidence/protocol/
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 \
    BONK_DATA_PATH=/app/data/bonk.sqlite BONK_MODS_DIR=/app/mods
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
    && mkdir -p data mods && chown node:node data mods
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/evidence/protocol ./evidence/protocol
COPY vendor/manifold-server/LICENSE ./third-party/manifold-server-LICENSE
COPY third-party ./third-party
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
