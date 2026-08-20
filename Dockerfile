FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# tower needs only ws; typebox/jiti serve the extension and tests
RUN npm ci --omit=dev --omit=peer
COPY tower.mjs ./
COPY ui.html ./
USER node
EXPOSE 9000
CMD ["node", "tower.mjs"]
