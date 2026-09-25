FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Banco em volume persistente (monte um disco em /data na hospedagem)
ENV DB_PATH=/data/plantao.db
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
