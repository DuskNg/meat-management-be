// meat-management-be/src/controllers/staffSubmission.js
const crypto = require('crypto');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { emitWorkspaceEvent } = require('../utils/socket');
const { parseStaffSubmission } = require('../services/aiInvoiceParser');

// Helper sinh chuỗi token ngẫu nhiên
const generateToken = () => {
  return crypto.randomBytes(12).toString('base64url');
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. CÁC API PUBLIC DÀNH CHO NHÂN VIÊN GỬI QUA LINK ZALO (KHÔNG CẦN LOGIN APP)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Lấy thông tin cơ bản của link gửi hóa đơn nhân viên
 */
const getPublicLinkInfo = async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token) throw new BadRequestError('Thiếu mã token truy cập.');

    const link = await prisma.staffSubmissionLink.findUnique({
      where: { token },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn gửi hóa đơn không tồn tại hoặc đã bị khóa.');
    }

    res.json({
      success: true,
      data: {
        id: link.id,
        name: link.name,
        ownerName: link.user?.name,
        hasPin: Boolean(link.pin),
        note: link.note,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Xác thực mã PIN của link gửi hóa đơn
 */
const verifyLinkPin = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { pin } = req.body;

    const link = await prisma.staffSubmissionLink.findUnique({
      where: { token },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn gửi hóa đơn không tồn tại hoặc đã bị khóa.');
    }

    if (!link.pin) {
      return res.json({ success: true, message: 'Đường dẫn không yêu cầu mã PIN.' });
    }

    if (link.pin !== String(pin).trim()) {
      throw new BadRequestError('Mã PIN không chính xác.');
    }

    res.json({ success: true, message: 'Xác thực mã PIN thành công.' });
  } catch (error) {
    next(error);
  }
};

/**
 * Nhân viên gửi hàng loạt ảnh hóa đơn / video qua link Zalo
 */
const submitBatchFromStaff = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { files, senderName, note, date } = req.body;

    if (!token) throw new BadRequestError('Thiếu mã token truy cập.');
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new BadRequestError('Vui lòng chọn ít nhất một hình ảnh hoặc video.');
    }

    const link = await prisma.staffSubmissionLink.findUnique({
      where: { token },
      include: { user: true },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn gửi hóa đơn không tồn tại hoặc đã bị khóa.');
    }

    const userId = link.userId;
    const submissionDate = date ? new Date(date) : new Date();

    // Tải song song tất cả các tệp lên Cloudinary và lưu vào database
    const uploadTasks = files.map(async (fileItem) => {
      const fileData = fileItem.fileData || fileItem.uri || fileItem.url;
      const isVideo = fileItem.fileType === 'VIDEO' || (fileItem.type && fileItem.type.startsWith('video'));
      const fileType = isVideo ? 'VIDEO' : 'IMAGE';

      if (!fileData) return null;

      let uploadedUrl = fileData;
      // Nếu là base64 hoặc blob, tải lên Cloudinary
      if (fileData.startsWith('data:') || fileData.startsWith('blob:')) {
        try {
          const uploadRes = await uploadToCloudinary(fileData, {
            folder: `meat_manager/${userId}/staff_submissions`,
            resource_type: isVideo ? 'video' : 'image',
          });
          if (uploadRes && (uploadRes.secure_url || uploadRes.url)) {
            uploadedUrl = uploadRes.secure_url || uploadRes.url;
          }
        } catch (uploadErr) {
          console.error('[CLOUDINARY_UPLOAD_ERR] Lỗi tải tệp lên Cloudinary:', uploadErr);
        }
      }

      const submission = await prisma.staffSubmission.create({
        data: {
          userId,
          linkId: link.id,
          senderName: senderName || fileItem.senderName || null,
          note: note || fileItem.note || null,
          fileUrl: uploadedUrl,
          fileType,
          date: submissionDate,
          status: 'PENDING',
        },
      });

      // Kích hoạt chạy ngầm AI phân tích hóa đơn ngay lập tức (không bắt client đợi)
      setImmediate(() => {
        parseStaffSubmission(submission.id).catch((err) => {
          console.error(`[BACKGROUND_AI_ERROR] Lỗi phân tích submission ${submission.id}:`, err);
        });
      });

      return submission;
    });

    const results = await Promise.all(uploadTasks);
    const createdSubmissions = results.filter(Boolean);

    // Phát socket thông báo cho chủ buôn có hóa đơn mới gửi về
    emitWorkspaceEvent(userId, 'NEW_STAFF_SUBMISSIONS', {
      count: createdSubmissions.length,
      senderName,
      date: submissionDate,
    });

    // Trả về kết quả thành công NGAY LẬP TỨC để nhân viên yên tâm
    res.json({
      success: true,
      message: `Đã lưu trữ thành công ${createdSubmissions.length} tệp hóa đơn/video. Hệ thống AI đang tự động phân tích ngầm.`,
      data: createdSubmissions,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Lấy lịch sử các tệp nhân viên đã nộp trong ngày qua link
 */
const getPublicSubmissionHistory = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { date } = req.query;

    const link = await prisma.staffSubmissionLink.findUnique({
      where: { token },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn gửi hóa đơn không tồn tại hoặc đã bị khóa.');
    }

    // Mặc định lấy các lượt gửi trong ngày hôm nay
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

    const submissions = await prisma.staffSubmission.findMany({
      where: {
        linkId: link.id,
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      select: {
        id: true,
        senderName: true,
        fileUrl: true,
        fileType: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: submissions,
    });
  } catch (error) {
    next(error);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// 2. CÁC API DÀNH CHO CHỦ BUÔN (ĐỐI SOÁT & PHÊ DUYỆT TRÊN APP)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Lấy danh sách hóa đơn nhân viên nộp chờ chủ buôn duyệt
 */
const getStaffSubmissions = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { status, date, fromDate, toDate } = req.query;

    const where = { userId };

    if (status && status !== 'ALL') {
      where.status = status;
    }

    if (date) {
      const d = new Date(date);
      where.date = {
        gte: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0),
        lte: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999),
      };
    } else if (fromDate && toDate) {
      where.date = {
        gte: new Date(fromDate),
        lte: new Date(toDate),
      };
    }

    const submissions = await prisma.staffSubmission.findMany({
      where,
      include: {
        link: { select: { id: true, name: true } },
        matchedCustomer: { select: { id: true, name: true, phone: true } },
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });

    res.json({
      success: true,
      data: submissions,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Lấy chi tiết 1 lượt gửi hóa đơn
 */
const getStaffSubmissionDetail = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { id } = req.params;

    const submission = await prisma.staffSubmission.findFirst({
      where: { id, userId },
      include: {
        link: true,
        matchedCustomer: true,
        items: true,
      },
    });

    if (!submission) {
      throw new NotFoundError('Không tìm thấy bản ghi hóa đơn.');
    }

    res.json({
      success: true,
      data: submission,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Chủ buôn cập nhật / chỉnh sửa lại các thông tin AI phân tích sai trước khi duyệt
 */
const updateStaffSubmission = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { id } = req.params;
    const { matchedCustomerId, detectedCustomerName, date, note, items } = req.body;

    const submission = await prisma.staffSubmission.findFirst({
      where: { id, userId },
    });

    if (!submission) {
      throw new NotFoundError('Không tìm thấy bản ghi hóa đơn.');
    }

    // Cập nhật thông tin chung
    const updateData = {};
    if (matchedCustomerId !== undefined) updateData.matchedCustomerId = matchedCustomerId;
    if (detectedCustomerName !== undefined) updateData.detectedCustomerName = detectedCustomerName;
    if (date) updateData.date = new Date(date);
    if (note !== undefined) updateData.note = note;

    await prisma.staffSubmission.update({
      where: { id },
      data: updateData,
    });

    // Cập nhật lại danh sách món thịt nếu có truyền vào
    if (items && Array.isArray(items)) {
      await prisma.staffSubmissionItem.deleteMany({
        where: { submissionId: id },
      });

      const itemsToCreate = items.map((it) => {
        const qty = it.quantity != null ? parseFloat(it.quantity) : null;
        const price = it.price != null ? parseFloat(it.price) : null;
        const amount = it.amount != null ? parseFloat(it.amount) : (qty && price ? Math.round(qty * price) : null);

        return {
          submissionId: id,
          rawName: it.rawName || it.name || 'Thịt lẻ',
          matchedProductId: it.matchedProductId || null,
          quantity: qty,
          price,
          amount,
        };
      });

      if (itemsToCreate.length > 0) {
        await prisma.staffSubmissionItem.createMany({
          data: itemsToCreate,
        });
      }
    }

    const updated = await prisma.staffSubmission.findUnique({
      where: { id },
      include: {
        items: true,
        matchedCustomer: true,
      },
    });

    res.json({
      success: true,
      message: 'Cập nhật thông tin hóa đơn thành công.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Chủ buôn phê duyệt hóa đơn: Tạo đơn nợ Transaction + TransactionInvoice
 */
const approveStaffSubmission = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const currentUserId = req.user.id;
    const { id } = req.params;
    const { customerId, date, note, items } = req.body;

    const submission = await prisma.staffSubmission.findFirst({
      where: { id, userId },
      include: { items: true },
    });

    if (!submission) {
      throw new NotFoundError('Không tìm thấy bản ghi hóa đơn.');
    }

    const finalCustomerId = customerId || submission.matchedCustomerId;
    if (!finalCustomerId) {
      throw new BadRequestError('Vui lòng chọn khách hàng để lên đơn nợ.');
    }

    // Danh sách mặt hàng áp dụng
    const finalItems = items && Array.isArray(items) && items.length > 0 ? items : submission.items;
    if (!finalItems || finalItems.length === 0) {
      throw new BadRequestError('Hóa đơn không có mặt hàng thịt nào.');
    }

    const finalDate = date ? new Date(date) : submission.date;
    const finalNote = note !== undefined ? note : (submission.note || 'Lên đơn từ hóa đơn Zalo nhân viên');

    // Tính tổng tiền đơn hàng
    let totalAmount = 0;
    const transactionItemsData = [];

    for (const it of finalItems) {
      const qty = parseFloat(it.quantity) || 0;
      const price = parseFloat(it.price) || 0;
      const amount = parseFloat(it.amount) || Math.round(qty * price);
      totalAmount += amount;

      let productId = it.matchedProductId;
      // Nếu chưa khớp productId, tìm hoặc dùng sản phẩm mặc định
      if (!productId) {
        const prod = await prisma.product.findFirst({
          where: { userId, isActive: true },
        });
        if (prod) productId = prod.id;
      }

      if (productId) {
        transactionItemsData.push({
          productId,
          quantity: qty,
          price,
          amount,
        });
      }
    }

    // Thực hiện transaction: Tạo đơn nợ + Tạo TransactionInvoice + Cập nhật submission
    const result = await prisma.$transaction(async (tx) => {
      // 1. Tạo đơn nợ Transaction
      const trans = await tx.transaction({
        data: {
          userId,
          customerId: finalCustomerId,
          createdBy: currentUserId,
          date: finalDate,
          note: finalNote,
          totalAmount,
          items: {
            create: transactionItemsData,
          },
        },
      });

      // 2. Tạo ảnh hóa đơn TransactionInvoice đính kèm
      if (submission.fileUrl) {
        await tx.transactionInvoice.create({
          data: {
            userId,
            customerId: finalCustomerId,
            transactionId: trans.id,
            date: finalDate,
            imageUrl: submission.fileUrl,
            note: submission.senderName ? `Nhân viên gửi: ${submission.senderName}` : 'Hóa đơn nhân viên',
          },
        });
      }

      // 3. Đánh dấu đã duyệt StaffSubmission
      const updatedSub = await tx.staffSubmission.update({
        where: { id },
        data: {
          status: 'APPROVED',
          matchedCustomerId: finalCustomerId,
          transactionId: trans.id,
          approvedAt: new Date(),
        },
      });

      return { transaction: trans, submission: updatedSub };
    });

    emitWorkspaceEvent(userId, 'TRANSACTION_CREATED', result.transaction);
    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_APPROVED', { id });

    res.json({
      success: true,
      message: 'Đã phê duyệt và lên đơn nợ thành công!',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Bác bỏ / Xóa hóa đơn nộp không hợp lệ
 */
const rejectStaffSubmission = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { id } = req.params;

    const submission = await prisma.staffSubmission.findFirst({
      where: { id, userId },
    });

    if (!submission) {
      throw new NotFoundError('Không tìm thấy bản ghi hóa đơn.');
    }

    await prisma.staffSubmission.update({
      where: { id },
      data: { status: 'REJECTED' },
    });

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_REJECTED', { id });

    res.json({
      success: true,
      message: 'Đã bác bỏ hóa đơn này.',
    });
  } catch (error) {
    next(error);
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// 3. QUẢN LÝ LINK ZALO NHÂN VIÊN
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Lấy danh sách các link Zalo nhân viên của chủ buôn
 */
const getSubmissionLinks = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;

    let links = await prisma.staffSubmissionLink.findMany({
      where: { userId },
      include: {
        _count: {
          select: { submissions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Nếu chưa có link nào, tự động sinh 1 link mặc định ban đầu cho chủ buôn
    if (links.length === 0) {
      const defaultLink = await prisma.staffSubmissionLink.create({
        data: {
          userId,
          name: 'Link Zalo Nhân viên gửi hóa đơn',
          token: generateToken(),
          isActive: true,
        },
        include: {
          _count: {
            select: { submissions: true },
          },
        },
      });
      links = [defaultLink];
    }

    res.json({
      success: true,
      data: links,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Tạo link Zalo nhân viên mới
 */
const createSubmissionLink = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { name, pin, note } = req.body;

    const link = await prisma.staffSubmissionLink.create({
      data: {
        userId,
        name: name || 'Link Zalo gửi hóa đơn',
        token: generateToken(),
        pin: pin ? String(pin).trim() : null,
        note: note || null,
        isActive: true,
      },
    });

    res.json({
      success: true,
      message: 'Tạo link nhân viên mới thành công.',
      data: link,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Cập nhật link Zalo nhân viên
 */
const updateSubmissionLink = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { id } = req.params;
    const { name, pin, note, isActive } = req.body;

    const link = await prisma.staffSubmissionLink.findFirst({
      where: { id, userId },
    });

    if (!link) throw new NotFoundError('Không tìm thấy link.');

    const updated = await prisma.staffSubmissionLink.update({
      where: { id },
      data: {
        name: name !== undefined ? name : link.name,
        pin: pin !== undefined ? (pin ? String(pin).trim() : null) : link.pin,
        note: note !== undefined ? note : link.note,
        isActive: isActive !== undefined ? isActive : link.isActive,
      },
    });

    res.json({
      success: true,
      message: 'Cập nhật link thành công.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Sinh lại mã token mới cho link Zalo nhân viên (thu hồi link cũ)
 */
const regenerateSubmissionToken = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { id } = req.params;

    const link = await prisma.staffSubmissionLink.findFirst({
      where: { id, userId },
    });

    if (!link) throw new NotFoundError('Không tìm thấy link.');

    const updated = await prisma.staffSubmissionLink.update({
      where: { id },
      data: { token: generateToken() },
    });

    res.json({
      success: true,
      message: 'Đã thu hồi link cũ và sinh link mới.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Xóa link Zalo nhân viên
 */
const deleteSubmissionLink = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { id } = req.params;

    const link = await prisma.staffSubmissionLink.findFirst({
      where: { id, userId },
    });

    if (!link) throw new NotFoundError('Không tìm thấy link.');

    await prisma.staffSubmissionLink.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: 'Đã xóa link thành công.',
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getPublicLinkInfo,
  verifyLinkPin,
  submitBatchFromStaff,
  getPublicSubmissionHistory,
  getStaffSubmissions,
  getStaffSubmissionDetail,
  updateStaffSubmission,
  approveStaffSubmission,
  rejectStaffSubmission,
  getSubmissionLinks,
  createSubmissionLink,
  updateSubmissionLink,
  regenerateSubmissionToken,
  deleteSubmissionLink,
};
