FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/planning-rag ./packages/planning-rag
# No shell/native coding tools are enabled in the product DSH profile.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node dsh ./dsh
COPY --chown=node:node db ./db
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /app/var && chown node:node /app/var
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/var
EXPOSE 3000
CMD ["node", "src/server.js"]
