FROM node:24-slim
WORKDIR /launcher
COPY fly.mjs pool.mjs server.mjs test.html ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
