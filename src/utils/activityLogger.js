// meat-management-be/src/utils/activityLogger.js
const prisma = require('./db');
const { getRequest } = require('./requestContext');
const { resolveDevice } = require('./deviceHelper');

/**
 * Ghi nhận nhật ký hoạt động của người dùng vào database kèm thông tin thiết bị
 * @param {string} userId - ID của người dùng thực hiện hành động
 * @param {string} action - Loại hành động (ví dụ: 'CREATE_TRANSACTION', 'DELETE_PAYMENT')
 * @param {string} details - Mô tả chi tiết hành động bằng tiếng Việt
 * @param {string|object|null} deviceOrReq - Thiết bị tùy chọn hoặc đối tượng request
 */
const logActivity = async (userId, action, details, deviceOrReq = null) => {
  try {
    if (!userId) {
      console.warn('[ActivityLogger] Không thể ghi log do thiếu userId:', action, details);
      return;
    }

    // Xác định thiết bị: Ưu tiên chuỗi truyền vào, hoặc trích xuất từ req (được truyền hoặc từ context)
    let device = null;
    if (typeof deviceOrReq === 'string' && deviceOrReq.trim()) {
      device = deviceOrReq.trim();
    } else {
      const req = (deviceOrReq && deviceOrReq.headers) ? deviceOrReq : getRequest();
      if (req) {
        device = resolveDevice(req);
      }
    }
    
    await prisma.activityLog.create({
      data: {
        userId,
        action,
        details,
        device,
      },
    });
    console.log(`[ActivityLogger] Đã lưu log: [${action}] - User: ${userId} - Device: ${device || 'N/A'} - Details: ${details}`);
  } catch (error) {
    console.error('[ActivityLogger] Lỗi khi lưu nhật ký hoạt động:', error);
  }
};

module.exports = {
  logActivity,
};
