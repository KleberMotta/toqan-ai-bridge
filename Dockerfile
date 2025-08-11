FROM node:20-alpine

WORKDIR /app

COPY package.json yarn.lock* ./
RUN yarn ci --production

COPY . .

RUN yarn build

EXPOSE 8000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
