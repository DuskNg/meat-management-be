// meat-management-be/src/services/esms.service.js
const winston = require('winston');

// Khởi tạo Logger riêng để ghi nhật ký lỗi gửi SMS
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/sms.log' }),
  ],
});

// Địa chỉ cổng API chính thức của eSMS
const ESMS_API_URL = 'https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/';

/**
 * Hàm thực hiện gửi tin nhắn OTP
 * @param {string} phone - Số điện thoại nhận tin
 * @param {string} code - Mã OTP gồm 4 chữ số
 * @returns {Promise<{ success: boolean, mode: string }>}
 */
const sendOtp = async (phone, code) => {
  const content = `Ma OTP dang nhap Meat Manager cua ban la: ${code}. Ma co hieu luc trong 5 phut.`;
  const mockMode = process.env.ESMS_MOCK_MODE === 'true';

  // 1. Chế độ MOCK: Chỉ ghi log ra console và file log, không gửi tin nhắn thật
  if (mockMode) {
    logger.info(`[MOCK MODE] Mã OTP dành cho số điện thoại [${phone}] là [${code}]`);
    return { success: true, mode: 'mock' };
  }

  // 2. Chế độ REAL: Gửi qua API eSMS
  try {
    const payload = {
      ApiKey: process.env.ESMS_API_KEY,
      SecretKey: process.env.ESMS_SECRET_KEY,
      Phone: phone,
      Content: content,
      SmsType: parseInt(process.env.ESMS_SMS_TYPE || '4', 10),
      Brandname: process.env.ESMS_BRANDNAME || 'Sandbox',
    };

    // Thiết lập cuộc gọi API sử dụng native fetch với timeout (AbortController)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000); // Hết hạn kết nối sau 8 giây

    const response = await fetch(ESMS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`eSMS API trả về mã HTTP lỗi: ${response.status}`);
    }

    const result = await response.json();

    // eSMS trả về Code = 100 là gửi tin thành công
    if (result && result.CodeResult === '100') {
      logger.info(`[ESMS REAL SUCCESS] Đã gửi OTP thành công tới SĐT: ${phone}. SMS ID: ${result.SMSID}`);
      return { success: true, mode: 'real' };
    } else {
      // eSMS trả về mã lỗi (ví dụ: 101 - sai Key, 103 - hết số dư tài khoản...)
      const errMessage = result ? result.ErrorMessage : 'Không có thông tin phản hồi lỗi';
      throw new Error(`eSMS từ chối gửi tin nhắn (Mã kết quả: ${result?.CodeResult}). Chi tiết: ${errMessage}`);
    }
  } catch (error) {
    // 3. Cơ chế tự động DỰ PHÒNG (AUTO FALLBACK)
    // Khi gặp bất kỳ lỗi gì (hết tiền, sai key, mạng chập chờn...), hệ thống ghi nhận lỗi chi tiết
    logger.error(`[ESMS REAL ERROR] Gửi tin thất bại tới SĐT [${phone}]. Chi tiết: ${error.message}`);
    
    // Ghi nhận kích hoạt chế độ dự phòng và in mã OTP ra console để hỗ trợ dev tiếp tục test
    logger.warn(`[AUTO FALLBACK] Đã kích hoạt chế độ dự phòng. Mã OTP của [${phone}] là [${code}]`);

    return { success: true, mode: 'fallback' };
  }
};

module.exports = {
  sendOtp,
};
