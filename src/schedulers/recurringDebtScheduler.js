// meat-management-be/src/schedulers/recurringDebtScheduler.js
const prisma = require('../utils/db');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

// Helper gửi socket event thông báo giao dịch / nợ khách hàng thay đổi
const notifyCustomerUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// Helper lấy ngày hiện tại theo múi giờ Việt Nam (UTC+7) dạng YYYY-MM-DD
const getVietnamDateKey = (date = new Date()) => {
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const year = vnTime.getUTCFullYear();
  const month = String(vnTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(vnTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper kiểm tra hiện tại đã qua thời điểm 00:30 sáng theo giờ Việt Nam chưa
const isPast0030Vietnam = (date = new Date()) => {
  const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const hour = vnTime.getUTCHours();
  const minute = vnTime.getUTCMinutes();
  // Từ 00:30 trở đi trong ngày
  return hour > 0 || (hour === 0 && minute >= 30);
};

// Hàm thực hiện sinh tự động đơn nợ từ các mẫu đơn cố định
const processRecurringDebts = async () => {
  try {
    const now = new Date();
    // Chỉ kích hoạt tự động sinh sau 00:30 sáng (giờ VN)
    if (!isPast0030Vietnam(now)) {
      return;
    }

    const todayKey = getVietnamDateKey(now);

    // Lấy tất cả các đơn nợ cố định đang active
    const activeRecurringDebts = await prisma.recurringDebt.findMany({
      where: {
        isActive: true,
      },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            isActive: true,
            isBadDebt: true,
          },
        },
        items: true,
      },
    });

    if (activeRecurringDebts.length === 0) {
      return;
    }

    for (const recDebt of activeRecurringDebts) {
      // Bỏ qua nếu khách hàng đã bị xóa mềm hoặc là nợ xấu
      if (!recDebt.customer || !recDebt.customer.isActive || recDebt.customer.isBadDebt) {
        continue;
      }

      // Kiểm tra xem hôm nay đơn này đã được sinh chưa
      if (recDebt.lastGeneratedAt) {
        const lastGenKey = getVietnamDateKey(new Date(recDebt.lastGeneratedAt));
        if (lastGenKey === todayKey) {
          // Đã sinh cho ngày hôm nay rồi, bỏ qua
          continue;
        }
      }

      // Chuẩn bị các dòng chi tiết đơn hàng
      const transactionItemsData = (recDebt.items || []).map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        price: item.price,
        costPrice: item.costPrice,
        amount: item.amount,
        profit: item.profit,
      }));

      // Tạo giao dịch mới vào bảng transactions và cập nhật lastGeneratedAt trong 1 transaction
      await prisma.$transaction(async (tx) => {
        const createdTx = await tx.transaction.create({
          data: {
            userId: recDebt.userId,
            createdBy: recDebt.createdBy || recDebt.userId,
            customerId: recDebt.customerId,
            date: now,
            note: recDebt.note || 'Đơn nợ cố định hàng ngày (Tự động tạo)',
            totalAmount: recDebt.totalAmount,
            profitPercent: recDebt.profitPercent,
            totalCost: recDebt.totalCost,
            totalProfit: recDebt.totalProfit,
            type: 'customer',
            items: {
              create: transactionItemsData,
            },
          },
        });

        await tx.recurringDebt.update({
          where: { id: recDebt.id },
          data: {
            lastGeneratedAt: now,
          },
        });

        await logActivity(
          recDebt.userId,
          'AUTO_RECURRING_TRANSACTION',
          `Hệ thống tự động ghi nợ cố định ngày ${todayKey} cho khách hàng ${recDebt.customer.name}: ${Number(recDebt.totalAmount).toLocaleString('vi-VN')}đ`
        );

        notifyCustomerUpdate(recDebt.userId, 'CREATE_TRANSACTION', {
          customerId: recDebt.customerId,
          transactionId: createdTx.id,
        });
      });
    }
  } catch (error) {
    console.error('[RECURRING DEBT SCHEDULER ERROR]:', error);
  }
};

// Khởi chạy tiến trình kiểm tra định kỳ (mỗi 30 giây kiểm tra 1 lần)
const initRecurringDebtScheduler = () => {
  // Chạy ngay 1 lần khi server khởi động (để bù nếu server vừa bật sau 00:30)
  processRecurringDebts();

  // Kiểm tra định kỳ mỗi 30 giây
  setInterval(() => {
    processRecurringDebts();
  }, 30 * 1000);

  console.log('⏰ [SCHEDULER] Tiến trình tự động ghi nợ cố định (00:30 hàng ngày) đã được khởi tạo.');
};

module.exports = {
  initRecurringDebtScheduler,
  processRecurringDebts,
};
