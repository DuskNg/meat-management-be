// Cấu hình Vitest cho kiểm thử tự động Backend
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // Cho phép tối đa 30s cho các tác vụ database mạng
    hookTimeout: 30000,
    include: ['tests/**/*.test.js'],
    fileParallelism: false, // Chạy tuần tự các file test để tránh xung đột dữ liệu kiểm thử
  },
});
