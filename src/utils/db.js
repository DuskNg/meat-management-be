// meat-management-be/src/utils/db.js
const { PrismaClient } = require('../../generated/prisma');

// Tạo một instance duy nhất của PrismaClient để quản lý kết nối hiệu quả
const prisma = new PrismaClient({
  accelerateUrl: process.env.DATABASE_URL,
});

module.exports = prisma;
