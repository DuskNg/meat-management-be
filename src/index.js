// meat-management-be/src/index.js
// Polyfill Object.hasOwn để hỗ trợ các phiên bản Node.js cũ (như v14.21.3)
if (!Object.hasOwn) {
  Object.hasOwn = function(object, property) {
    return Object.prototype.hasOwnProperty.call(object, property);
  };
}

// Tải cấu hình môi trường động dựa trên biến NODE_ENV
const path = require('path');
const nodeEnv = process.env.NODE_ENV || 'development';
require('dotenv').config({ path: path.resolve(process.cwd(), `.env.${nodeEnv}`) });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const prisma = require('./utils/db');

// Khởi tạo Express
const app = express();
const PORT = process.env.PORT || 3000;

// Cấu hình Logger (Winston)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// Middleware Bảo mật (Helmet)
app.use(helmet());

// Middleware CORS - cho phép Mobile và Web Client gọi API
app.use(cors());

// Middleware đọc JSON Body (Tăng giới hạn lên 10mb để nhận diện ảnh tích kê base64 lớn)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Cấu hình Rate Limiter chung cho toàn bộ ứng dụng (chặn Spam)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 1000, // Tối đa 1000 request trên mỗi IP trong 15 phút
  message: {
    success: false,
    code: 'TOO_MANY_REQUESTS',
    message: 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng quay lại sau.',
  },
  standardHeaders: true, // Trả về thông tin giới hạn trong Header `RateLimit-*`
  legacyHeaders: false, // Tắt các Header cũ `X-RateLimit-*`
});
app.use(globalLimiter);

// Kết nối các Route đường dẫn API
const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customer');
const productRoutes = require('./routes/product');
const transactionRoutes = require('./routes/transaction');
const paymentRoutes = require('./routes/payment');
const supplierRoutes = require('./routes/supplier');
const employeeRoutes = require('./routes/employee');
const adminRoutes = require('./routes/admin');
const storeRoutes = require('./routes/store');
const inventoryRoutes = require('./routes/inventory');
const shopRoutes = require('./routes/shop');
const workspaceRoutes = require('./routes/workspace');

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/suppliers', supplierRoutes);
app.use('/api/v1/employees', employeeRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/store', storeRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/shop', shopRoutes);
app.use('/api/v1/workspace', workspaceRoutes);

// Route kiểm tra trạng thái hoạt động (Health Check)
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Hệ thống hoạt động bình thường.',
    timestamp: new Date(),
  });
});

// Trình xử lý lỗi tập trung (Error Handler Middleware)
app.use((err, req, res, next) => {
  const { AppError } = require('./utils/errors');
  
  // Ghi nhận lỗi chi tiết kèm stack trace vào log server
  logger.error(`${req.method} ${req.originalUrl} - Lỗi hệ thống: ${err.stack || err.message}`);
  
  // Nếu là lỗi đã được định nghĩa từ trước (AppError - như sai OTP, thiếu tham số...)
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
    });
  }

  // Nếu là lỗi hệ thống không lường trước (lỗi database, lỗi kết nối, Prisma, lỗi cú pháp...)
  res.status(500).json({
    success: false,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Đã có lỗi xảy ra trên máy chủ. Vui lòng thử lại sau.',
  });
});

// Cập nhật cấu hình và giá trị phân quyền mặc định tài khoản mới

// Lập lịch dọn dẹp tài khoản đã xóa mềm quá 7 ngày (Chạy định kỳ mỗi 24 giờ)
const startCleanupScheduler = () => {
  const cleanup = async () => {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const usersToDelete = await prisma.user.findMany({
        where: {
          isActive: false,
          deletedAt: {
            lte: sevenDaysAgo,
          },
        },
        select: { id: true },
      });

      if (usersToDelete.length === 0) return;

      const userIds = usersToDelete.map((u) => u.id);

      await prisma.$transaction(async (tx) => {
        // 1. Xóa các chi tiết đơn hàng (transaction_items) liên quan đến user và sản phẩm của user
        await tx.transactionItem.deleteMany({
          where: {
            OR: [
              { transaction: { userId: { in: userIds } } },
              { product: { userId: { in: userIds } } },
            ],
          },
        });

        // 2. Xóa các giao dịch mua hàng (transactions)
        await tx.transaction.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 3. Xóa bảng giá bán riêng theo khách hàng (customer_product_prices)
        await tx.customerProductPrice.deleteMany({
          where: {
            OR: [
              { customer: { userId: { in: userIds } } },
              { product: { userId: { in: userIds } } },
            ],
          },
        });

        // 4. Xóa các lượt thanh toán tiền của khách (payments)
        await tx.payment.deleteMany({
          where: { customer: { userId: { in: userIds } } },
        });

        // 5. Xóa danh mục khách hàng (customers)
        await tx.customer.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 6. Xóa danh mục sản phẩm (products)
        await tx.product.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 7. Xóa nhà cung cấp và các đơn/thanh toán nhập hàng (suppliers)
        await tx.supplierTransaction.deleteMany({
          where: { supplier: { userId: { in: userIds } } },
        });
        await tx.supplierPayment.deleteMany({
          where: { supplier: { userId: { in: userIds } } },
        });
        await tx.supplier.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 8. Xóa nhân viên và chấm công/ứng lương/bảng lương (employees)
        await tx.attendance.deleteMany({
          where: { employee: { userId: { in: userIds } } },
        });
        await tx.salaryAdvance.deleteMany({
          where: { employee: { userId: { in: userIds } } },
        });
        await tx.salaryPayment.deleteMany({
          where: { employee: { userId: { in: userIds } } },
        });
        await tx.employee.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 9. Xóa dữ liệu quán tính giờ (shop tables, sessions)
        await tx.shopSession.deleteMany({
          where: {
            OR: [
              { userId: { in: userIds } },
              { table: { userId: { in: userIds } } },
            ],
          },
        });
        await tx.shopTable.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 10. Xóa sản phẩm tồn kho (inventory_products)
        await tx.inventoryProduct.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 11. Xóa liên kết và yêu cầu Workspace
        await tx.workspaceJoinRequest.deleteMany({
          where: {
            OR: [
              { userId: { in: userIds } },
              { workspace: { ownerId: { in: userIds } } },
            ],
          },
        });
        await tx.workspaceMember.deleteMany({
          where: {
            OR: [
              { userId: { in: userIds } },
              { workspace: { ownerId: { in: userIds } } },
            ],
          },
        });
        await tx.workspace.deleteMany({
          where: { ownerId: { in: userIds } },
        });

        // 12. Xóa nhật ký hoạt động (activity_logs)
        await tx.activityLog.deleteMany({
          where: { userId: { in: userIds } },
        });

        // 13. Xóa tài khoản User
        await tx.user.deleteMany({
          where: { id: { in: userIds } },
        });
      });

      logger.info(`[CLEANUP] Đã xóa vĩnh viễn và dọn dẹp sạch sẽ ${userIds.length} tài khoản đã xóa mềm quá 7 ngày.`);
    } catch (error) {
      logger.error(`[CLEANUP] Lỗi dọn dẹp tài khoản xóa mềm: ${error.stack || error.message}`);
    }
  };

  // Chạy dọn dẹp ngay khi khởi động máy chủ
  cleanup();

  // Chạy lại mỗi 24 giờ
  setInterval(cleanup, 24 * 60 * 60 * 1000);
};

startCleanupScheduler();

// Tạo HTTP server và khởi tạo Socket.IO
const http = require('http');
const { initSocket } = require('./utils/socket');
const server = http.createServer(app);
initSocket(server);

// Bắt đầu lắng nghe cổng mạng (Tải lại máy chủ khi lưu cấu hình và prompt mới)
server.listen(PORT, () => {
  logger.info(`Máy chủ Express + Socket.IO đang chạy thành công tại cổng ${PORT}`);
});
