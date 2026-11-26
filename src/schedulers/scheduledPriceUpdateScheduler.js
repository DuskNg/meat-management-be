// meat-management-be/src/schedulers/scheduledPriceUpdateScheduler.js
const prisma = require('../utils/db');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper lấy ngày hiện tại theo múi giờ Việt Nam (UTC+7) dạng YYYY-MM-DD
const getVietnamDateKey = (date = new Date()) => {
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const year = vnTime.getUTCFullYear();
  const month = String(vnTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(vnTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Kiểm tra tên sản phẩm giả lập (không bao giờ áp dụng vào giá thịt)
const isQuickDebtProductName = (name) => {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim().toLowerCase();
  return n === 'tiền hàng' || n.startsWith('tiền') || n === 'trả hàng nhanh' || n === 'ghi nợ nhanh';
};

/**
 * Thực thi áp dụng một bản ghi lịch cập nhật giá thịt
 * @param {Object} scheduleRecord - Bản ghi ScheduledPriceUpdate từ Prisma
 * @returns {Promise<Object>} Bản ghi sau khi cập nhật trạng thái
 */
const applySingleScheduledPriceUpdate = async (scheduleRecord) => {
  if (!scheduleRecord || scheduleRecord.status === 'APPLIED') {
    return scheduleRecord;
  }

  let parsedItems = [];
  let parsedCustomerIds = [];

  try {
    parsedItems = JSON.parse(scheduleRecord.items || '[]');
    if (scheduleRecord.customerIds) {
      parsedCustomerIds = JSON.parse(scheduleRecord.customerIds);
    }
  } catch (parseErr) {
    return prisma.scheduledPriceUpdate.update({
      where: { id: scheduleRecord.id },
      data: {
        status: 'FAILED',
        errorMessage: 'Dữ liệu danh sách món thịt hoặc khách hàng bị lỗi định dạng.',
      },
    });
  }

  const validItems = (Array.isArray(parsedItems) ? parsedItems : []).filter(
    (it) => it && it.productId && !isNaN(Number(it.newPrice)) && Number(it.newPrice) >= 0 && !isQuickDebtProductName(it.productName)
  );

  if (validItems.length === 0) {
    return prisma.scheduledPriceUpdate.update({
      where: { id: scheduleRecord.id },
      data: {
        status: 'FAILED',
        errorMessage: 'Không có món thịt hợp lệ để cập nhật giá.',
      },
    });
  }

  const productIds = validItems.map((it) => it.productId);
  const existingProducts = await prisma.product.findMany({
    where: { id: { in: productIds }, userId: scheduleRecord.userId, isActive: true },
    select: { id: true, name: true },
  });
  const activeProductMap = new Map(
    existingProducts
      .filter((p) => !isQuickDebtProductName(p.name))
      .map((p) => [p.id, p])
  );

  const safeItems = validItems.filter((it) => activeProductMap.has(it.productId));
  if (safeItems.length === 0) {
    return prisma.scheduledPriceUpdate.update({
      where: { id: scheduleRecord.id },
      data: {
        status: 'FAILED',
        errorMessage: 'Các món thịt trong lịch không còn tồn tại hoặc đã bị ngừng kinh doanh.',
      },
    });
  }

  const reasonText = (scheduleRecord.note || '').trim() || `Lịch tự động cập nhật giá (${scheduleRecord.targetDate})`;

  const updatedSchedule = await prisma.$transaction(async (tx) => {
    if (scheduleRecord.scope === 'CUSTOMER') {
      const uniqueCustomerIds = [...new Set((Array.isArray(parsedCustomerIds) ? parsedCustomerIds : []).filter(Boolean))];
      if (uniqueCustomerIds.length === 0) {
        throw new Error('Không có khách hàng nào được chọn để cập nhật giá riêng.');
      }

      // Chỉ cập nhật giá riêng cho các khách hàng thuộc quyền quản lý của chủ buôn
      const validCustomers = await tx.customer.findMany({
        where: { id: { in: uniqueCustomerIds }, userId: scheduleRecord.userId, isActive: true },
        select: { id: true },
      });
      const validCustIds = validCustomers.map((c) => c.id);

      for (const cId of validCustIds) {
        for (const item of safeItems) {
          const newPrice = Math.round(Number(item.newPrice));
          await tx.customerProductPrice.upsert({
            where: {
              customerId_productId: {
                customerId: cId,
                productId: item.productId,
              },
            },
            update: {
              price: newPrice,
              changeReason: reasonText,
            },
            create: {
              customerId: cId,
              productId: item.productId,
              price: newPrice,
              changeReason: reasonText,
            },
          });
        }
      }
    } else {
      // Phạm vi DEFAULT: chỉ cập nhật giá chung của sạp (Product.defaultPrice), tuyệt đối không đụng giá riêng của khách
      for (const item of safeItems) {
        const newPrice = Math.round(Number(item.newPrice));
        await tx.product.updateMany({
          where: { id: item.productId, userId: scheduleRecord.userId },
          data: { defaultPrice: newPrice },
        });
      }
    }

    return tx.scheduledPriceUpdate.update({
      where: { id: scheduleRecord.id },
      data: {
        status: 'APPLIED',
        appliedAt: new Date(),
        errorMessage: null,
      },
    });
  });

  // Ghi nhật ký & phát socket thông báo cập nhật giá thành công
  void logActivity(
    scheduleRecord.userId,
    scheduleRecord.scope === 'CUSTOMER' ? 'BATCH_UPDATE_CUSTOMER_PRICES' : 'BATCH_UPDATE_PRODUCT_PRICES',
    `Tự động cập nhật giá ${safeItems.length} món thịt theo lịch ngày ${scheduleRecord.targetDate} (${scheduleRecord.scope === 'CUSTOMER' ? 'Giá riêng khách' : 'Giá chung sạp'})`
  );

  emitWorkspaceEvent(scheduleRecord.userId, 'CUSTOMER_UPDATED', {
    action: 'SCHEDULED_PRICE_APPLIED',
    scheduleId: scheduleRecord.id,
    userId: scheduleRecord.userId,
    timestamp: new Date().toISOString(),
  });

  return updatedSchedule;
};

let missingTableWarned = false;

// Quét và xử lý các lịch cập nhật giá đã đến ngày (targetDate <= hôm nay theo giờ VN)
const processScheduledPriceUpdates = async () => {
  try {
    const todayKey = getVietnamDateKey(new Date());
    const dueSchedules = await prisma.scheduledPriceUpdate.findMany({
      where: {
        status: 'PENDING',
        targetDate: { lte: todayKey },
      },
      orderBy: [{ targetDate: 'asc' }, { createdAt: 'asc' }],
    });

    if (dueSchedules.length === 0) return;

    console.log(`[ScheduledPriceUpdate] Phát hiện ${dueSchedules.length} lịch cập nhật giá đến hạn (<= ${todayKey}).`);
    for (const schedule of dueSchedules) {
      try {
        await applySingleScheduledPriceUpdate(schedule);
      } catch (err) {
        console.error(`[ScheduledPriceUpdate] Lỗi khi áp dụng lịch ${schedule.id}:`, err);
        await prisma.scheduledPriceUpdate.update({
          where: { id: schedule.id },
          data: {
            status: 'FAILED',
            errorMessage: err.message || 'Lỗi không xác định khi cập nhật giá.',
          },
        }).catch(() => {});
      }
    }
  } catch (error) {
    if (error?.code === 'P2021' || String(error?.message || '').includes('does not exist')) {
      if (!missingTableWarned) {
        missingTableWarned = true;
        console.warn('[ScheduledPriceUpdate] Bảng scheduled_price_updates chưa tồn tại. Vui lòng chạy `npx prisma db push`.');
      }
      return;
    }
    console.error('[ScheduledPriceUpdate] Lỗi kiểm tra tiến trình lịch giá:', error);
  }
};

let schedulerInterval = null;

// Khởi chạy scheduler kiểm tra mỗi 1 phút
const initScheduledPriceUpdateScheduler = () => {
  if (schedulerInterval) return;
  console.log('[ScheduledPriceUpdate] Đã kích hoạt tiến trình tự động cập nhật giá thịt theo lịch.');

  setTimeout(() => {
    processScheduledPriceUpdates();
  }, 8000);

  schedulerInterval = setInterval(() => {
    processScheduledPriceUpdates();
  }, 60 * 1000);
};

module.exports = {
  initScheduledPriceUpdateScheduler,
  processScheduledPriceUpdates,
  applySingleScheduledPriceUpdate,
  getVietnamDateKey,
};
