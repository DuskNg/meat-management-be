const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('./generated/prisma');
const jwt = require('jsonwebtoken');

require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const phone = '0976955793';

  // Lấy thông tin user
  const user = await prisma.user.findUnique({
    where: { phone },
  });

  if (!user) {
    console.log('❌ Không tìm thấy user');
    return;
  }

  // Ký token giống backend
  const accessSecret = process.env.JWT_ACCESS_SECRET || 'default_access_secret';
  const token = jwt.sign(
    { id: user.id, phone: user.phone },
    accessSecret,
    { expiresIn: '7d' }
  );

  console.log(`🔑 Tạo Token thành công cho: ${user.name}`);
  console.log(`🔗 Gọi API debug-sockets...`);

  try {
    const res = await fetch('http://127.0.0.1:3000/api/v1/workspace/debug-sockets', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await res.json();

    console.log('\n📡 DANH SÁCH SOCKETS ĐANG KẾT NỐI:');
    console.log('══════════════════════════════════════════');
    console.log(`Số lượng socket: ${data.socketsCount}`);
    console.log(JSON.stringify(data.sockets, null, 2));
    console.log('══════════════════════════════════════════');

  } catch (error) {
    console.error('❌ Lỗi gọi API:', error.message);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
