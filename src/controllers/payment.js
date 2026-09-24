// meat-management-be/src/controllers/payment.js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');
const { uploadToCloudinary, isCloudinaryConfigured } = require('../utils/cloudinary');

// Thư mục lưu trữ hóa đơn cục bộ
const uploadsDir = path.join(__dirname, '../../uploads/invoices');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper lưu tệp ảnh / video đính kèm (hỗ trợ cả Base64 Data URI và Cloudinary)
const processMediaUpload = async (mediaInput, userId) => {
  if (!mediaInput || typeof mediaInput !== 'string') return null;

  // Nếu đã là link web hoặc link server
  if (mediaInput.startsWith('http://') || mediaInput.startsWith('https://') || mediaInput.startsWith('/uploads/')) {
    return mediaInput;
  }

  let fileExt = 'jpg';
  let isVideo = false;
  let mimeType = 'image/jpeg';
  let cleanBase64 = mediaInput;

  if (mediaInput.startsWith('data:video/')) {
    isVideo = true;
    const match = mediaInput.match(/^data:video\/([a-zA-Z0-9+.\-_]+);base64,(.+)$/);
    if (match && match.length === 3) {
      const subType = match[1].toLowerCase();
      fileExt = subType === 'quicktime' ? 'mov' : subType.split('+')[0];
      mimeType = `video/${match[1]}`;
      cleanBase64 = match[2];
    } else {
      fileExt = 'mp4';
      mimeType = 'video/mp4';
      cleanBase64 = mediaInput.split(',')[1] || mediaInput;
    }
  } else if (mediaInput.startsWith('data:image/')) {
    const match = mediaInput.match(/^data:image\/([a-zA-Z0-9+.\-_]+);base64,(.+)$/);
    if (match && match.length === 3) {
      const subType = match[1].toLowerCase();
      fileExt = subType === 'jpeg' ? 'jpg' : subType;
      mimeType = `image/${match[1]}`;
      cleanBase64 = match[2];
    } else {
      fileExt = 'jpg';
      mimeType = 'image/jpeg';
      cleanBase64 = mediaInput.split(',')[1] || mediaInput;
    }
  }

  // Lưu file cục bộ vào thư mục uploads/invoices
  const prefix = isVideo ? 'vid' : 'inv';
  const fileName = `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${fileExt}`;
  const filePath = path.join(uploadsDir, fileName);
  const buffer = Buffer.from(cleanBase64, 'base64');
  await fs.promises.writeFile(filePath, buffer);

  let finalUrl = `/uploads/invoices/${fileName}`;

  // Đẩy lên Cloudinary nếu có cấu hình
  if (isCloudinaryConfigured()) {
    try {
      const dataUri = `data:${mimeType};base64,${cleanBase64}`;
      const uploadRes = await uploadToCloudinary(dataUri, {
        filePath,
        folder: isVideo ? 'meat_invoices/videos' : 'meat_invoices',
        resource_type: isVideo ? 'video' : 'image',
      });
      if (uploadRes && (uploadRes.secure_url || uploadRes.url)) {
        finalUrl = uploadRes.secure_url || uploadRes.url;
      }
    } catch (cloudErr) {
      console.warn('[PAYMENT_UPLOAD] Lỗi tải lên Cloudinary, giữ link cục bộ:', cloudErr.message);
    }
  }

  return finalUrl;
};

// Helper gửi socket event thông báo thanh toán / nợ khách hàng thay đổi
const notifyCustomerUpdate = (userId, action, payload = {}) => {
  emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    ...payload,
  });
};

// 1. Tạo nhật ký thu tiền trả nợ mới (Payment)
const createPayment = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, amount, paidAt, note, imageUrl, mediaData, imageBase64, images } = req.body;

    if (!customerId || amount === undefined) {
      throw new BadRequestError('Khách hàng và số tiền thanh toán là bắt buộc.');
    }

    const payAmount = parseFloat(amount);
    if (payAmount <= 0) {
      throw new BadRequestError('Số tiền thanh toán phải lớn hơn 0.');
    }

    // Kiểm tra khách hàng có tồn tại và thuộc quyền quản lý của chủ buôn hay không
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });
    if (!customer) {
      throw new NotFoundError('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Ngày thanh toán: ưu tiên ngày do client truyền (nếu người dùng chủ động chọn ngày), ngược lại mặc định là thời điểm hiện tại
    const paymentPaidAt = paidAt ? new Date(paidAt) : new Date();

    // Lưu lượt trả nợ vào database
    const payment = await prisma.payment.create({
      data: {
        customerId,
        createdBy: req.user.id,
        amount: payAmount,
        paidAt: paymentPaidAt,
        note: note || null,
      },
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
    });

    // Lưu các ảnh / video hóa đơn / chứng từ trả hàng đính kèm nếu có
    const mediaInputs = [];
    if (Array.isArray(images) && images.length > 0) {
      mediaInputs.push(...images);
    } else if (mediaData) {
      mediaInputs.push(mediaData);
    } else if (imageBase64) {
      mediaInputs.push(imageBase64);
    } else if (imageUrl) {
      mediaInputs.push(imageUrl);
    }

    const createdInvoices = [];
    if (mediaInputs.length > 0) {
      for (const item of mediaInputs) {
        try {
          const finalUrl = await processMediaUpload(item, userId);
          if (finalUrl) {
            const returnNote = `[paymentId:${payment.id}] ` + (note ? `${note}` : 'Đơn trả hàng');
            const inv = await prisma.transactionInvoice.create({
              data: {
                userId,
                customerId,
                date: paymentPaidAt,
                imageUrl: finalUrl,
                note: returnNote,
                transactionId: null,
              },
            });
            createdInvoices.push({
              id: inv.id,
              imageUrl: inv.imageUrl,
              note: inv.note.replace(/\[paymentId:[a-f0-9\-]+\]\s*/i, ''),
              date: inv.date,
            });
          }
        } catch (mediaErr) {
          console.warn('[CREATE_PAYMENT_MEDIA_ERR]', mediaErr.message);
        }
      }
    }

    await logActivity(
      userId,
      'CREATE_PAYMENT',
      `Thu tiền trả nợ / trả hàng từ khách hàng ${customer.name}: Số tiền ${payAmount.toLocaleString('vi-VN')}đ`
    );
    notifyCustomerUpdate(userId, 'CREATE_PAYMENT', { customerId, paymentId: payment.id });

    res.status(201).json({
      success: true,
      data: {
        ...payment,
        invoices: createdInvoices,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 2. Lấy danh sách nhật ký trả nợ (có thể lọc theo khách hàng)
const getPayments = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { customerId, date, month } = req.query;

    // Lọc theo khách hàng thuộc chủ buôn này
    const whereClause = {
      customer: {
        userId,
      },
    };
    if (customerId) {
      whereClause.customerId = customerId;
    }

    // Lọc theo ngày hoặc tháng cụ thể
    if (date) {
      const parts = date.includes('/') ? date.split('/') : date.split('-');
      if (parts.length === 3) {
        const isSlash = date.includes('/');
        const year = parseInt(isSlash ? parts[2] : parts[0], 10);
        const monthVal = parseInt(parts[1], 10) - 1;
        const dayVal = parseInt(isSlash ? parts[0] : parts[2], 10);

        const startUTC = new Date(Date.UTC(year, monthVal, dayVal, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
        const endUTC = new Date(Date.UTC(year, monthVal, dayVal, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
        // Lấy tất cả các khoản thanh toán có paidAt hoặc createdAt trong ngày này (tránh sót các khoản thu tạo trong ngày)
        whereClause.OR = [
          { paidAt: { gte: startUTC, lte: endUTC } },
          { createdAt: { gte: startUTC, lte: endUTC } },
        ];
      }
    } else if (month) {
      const parts = month.split('/');
      if (parts.length === 2) {
        const m = parseInt(parts[0], 10) - 1;
        const y = parseInt(parts[1], 10);
        const startUTC = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
        const endUTC = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
        whereClause.paidAt = { gte: startUTC, lte: endUTC };
      }
    }

    const payments = await prisma.payment.findMany({
      where: whereClause,
      include: {
        customer: {
          select: {
            name: true,
            phone: true,
          },
        },
      },
      orderBy: {
        paidAt: 'desc', // Lượt trả nợ mới nhất xếp trên đầu
      },
    });

    // Bổ sung danh sách ảnh/video hóa đơn hoặc đơn trả hàng cho từng Payment
    const paymentIds = payments.map((p) => p.id);
    const invoicesByPaymentId = {};

    if (paymentIds.length > 0) {
      // 1. Tìm từ StaffSubmission liên kết trực tiếp với Payment (khi duyệt đơn trả hàng do nhân viên gửi)
      const staffSubs = await prisma.staffSubmission.findMany({
        where: {
          transactionId: { in: paymentIds },
          fileUrl: { not: '' },
        },
        select: {
          id: true,
          fileUrl: true,
          fileType: true,
          transactionId: true,
          date: true,
          senderName: true,
        },
      });

      staffSubs.forEach((sub) => {
        if (!invoicesByPaymentId[sub.transactionId]) {
          invoicesByPaymentId[sub.transactionId] = [];
        }
        invoicesByPaymentId[sub.transactionId].push({
          id: sub.id,
          imageUrl: sub.fileUrl,
          fileType: sub.fileType,
          note: sub.senderName ? `NV: ${sub.senderName}` : 'Đơn trả hàng',
          date: sub.date,
        });
      });

      // 2. Tìm từ TransactionInvoice được gắn tag [paymentId:xxx]
      const transInvs = await prisma.transactionInvoice.findMany({
        where: {
          userId,
          OR: paymentIds.map((pid) => ({ note: { contains: `[paymentId:${pid}]` } })),
        },
        select: {
          id: true,
          imageUrl: true,
          note: true,
          date: true,
        },
      });

      transInvs.forEach((inv) => {
        const match = inv.note?.match(/\[paymentId:([a-f0-9\-]+)\]/i);
        const pid = match ? match[1] : null;
        if (pid && paymentIds.includes(pid)) {
          if (!invoicesByPaymentId[pid]) {
            invoicesByPaymentId[pid] = [];
          }
          if (!invoicesByPaymentId[pid].some((item) => item.imageUrl === inv.imageUrl)) {
            invoicesByPaymentId[pid].push({
              id: inv.id,
              imageUrl: inv.imageUrl,
              note: inv.note.replace(/\[paymentId:[a-f0-9\-]+\]\s*/i, ''),
              date: inv.date,
            });
          }
        }
      });
    }

    const paymentsWithInvoices = payments.map((p) => ({
      ...p,
      invoices: invoicesByPaymentId[p.id] || [],
    }));

    res.status(200).json({
      success: true,
      data: paymentsWithInvoices,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật lượt thu tiền (số tiền, ngày, ghi chú)
const updatePayment = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { amount, paidAt, note, imageUrl, mediaData, imageBase64, images, deletedInvoiceIds } = req.body;

    // Kiểm tra payment tồn tại và thuộc khách hàng của chủ buôn này
    const existing = await prisma.payment.findFirst({
      where: { id, customer: { userId } },
    });
    if (!existing) {
      throw new NotFoundError('Lượt thu tiền không tồn tại hoặc không thuộc quyền quản lý.');
    }

    // Xác thực số tiền nếu có cung cấp
    let payAmount = existing.amount;
    if (amount !== undefined) {
      payAmount = parseFloat(amount);
      if (payAmount <= 0) throw new BadRequestError('Số tiền phải lớn hơn 0.');
    }

    const newPaidAt = paidAt ? new Date(paidAt) : existing.paidAt;

    const updated = await prisma.payment.update({
      where: { id },
      data: {
        amount: payAmount,
        paidAt: newPaidAt,
        note: note !== undefined ? (note || null) : existing.note,
      },
      include: { customer: { select: { name: true, phone: true } } },
    });

    // 1. Xóa các hóa đơn bị người dùng gỡ bỏ
    if (Array.isArray(deletedInvoiceIds) && deletedInvoiceIds.length > 0) {
      await prisma.transactionInvoice.deleteMany({
        where: {
          id: { in: deletedInvoiceIds },
          userId,
        },
      });
    }

    // 2. Thêm các ảnh/video hóa đơn mới nếu có
    const mediaInputs = [];
    if (Array.isArray(images) && images.length > 0) {
      mediaInputs.push(...images);
    } else if (mediaData) {
      mediaInputs.push(mediaData);
    } else if (imageBase64) {
      mediaInputs.push(imageBase64);
    } else if (imageUrl) {
      mediaInputs.push(imageUrl);
    }

    if (mediaInputs.length > 0) {
      for (const item of mediaInputs) {
        try {
          const finalUrl = await processMediaUpload(item, userId);
          if (finalUrl) {
            const currentNote = updated.note || '';
            const returnNote = `[paymentId:${id}] ` + (currentNote ? `Trả hàng - ${currentNote}` : 'Đơn trả hàng');
            await prisma.transactionInvoice.create({
              data: {
                userId,
                customerId: existing.customerId,
                date: newPaidAt,
                imageUrl: finalUrl,
                note: returnNote,
                transactionId: null,
              },
            });
          }
        } catch (mediaErr) {
          console.warn('[UPDATE_PAYMENT_MEDIA_ERR]', mediaErr.message);
        }
      }
    }

    // 3. Đồng bộ lại ngày của các TransactionInvoice liên kết nếu ngày thanh toán thay đổi
    if (paidAt && new Date(paidAt).getTime() !== new Date(existing.paidAt).getTime()) {
      await prisma.transactionInvoice.updateMany({
        where: {
          userId,
          note: { contains: `[paymentId:${id}]` },
        },
        data: {
          date: newPaidAt,
        },
      });
    }

    const oldAmountStr = `${Number(existing.amount).toLocaleString('vi-VN')}đ`;
    const newAmountStr = `${Number(payAmount).toLocaleString('vi-VN')}đ`;

    const oldDateStr = existing.paidAt
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(existing.paidAt))
      : '';
    const newDateStr = updated.paidAt
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(updated.paidAt))
      : oldDateStr;

    const changes = [];
    changes.push(`Số tiền: ${oldAmountStr} ➔ ${newAmountStr}`);
    if (oldDateStr !== newDateStr) {
      changes.push(`Ngày thu: ${oldDateStr} ➔ ${newDateStr}`);
    }
    if ((existing.note || '') !== (updated.note || '')) {
      changes.push(`Ghi chú: "${existing.note || 'Không'}" ➔ "${updated.note || 'Không'}"`);
    }

    const logDetail = `Cập nhật lượt thu tiền của khách hàng ${updated.customer.name}:\n• ${changes.join('\n• ')}`;

    await logActivity(
      userId,
      'UPDATE_PAYMENT',
      logDetail
    );
    notifyCustomerUpdate(userId, 'UPDATE_PAYMENT', { customerId: existing.customerId, paymentId: id });

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa lượt thu tiền trả nợ (Payment) theo ID
const deletePayment = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    // Kiểm tra payment tồn tại và thuộc khách hàng của chủ buôn này
    const existing = await prisma.payment.findFirst({
      where: { id, customer: { userId } },
    });
    if (!existing) {
      throw new NotFoundError('Lượt thu tiền không tồn tại hoặc không thuộc quyền quản lý của bạn.');
    }

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && existing.createdBy !== actorId && actorId !== userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    // Xóa tất cả ảnh/video hóa đơn TransactionInvoice liên kết với payment này
    await prisma.transactionInvoice.deleteMany({
      where: {
        userId,
        note: { contains: `[paymentId:${id}]` },
      },
    }).catch((delErr) => console.warn('[DELETE_PAYMENT_INVOICES_ERR]', delErr.message));

    // Thực hiện xóa lượt trả nợ
    await prisma.payment.delete({
      where: { id },
    });

    const customer = await prisma.customer.findUnique({
      where: { id: existing.customerId }
    });

    await logActivity(
      userId,
      'DELETE_PAYMENT',
      `Xóa lượt thu tiền của khách hàng ${customer?.name || 'ẩn'}: Số tiền ${existing.amount.toLocaleString('vi-VN')}đ`
    );
    notifyCustomerUpdate(userId, 'DELETE_PAYMENT', { customerId: existing.customerId, paymentId: id });

    res.status(200).json({
      success: true,
      message: 'Xóa lượt thu tiền thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createPayment,
  getPayments,
  updatePayment,
  deletePayment,
};
