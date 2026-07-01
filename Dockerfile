# Sử dụng Node.js phiên bản 22 làm nền tảng cơ bản
FROM node:22-alpine AS base

# Thiết lập thư mục làm việc trong container
WORKDIR /app

# Cài đặt thư viện openssl cần thiết cho Prisma hoạt động trên Alpine Linux
RUN apk add --no-cache openssl

# Sao chép các file cấu hình package và cấu hình dự án
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma.config.ts ./

# Sao chép thư mục cấu hình Prisma schema
COPY prisma ./prisma/

# --- Giai đoạn phát triển (Development) ---
FROM base AS development

# Cài đặt tất cả dependencies (bao gồm cả devDependencies phục vụ hot-reload)
RUN npm install

# Sinh mã nguồn Prisma Client tương ứng với Schema
RUN npx prisma generate

# Sao chép thư mục mã nguồn
COPY src ./src

# Expose cổng kết nối của Backend
EXPOSE 3000

# Chạy backend ở chế độ phát triển sử dụng nodemon
CMD ["npm", "run", "dev"]

# --- Giai đoạn vận hành thực tế (Production) ---
FROM base AS production

# Chỉ cài đặt các packages phục vụ chạy production (bỏ qua devDependencies)
RUN npm ci --omit=dev

# Sinh mã nguồn Prisma Client
RUN npx prisma generate

# Sao chép mã nguồn của ứng dụng
COPY src ./src

# Expose cổng kết nối
EXPOSE 3000

# Chạy ứng dụng (Tự động đồng bộ các bảng dữ liệu lên database trước khi khởi chạy server)
CMD npx prisma db push && node src/index.js
