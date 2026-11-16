// meat-management-be/src/utils/db.js
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../../generated/prisma');

// Khởi tạo kết nối PostgreSQL thông qua pg Pool (tối ưu keepAlive và timeout cho DB remote)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Bắt lỗi kết nối nhàn rỗi trong Pool để tránh treo hoặc sập tiến trình Node.js
pool.on('error', (err) => {
  console.error('[PG_POOL_ERROR] Lỗi kết nối nhàn rỗi trong pool:', err.message);
});

// Khởi tạo Driver Adapter của Prisma cho PostgreSQL (bắt buộc từ Prisma v7)
const adapter = new PrismaPg(pool);

// Tạo một instance duy nhất của PrismaClient sử dụng adapter
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
