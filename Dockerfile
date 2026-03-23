FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY index.ts ./

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
