const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { isCloudinaryConfigured, uploadToCloudinary } = require('../utils/cloudinary');

// 1. Lấy toàn bộ danh sách nhà cung cấp kèm theo dư nợ (Tiền nợ)
// Dư nợ = Tổng số tiền transactions (nhập hàng) - Tổng số tiền payments (đã trả)
const getSuppliers = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

    // Lấy danh sách nhà cung cấp đang hoạt động của chủ sạp
    const suppliers = await prisma.supplier.findMany({
      where: {
        userId,
        isActive: true,
      },
      include: {
        transactions: {
          select: {
            totalAmount: true,
          },
        },
        payments: {
          select: {
            amount: true,
          },
        },
      },
      orderBy: {
        name: 'asc', // Sắp xếp A-Z theo tên nhà cung cấp
      },
    });

    // Tính dư nợ đối với từng nhà cung cấp
    const suppliersWithDebt = suppliers.map((supplier) => {
      const totalDebt = supplier.transactions.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0);
      const totalPaid = supplier.payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const debt = totalDebt - totalPaid;

      // Loại bỏ mảng giao dịch con để giảm tải dung lượng mạng
      const { transactions, payments, ...rest } = supplier;
      return {
        ...rest,
        debt,
      };
    });

    res.status(200).json({
      success: true,
      data: suppliersWithDebt,
    });
  } catch (error) {
    next(error);
  }
};

// 2. Tạo mới một nhà cung cấp
const createSupplier = async (req, res, next) => {
  try {
    const { name, phone, address, note } = req.body;
    const userId = req.effectiveUserId;

    if (!name || name.trim() === '') {
      throw new BadRequestError('Tên nhà cung cấp là thông tin bắt buộc.');
    }

    const trimmedName = name.trim();

    // Kiểm tra trùng tên nhà cung cấp đang hoạt động
    const existingSupplier = await prisma.supplier.findFirst({
      where: {
        userId,
        name: trimmedName,
        isActive: true,
      },
    });

    if (existingSupplier) {
      throw new BadRequestError('Nhà cung cấp này đã tồn tại trong danh sách của bạn.');
    }

    const supplier = await prisma.supplier.create({
      data: {
        userId,
        createdBy: req.user.id,
        name: trimmedName,
        phone: phone ? phone.trim() : null,
        address: address ? address.trim() : null,
        note: note ? note.trim() : null,
      },
    });

    await logActivity(
      userId,
      'CREATE_SUPPLIER',
      `Thêm nhà cung cấp mới: ${trimmedName}`
    );

    res.status(201).json({
      success: true,
      data: supplier,
    });
  } catch (error) {
    next(error);
  }
};

// 3. Cập nhật thông tin nhà cung cấp
const updateSupplier = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, phone, address, note } = req.body;
    const userId = req.effectiveUserId;

    // Kiểm tra sự tồn tại của nhà cung cấp
    const supplierExists = await prisma.supplier.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!supplierExists) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp này hoặc bạn không có quyền sửa.');
    }

    if (name !== undefined) {
      if (!name || name.trim() === '') {
        throw new BadRequestError('Tên nhà cung cấp là thông tin bắt buộc.');
      }
      const trimmedName = name.trim();
      const existingName = await prisma.supplier.findFirst({
        where: {
          userId,
          name: trimmedName,
          isActive: true,
          NOT: { id },
        },
      });

      if (existingName) {
        throw new BadRequestError('Tên nhà cung cấp này đã tồn tại trong danh sách của bạn.');
      }
    }

    const updated = await prisma.supplier.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        phone: phone !== undefined ? (phone ? phone.trim() : null) : undefined,
        address: address !== undefined ? (address ? address.trim() : null) : undefined,
        note: note !== undefined ? (note ? note.trim() : null) : undefined,
      },
    });

    const changes = [];
    if (supplierExists.name !== updated.name) {
      changes.push(`Tên: "${supplierExists.name}" ➔ "${updated.name}"`);
    }
    if ((supplierExists.phone || '') !== (updated.phone || '')) {
      changes.push(`SĐT: "${supplierExists.phone || 'Không'}" ➔ "${updated.phone || 'Không'}"`);
    }
    if ((supplierExists.address || '') !== (updated.address || '')) {
      changes.push(`Địa chỉ: "${supplierExists.address || 'Không'}" ➔ "${updated.address || 'Không'}"`);
    }
    if ((supplierExists.note || '') !== (updated.note || '')) {
      changes.push(`Ghi chú: "${supplierExists.note || 'Không'}" ➔ "${updated.note || 'Không'}"`);
    }

    const logDetail = changes.length > 0
      ? `Cập nhật nhà cung cấp "${supplierExists.name}":\n• ${changes.join('\n• ')}`
      : `Cập nhật nhà cung cấp "${supplierExists.name}" (Không có thay đổi)`;

    await logActivity(
      userId,
      'UPDATE_SUPPLIER',
      logDetail
    );

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// 4. Xóa mềm nhà cung cấp
const deleteSupplier = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const supplierExists = await prisma.supplier.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!supplierExists) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp này hoặc bạn không có quyền xóa.');
    }

    // Kiểm tra bảo vệ dữ liệu chéo: Nhân viên chỉ được xóa dữ liệu do chính mình tạo. Chủ Workspace và Admin tối cao có toàn quyền.
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && supplierExists.createdBy !== actorId && actorId !== supplierExists.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    await prisma.supplier.update({
      where: { id },
      data: {
        isActive: false,
      },
    });

    await logActivity(
      userId,
      'DELETE_SUPPLIER',
      `Xóa nhà cung cấp: ${supplierExists.name}`
    );

    res.status(200).json({
      success: true,
      message: 'Xóa nhà cung cấp thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Ghi nhận giao dịch nhập hàng (Nợ phát sinh)
const createSupplierTransaction = async (req, res, next) => {
  try {
    const { supplierId, totalAmount, note, date, items, mediaUrls } = req.body;
    const userId = req.effectiveUserId;

    if (!supplierId) {
      throw new BadRequestError('supplierId là bắt buộc.');
    }
    if (!totalAmount || parseFloat(totalAmount) <= 0) {
      throw new BadRequestError('Số tiền hàng nhập phải lớn hơn 0.');
    }

    // Kiểm tra nhà cung cấp
    const supplier = await prisma.supplier.findFirst({
      where: {
        id: supplierId,
        userId,
        isActive: true,
      },
    });

    if (!supplier) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp.');
    }

    const itemsStr = items ? (typeof items === 'string' ? items : JSON.stringify(items)) : null;
    const mediaUrlsStr = mediaUrls ? (typeof mediaUrls === 'string' ? mediaUrls : JSON.stringify(mediaUrls)) : null;

    const transaction = await prisma.supplierTransaction.create({
      data: {
        supplierId,
        createdBy: req.user.id,
        totalAmount: parseFloat(totalAmount),
        note: note ? note.trim() : null,
        date: date ? new Date(date) : new Date(),
        items: itemsStr,
        mediaUrls: mediaUrlsStr,
      },
    });

    const formatCurrency = (val) => new Intl.NumberFormat('vi-VN').format(val) + ' đ';
    const detailCount = Array.isArray(items) && items.length > 0 ? ` (${items.length} món thịt)` : '';
    await logActivity(
      userId,
      'CREATE_SUPPLIER_TRANSACTION',
      `Nhập hàng từ nhà cung cấp ${supplier.name}: +${formatCurrency(totalAmount)}${detailCount} (Nợ phát sinh)`
    );

    res.status(201).json({
      success: true,
      data: {
        ...transaction,
        items: items || null,
        mediaUrls: mediaUrls || [],
      },
    });
  } catch (error) {
    next(error);
  }
};

// 6. Ghi nhận thanh toán trả nợ cho nhà cung cấp
const createSupplierPayment = async (req, res, next) => {
  try {
    const { supplierId, amount, note, paidAt, mediaUrls } = req.body;
    const userId = req.effectiveUserId;

    if (!supplierId) {
      throw new BadRequestError('supplierId là bắt buộc.');
    }
    if (!amount || parseFloat(amount) <= 0) {
      throw new BadRequestError('Số tiền thanh toán phải lớn hơn 0.');
    }

    // Kiểm tra nhà cung cấp
    const supplier = await prisma.supplier.findFirst({
      where: {
        id: supplierId,
        userId,
        isActive: true,
      },
    });

    if (!supplier) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp.');
    }

    const mediaUrlsStr = mediaUrls ? (typeof mediaUrls === 'string' ? mediaUrls : JSON.stringify(mediaUrls)) : null;

    const payment = await prisma.supplierPayment.create({
      data: {
        supplierId,
        createdBy: req.user.id,
        amount: parseFloat(amount),
        note: note ? note.trim() : null,
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        mediaUrls: mediaUrlsStr,
      },
    });

    const formatCurrency = (val) => new Intl.NumberFormat('vi-VN').format(val) + ' đ';
    await logActivity(
      userId,
      'CREATE_SUPPLIER_PAYMENT',
      `Thanh toán tiền hàng cho nhà cung cấp ${supplier.name}: -${formatCurrency(amount)}`
    );

    res.status(201).json({
      success: true,
      data: {
        ...payment,
        mediaUrls: mediaUrls || [],
      },
    });
  } catch (error) {
    next(error);
  }
};

// 7. Xem lịch sử dòng tiền của một nhà cung cấp (Sắp xếp theo thời gian mới nhất)
const getSupplierHistory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    // Kiểm tra nhà cung cấp
    const supplier = await prisma.supplier.findFirst({
      where: {
        id,
        userId,
        isActive: true,
      },
    });

    if (!supplier) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp.');
    }

    // Lấy transactions (Nhập hàng / nợ phát sinh)
    const transactions = await prisma.supplierTransaction.findMany({
      where: { supplierId: id },
      orderBy: { date: 'desc' },
    });

    // Lấy payments (Đã thanh toán)
    const payments = await prisma.supplierPayment.findMany({
      where: { supplierId: id },
      orderBy: { paidAt: 'desc' },
    });

    // Gom hai loại thành dòng lịch sử thống nhất
    const historyList = [
      ...transactions.map((t) => {
        let parsedItems = null;
        if (t.items) {
          try { parsedItems = JSON.parse(t.items); } catch (e) { parsedItems = null; }
        }
        let parsedMedia = [];
        if (t.mediaUrls) {
          try { parsedMedia = JSON.parse(t.mediaUrls); } catch (e) { parsedMedia = []; }
        }
        return {
          id: t.id,
          type: 'DEBT', // Nợ phát sinh (mình nợ họ)
          amount: parseFloat(t.totalAmount),
          date: t.date,
          note: t.note,
          items: parsedItems,
          mediaUrls: parsedMedia,
          createdAt: t.createdAt,
        };
      }),
      ...payments.map((p) => {
        let parsedMedia = [];
        if (p.mediaUrls) {
          try { parsedMedia = JSON.parse(p.mediaUrls); } catch (e) { parsedMedia = []; }
        }
        return {
          id: p.id,
          type: 'PAYMENT', // Trả nợ (mình trả họ)
          amount: parseFloat(p.amount),
          date: p.paidAt,
          note: p.note,
          mediaUrls: parsedMedia,
          createdAt: p.createdAt,
        };
      }),
    ];

    // Sắp xếp theo ngày giao dịch (date), nếu trùng thì xếp theo createdAt mới hơn lên trước
    historyList.sort((a, b) => {
      const dateDiff = new Date(b.date) - new Date(a.date);
      if (dateDiff !== 0) return dateDiff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.status(200).json({
      success: true,
      data: historyList,
      supplier: {
        id: supplier.id,
        name: supplier.name,
        createdAt: supplier.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 8. Cập nhật giao dịch nhập hàng (sửa nợ phát sinh)
const updateSupplierTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { totalAmount, note, date, items, mediaUrls } = req.body;
    const userId = req.effectiveUserId;

    const transaction = await prisma.supplierTransaction.findFirst({
      where: {
        id,
        supplier: { userId, isActive: true },
      },
      include: { supplier: true },
    });

    if (!transaction) {
      throw new NotFoundError('Không tìm thấy giao dịch nhập hàng.');
    }

    // Bảo vệ quyền sửa dữ liệu chéo
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && transaction.createdBy && transaction.createdBy !== actorId && actorId !== transaction.supplier.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền sửa dữ liệu do người khác tạo.');
    }

    if (totalAmount !== undefined && parseFloat(totalAmount) <= 0) {
      throw new BadRequestError('Số tiền hàng nhập phải lớn hơn 0.');
    }

    const itemsStr = items !== undefined ? (items ? (typeof items === 'string' ? items : JSON.stringify(items)) : null) : undefined;
    const mediaUrlsStr = mediaUrls !== undefined ? (mediaUrls ? (typeof mediaUrls === 'string' ? mediaUrls : JSON.stringify(mediaUrls)) : null) : undefined;

    const updated = await prisma.supplierTransaction.update({
      where: { id },
      data: {
        totalAmount: totalAmount !== undefined ? parseFloat(totalAmount) : undefined,
        note: note !== undefined ? (note ? note.trim() : null) : undefined,
        date: date !== undefined ? new Date(date) : undefined,
        items: itemsStr,
        mediaUrls: mediaUrlsStr,
      },
    });

    const formatCurrency = (val) => new Intl.NumberFormat('vi-VN').format(val) + 'đ';
    const oldAmountStr = formatCurrency(transaction.totalAmount);
    const newAmountStr = formatCurrency(updated.totalAmount);

    const oldDateStr = transaction.date
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(transaction.date))
      : '';
    const newDateStr = updated.date
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(updated.date))
      : oldDateStr;

    const changes = [];
    changes.push(`Số tiền: ${oldAmountStr} ➔ ${newAmountStr}`);
    if (oldDateStr !== newDateStr) {
      changes.push(`Ngày nhập: ${oldDateStr} ➔ ${newDateStr}`);
    }
    if ((transaction.note || '') !== (updated.note || '')) {
      changes.push(`Ghi chú: "${transaction.note || 'Không'}" ➔ "${updated.note || 'Không'}"`);
    }

    const dateDisplay = oldDateStr ? ` ngày ${oldDateStr}` : '';
    const logDetail = `Cập nhật đơn nhập hàng${dateDisplay} của nhà cung cấp ${transaction.supplier.name}:\n• ${changes.join('\n• ')}`;

    await logActivity(
      userId,
      'UPDATE_SUPPLIER_TRANSACTION',
      logDetail
    );

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// 9. Xóa giao dịch nhập hàng
const deleteSupplierTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const transaction = await prisma.supplierTransaction.findFirst({
      where: {
        id,
        supplier: { userId, isActive: true },
      },
      include: { supplier: true },
    });

    if (!transaction) {
      throw new NotFoundError('Không tìm thấy giao dịch nhập hàng.');
    }

    // Bảo vệ quyền xóa dữ liệu chéo
    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && transaction.createdBy && transaction.createdBy !== actorId && actorId !== transaction.supplier.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    await prisma.supplierTransaction.delete({
      where: { id },
    });

    const transDateStr = transaction.date
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(transaction.date))
      : '';
    const dateDisplay = transDateStr ? ` ngày ${transDateStr}` : '';
    const formatCurrency = (val) => new Intl.NumberFormat('vi-VN').format(val) + ' đ';
    await logActivity(
      userId,
      'DELETE_SUPPLIER_TRANSACTION',
      `Xóa đơn nhập hàng${dateDisplay} của nhà cung cấp ${transaction.supplier.name}: ${formatCurrency(transaction.totalAmount)}`
    );

    res.status(200).json({
      success: true,
      message: 'Xóa giao dịch nhập hàng thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 10. Cập nhật giao dịch thanh toán tiền hàng
const updateSupplierPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount, note, paidAt, mediaUrls } = req.body;
    const userId = req.effectiveUserId;

    const payment = await prisma.supplierPayment.findFirst({
      where: {
        id,
        supplier: { userId, isActive: true },
      },
      include: { supplier: true },
    });

    if (!payment) {
      throw new NotFoundError('Không tìm thấy giao dịch thanh toán.');
    }

    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && payment.createdBy && payment.createdBy !== actorId && actorId !== payment.supplier.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền sửa dữ liệu do người khác tạo.');
    }

    if (amount !== undefined && parseFloat(amount) <= 0) {
      throw new BadRequestError('Số tiền thanh toán phải lớn hơn 0.');
    }

    const mediaUrlsStr = mediaUrls !== undefined ? (mediaUrls ? (typeof mediaUrls === 'string' ? mediaUrls : JSON.stringify(mediaUrls)) : null) : undefined;

    const updated = await prisma.supplierPayment.update({
      where: { id },
      data: {
        amount: amount !== undefined ? parseFloat(amount) : undefined,
        note: note !== undefined ? (note ? note.trim() : null) : undefined,
        paidAt: paidAt !== undefined ? new Date(paidAt) : undefined,
        mediaUrls: mediaUrlsStr,
      },
    });

    const formatCurrency = (val) => new Intl.NumberFormat('vi-VN').format(val) + 'đ';
    const oldAmountStr = formatCurrency(payment.amount);
    const newAmountStr = formatCurrency(updated.amount);

    const oldDateStr = payment.paidAt
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(payment.paidAt))
      : '';
    const newDateStr = updated.paidAt
      ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(updated.paidAt))
      : oldDateStr;

    const changes = [];
    changes.push(`Số tiền: ${oldAmountStr} ➔ ${newAmountStr}`);
    if (oldDateStr !== newDateStr) {
      changes.push(`Ngày thanh toán: ${oldDateStr} ➔ ${newDateStr}`);
    }
    if ((payment.note || '') !== (updated.note || '')) {
      changes.push(`Ghi chú: "${payment.note || 'Không'}" ➔ "${updated.note || 'Không'}"`);
    }

    const logDetail = `Cập nhật thanh toán cho nhà cung cấp ${payment.supplier.name}:\n• ${changes.join('\n• ')}`;

    await logActivity(
      userId,
      'UPDATE_SUPPLIER_PAYMENT',
      logDetail
    );

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

// 11. Xóa giao dịch thanh toán tiền hàng
const deleteSupplierPayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const payment = await prisma.supplierPayment.findFirst({
      where: {
        id,
        supplier: { userId, isActive: true },
      },
      include: { supplier: true },
    });

    if (!payment) {
      throw new NotFoundError('Không tìm thấy giao dịch thanh toán.');
    }

    const actorId = req.user.id;
    const actorIsAdmin = req.user.isAdmin === true;
    if (!actorIsAdmin && payment.createdBy && payment.createdBy !== actorId && actorId !== payment.supplier.userId) {
      throw new ForbiddenError('Tài khoản của bạn không có quyền xóa dữ liệu do người khác tạo.');
    }

    await prisma.supplierPayment.delete({
      where: { id },
    });

    const formatCurrency = (val) => new Intl.NumberFormat('vi-VN').format(val) + ' đ';
    await logActivity(
      userId,
      'DELETE_SUPPLIER_PAYMENT',
      `Xóa thanh toán cho nhà cung cấp ${payment.supplier.name}: ${formatCurrency(payment.amount)}`
    );

    res.status(200).json({
      success: true,
      message: 'Xóa giao dịch thanh toán thành công.',
    });
  } catch (error) {
    next(error);
  }
};

// 12. Tải lên hình ảnh hoặc video chứng từ, phiếu cân, hóa đơn nhà cung cấp
const uploadSupplierMedia = async (req, res, next) => {
  try {
    const { fileData, fileName: origFileName, fileType: origFileType } = req.body;
    if (!fileData) {
      throw new BadRequestError('Dữ liệu hình ảnh hoặc video không được để trống.');
    }

    const uploadsDir = path.join(__dirname, '../../uploads/suppliers');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    let isVideo = origFileType === 'VIDEO' ||
      (origFileName && /\.(mp4|mov|qt|avi|webm|m4v|3gp|mkv)$/i.test(origFileName));
    let fileExt = 'jpg';
    let mimeType = 'image/jpeg';
    let cleanBase64 = fileData;

    if (typeof fileData === 'string' && fileData.startsWith('data:')) {
      const commaIdx = fileData.indexOf(',');
      if (commaIdx !== -1) {
        const header = fileData.substring(0, commaIdx).toLowerCase();
        cleanBase64 = fileData.substring(commaIdx + 1);
        if (header.includes('video') || header.includes('quicktime') || header.includes('mp4') || header.includes('mov')) {
          isVideo = true;
          fileExt = header.includes('quicktime') ? 'mov' : 'mp4';
          mimeType = isVideo ? (header.includes('quicktime') ? 'video/quicktime' : 'video/mp4') : 'video/mp4';
        } else if (header.includes('png')) {
          fileExt = 'png';
          mimeType = 'image/png';
        } else if (header.includes('webp')) {
          fileExt = 'webp';
          mimeType = 'image/webp';
        } else {
          fileExt = 'jpg';
          mimeType = 'image/jpeg';
        }
      }
    }

    const prefix = isVideo ? 'sup_vid' : 'sup_img';
    const savedFileName = `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${fileExt}`;
    const filePath = path.join(uploadsDir, savedFileName);
    const buffer = Buffer.from(cleanBase64, 'base64');
    fs.writeFileSync(filePath, buffer);

    let finalUrl = `/uploads/suppliers/${savedFileName}`;

    if (isCloudinaryConfigured()) {
      try {
        const dataUri = `data:${mimeType};base64,${cleanBase64}`;
        const uploadRes = await uploadToCloudinary(dataUri, {
          folder: isVideo ? 'meat_suppliers/videos' : 'meat_suppliers/images',
          resource_type: isVideo ? 'video' : 'image',
        });
        if (uploadRes && uploadRes.secure_url) {
          finalUrl = uploadRes.secure_url;
        }
      } catch (cloudErr) {
        console.warn('[SUPPLIER_MEDIA] Lỗi upload Cloudinary, dùng file máy chủ cục bộ:', cloudErr.message);
      }
    }

    res.status(200).json({
      success: true,
      data: {
        url: finalUrl,
        fileType: isVideo ? 'VIDEO' : 'IMAGE',
        fileName: origFileName || savedFileName,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 12. Lấy bảng giá riêng của nhà cung cấp (lấy từ các giao dịch nhập hàng gần nhất)
const getSupplierPrices = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.effectiveUserId;

    const supplierExists = await prisma.supplier.findFirst({
      where: { id, userId, isActive: true },
    });
    if (!supplierExists) {
      throw new NotFoundError('Không tìm thấy nhà cung cấp.');
    }

    const products = await prisma.product.findMany({
      where: { userId, isActive: true },
      orderBy: { name: 'asc' },
    });

    const supTxs = await prisma.supplierTransaction.findMany({
      where: { supplierId: id },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      select: { items: true },
    });

    const supplierPriceMap = new Map();
    for (const stx of supTxs) {
      if (!stx.items) continue;
      try {
        const parsedItems = JSON.parse(stx.items);
        if (Array.isArray(parsedItems)) {
          for (const it of parsedItems) {
            const itPrice = it.price != null && !isNaN(Number(it.price)) && Number(it.price) > 0 ? Number(it.price) : null;
            if (itPrice !== null) {
              if (it.productId && !supplierPriceMap.has(it.productId)) {
                supplierPriceMap.set(it.productId, itPrice);
              }
              const nameKey = (it.productName || it.rawName || '').toLowerCase().trim();
              if (nameKey && !supplierPriceMap.has(nameKey)) {
                supplierPriceMap.set(nameKey, itPrice);
              }
            }
          }
        }
      } catch { }
    }

    const supplierProducts = products.map((p) => {
      const pNameKey = p.name.toLowerCase().trim();
      let supPrice = null;
      if (supplierPriceMap.has(p.id)) {
        supPrice = supplierPriceMap.get(p.id);
      } else if (supplierPriceMap.has(pNameKey)) {
        supPrice = supplierPriceMap.get(pNameKey);
      }

      const hasCustomPrice = supPrice !== null && supPrice > 0;
      const effectivePrice = hasCustomPrice ? supPrice : (p.costPrice > 0 ? Number(p.costPrice) : Number(p.defaultPrice));

      return {
        ...p,
        baseDefaultPrice: p.defaultPrice,
        hasCustomPrice,
        customPrice: supPrice,
        defaultPrice: effectivePrice,
        costPrice: effectivePrice,
      };
    });

    res.status(200).json({
      success: true,
      data: supplierProducts,
    });
  } catch (error) {
    next(error);
  }
};

// 14. Báo cáo quản lý lợi nhuận toàn diện (Đối soát tiền bán, tiền nhập lò, kết luận lãi lỗ)
const getProfitReport = async (req, res, next) => {

  try {
    const userId = req.effectiveUserId;
    const { month } = req.query; // 'YYYY-MM' hoặc 'ALL' hoặc rỗng

    let dateFilter = {};
    let paidAtFilter = {};
    let totalDaysInMonth = 0;
    let targetYear = null;
    let targetMonthNum = null;
    const isAllTime = !month || month === 'ALL';

    if (!isAllTime && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      targetYear = y;
      targetMonthNum = m;
      // Chuẩn hóa theo múi giờ Việt Nam (UTC+7)
      const start = new Date(Date.UTC(y, m - 1, 1, -7, 0, 0, 0));
      totalDaysInMonth = new Date(y, m, 0).getDate();
      const end = new Date(Date.UTC(y, m - 1, totalDaysInMonth, 16, 59, 59, 999));
      dateFilter = { date: { gte: start, lte: end } };
      paidAtFilter = { paidAt: { gte: start, lte: end } };
    }

    // Tải đồng thời tất cả dữ liệu bán hàng, thu tiền, nhập hàng, trả nợ và nhà cung cấp
    const [salesTxs, custPayments, supTxs, supPayments, suppliers, allTimeSales, allTimeSupTxs] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId, ...dateFilter },
        select: {
          id: true,
          date: true,
          totalAmount: true,
          totalCost: true,
          totalProfit: true,
          customerId: true,
        },
      }),
      prisma.payment.findMany({
        where: { customer: { userId }, ...paidAtFilter },
        select: {
          id: true,
          paidAt: true,
          amount: true,
          customerId: true,
        },
      }),
      prisma.supplierTransaction.findMany({
        where: { supplier: { userId, isActive: true }, ...dateFilter },
        include: {
          supplier: {
            select: { id: true, name: true, phone: true },
          },
        },
      }),
      prisma.supplierPayment.findMany({
        where: { supplier: { userId, isActive: true }, ...paidAtFilter },
        include: {
          supplier: {
            select: { id: true, name: true, phone: true },
          },
        },
      }),
      prisma.supplier.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, phone: true },
        orderBy: { name: 'asc' },
      }),
      // Lấy danh sách tháng có giao dịch bán hàng để tạo bộ lọc tháng
      prisma.transaction.findMany({
        where: { userId },
        select: { date: true },
        orderBy: { date: 'desc' },
      }),
      // Lấy danh sách tháng có giao dịch nhập hàng
      prisma.supplierTransaction.findMany({
        where: { supplier: { userId, isActive: true } },
        select: { date: true },
        orderBy: { date: 'desc' },
      }),
    ]);

    // 1. Tổng hợp danh sách các tháng có dữ liệu
    const monthSet = new Set();
    allTimeSales.forEach((t) => {
      if (t.date) {
        const d = new Date(t.date);
        if (!isNaN(d.getTime())) {
          const vnDate = new Date(d.getTime() + 7 * 3600 * 1000);
          const mKey = `${vnDate.getUTCFullYear()}-${String(vnDate.getUTCMonth() + 1).padStart(2, '0')}`;
          monthSet.add(mKey);
        }
      }
    });
    allTimeSupTxs.forEach((t) => {
      if (t.date) {
        const d = new Date(t.date);
        if (!isNaN(d.getTime())) {
          const vnDate = new Date(d.getTime() + 7 * 3600 * 1000);
          const mKey = `${vnDate.getUTCFullYear()}-${String(vnDate.getUTCMonth() + 1).padStart(2, '0')}`;
          monthSet.add(mKey);
        }
      }
    });
    const availableMonths = Array.from(monthSet).sort().reverse();

    // 2. Tính toán phía khách hàng
    const totalSales = salesTxs.reduce((sum, t) => sum + parseFloat(t.totalAmount || 0), 0);
    const salesCount = salesTxs.length;
    const totalCollected = custPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const collectedCount = custPayments.length;
    const customerDebtRemaining = Math.max(0, totalSales - totalCollected);

    // 3. Tính toán phía nhà cung cấp (Gồm cả nhà 666 và Không gồm nhà 666)
    let totalImportAll = 0;
    let totalPaidAll = 0;
    let totalImportNo666 = 0;
    let totalPaidNo666 = 0;

    const supplierMap = new Map();
    suppliers.forEach((s) => {
      supplierMap.set(s.id, {
        id: s.id,
        name: s.name,
        phone: s.phone,
        importAmount: 0,
        importCount: 0,
        paidAmount: 0,
        paymentCount: 0,
        remainingDebt: 0,
      });
    });

    supTxs.forEach((t) => {
      const amt = parseFloat(t.totalAmount || 0);
      totalImportAll += amt;
      const is666 = (t.supplier?.name || '').trim() === '666';
      if (!is666) {
        totalImportNo666 += amt;
      }
      const sup = supplierMap.get(t.supplierId);
      if (sup) {
        sup.importAmount += amt;
        sup.importCount += 1;
      }
    });

    supPayments.forEach((p) => {
      const amt = parseFloat(p.amount || 0);
      totalPaidAll += amt;
      const is666 = (p.supplier?.name || '').trim() === '666';
      if (!is666) {
        totalPaidNo666 += amt;
      }
      const sup = supplierMap.get(p.supplierId);
      if (sup) {
        sup.paidAmount += amt;
        sup.paymentCount += 1;
      }
    });

    const suppliersBreakdown = Array.from(supplierMap.values())
      .map((s) => {
        s.remainingDebt = s.importAmount - s.paidAmount;
        s.percentOfImport = totalImportAll > 0 ? Math.round((s.importAmount / totalImportAll) * 1000) / 10 : 0;
        return s;
      })
      .sort((a, b) => b.importAmount - a.importAmount);

    // 4. Kết luận Lãi / Lỗ
    const profitOrLossAll = totalSales - totalImportAll;
    const profitPercentAll = totalSales > 0 ? Math.round((profitOrLossAll / totalSales) * 1000) / 10 : 0;
    const statusAll = profitOrLossAll > 0 ? 'PROFIT' : (profitOrLossAll < 0 ? 'LOSS' : 'BREAK_EVEN');

    const profitOrLossNo666 = totalSales - totalImportNo666;
    const profitPercentNo666 = totalSales > 0 ? Math.round((profitOrLossNo666 / totalSales) * 1000) / 10 : 0;
    const statusNo666 = profitOrLossNo666 > 0 ? 'PROFIT' : (profitOrLossNo666 < 0 ? 'LOSS' : 'BREAK_EVEN');

    // 5. Chi tiết theo từng ngày (nếu lọc theo tháng cụ thể)
    let dailyBreakdown = [];
    if (!isAllTime && totalDaysInMonth > 0) {
      const daySalesMap = new Map();
      const dayImportAllMap = new Map();
      const dayImportNo666Map = new Map();
      const dayCollectedMap = new Map();
      const dayPaidMap = new Map();
      const daySuppliersMap = new Map();

      salesTxs.forEach((t) => {
        if (!t.date) return;
        const vnDate = new Date(new Date(t.date).getTime() + 7 * 3600 * 1000);
        const day = vnDate.getUTCDate();
        daySalesMap.set(day, (daySalesMap.get(day) || 0) + parseFloat(t.totalAmount || 0));
      });

      supTxs.forEach((t) => {
        if (!t.date) return;
        const vnDate = new Date(new Date(t.date).getTime() + 7 * 3600 * 1000);
        const day = vnDate.getUTCDate();
        const amt = parseFloat(t.totalAmount || 0);
        dayImportAllMap.set(day, (dayImportAllMap.get(day) || 0) + amt);
        if ((t.supplier?.name || '').trim() !== '666') {
          dayImportNo666Map.set(day, (dayImportNo666Map.get(day) || 0) + amt);
        }

        // Gom nhóm theo từng nhà cung cấp trong ngày
        if (!daySuppliersMap.has(day)) {
          daySuppliersMap.set(day, new Map());
        }
        const daySupMap = daySuppliersMap.get(day);
        const sId = t.supplierId || 'unknown';
        const sName = (t.supplier?.name || 'Khác').trim();
        if (!daySupMap.has(sId)) {
          daySupMap.set(sId, {
            supplierId: sId,
            supplierName: sName,
            amount: 0,
          });
        }
        daySupMap.get(sId).amount += amt;
      });

      custPayments.forEach((p) => {
        if (!p.paidAt) return;
        const vnDate = new Date(new Date(p.paidAt).getTime() + 7 * 3600 * 1000);
        const day = vnDate.getUTCDate();
        dayCollectedMap.set(day, (dayCollectedMap.get(day) || 0) + parseFloat(p.amount || 0));
      });

      supPayments.forEach((p) => {
        if (!p.paidAt) return;
        const vnDate = new Date(new Date(p.paidAt).getTime() + 7 * 3600 * 1000);
        const day = vnDate.getUTCDate();
        dayPaidMap.set(day, (dayPaidMap.get(day) || 0) + parseFloat(p.amount || 0));
      });

      for (let day = 1; day <= totalDaysInMonth; day++) {
        const sales = daySalesMap.get(day) || 0;
        const importAll = dayImportAllMap.get(day) || 0;
        const importNo666 = dayImportNo666Map.get(day) || 0;
        const collected = dayCollectedMap.get(day) || 0;
        const paid = dayPaidMap.get(day) || 0;

        const daySupMap = daySuppliersMap.get(day);
        const suppliers = daySupMap
          ? Array.from(daySupMap.values())
              .filter((s) => s.amount > 0)
              .sort((a, b) => b.amount - a.amount)
          : [];

        const hasData = sales > 0 || importAll > 0 || collected > 0 || paid > 0;
        if (hasData) {
          dailyBreakdown.push({
            day,
            dateDisplay: `${String(day).padStart(2, '0')}/${String(targetMonthNum).padStart(2, '0')}`,
            sales,
            importAll,
            importNo666,
            diffAll: sales - importAll,
            diffNo666: sales - importNo666,
            isProfitAll: sales >= importAll,
            isProfitNo666: sales >= importNo666,
            collected,
            paid,
            suppliers,
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      data: {
        filter: {
          month: isAllTime ? 'ALL' : month,
          isAllTime,
          availableMonths,
        },
        sales: {
          totalAmount: totalSales,
          count: salesCount,
          totalCollected,
          collectedCount,
          customerDebtRemaining,
        },
        withAllSuppliers: {
          totalImport: totalImportAll,
          importCount: supTxs.length,
          totalPaid: totalPaidAll,
          paidCount: supPayments.length,
          supplierDebtRemaining: Math.max(0, totalImportAll - totalPaidAll),
          profitOrLoss: profitOrLossAll,
          profitPercent: profitPercentAll,
          status: statusAll,
          cashFlowDiff: totalCollected - totalPaidAll,
        },
        excluding666: {
          totalImport: totalImportNo666,
          importCount: supTxs.filter((t) => (t.supplier?.name || '').trim() !== '666').length,
          totalPaid: totalPaidNo666,
          paidCount: supPayments.filter((p) => (p.supplier?.name || '').trim() !== '666').length,
          supplierDebtRemaining: Math.max(0, totalImportNo666 - totalPaidNo666),
          profitOrLoss: profitOrLossNo666,
          profitPercent: profitPercentNo666,
          status: statusNo666,
          cashFlowDiff: totalCollected - totalPaidNo666,
        },
        suppliersBreakdown,
        dailyBreakdown,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  createSupplierTransaction,
  updateSupplierTransaction,
  deleteSupplierTransaction,
  createSupplierPayment,
  updateSupplierPayment,
  deleteSupplierPayment,
  getSupplierHistory,
  uploadSupplierMedia,
  getSupplierPrices,
  getProfitReport,
};

