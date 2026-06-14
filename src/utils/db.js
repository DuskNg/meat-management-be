// meat-management-be/src/utils/db.js
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../../generated/prisma');

// Khởi tạo kết nối PostgreSQL thông qua pg Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Khởi tạo Driver Adapter của Prisma cho PostgreSQL (bắt buộc từ Prisma v7)
const adapter = new PrismaPg(pool);

// Tạo một instance duy nhất của PrismaClient sử dụng adapter
const prisma = new PrismaClient({ adapter });

module.exports = prisma;
