// Helper hỗ trợ khởi tạo và dọn dẹp dữ liệu kiểm thử độc lập cho Automation Test
const jwt = require('jsonwebtoken');
const prisma = require('../../src/utils/db');

// Hàm tạo số điện thoại ngẫu nhiên có tiền tố 0999 phục vụ kiểm thử cách ly
const generateTestPhone = () => {
  const randomSuffix = Math.floor(100000 + Math.random() * 900000);
  return `0999${randomSuffix}`;
};

// Khởi tạo một chủ buôn (User) độc lập để chạy test
const createTestUser = async (customName = 'Chủ Buôn Test') => {
  const phone = generateTestPhone();
  const user = await prisma.user.create({
    data: {
      name: `[TEST]_${customName}`,
      phone,
      isAdmin: false,
      canManageCustomers: true,
      canManageDebt: true,
    },
  });

  const accessSecret = process.env.JWT_ACCESS_SECRET || 'meat_manager_access_secret_key_2026_super_secure_random';
  const token = jwt.sign(
    { id: user.id, phone: user.phone },
    accessSecret,
    { expiresIn: '1d' }
  );

  return { user, token };
};

// Khởi tạo một khách hàng mẫu
const createTestCustomer = async (userId, customName = 'Khách Mua Thịt A') => {
  return await prisma.customer.create({
    data: {
      userId,
      name: `[TEST]_${customName}`,
      phone: generateTestPhone(),
      address: '123 Đường Test, Hà Nội',
    },
  });
};

// Khởi tạo một sản phẩm thịt mẫu
const createTestProduct = async (userId, name = 'Thịt Ba Chỉ Test', defaultPrice = 100000, costPrice = 80000) => {
  return await prisma.product.create({
    data: {
      userId,
      name: `[TEST]_${name}`,
      defaultPrice,
      costPrice,
      unit: 'kg',
    },
  });
};

// Dọn dẹp toàn bộ dữ liệu do User test sinh ra (Teardown)
const cleanupTestUser = async (userId) => {
  if (!userId) return;

  try {
    // 1. Xóa các chi tiết mặt hàng trong giao dịch nợ
    await prisma.transactionItem.deleteMany({
      where: {
        transaction: {
          customer: { userId },
        },
      },
    });

    // 2. Xóa các giao dịch nợ
    await prisma.transaction.deleteMany({
      where: {
        customer: { userId },
      },
    });

    // 3. Xóa các đợt thanh toán trả nợ
    await prisma.payment.deleteMany({
      where: {
        customer: { userId },
      },
    });

    // 4. Xóa giá bán riêng của khách hàng
    await prisma.customerProductPrice.deleteMany({
      where: {
        customer: { userId },
      },
    });

    // 5. Xóa khách hàng
    await prisma.customer.deleteMany({
      where: { userId },
    });

    // 6. Xóa sản phẩm
    await prisma.product.deleteMany({
      where: { userId },
    });

    // 7. Xóa nhật ký hoạt động
    await prisma.activityLog.deleteMany({
      where: { userId },
    });

    // 8. Xóa tài khoản User
    await prisma.user.delete({
      where: { id: userId },
    });
  } catch (error) {
    console.error(`[TEST_CLEANUP] Lỗi dọn dẹp dữ liệu user test ${userId}:`, error.message);
  }
};

module.exports = {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
};
