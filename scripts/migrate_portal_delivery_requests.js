// meat-management-be/scripts/migrate_portal_delivery_requests.js
const path = require('path');
const { Pool } = require('pg');

async function migrateEnv(envName) {
  const envPath = path.resolve(__dirname, `../.env.${envName}`);
  const fs = require('fs');
  if (!fs.existsSync(envPath)) return;

  const dotenv = require('dotenv');
  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  const dbUrl = envConfig.DATABASE_URL;
  if (!dbUrl) return;

  console.log(`Đang chạy migration portal_delivery_requests cho môi trường: ${envName}...`);
  let pool;
  let client;
  try {
    pool = new Pool({ connectionString: dbUrl });
    client = await pool.connect();
  } catch (connErr) {
    console.warn(`⚠️ Không thể kết nối tới DB [${envName}]:`, connErr.message);
    if (pool) await pool.end().catch(() => {});
    return;
  }
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS portal_delivery_requests (
        id VARCHAR(36) PRIMARY KEY,
        "userId" VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "portalLinkId" VARCHAR(36) NOT NULL REFERENCES portal_links(id) ON DELETE CASCADE,
        "customerId" VARCHAR(36) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        "deliveryDate" TIMESTAMP(3) NOT NULL,
        "dateType" VARCHAR(32) NOT NULL DEFAULT 'today',
        note TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        "isConfirmed" BOOLEAN NOT NULL DEFAULT false,
        "confirmedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS "portal_delivery_requests_userId_idx" ON portal_delivery_requests("userId");
      CREATE INDEX IF NOT EXISTS "portal_delivery_requests_customerId_idx" ON portal_delivery_requests("customerId");
      CREATE INDEX IF NOT EXISTS "portal_delivery_requests_portalLinkId_idx" ON portal_delivery_requests("portalLinkId");
      CREATE INDEX IF NOT EXISTS "portal_delivery_requests_deliveryDate_idx" ON portal_delivery_requests("deliveryDate");
    `);
    console.log(`✅ Đã tạo bảng portal_delivery_requests thành công cho [${envName}]!`);
  } catch (err) {
    console.error(`❌ Lỗi khi migrate bảng cho [${envName}]:`, err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  await migrateEnv('development');
  await migrateEnv('test');
  await migrateEnv('production');
}

main().catch(console.error);
