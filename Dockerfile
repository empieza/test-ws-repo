FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

# Используем npm install вместо npm ci (не требует lock-файла)
RUN npm install --omit=dev

COPY server.js .

EXPOSE 8080

CMD ["node", "server.js"]
