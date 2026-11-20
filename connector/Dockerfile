FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node *.mjs ./
USER node
ENV PORT=8080 PLANX_BIND=0.0.0.0
CMD ["node", "server.mjs"]
