# docker build -f deploy/Dockerfile -t atm-enugu .
# docker run -d -p 3000:3000 -v atm-data:/data --env-file .env atm-enugu
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
