// meat-management-be/src/controllers/staffSubmission.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { uploadToCloudinary } = require('../utils/cloudinary');
const { emitWorkspaceEvent } = require('../utils/socket');
const { parseStaffSubmission } = require('../services/aiInvoiceParser');
const { logActivity } = require('../utils/activityLogger');

// Đảm bảo thư mục lưu trữ ảnh/video nhân viên nộp luôn sẵn sàng
const uploadsStaffDir = path.join(__dirname, '../../uploads/staff_submissions');
if (!fs.existsSync(uploadsStaffDir)) {
  fs.mkdirSync(uploadsStaffDir, { recursive: true });
}

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
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
          },
        },
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
        hasPin: !!link.pin,
        ownerName: link.user?.name || 'Chủ buôn',
        token: link.token,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Xác thực mã PIN để mở link gửi hóa đơn
 */
const verifyLinkPin = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { pin } = req.body;

    if (!token) throw new BadRequestError('Thiếu mã token truy cập.');
    if (!pin) throw new BadRequestError('Vui lòng nhập mã PIN bảo mật.');

    const link = await prisma.staffSubmissionLink.findUnique({
      where: { token },
    });

    if (!link || !link.isActive) {
      throw new NotFoundError('Đường dẫn gửi hóa đơn không tồn tại hoặc đã bị khóa.');
    }

    if (!link.pin) {
      return res.json({ success: true, message: 'Đường dẫn không yêu cầu mã PIN.' });
    }

    if (link.pin !== pin.trim()) {
      throw new ForbiddenError('Mã PIN không chính xác. Vui lòng kiểm tra lại với chủ buôn.');
    }

    res.json({
      success: true,
      message: 'Xác thực mã PIN thành công.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Nhân viên gửi hàng loạt ảnh hóa đơn / video (Tối ưu siêu tốc: lưu trữ cục bộ tức thì -> phản hồi nhân viên ngay -> upload Cloudinary & AI chạy ngầm)
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
    // Luôn mặc định ngày hiện tại khi tải ảnh lên để danh sách hiển thị chung ở giao diện ngày hiện tại
    const submissionDate = new Date();

    // Danh sách các tác vụ chạy ngầm sau khi đã trả response cho client
    const bgTasks = [];

    // Xử lý song song tất cả các tệp cùng lúc (dùng indexOf/substring thay Regex tránh ReDoS)
    const saveTasks = files.map(async (fileItem) => {
      const fileData = fileItem.fileData || fileItem.uri || fileItem.url;
      const isVideo = fileItem.fileType === 'VIDEO' || (fileItem.type && fileItem.type.startsWith('video'));
      const fileType = isVideo ? 'VIDEO' : 'IMAGE';

      if (!fileData) return null;

      let localUrl = fileData;
      let rawBase64ToUpload = null;
      let savedFilePath = null;

      // Xử lý Base64 siêu tốc bằng indexOf & substring (0ms, tuyệt đối không dùng Regex tránh ReDoS)
      if (typeof fileData === 'string' && fileData.startsWith('data:')) {
        const commaIdx = fileData.indexOf(',');
        if (commaIdx !== -1) {
          const header = fileData.substring(0, commaIdx);
          const cleanBase64 = fileData.substring(commaIdx + 1);
          const isPng = header.includes('png');
          const ext = isVideo ? 'mp4' : (isPng ? 'png' : 'jpg');
          const fileName = `sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
          const filePath = path.join(uploadsStaffDir, fileName);

          try {
            // Ghi file bất đồng bộ qua libuv thread pool (không chặn Event Loop của Node.js)
            await fs.promises.writeFile(filePath, Buffer.from(cleanBase64, 'base64'));
            localUrl = `/uploads/staff_submissions/${fileName}`;
            savedFilePath = filePath;
            // Với video, giải phóng base64 ngay khỏi RAM để tránh tràn bộ nhớ (OOM) trên máy chủ
            rawBase64ToUpload = isVideo ? null : fileData;
          } catch (saveErr) {
            console.error('[LOCAL_SAVE_ERR] Lỗi lưu tệp cục bộ:', saveErr);
          }
        }
      }

      const submission = await prisma.staffSubmission.create({
        data: {
          userId,
          linkId: link.id,
          senderName: senderName || fileItem.senderName || null,
          note: note || fileItem.note || null,
          fileUrl: localUrl,
          fileType,
          date: submissionDate,
          status: 'PENDING',
        },
      });

      bgTasks.push({
        submissionId: submission.id,
        filePath: savedFilePath,
        rawBase64: rawBase64ToUpload,
        isVideo,
        localUrl,
      });

      return submission;
    });

    const results = await Promise.all(saveTasks);
    const createdSubmissions = results.filter(Boolean);

    // Phát socket thông báo cho chủ buôn có hóa đơn mới gửi về ngay lập tức
    emitWorkspaceEvent(userId, 'NEW_STAFF_SUBMISSIONS', {
      count: createdSubmissions.length,
      senderName,
      date: submissionDate,
    });

    // Trả về kết quả thành công NGAY LẬP TỨC để nhân viên yên tâm (chỉ mất ~100-200ms!)
    res.json({
      success: true,
      message: `Đã lưu trữ thành công ${createdSubmissions.length} tệp hóa đơn/video. Hệ thống AI đang tự động phân tích ngầm.`,
      data: createdSubmissions,
    });

    // Kích hoạt tác vụ nền (Cloudinary & AI) SAU KHI ĐÃ TRẢ RESPONSE CHO CLIENT
    res.on('finish', () => {
      setImmediate(async () => {
        for (const item of bgTasks) {
          try {
            const uploadSource = (item.filePath && fs.existsSync(item.filePath)) ? item.filePath : item.rawBase64;
            if (uploadSource) {
              try {
                const uploadRes = await uploadToCloudinary(uploadSource, {
                  filePath: item.filePath,
                  folder: `meat_manager/${userId}/staff_submissions`,
                  resource_type: item.isVideo ? 'video' : 'image',
                });
                if (uploadRes && (uploadRes.secure_url || uploadRes.url)) {
                  const cloudUrl = uploadRes.secure_url || uploadRes.url;
                  await prisma.staffSubmission.update({
                    where: { id: item.submissionId },
                    data: { fileUrl: cloudUrl },
                  });
                  // Đồng bộ đường dẫn Cloudinary mới cho TransactionInvoice nếu đơn nợ đã được tạo bằng localUrl trước đó
                  if (item.localUrl) {
                    await prisma.transactionInvoice.updateMany({
                      where: { imageUrl: item.localUrl },
                      data: { imageUrl: cloudUrl },
                    });
                  }
                }
              } catch (cloudErr) {
                console.warn('[BACKGROUND_CLOUDINARY] Upload Cloudinary chạy ngầm lỗi, giữ link máy chủ cục bộ:', cloudErr.message);
              }
            }

            // Gọi AI phân tích hóa đơn ngầm
            parseStaffSubmission(item.submissionId).catch((err) => {
              console.error(`[BACKGROUND_AI_ERROR] Lỗi phân tích submission ${item.submissionId}:`, err);
            });
          } catch (itemErr) {
            console.error('[BACKGROUND_ITEM_ERR]', itemErr);
          }
        }
      });
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
    } else {
      where.status = { not: 'REJECTED' };
    }

    if (date) {
      const d = new Date(date);
      const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

      const now = new Date();
      const isViewingToday = (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate()
      );

      // Nếu đang xem giao diện ngày hiện tại: Hiển thị chung tất cả hóa đơn ngày hôm nay,
      // ĐỒNG THỜI tự động gom tất cả hóa đơn chưa duyệt (kể cả trước đó mang ngày khác) vào chung 1 giao diện
      if (isViewingToday && status !== 'APPROVED') {
        where.OR = [
          { date: { gte: startOfDay, lte: endOfDay } },
          { status: { not: 'APPROVED' } },
        ];
      } else {
        where.date = {
          gte: startOfDay,
          lte: endOfDay,
        };
      }
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
        items: {
          orderBy: { createdAt: 'asc' },
        },
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

      const itemsToCreate = items.map((it, idx) => {
        const qty = it.quantity != null ? parseFloat(it.quantity) : null;
        const price = it.price != null ? parseFloat(it.price) : null;
        const amount = it.amount != null ? parseFloat(it.amount) : (qty && price ? Math.round(qty * price) : null);

        const baseItemTime = Date.now();
        return {
          submissionId: id,
          rawName: it.rawName || it.name || 'Thịt lẻ',
          matchedProductId: it.matchedProductId || null,
          quantity: qty,
          price,
          amount,
          createdAt: new Date(baseItemTime + idx * 50),
          updatedAt: new Date(baseItemTime + idx * 50),
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
        items: {
          orderBy: { createdAt: 'asc' },
        },
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
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
        },
      },
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
    let totalCost = 0;
    let totalProfit = 0;
    const transactionItemsData = [];

    for (const it of finalItems) {
      const qty = parseFloat(it.quantity) || 0;
      const price = parseFloat(it.price) || 0;
      const amount = parseFloat(it.amount) || Math.round(qty * price);
      totalAmount += amount;

      let productId = it.matchedProductId;
      let product = null;
      if (productId) {
        product = await prisma.product.findUnique({ where: { id: productId } });
      }
      if (!product && it.rawName) {
        product = await prisma.product.findFirst({
          where: { userId, isActive: true, name: { equals: it.rawName, mode: 'insensitive' } },
        }) || await prisma.product.findFirst({
          where: { userId, isActive: true, name: { contains: it.rawName, mode: 'insensitive' } },
        });
      }
      if (!product) {
        product = await prisma.product.findFirst({
          where: { userId, isActive: true },
        });
      }
      if (product) {
        productId = product.id;
      }

      if (productId) {
        const costPrice = product ? (parseFloat(product.costPrice) || 0) : 0;
        const itemCost = Math.round(qty * costPrice);
        const profit = amount - itemCost;
        totalCost += itemCost;
        totalProfit += profit;

        transactionItemsData.push({
          productId,
          quantity: qty > 0 ? qty : 1,
          price,
          costPrice,
          amount,
          profit,
        });
      }
    }

    // Kiểm tra đơn có phải là đơn trả hàng hay không
    const isReturnOrder = Boolean(
      req.body.isReturn ||
      (finalNote && (finalNote.includes('[Trả lại hàng]') || finalNote.includes('[Trả hàng]') || /(trả hàng|gửi về|trả về|trả lại)/i.test(finalNote)))
    );

    // Thực hiện transaction: Nếu đơn trả hàng -> Tạo/Cập nhật Payment trừ nợ; Nếu đơn bán -> Tạo/Cập nhật Transaction tăng nợ
    const result = await prisma.$transaction(async (tx) => {
      let payment = null;
      let trans = null;
      let newTxId = null;

      if (isReturnOrder) {
        // Chuẩn bị ghi chú chi tiết danh sách thịt trả lại
        const itemsDesc = finalItems
          .map((it) => {
            const q = it.quantity != null && it.quantity !== '' ? `${it.quantity}kg` : '';
            const n = it.rawName || 'Thịt';
            const a = it.amount != null && it.amount !== '' ? `(${new Intl.NumberFormat('vi-VN').format(Math.round(it.amount))}đ)` : '';
            return `${q} ${n} ${a}`.trim();
          })
          .filter(Boolean)
          .join(', ');

        let returnNote = finalNote || '';
        if (!returnNote.includes('[Trả lại hàng]') && !returnNote.includes('[Trả hàng]')) {
          returnNote = `[Trả lại hàng] ${itemsDesc}${returnNote ? ` - ${returnNote}` : ''}`.trim();
        }

        // 1. Kiểm tra xem submission này trước đó đã có Transaction hay Payment chưa để cập nhật hoặc tạo mới
        if (submission.transactionId) {
          const existingTrans = await tx.transaction.findUnique({ where: { id: submission.transactionId } });
          if (existingTrans) {
            // Trước đó là đơn bán nợ, nay đổi sang đơn trả hàng: Xóa Transaction cũ
            await tx.transactionItem.deleteMany({ where: { transactionId: submission.transactionId } });
            await tx.transactionInvoice.updateMany({
              where: { transactionId: submission.transactionId },
              data: { transactionId: null },
            });
            await tx.transaction.delete({ where: { id: submission.transactionId } });
          } else {
            const existingPayment = await tx.payment.findUnique({ where: { id: submission.transactionId } });
            if (existingPayment) {
              // Cập nhật bản ghi Payment đã có
              payment = await tx.payment.update({
                where: { id: submission.transactionId },
                data: {
                  customerId: finalCustomerId,
                  createdBy: currentUserId,
                  amount: totalAmount,
                  paidAt: finalDate,
                  note: returnNote,
                  type: 'customer',
                },
              });
              newTxId = payment.id;
            }
          }
        }

        // Nếu chưa có Payment thì kiểm tra payment cũ để tránh trùng lặp số tiền trả hàng
        if (!payment) {
          let oldPayment = null;
          if (submission.transactionId) {
            oldPayment = await tx.payment.findUnique({ where: { id: submission.transactionId } });
          }

          if (!oldPayment) {
            // Kiểm tra xem trong cùng ngày đã có lượt trả hàng nào cùng khách hàng và cùng số tiền chưa
            const finalD = new Date(finalDate);
            const startDay = new Date(finalD);
            startDay.setHours(0, 0, 0, 0);
            const endDay = new Date(finalD);
            endDay.setHours(23, 59, 59, 999);

            oldPayment = await tx.payment.findFirst({
              where: {
                customerId: finalCustomerId,
                type: 'customer',
                amount: totalAmount,
                paidAt: { gte: startDay, lte: endDay },
                note: { contains: 'Trả' },
              },
              orderBy: { createdAt: 'desc' },
            });
          }

          if (oldPayment) {
            payment = await tx.payment.update({
              where: { id: oldPayment.id },
              data: {
                customerId: finalCustomerId,
                createdBy: currentUserId,
                amount: totalAmount,
                paidAt: finalDate,
                note: returnNote,
                type: 'customer',
              },
            });
            newTxId = payment.id;
          } else {
            payment = await tx.payment.create({
              data: {
                customerId: finalCustomerId,
                createdBy: currentUserId,
                amount: totalAmount,
                paidAt: finalDate,
                note: returnNote,
                type: 'customer',
              },
            });
            newTxId = payment.id;
          }
        }

        // 2. Tạo/Cập nhật ảnh hóa đơn đính kèm nếu có
        if (submission.fileUrl) {
          const existingInv = await tx.transactionInvoice.findFirst({
            where: { userId, imageUrl: submission.fileUrl },
          });
          if (existingInv) {
            await tx.transactionInvoice.update({
              where: { id: existingInv.id },
              data: {
                customerId: finalCustomerId,
                transactionId: null,
                date: finalDate,
                note: submission.senderName ? `Trả hàng - NV: ${submission.senderName}` : 'Đơn trả hàng nhân viên gửi',
              },
            });
          } else {
            await tx.transactionInvoice.create({
              data: {
                userId,
                customerId: finalCustomerId,
                transactionId: null,
                date: finalDate,
                imageUrl: submission.fileUrl,
                note: submission.senderName ? `Trả hàng - NV: ${submission.senderName}` : 'Đơn trả hàng nhân viên gửi',
              },
            });
          }
        }
      } else {
        // Đơn bán hàng bình thường: Tạo / Cập nhật đơn nợ Transaction
        if (submission.transactionId) {
          const existingPayment = await tx.payment.findUnique({ where: { id: submission.transactionId } });
          if (existingPayment) {
            // Trước đó là đơn trả hàng, nay đổi sang đơn bán: Xóa Payment cũ
            await tx.payment.delete({ where: { id: submission.transactionId } });
          } else {
            const existingTrans = await tx.transaction.findUnique({ where: { id: submission.transactionId } });
            if (existingTrans) {
              // Cập nhật Transaction cũ
              await tx.transactionItem.deleteMany({ where: { transactionId: submission.transactionId } });
              trans = await tx.transaction.update({
                where: { id: submission.transactionId },
                data: {
                  customerId: finalCustomerId,
                  createdBy: currentUserId,
                  date: finalDate,
                  note: finalNote,
                  totalAmount,
                  totalCost,
                  totalProfit,
                  items: {
                    create: transactionItemsData,
                  },
                },
              });
              newTxId = trans.id;
            }
          }
        }

        // Nếu chưa có Transaction thì tạo mới
        if (!trans) {
          trans = await tx.transaction.create({
            data: {
              userId,
              customerId: finalCustomerId,
              createdBy: currentUserId,
              date: finalDate,
              note: finalNote,
              totalAmount,
              totalCost,
              totalProfit,
              items: {
                create: transactionItemsData,
              },
            },
          });
          newTxId = trans.id;
        }

        // Tạo/Cập nhật ảnh/video hóa đơn TransactionInvoice đính kèm trực tiếp vào đơn nợ này
        if (submission.fileUrl) {
          const existingInv = await tx.transactionInvoice.findFirst({
            where: {
              userId,
              OR: [
                { imageUrl: submission.fileUrl },
                { transactionId: trans.id },
              ],
            },
          });
          if (existingInv) {
            await tx.transactionInvoice.update({
              where: { id: existingInv.id },
              data: {
                customerId: finalCustomerId,
                transactionId: trans.id,
                imageUrl: submission.fileUrl,
                date: finalDate,
                note: submission.senderName ? `Nhân viên gửi: ${submission.senderName}` : 'Hóa đơn nhân viên',
              },
            });
          } else {
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
        }
      }

      // 3. Cập nhật StaffSubmission với đầy đủ thông tin số cân, ghi chú, khách hàng, ngày tháng
      const updatedSub = await tx.staffSubmission.update({
        where: { id },
        data: {
          status: 'APPROVED',
          matchedCustomerId: finalCustomerId,
          date: finalDate,
          note: finalNote,
          transactionId: newTxId,
          approvedAt: new Date(),
        },
      });

      // 4. Lưu đồng bộ danh sách món thịt chi tiết (StaffSubmissionItem) vào CSDL
      await tx.staffSubmissionItem.deleteMany({
        where: { submissionId: id },
      });

      const baseItemTime = Date.now();
      const itemsToCreate = finalItems.map((it, idx) => {
        const qty = it.quantity != null && it.quantity !== '' ? parseFloat(it.quantity) : null;
        const price = it.price != null && it.price !== '' ? parseFloat(it.price) : null;
        const amount = it.amount != null && it.amount !== '' ? parseFloat(it.amount) : (qty && price ? Math.round(qty * price) : null);

        return {
          submissionId: id,
          rawName: it.rawName || it.name || 'Thịt lẻ',
          matchedProductId: it.matchedProductId || null,
          quantity: qty,
          price,
          amount,
          createdAt: new Date(baseItemTime + idx * 50),
          updatedAt: new Date(baseItemTime + idx * 50),
        };
      });

      if (itemsToCreate.length > 0) {
        await tx.staffSubmissionItem.createMany({
          data: itemsToCreate,
        });
      }

      // 5. Tự động đồng bộ và cập nhật đơn giá bán/trả vào Bảng giá riêng (CustomerProductPrice) của khách hàng
      for (const it of finalItems) {
        let pId = it.matchedProductId || it.productId;
        const itemPrice = parseFloat(it.price) || 0;
        if (itemPrice > 0 && finalCustomerId) {
          if (!pId && it.rawName) {
            const foundP = await tx.product.findFirst({
              where: { userId, isActive: true, name: { equals: it.rawName, mode: 'insensitive' } },
            });
            if (foundP) pId = foundP.id;
          }
          if (pId) {
            const prod = await tx.product.findUnique({ where: { id: pId } });
            if (prod && prod.name !== 'Tiền hàng' && !prod.name.toLowerCase().startsWith('tiền')) {
              await tx.customerProductPrice.upsert({
                where: {
                  customerId_productId: {
                    customerId: finalCustomerId,
                    productId: pId,
                  },
                },
                update: {
                  price: itemPrice,
                },
                create: {
                  customerId: finalCustomerId,
                  productId: pId,
                  price: itemPrice,
                },
              });
            }
          }
        }
      }

      // Lấy bản ghi đầy đủ nhất trả về cho client
      const fullSub = await tx.staffSubmission.findUnique({
        where: { id },
        include: {
          items: {
            orderBy: { createdAt: 'asc' },
          },
          matchedCustomer: {
            select: { id: true, name: true, phone: true },
          },
        },
      });

      let fullTrans = null;
      if (trans) {
        fullTrans = await tx.transaction.findUnique({
          where: { id: trans.id },
          include: {
            invoices: true,
            items: {
              include: {
                product: {
                  select: { name: true, unit: true, defaultPrice: true, costPrice: true },
                },
              },
            },
            customer: { select: { id: true, name: true, phone: true } },
          },
        });
      }

      return {
        payment,
        transaction: fullTrans || trans,
        submission: fullSub,
        isReturn: isReturnOrder,
      };
    });

    const custName = result.submission?.matchedCustomer?.name || 'Khách';
    const senderInfo = submission.senderName ? ` do ${submission.senderName} nộp` : '';

    if (result.isReturn) {
      await logActivity(
        userId,
        'APPROVE_STAFF_SUBMISSION_RETURN',
        `Duyệt hóa đơn trả hàng${senderInfo} cho khách ${custName}: Số tiền ${parseFloat(result.payment?.amount || 0).toLocaleString('vi-VN')}đ`
      );

      emitWorkspaceEvent(userId, 'PAYMENT_CREATED', result.payment);
      emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_APPROVED', { id });

      return res.json({
        success: true,
        message: 'Đã phê duyệt và trừ nợ trả hàng cho khách thành công!',
        data: result,
      });
    }

    await logActivity(
      userId,
      'APPROVE_STAFF_SUBMISSION',
      `Duyệt hóa đơn nộp${senderInfo} lên đơn nợ cho khách ${custName}: Tổng tiền ${parseFloat(result.transaction?.totalAmount || 0).toLocaleString('vi-VN')}đ`
    );

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
      include: { matchedCustomer: { select: { name: true } } },
    });

    if (!submission) {
      throw new NotFoundError('Không tìm thấy bản ghi hóa đơn.');
    }

    // Xóa vĩnh viễn hóa đơn và các món thịt liên quan (Cascade)
    await prisma.staffSubmission.delete({
      where: { id },
    });

    const senderInfo = submission.senderName ? ` của ${submission.senderName}` : '';
    const custInfo = submission.matchedCustomer?.name ? ` (khách ${submission.matchedCustomer.name})` : '';
    await logActivity(
      userId,
      'REJECT_STAFF_SUBMISSION',
      `Xóa/bác bỏ hóa đơn nộp${senderInfo}${custInfo}`
    );

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_REJECTED', { id });

    res.json({
      success: true,
      message: 'Đã xóa hóa đơn thành công.',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Bác bỏ / Xóa hàng loạt hóa đơn
 */
const batchRejectStaffSubmissions = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestError('Vui lòng cung cấp danh sách ID hóa đơn cần xóa.');
    }

    // Xóa vĩnh viễn các bản ghi hóa đơn
    await prisma.staffSubmission.deleteMany({
      where: {
        id: { in: ids },
        userId,
      },
    });

    await logActivity(
      userId,
      'REJECT_STAFF_SUBMISSION',
      `Xóa hàng loạt ${ids.length} hóa đơn nộp của nhân viên.`
    );

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_BATCH_REJECTED', { ids });

    res.json({
      success: true,
      message: `Đã xóa ${ids.length} hóa đơn thành công.`,
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

/**
 * Chủ buôn kích hoạt quét lại AI cho 1 submission
 */
const reparseStaffSubmission = async (req, res, next) => {
  try {
    const userId = req.workspaceOwnerId || req.user.id;
    const { id } = req.params;

    const submission = await prisma.staffSubmission.findFirst({
      where: { id, userId },
    });

    if (!submission) {
      throw new NotFoundError('Không tìm thấy hóa đơn cần quét lại.');
    }

    // Chuyển trạng thái sang ANALYZING và xóa lỗi cũ
    await prisma.staffSubmission.update({
      where: { id },
      data: { status: 'ANALYZING', aiError: null },
    });

    emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_ANALYZING', { id });

    // Gọi hàm phân tích AI
    parseStaffSubmission(id)
      .then((updated) => {
        emitWorkspaceEvent(userId, 'STAFF_SUBMISSION_READY', updated);
      })
      .catch((err) => {
        console.error(`[REPARSE_ERROR] Lỗi quét lại submission ${id}:`, err);
      });

    res.json({
      success: true,
      message: 'Hệ thống AI đang bắt đầu quét lại hóa đơn / video...',
      data: { id, status: 'ANALYZING' },
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
  batchRejectStaffSubmissions,
  reparseStaffSubmission,
  getSubmissionLinks,
  createSubmissionLink,
  updateSubmissionLink,
  regenerateSubmissionToken,
  deleteSubmissionLink,
};
