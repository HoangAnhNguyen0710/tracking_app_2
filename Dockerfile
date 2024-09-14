FROM node:18-buster

# Cài đặt Chromium và các phụ thuộc cần thiết
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libgdk-pixbuf2.0-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libxss1 \
  libxtst6 \
  xdg-utils \
  xvfb \
  x11vnc \
  xauth \
  --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Thiết lập thư mục làm việc
WORKDIR /app

# Sao chép package.json và cài đặt dependencies
COPY package.json ./
RUN npm install

# Sao chép toàn bộ mã nguồn
COPY . .

# Thiết lập đường dẫn cho Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Cấu hình X server
RUN mkdir -p /root/.vnc
RUN x11vnc -storepasswd 123456 /root/.vnc/passwd

# Mở cổng
EXPOSE 3000
EXPOSE 5900

# Chạy ứng dụng
CMD ["sh", "-c", "xvfb-run --server-args='-screen 0, 1024x768x24' x11vnc -forever -usepw & npm start"]
