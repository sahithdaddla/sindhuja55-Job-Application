FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Ensure uploads folder exists
RUN mkdir -p uploads

EXPOSE 3044
CMD ["node", "server.js"]

