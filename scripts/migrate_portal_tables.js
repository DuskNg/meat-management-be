const path = require('path');
const nodeEnv = process.env.NODE_ENV || 'production';
require('dotenv').config({ path: path.resolve(__dirname, `../.env.${nodeEnv}`) });

const { Pool } = require('pg');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  console.log('Đang kết nối database để tạo bảng Portal...');

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_links (
        id VARCHAR(36) PRIMARY KEY,
        "userId" VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        token VARCHAR(64) NOT NULL UNIQUE,
        type VARCHAR(32) NOT NULL DEFAULT 'customer',
        pin VARCHAR(32),
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "supplierId" VARCHAR(36) REFERENCES suppliers(id) ON DELETE SET NULL,
        note TEXT,
        "viewCount" INTEGER NOT NULL DEFAULT 0,
        "lastViewedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS "portal_links_userId_idx" ON portal_links("userId");
      CREATE INDEX IF NOT EXISTS "portal_links_token_idx" ON portal_links(token);

      CREATE TABLE IF NOT EXISTS portal_link_customers (
        id VARCHAR(36) PRIMARY KEY,
        "portalLinkId" VARCHAR(36) NOT NULL REFERENCES portal_links(id) ON DELETE CASCADE,
        "customerId" VARCHAR(36) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "portal_link_customers_unique" UNIQUE ("portalLinkId", "customerId")
      );

      CREATE INDEX IF NOT EXISTS "portal_link_customers_portalLinkId_idx" ON portal_link_customers("portalLinkId");
      CREATE INDEX IF NOT EXISTS "portal_link_customers_customerId_idx" ON portal_link_customers("customerId");

      CREATE TABLE IF NOT EXISTS portal_feedbacks (
        id VARCHAR(36) PRIMARY KEY,
        "portalLinkId" VARCHAR(36) NOT NULL REFERENCES portal_links(id) ON DELETE CASCADE,
        "customerId" VARCHAR(36) REFERENCES customers(id) ON DELETE SET NULL,
        "senderName" VARCHAR(255),
        phone VARCHAR(32),
        type VARCHAR(64) NOT NULL DEFAULT 'DISCREPANCY',
        content TEXT NOT NULL,
        "imageUrls" TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        "adminNote" TEXT,
        "resolvedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS "portal_feedbacks_portalLinkId_idx" ON portal_feedbacks("portalLinkId");
      CREATE INDEX IF NOT EXISTS "portal_feedbacks_customerId_idx" ON portal_feedbacks("customerId");
      CREATE INDEX IF NOT EXISTS "portal_feedbacks_status_idx" ON portal_feedbacks(status);
    `);

    console.log('TẠO BẢNG PORTAL THÀNH CÔNG VÀO DATABASE POSTGRESQL!');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Lỗi khi migrate bảng:', err);
  process.exit(1);
});
