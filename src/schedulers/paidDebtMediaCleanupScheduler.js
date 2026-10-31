// meat-management-be/src/schedulers/paidDebtMediaCleanupScheduler.js
const prisma = require('../utils/db');
const { deleteFromCloudinary } = require('../utils/cloudinary');
const { logActivity } = require('../utils/activityLogger');

/**
 * Thuật toán phân bổ thanh toán công nợ theo chuẩn FIFO và ghi chú cụ thể.
 * Tái sử dụng cùng logic chuẩn với portal / đối soát công nợ của hệ thống.
 * 
 * @param {Array} transactions - Danh sách đơn nợ của khách hàng (sắp xếp tăng dần theo date)
 * @param {Array} payments - Danh sách các khoản thanh toán của khách hàng (sắp xếp tăng dần theo paidAt)
 * @returns {Array} transactions kèm trường fullyPaidAt (nếu đã thanh toán hết) và isPaid
 */
const reconcileDebtTransactions = (transactions = [], payments = []) => {
  // Chuẩn bị danh sách đơn nợ với số tiền còn nợ
  const txList = transactions.map((t) => {
    const totalAmt = Math.round(Number(t.totalAmount || 0));
    return {
      ...t,
      totalAmountNum: totalAmt,
      paidAmount: 0,
      isPaid: totalAmt <= 0,
      fullyPaidAt: totalAmt <= 0 ? new Date(t.date) : null,
      dateObj: new Date(t.date),
    };
  });

  // Chuẩn bị danh sách thanh toán
  const cashPayments = payments.map((p) => ({
    id: p.id,
    amount: Math.round(Number(p.amount || 0)),
    remaining: Math.round(Number(p.amount || 0)),
    paidAt: new Date(p.paidAt),
    note: p.note || '',
  }));

  // Hàm phụ trợ thanh toán từng phần hoặc toàn bộ đơn nợ
  const applyPaymentToTx = (pm, tx) => {
    if (pm.remaining <= 0 || tx.isPaid) return;
    const unpaid = tx.totalAmountNum - tx.paidAmount;
    const used = Math.min(pm.remaining, unpaid);
    tx.paidAmount += used;
    pm.remaining -= used;

    if (tx.paidAmount >= tx.totalAmountNum) {
      tx.isPaid = true;
      // Thời điểm hoàn tất thu nợ là thời điểm trả tiền (hoặc ngày đơn nếu thanh toán trước/cùng lúc)
      tx.fullyPaidAt = pm.paidAt > tx.dateObj ? pm.paidAt : tx.dateObj;
    }
  };

  // Bước A: Khấu trừ thanh toán có ghi chú theo ngày cụ thể: "Thanh toán nợ ngày DD/MM/YYYY"
  cashPayments.forEach((pm) => {
    if (pm.remaining <= 0) return;
    const trimNote = (pm.note || '').trim();
    const dateMatch = trimNote.match(/^Thanh toán (?:nợ\s+)?ngày (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (dateMatch) {
      const d = parseInt(dateMatch[1], 10);
      const m = parseInt(dateMatch[2], 10) - 1;
      const y = parseInt(dateMatch[3], 10);

      // Tìm các đơn nợ khớp ngày này
      const sameDayTxs = txList.filter((tx) => {
        const td = tx.dateObj;
        return td.getDate() === d && td.getMonth() === m && td.getFullYear() === y;
      });

      for (const tx of sameDayTxs) {
        if (pm.remaining <= 0) break;
        applyPaymentToTx(pm, tx);
      }
    }
  });

  // Bước B: Khấu trừ thanh toán có ghi chú theo tháng cụ thể: "Thanh toán nợ Tháng MM/YYYY"
  cashPayments.forEach((pm) => {
    if (pm.remaining <= 0) return;
    const trimNote = (pm.note || '').trim();
    const monthMatch = trimNote.match(/^Thanh toán (?:nợ|hóa đơn)?\s*[Tt]háng (\d{1,2})\/(\d{4})/i);
    if (monthMatch) {
      const m = parseInt(monthMatch[1], 10) - 1;
      const y = parseInt(monthMatch[2], 10);

      const sameMonthTxs = txList.filter((tx) => {
        const td = tx.dateObj;
        return td.getMonth() === m && td.getFullYear() === y;
      });

      for (const tx of sameMonthTxs) {
        if (pm.remaining <= 0) break;
        applyPaymentToTx(pm, tx);
      }
    }
  });

  // Bước C: Phân bổ chung theo nguyên tắc FIFO (đơn nợ cũ được thanh toán trước)
  txList.forEach((tx) => {
    if (tx.isPaid) return;
    for (const pm of cashPayments) {
      if (pm.remaining <= 0) continue;
      applyPaymentToTx(pm, tx);
      if (tx.isPaid) break;
    }
  });

  return txList;
};

/**
 * Dọn dẹp ảnh và video của các đơn công nợ đã được thu nợ sau N ngày (mặc định 15 ngày).
 * 
 * NGUYÊN TẮC AN TOÀN TUYỆT ĐỐI:
 * - CHỈ xóa ảnh/video trên Cloudflare R2 / Cloudinary và dọn dẹp liên kết media.
 * - BẢO TOÀN NGUYÊN VẸN 100% bản ghi đơn nợ (Transaction), chi tiết thịt (TransactionItem), 
 *   lịch sử thanh toán (Payment) và công nợ của khách hàng.
 * 
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - Nếu true thì chỉ quét và đếm, không xóa thật
 * @param {string} [options.userId=null] - Giới hạn theo chủ buôn cụ thể (nếu có)
 * @param {number} [options.daysThreshold=15] - Số ngày sau khi thu nợ xong mới được xóa media
 * @returns {Promise<Object>} Báo cáo kết quả dọn dẹp
 */
const cleanupPaidDebtMedia = async (options = {}) => {
  const { dryRun = false, userId = null, daysThreshold = 15 } = options;
  const now = new Date();
  const thresholdMs = Math.max(1, daysThreshold) * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(now.getTime() - thresholdMs);

  console.log(`[MEDIA_CLEANUP] 🧹 Bắt đầu rà soát dọn dẹp ảnh/video đơn đã thu nợ (Ngưỡng: ${daysThreshold} ngày, mốc trước: ${cutoffDate.toISOString()})`);

  let totalTransactionsCleaned = 0;
  let totalInvoicesDeleted = 0;
  let totalSubmissionsCleaned = 0;

  try {
    // 1. Tìm tất cả customerId có ảnh hóa đơn TransactionInvoice
    const invoiceCustomerWhere = {};
    if (userId) invoiceCustomerWhere.userId = userId;

    const invoiceCustomers = await prisma.transactionInvoice.findMany({
      where: invoiceCustomerWhere,
      select: { customerId: true },
      distinct: ['customerId'],
    });

    // 2. Tìm tất cả customerId có StaffSubmission gắn đơn nợ và còn mediaUrl
    const submissionWhere = {
      transactionId: { not: null },
      fileUrl: { not: '' },
    };
    if (userId) submissionWhere.userId = userId;

    const submissionCustomers = await prisma.staffSubmission.findMany({
      where: submissionWhere,
      select: { matchedCustomerId: true },
      distinct: ['matchedCustomerId'],
    });

    // Tập hợp danh sách các khách hàng duy nhất có ảnh/video cần kiểm tra
    const customerIdSet = new Set();
    invoiceCustomers.forEach((c) => {
      if (c.customerId) customerIdSet.add(c.customerId);
    });
    submissionCustomers.forEach((s) => {
      if (s.matchedCustomerId) customerIdSet.add(s.matchedCustomerId);
    });

    const targetCustomerIds = Array.from(customerIdSet);

    if (targetCustomerIds.length === 0) {
      console.log('[MEDIA_CLEANUP] Không có khách hàng nào chứa ảnh/video hóa đơn cần kiểm tra.');
      return {
        success: true,
        dryRun,
        cutoffDate,
        daysThreshold,
        totalCustomersChecked: 0,
        totalTransactionsCleaned: 0,
        totalInvoicesDeleted: 0,
        totalSubmissionsCleaned: 0,
        totalMediaFilesDeleted: 0,
      };
    }

    console.log(`[MEDIA_CLEANUP] Đang kiểm tra công nợ của ${targetCustomerIds.length} khách hàng có ảnh/video...`);

    for (const customerId of targetCustomerIds) {
      // Lấy toàn bộ đơn nợ của khách hàng kèm ảnh hóa đơn TransactionInvoice
      const transactions = await prisma.transaction.findMany({
        where: { customerId },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        include: {
          invoices: true,
        },
      });

      // Lấy tất cả staffSubmissions liên quan đến các đơn nợ này
      const txIds = transactions.map((t) => t.id);
      const staffSubmissions = txIds.length > 0
        ? await prisma.staffSubmission.findMany({
            where: {
              transactionId: { in: txIds },
              fileUrl: { not: '' },
            },
          })
        : [];

      // Nhóm submissions theo transactionId
      const submissionMap = {};
      staffSubmissions.forEach((sub) => {
        if (!submissionMap[sub.transactionId]) {
          submissionMap[sub.transactionId] = [];
        }
        submissionMap[sub.transactionId].push(sub);
      });

      // Lấy toàn bộ phiếu thanh toán nợ của khách hàng
      const payments = await prisma.payment.findMany({
        where: { customerId },
        orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
      });

      // Phân bổ đối soát thanh toán
      const reconciledTxs = reconcileDebtTransactions(transactions, payments);

      // Lọc các đơn nợ đã thu nợ và thời điểm thu nợ đã quá 15 ngày
      const paidAndExpiredTxs = reconciledTxs.filter((tx) => {
        return (
          tx.isPaid &&
          tx.fullyPaidAt &&
          tx.fullyPaidAt.getTime() <= cutoffDate.getTime()
        );
      });

      for (const tx of paidAndExpiredTxs) {
        const invoices = tx.invoices || [];
        const submissions = submissionMap[tx.id] || [];

        if (invoices.length === 0 && submissions.length === 0) {
          continue;
        }

        totalTransactionsCleaned++;

        // A. Dọn dẹp ảnh/video từ TransactionInvoice
        for (const inv of invoices) {
          totalInvoicesDeleted++;
          if (!dryRun) {
            try {
              // 1. Xóa file trên Cloudflare R2 / Cloudinary
              await deleteFromCloudinary(inv.imageUrl);
            } catch (delFileErr) {
              console.warn(`[MEDIA_CLEANUP] Lỗi xóa file đám mây cho hóa đơn ${inv.id}:`, delFileErr.message);
            }

            try {
              // 2. Xóa bản ghi TransactionInvoice trong CSDL
              await prisma.transactionInvoice.delete({
                where: { id: inv.id },
              });
            } catch (delDbErr) {
              console.warn(`[MEDIA_CLEANUP] Lỗi xóa bản ghi hóa đơn ${inv.id}:`, delDbErr.message);
            }
          }
        }

        // B. Dọn dẹp ảnh/video từ StaffSubmission liên kết đơn nợ này
        for (const sub of submissions) {
          totalSubmissionsCleaned++;
          if (!dryRun) {
            try {
              // 1. Xóa file trên Cloudflare R2 / Cloudinary
              await deleteFromCloudinary(sub.fileUrl);
            } catch (delFileErr) {
              console.warn(`[MEDIA_CLEANUP] Lỗi xóa file video/ảnh của submission ${sub.id}:`, delFileErr.message);
            }

            try {
              // 2. Làm rỗng link fileUrl trong DB (giữ lại nội dung items và lịch sử duyệt, không ghi đè vào note của đơn hàng)
              await prisma.staffSubmission.update({
                where: { id: sub.id },
                data: {
                  fileUrl: '',
                },
              });
            } catch (upDbErr) {
              console.warn(`[MEDIA_CLEANUP] Lỗi cập nhật submission ${sub.id}:`, upDbErr.message);
            }
          }
        }
      }

      // Xử lý thêm các TransactionInvoice độc lập (chưa liên kết transactionId) nhưng ngày của hóa đơn đó đã thanh toán đủ trước 15 ngày
      const unlinkedInvoices = await prisma.transactionInvoice.findMany({
        where: { customerId, transactionId: null },
      });

      if (unlinkedInvoices.length > 0) {
        for (const uInv of unlinkedInvoices) {
          const invDate = new Date(uInv.date);
          // Tìm xem các đơn nợ trong cùng ngày của hóa đơn này đã được trả hết chưa
          const sameDayTxs = reconciledTxs.filter((t) => {
            return (
              t.dateObj.getDate() === invDate.getDate() &&
              t.dateObj.getMonth() === invDate.getMonth() &&
              t.dateObj.getFullYear() === invDate.getFullYear()
            );
          });

          // Nếu tất cả đơn nợ cùng ngày đều đã thu nợ và đã quá 15 ngày
          const isSameDayFullyPaid =
            sameDayTxs.length > 0 &&
            sameDayTxs.every(
              (t) => t.isPaid && t.fullyPaidAt && t.fullyPaidAt.getTime() <= cutoffDate.getTime()
            );

          if (isSameDayFullyPaid) {
            totalInvoicesDeleted++;
            if (!dryRun) {
              try {
                await deleteFromCloudinary(uInv.imageUrl);
                await prisma.transactionInvoice.delete({ where: { id: uInv.id } });
              } catch (uDelErr) {
                console.warn(`[MEDIA_CLEANUP] Lỗi xóa ảnh hóa đơn chưa liên kết ${uInv.id}:`, uDelErr.message);
              }
            }
          }
        }
      }
    }

    const totalMediaFilesDeleted = totalInvoicesDeleted + totalSubmissionsCleaned;
    console.log(
      `[MEDIA_CLEANUP] ✅ Hoàn tất dọn dẹp: Đã xử lý ${totalTransactionsCleaned} đơn nợ, xóa ${totalInvoicesDeleted} ảnh TransactionInvoice, dọn dẹp ${totalSubmissionsCleaned} video/ảnh StaffSubmission (Tổng cộng: ${totalMediaFilesDeleted} tệp tin media).`
    );

    return {
      success: true,
      dryRun,
      cutoffDate,
      daysThreshold,
      totalCustomersChecked: targetCustomerIds.length,
      totalTransactionsCleaned,
      totalInvoicesDeleted,
      totalSubmissionsCleaned,
      totalMediaFilesDeleted,
    };
  } catch (error) {
    console.error('[MEDIA_CLEANUP_ERROR]:', error);
    return {
      success: false,
      error: error.message,
      totalTransactionsCleaned,
      totalInvoicesDeleted,
      totalSubmissionsCleaned,
      totalMediaFilesDeleted: totalInvoicesDeleted + totalSubmissionsCleaned,
    };
  }
};

let cleanupInterval = null;

/**
 * Khởi tạo Scheduler tự động dọn dẹp media của các đơn nợ đã thanh toán sau 15 ngày
 * (Chạy kiểm tra mỗi ngày 1 lần vào ban đêm lúc 02:00 sáng theo giờ Việt Nam)
 */
const initPaidDebtMediaCleanupScheduler = () => {
  if (cleanupInterval) return;

  // Helper kiểm tra có phải khoảng 02:00 - 02:15 sáng giờ Việt Nam hay không
  const is2AMVietnam = () => {
    const vnTime = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return vnTime.getUTCHours() === 2 && vnTime.getUTCMinutes() < 15;
  };

  let hasRunToday = false;

  // Chạy ngay 1 lần khi server khởi động để dọn dẹp tồn đọng
  setTimeout(() => {
    cleanupPaidDebtMedia({ daysThreshold: 15 }).catch((err) => {
      console.warn('[SCHEDULER] Lỗi lần chạy đầu tiên của dọn dẹp media:', err.message);
    });
  }, 10 * 1000); // Đợi 10s sau khi server khởi động ổn định

  // Kiểm tra định kỳ mỗi 15 phút
  cleanupInterval = setInterval(() => {
    const vnTime = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const hour = vnTime.getUTCHours();

    if (hour === 2) {
      if (!hasRunToday) {
        hasRunToday = true;
        cleanupPaidDebtMedia({ daysThreshold: 15 }).catch((err) => {
          console.error('[SCHEDULER] Lỗi dọn dẹp media định kỳ 02:00 sáng:', err);
        });
      }
    } else {
      hasRunToday = false; // Reset cờ cho ngày tiếp theo
    }
  }, 15 * 60 * 1000);

  console.log('⏰ [SCHEDULER] Tiến trình tự động xóa ảnh/video đơn đã thu nợ sau 15 ngày (02:00 sáng hàng ngày) đã được kích hoạt.');
};

module.exports = {
  cleanupPaidDebtMedia,
  initPaidDebtMediaCleanupScheduler,
  reconcileDebtTransactions,
};
