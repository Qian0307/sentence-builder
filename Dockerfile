FROM node:18-alpine

WORKDIR /app

# 複製並安裝 backend 套件
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# 複製其餘所有檔案
COPY . .

EXPOSE 3000

CMD ["node", "backend/server.js"]
