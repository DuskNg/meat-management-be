// meat-management-be/scripts/migrate_customer_ai_aliases.js
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const dotenv = require('dotenv');

async function migrateEnvFile(envFileName) {
  const envPath = path.resolve(__dirname, `../${envFileName}`);
  if (!fs.existsSync(envPath)) return;

  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  const dbUrl = envConfig.DATABASE_URL;
  if (!dbUrl) return;

  console.log(`Đang chạy migration customer_ai_aliases cho file: ${envFileName}...`);
  let pool;
  let client;
  try {
    pool = new Pool({ connectionString: dbUrl });
    client = await pool.connect();
  } catch (connErr) {
    console.warn(`⚠️ Không thể kết nối tới DB [${envFileName}]:`, connErr.message);
    if (pool) await pool.end().catch(() => {});
    return;
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_ai_aliases (
        id VARCHAR(36) PRIMARY KEY,
        "userId" VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "customerId" VARCHAR(36) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        "rawAlias" TEXT NOT NULL,
        "normalizedAlias" TEXT NOT NULL,
        "compactAlias" TEXT NOT NULL,
        "usageCount" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "customer_ai_aliases_userId_normalizedAlias_key" UNIQUE ("userId", "normalizedAlias")
      );

      CREATE INDEX IF NOT EXISTS "customer_ai_aliases_userId_idx" ON customer_ai_aliases("userId");
      CREATE INDEX IF NOT EXISTS "customer_ai_aliases_customerId_idx" ON customer_ai_aliases("customerId");
      CREATE INDEX IF NOT EXISTS "customer_ai_aliases_userId_compactAlias_idx" ON customer_ai_aliases("userId", "compactAlias");

      CREATE TABLE IF NOT EXISTS product_ai_aliases (
        id VARCHAR(36) PRIMARY KEY,
        "userId" VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "productId" VARCHAR(36) NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        "rawAlias" TEXT NOT NULL,
        "normalizedAlias" TEXT NOT NULL,
        "compactAlias" TEXT NOT NULL,
        "usageCount" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "product_ai_aliases_userId_normalizedAlias_key" UNIQUE ("userId", "normalizedAlias")
      );

      CREATE INDEX IF NOT EXISTS "product_ai_aliases_userId_idx" ON product_ai_aliases("userId");
      CREATE INDEX IF NOT EXISTS "product_ai_aliases_productId_idx" ON product_ai_aliases("productId");
      CREATE INDEX IF NOT EXISTS "product_ai_aliases_userId_compactAlias_idx" ON product_ai_aliases("userId", "compactAlias");
    `);
    console.log(`✅ Đã tạo bảng customer_ai_aliases & product_ai_aliases thành công cho [${envFileName}]!`);
  } catch (err) {
    console.error(`❌ Lỗi khi migrate bảng cho [${envFileName}]:`, err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  await migrateEnvFile('.env');
  await migrateEnvFile('.env.development');
  await migrateEnvFile('.env.test');
  await migrateEnvFile('.env.production');
}

main().catch(console.error);

