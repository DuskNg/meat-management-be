// meat-management-be/src/utils/activityLogger.js
const prisma = require('./db');

/**
 * Ghi nhận nhật ký hoạt động của người dùng vào database
 * @param {string} userId - ID của người dùng thực hiện hành động
 * @param {string} action - Loại hành động (ví dụ: 'CREATE_TRANSACTION', 'DELETE_PAYMENT')
 * @param {string} details - Mô tả chi tiết hành động bằng tiếng Việt
 */
const logActivity = async (userId, action, details) => {
  try {
    if (!userId) {
      console.warn('[ActivityLogger] Không thể ghi log do thiếu userId:', action, details);
      return;
    }
    
    await prisma.activityLog.create({
      data: {
        userId,
        action,
        details,
      },
    });
    console.log(`[ActivityLogger] Đã lưu log: [${action}] - User: ${userId} - Details: ${details}`);
  } catch (error) {
    console.error('[ActivityLogger] Lỗi khi lưu nhật ký hoạt động:', error);
  }
};

module.exports = {
  logActivity,
};
