// meat-management-be/src/scripts/createAdminSafe.js
// Polyfill Object.hasOwn
if (!Object.hasOwn) {
  Object.hasOwn = function(object, property) {
    return Object.prototype.hasOwnProperty.call(object, property);
  };
}

// Tải cấu hình môi trường động dựa trên biến NODE_ENV
const path = require('path');
const nodeEnv = process.env.NODE_ENV || 'production'; // Mặc định là production để khớp với DB Render
require('dotenv').config({ path: path.resolve(process.cwd(), `.env.${nodeEnv}`) });

const prisma = require('../utils/db');
const bcrypt = require('bcryptjs');

async function createAdminSafe() {
  console.log('🔄 Bắt đầu chạy kịch bản tạo tài khoản Admin an toàn...');
  
  const adminPhone = '0000000000';
  const adminName = 'Hệ thống Quản trị';
  
  try {
    // 1. Kiểm tra xem tài khoản admin đã tồn tại chưa
    const existingAdmin = await prisma.user.findUnique({
      where: { phone: adminPhone },
    });
    
    if (existingAdmin) {
      console.log(`ℹ️ Tài khoản Admin với SĐT ${adminPhone} đã tồn tại từ trước.`);
      
      // Nếu tồn tại nhưng chưa phải là admin, cập nhật thành admin
      if (!existingAdmin.isAdmin) {
        await prisma.user.update({
          where: { id: existingAdmin.id },
          data: { isAdmin: true },
        });
        console.log('✅ Đã cập nhật quyền Admin cho tài khoản cũ.');
      }
      return;
    }
    
    // 2. Tạo tài khoản admin mới an toàn
    const passwordHash = await bcrypt.hash('admin123', 10);
    const newAdmin = await prisma.user.create({
      data: {
        name: adminName,
        phone: adminPhone,
        password: passwordHash,
        isAdmin: true,
      },
    });
    
    console.log(`🎉 Tạo thành công tài khoản Admin mới:`);
    console.log(`- Tên: ${newAdmin.name}`);
    console.log(`- SĐT đăng nhập: ${newAdmin.phone}`);
    console.log(`- Mật khẩu: admin123`);
    
  } catch (error) {
    console.error('❌ Có lỗi xảy ra khi tạo tài khoản Admin:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createAdminSafe();
