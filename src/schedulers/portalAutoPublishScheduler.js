// meat-management-be/src/schedulers/portalAutoPublishScheduler.js
const prisma = require('../utils/db');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper lấy ngày hiện tại theo múi giờ Việt Nam (UTC+7) dạng YYYY-MM-DD
const getVietnamDateKey = (date = new Date()) => {
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const year = vnTime.getUTCFullYear();
  const month = String(vnTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(vnTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper kiểm tra hiện tại đã đến hoặc qua 20:00 tối theo giờ Việt Nam chưa
const isPast2000Vietnam = (date = new Date()) => {
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const hour = vnTime.getUTCHours();
  // Từ 20:00 trở đi trong ngày (hour >= 20)
  return hour >= 20;
};

// Biến lưu ngày gần nhất đã chạy auto-publish (tránh chạy lặp lại trong cùng 1 ngày)
let lastAutoPublishedDate = null;

// Hàm thực hiện tự động công bố số liệu portal lúc 20:00 hàng ngày
const processAutoPublishPortal = async () => {
  try {
    const now = new Date();
    // Chỉ kích hoạt tự động công bố khi đã đến hoặc qua 20:00 tối (giờ VN)
    if (!isPast2000Vietnam(now)) {
      return;
    }

    const todayKey = getVietnamDateKey(now);

    // Nếu ngày hôm nay đã chạy tự động công bố rồi thì bỏ qua
    if (lastAutoPublishedDate === todayKey) {
      return;
    }

    // Tìm tất cả các link portal đang hoạt động
    const activeLinks = await prisma.portalLink.findMany({
      where: { isActive: true },
      select: { id: true, userId: true, name: true, lastPublishedAt: true },
    });

    if (activeLinks.length === 0) {
      lastAutoPublishedDate = todayKey;
      return;
    }

    // Cập nhật lastPublishedAt thành thời điểm hiện tại cho toàn bộ các link đang active
    const result = await prisma.portalLink.updateMany({
      where: { isActive: true },
      data: { lastPublishedAt: now },
    });

    lastAutoPublishedDate = todayKey;
    console.log(`⏰ [AUTO_PUBLISH_PORTAL] Đã tự động công bố số liệu ngày ${todayKey} lúc 20:00 cho ${result.count} nhóm Zalo.`);

    // Gửi socket thông báo đến tất cả các workspace của các chủ buôn
    const userIds = [...new Set(activeLinks.map((l) => l.userId))];
    for (const uId of userIds) {
      try {
        emitWorkspaceEvent(uId, 'PORTAL_DATA_PUBLISHED', {
          action: 'AUTO_PUBLISH_20H',
          timestamp: now.toISOString(),
          publishedAt: now.toISOString(),
        });
      } catch (_) {}
    }
  } catch (error) {
    console.error('[PORTAL AUTO-PUBLISH SCHEDULER ERROR]:', error);
  }
};

// Khởi chạy tiến trình kiểm tra định kỳ (mỗi 30 giây kiểm tra 1 lần)
const initPortalAutoPublishScheduler = () => {
  // Kiểm tra ngay 1 lần khi server khởi động
  processAutoPublishPortal();

  // Kiểm tra định kỳ mỗi 30 giây
  setInterval(() => {
    processAutoPublishPortal();
  }, 30 * 1000);

  console.log('⏰ [SCHEDULER] Tiến trình tự động công bố số liệu nhóm Zalo (20:00 hàng ngày) đã được khởi tạo.');
};

module.exports = {
  initPortalAutoPublishScheduler,
  processAutoPublishPortal,
};
