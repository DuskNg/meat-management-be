// meat-management-be/scripts/migrate_employee_access_code.js
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { Pool } = require('pg');

async function migrateEnv(envName) {
  const envPath = path.resolve(__dirname, `../.env.${envName}`);
  if (!fs.existsSync(envPath)) return;

  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  const dbUrl = envConfig.DATABASE_URL;
  if (!dbUrl) return;

  console.log(`Đang chạy migration accessCode nhân viên & chủ cơ sở cho môi trường: ${envName}...`);
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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS "salaryPortalOwnerCode" VARCHAR(16);
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS "accessCode" VARCHAR(16);
    `);
    console.log(`✅ Đã thêm cột salaryPortalOwnerCode (users) và accessCode (employees) thành công cho [${envName}]!`);
  } catch (err) {
    console.error(`❌ Lỗi khi migrate cho [${envName}]:`, err.message);
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

