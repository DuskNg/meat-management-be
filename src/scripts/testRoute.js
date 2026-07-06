// d:\meat-management\meat-management-be\src\scripts\testRoute.js
const path = require('path');
const nodeEnv = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: path.resolve(__dirname, `../../.env.${nodeEnv}`) });

const jwt = require('jsonwebtoken');
const prisma = require('../utils/db');

async function run() {
  try {
    // 1. Lấy một user từ cơ sở dữ liệu
    console.log("DATABASE_URL length:", process.env.DATABASE_URL ? process.env.DATABASE_URL.length : 0);
    console.log("DATABASE_URL starts with:", process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 30) : "undefined");
    const user = await prisma.user.findFirst();
    if (!user) {
      console.error("Không tìm thấy user nào trong database để test!");
      return;
    }

    console.log(`Đang giả lập đăng nhập cho user: ${user.phone} (ID: ${user.id})`);

    // 2. Ký JWT Token giống như hệ thống
    const accessSecret = process.env.JWT_ACCESS_SECRET || 'default_access_secret';
    const accessToken = jwt.sign(
      { id: user.id, phone: user.phone },
      accessSecret,
      { expiresIn: '1h' }
    );

    // 3. Gửi request tới API vừa tạo
    const url = 'http://localhost:3000/api/v1/transactions/parse-transcript';
    console.log(`Gửi request POST tới ${url}...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        transcript: "Ngày 5 tháng 7, chị Lan, 2 cân ba chỉ, 150 nghìn"
      })
    });

    const result = await response.json();
    console.log(`Response status: ${response.status}`);
    console.log("Response body:");
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error("Lỗi khi test route:", error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
