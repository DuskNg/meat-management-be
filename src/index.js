// meat-management-be/src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

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
  max: 100, // Tối đa 100 request trên mỗi IP trong 15 phút
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

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/transactions', transactionRoutes);
app.use('/api/v1/payments', paymentRoutes);

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

// Bắt đầu lắng nghe cổng mạng (Tải lại máy chủ khi lưu cấu hình và prompt mới)
app.listen(PORT, () => {
  logger.info(`Máy chủ Express đang chạy thành công tại cổng ${PORT}`);
});
