// meat-management-be/src/controllers/portal.js
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError, UnauthorizedError } = require('../utils/errors');
const { emitWorkspaceEvent } = require('../utils/socket');
const { logActivity } = require('../utils/activityLogger');
const { syncGroupCustomPricesToNewCustomers } = require('../services/groupPriceSyncService');
const { getEligibleDaysForEmployee } = require('./employee');
const { uploadToCloudinary, isCloudinaryConfigured } = require('../utils/cloudinary');

// Thư mục lưu trữ ảnh hóa đơn cục bộ
const uploadsDir = path.join(__dirname, '../../uploads/invoices');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper lưu tệp ảnh hóa đơn (hỗ trợ cả Base64 Data URI và Cloudinary)
const processPortalMediaUpload = async (mediaInput) => {
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
      console.warn('[PORTAL_UPLOAD] Lỗi tải lên Cloudinary, giữ link cục bộ:', cloudErr.message);
    }
  }

  return finalUrl;
};


const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'default_access_secret';
const PORTAL_SESSION_SECRET = process.env.JWT_PORTAL_SECRET || process.env.JWT_ACCESS_SECRET || 'meat_manager_portal_secret_key_2026';

// Helper sinh chuỗi token URL-safe ngẫu nhiên 16 ký tự
const generatePortalToken = () => {
  return crypto.randomBytes(12).toString('base64url');
};

// Helper ký session token cho portal khi đã xác thực PIN
const signPortalSession = (portalLinkId, token) => {
  return jwt.sign(
    { portalLinkId, token, type: 'PORTAL_SESSION' },
    PORTAL_SESSION_SECRET,
    { expiresIn: '60d' }
  );
};

// Helper xác thực session token của portal
const verifyPortalSession = (req, portalLink) => {
  if (!portalLink.pin) return true; // Không cài PIN thì luôn hợp lệ
  if (checkIsOwner(req, portalLink)) return true; // Chủ buôn luôn được phép truy cập không cần PIN

  const headers = req.headers || {};
  const query = req.query || {};

  const authHeader = headers['authorization'];
  let sessionToken = headers['x-portal-session'] || null;
  if (!sessionToken && authHeader && authHeader.startsWith('Bearer ')) {
    sessionToken = authHeader.split(' ')[1];
  } else if (query.session) {
    sessionToken = query.session;
  }

  // Cho phép truyền thẳng mã PIN qua header x-portal-pin
  const directPin = headers['x-portal-pin'] || query.pin;
  if (directPin && String(directPin).trim() === String(portalLink.pin).trim()) {
    return true;
  }

  if (!sessionToken) return false;

  try {
    const decoded = jwt.verify(sessionToken, PORTAL_SESSION_SECRET);
    return decoded.portalLinkId === portalLink.id && decoded.token === portalLink.token;
  } catch (err) {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────
// 1. CÁC API CÔNG KHAI DÀNH CHO KHÁCH HÀNG / NCC TRUY CẬP TỪ LINK ZALO
// ─────────────────────────────────────────────────────────────

// [GET] /api/v1/portal/info/:token
// Lấy thông tin cơ bản về link nhóm Zalo
const getPublicPortalInfo = async (req, res, next) => {
  try {
    const { token } = req.params;

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        user: {
          select: { id: true, name: true, phone: true }
        },
        customers: {
          where: {
            customer: {
              isActive: true,
            },
          },
          include: {
            customer: {
              select: { id: true, name: true, phone: true, address: true, note: true }
            }
          }
        },
        supplier: {
          select: { id: true, name: true, phone: true, address: true }
        }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn này không tồn tại hoặc đã bị chủ buôn thu hồi.');
    }

    // Tăng lượt xem và cập nhật thời gian xem gần nhất
    await prisma.portalLink.update({
      where: { id: portalLink.id },
      data: {
        viewCount: { increment: 1 },
        lastViewedAt: new Date()
      }
    });

    const isSessionValid = verifyPortalSession(req, portalLink);

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.status(200).json({
      success: true,
      data: {
        id: portalLink.id,
        name: portalLink.name,
        type: portalLink.type,
        hasPin: Boolean(portalLink.pin),
        isSessionValid,
        owner: {
          name: portalLink.user.name,
          phone: portalLink.user.phone
        },
        customers: portalLink.customers.map(c => c.customer),
        supplier: portalLink.supplier
      }
    });
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/verify-pin/:token
// Xác thực mã PIN nhóm Zalo
const verifyPortalPin = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { pin } = req.body;

    const portalLink = await prisma.portalLink.findUnique({
      where: { token }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn này không tồn tại hoặc đã bị chủ buôn thu hồi.');
    }

    if (!portalLink.pin) {
      return res.status(200).json({
        success: true,
        message: 'Link không yêu cầu mã PIN.',
        sessionToken: signPortalSession(portalLink.id, portalLink.token)
      });
    }

    if (String(pin).trim() !== String(portalLink.pin).trim()) {
      throw new BadRequestError('Mã PIN không chính xác. Vui lòng kiểm tra lại mã được ghim trong nhóm Zalo.');
    }

    const sessionToken = signPortalSession(portalLink.id, portalLink.token);

    res.status(200).json({
      success: true,
      message: 'Xác thực mã PIN thành công.',
      sessionToken
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Helper xác định request có phải từ localhost / môi trường dev không
 */
const isRequestFromLocalhost = (req) => {
  if (req.headers['x-portal-env'] === 'development') return true;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || req.hostname || '');
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  return (
    host.includes('localhost') ||
    host.includes('127.0.0.1') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1') ||
    referer.includes('localhost') ||
    referer.includes('127.0.0.1') ||
    process.env.NODE_ENV === 'development'
  );
};

// Helper xác thực xem người gọi request có phải là chủ buôn sở hữu link này không
const checkIsOwner = (req, portalLink) => {
  if (req.user && (req.user.id === portalLink.userId || req.effectiveUserId === portalLink.userId)) {
    return true;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && (decoded.userId === portalLink.userId || decoded.id === portalLink.userId)) {
        return true;
      }
    } catch (e) {
      // Bỏ qua nếu không phải JWT token của chủ buôn
    }
  }
  return false;
};

// Lấy danh sách ảnh/video gắn với các lượt thanh toán / trả hàng
const fetchInvoicesForPayments = async (paymentIds, userId) => {
  const invoicesByPaymentId = {};
  if (!paymentIds || paymentIds.length === 0) return invoicesByPaymentId;

  const [staffSubs, transInvs] = await Promise.all([
    prisma.staffSubmission.findMany({
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
    }),
    prisma.transactionInvoice.findMany({
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
    }),
  ]);

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

  return invoicesByPaymentId;
};

// [GET] /api/v1/portal/data/:token
// Lấy dữ liệu công nợ, đơn hàng, bảng giá thịt an toàn (Zero-leakage)
const getPublicPortalData = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const { token } = req.params;
    const { customerId, from, to } = req.query;

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: {
          where: {
            customer: {
              isActive: true,
            },
          },
          include: { customer: true }
        },
        supplier: true
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị chủ buôn thu hồi.');
    }

    // Kiểm tra bảo mật PIN
    if (portalLink.pin && !verifyPortalSession(req, portalLink)) {
      return res.status(401).json({
        success: false,
        code: 'PIN_REQUIRED',
        message: 'Yêu cầu nhập mã PIN nhóm Zalo để xem số liệu.'
      });
    }

    const isLocalhost = isRequestFromLocalhost(req);
    // Chủ buôn xem Real-time tức thì, Khách hàng xem theo mốc đã công bố (lastPublishedAt)
    const isOwner = isLocalhost || checkIsOwner(req, portalLink);
    const cutoffDate = isOwner ? null : (portalLink.lastPublishedAt || null);

    // Đếm số đơn nợ và khoản thu tiền mới phát sinh chưa công bố (dành riêng cho chủ buôn)
    let unpublishedCount = 0;
    if (isOwner && portalLink.lastPublishedAt) {
      const allowedIds = portalLink.customers.map(c => c.customerId);
      if (allowedIds.length > 0) {
        const [txCount, payCount] = await Promise.all([
          prisma.transaction.count({
            where: {
              customerId: { in: allowedIds },
              createdAt: { gt: portalLink.lastPublishedAt }
            }
          }),
          prisma.payment.count({
            where: {
              customerId: { in: allowedIds },
              createdAt: { gt: portalLink.lastPublishedAt }
            }
          })
        ]);
        unpublishedCount = txCount + payCount;
      }
    }

    // ─── A. CASE: KHÁCH HÀNG / NHÀ HÀNG (BÁN THỊT RA) ───
    if (portalLink.type === 'customer') {
      const allowedCustomerIds = portalLink.customers.map(c => c.customerId);
      if (allowedCustomerIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            type: 'customer',
            customers: [],
            summary: { totalDebt: 0 },
            transactions: [],
            publishInfo: {
              isOwner,
              lastPublishedAt: portalLink.lastPublishedAt ? portalLink.lastPublishedAt.toISOString() : null,
              unpublishedCount: 0,
            }
          }
        });
      }

      // Xử lý bộ lọc ngày
      const dateFilter = {};
      if (from) {
        dateFilter.gte = new Date(from);
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        dateFilter.lte = toDate;
      }

      // CHỈ xem chế độ toàn chuỗi khi link này liên kết từ 2 cơ sở trở lên VÀ (customerId === 'all' hoặc không truyền)
      const hasMultipleBranches = allowedCustomerIds.length > 1;
      const isViewingAll = hasMultipleBranches && (customerId === 'all' || !customerId);

      if (isViewingAll) {
        // Lấy dữ liệu tổng hợp toàn chuỗi
        const allCustomersData = [];
        let grandTotalPurchase = 0;
        let grandTotalPaid = 0;
        let grandTotalDebt = 0;

        for (const item of portalLink.customers) {
          const c = item.customer;
          const [purchases, payments] = await Promise.all([
            prisma.transaction.aggregate({
              where: {
                customerId: c.id,
                ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
              },
              _sum: { totalAmount: true }
            }),
            prisma.payment.aggregate({
              where: {
                customerId: c.id,
                ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
              },
              _sum: { amount: true }
            })
          ]);

          const totalPurchase = Math.round(Number(purchases._sum.totalAmount || 0));
          const totalPaid = Math.round(Number(payments._sum.amount || 0));
          let debt = Math.round(totalPurchase - totalPaid + Number(c.manualDebt || 0));
          if (Math.abs(debt) < 1) debt = 0;

          grandTotalPurchase += totalPurchase;
          grandTotalPaid += totalPaid;
          grandTotalDebt += debt;

          allCustomersData.push({
            id: c.id,
            name: c.name,
            phone: c.phone,
            address: c.address,
            totalPurchase,
            totalPaid,
            debt
          });
        }

        // Lấy toàn bộ giao dịch của toàn chuỗi (không giới hạn 50 đơn để hiển thị đầy đủ theo thời gian lọc)
        const recentTxs = await prisma.transaction.findMany({
          where: {
            customerId: { in: allowedCustomerIds },
            ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          include: {
            customer: { select: { id: true, name: true } },
            items: {
              include: {
                product: { select: { id: true, name: true, unit: true } }
              }
            },
            invoices: true, // Bao gồm ảnh hóa đơn đính kèm đơn nợ
          },
          orderBy: { date: 'desc' },
        });

        // Lấy danh sách thanh toán / trả hàng của toàn chuỗi để đối soát chi tiết
        const chainPayments = await prisma.payment.findMany({
          where: {
            customerId: { in: allowedCustomerIds },
            ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          include: {
            customer: { select: { id: true, name: true } }
          },
          orderBy: { paidAt: 'desc' }
        });

        // Định dạng dữ liệu an toàn (Zero-leakage: không costPrice, không profit)
        const safeTxs = recentTxs.map(tx => ({
          id: tx.id,
          date: tx.date,
          customerName: tx.customer.name,
          customerId: tx.customer.id,
          totalAmount: Number(tx.totalAmount),
          note: tx.note,
          invoices: (tx.invoices || []).map(inv => ({ id: inv.id, imageUrl: inv.imageUrl, note: inv.note, date: inv.date })),
          items: tx.items.map(it => ({
            id: it.id,
            productName: it.product.name,
            unit: it.product.unit,
            quantity: Number(it.quantity),
            price: Number(it.price),
            amount: Number(it.amount)
          }))
        }));

        const chainPaymentInvoices = await fetchInvoicesForPayments(chainPayments.map(p => p.id), portalLink.userId);
        const safePayments = chainPayments.map(pm => ({
          id: pm.id,
          amount: Number(pm.amount),
          paidAt: pm.paidAt,
          note: pm.note,
          method: pm.method,
          customerId: pm.customerId,
          customerName: pm.customer?.name || null,
          invoices: chainPaymentInvoices[pm.id] || [],
        }));

        const chainData = {
          type: 'customer',
          isChainOverview: true,
          summary: {
            totalDebt: grandTotalDebt,
            totalPurchase: grandTotalPurchase,
            totalPaid: grandTotalPaid,
            branchCount: allowedCustomerIds.length
          },
          branches: allCustomersData,
          transactions: safeTxs,
          payments: safePayments,
          publishInfo: {
            isOwner,
            lastPublishedAt: portalLink.lastPublishedAt ? portalLink.lastPublishedAt.toISOString() : null,
            unpublishedCount,
          }
        };

        return res.status(200).json({ success: true, data: chainData });
      }

      // Xử lý xem cụ thể 1 khách hàng / chi nhánh (nếu truyền 'all' mà chỉ có 1 quán thì lấy quán đó)
      const targetCustomerId = (customerId && customerId !== 'all') ? customerId : allowedCustomerIds[0];
      if (!allowedCustomerIds.includes(targetCustomerId)) {
        throw new ForbiddenError('Bạn không có quyền truy cập dữ liệu của chi nhánh này.');
      }

      const targetCustomer = await prisma.customer.findUnique({
        where: { id: targetCustomerId }
      });

      // Tính công nợ thực tế
      const [purchases, paymentsTotal, transactions, payments, customPrices] = await Promise.all([
        prisma.transaction.aggregate({
          where: {
            customerId: targetCustomerId,
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          _sum: { totalAmount: true }
        }),
        prisma.payment.aggregate({
          where: {
            customerId: targetCustomerId,
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          _sum: { amount: true }
        }),
        prisma.transaction.findMany({
          where: {
            customerId: targetCustomerId,
            ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          include: {
            items: {
              include: {
                product: { select: { id: true, name: true, unit: true } }
              }
            },
            invoices: true, // Bao gồm ảnh hóa đơn đính kèm đơn nợ
          },
          orderBy: { date: 'desc' }
        }),
        prisma.payment.findMany({
          where: {
            customerId: targetCustomerId,
            ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          orderBy: { paidAt: 'desc' },
          take: 100
        }),
        prisma.customerProductPrice.findMany({
          where: { customerId: targetCustomerId },
          include: {
            product: { select: { id: true, name: true, unit: true } }
          },
          orderBy: { product: { name: 'asc' } }
        })
      ]);

      const totalPurchase = Math.round(Number(purchases._sum.totalAmount || 0));
      const totalPaid = Math.round(Number(paymentsTotal._sum.amount || 0));
      let debt = Math.round(totalPurchase - totalPaid + Number(targetCustomer.manualDebt || 0));
      if (Math.abs(debt) < 1) debt = 0;

      // Chuẩn hóa dữ liệu an toàn
      const safeTxs = transactions.map(tx => ({
        id: tx.id,
        date: tx.date,
        totalAmount: Number(tx.totalAmount),
        note: tx.note,
        invoices: (tx.invoices || []).map(inv => ({ id: inv.id, imageUrl: inv.imageUrl, note: inv.note, date: inv.date })),
        items: tx.items.map(it => ({
          id: it.id,
          productName: it.product.name,
          unit: it.product.unit,
          quantity: Number(it.quantity),
          price: Number(it.price),
          amount: Number(it.amount)
        }))
      }));

      const safePrices = customPrices.map(cp => ({
        id: cp.id,
        productName: cp.product.name,
        unit: cp.product.unit,
        price: Number(cp.price),
        changeReason: cp.changeReason || null,
      }));

      const singlePaymentInvoices = await fetchInvoicesForPayments(payments.map(p => p.id), portalLink.userId);
      const safePayments = payments.map(p => ({
        id: p.id,
        paidAt: p.paidAt,
        amount: Number(p.amount),
        note: p.note,
        invoices: singlePaymentInvoices[p.id] || [],
      }));

      const singleCustomerData = {
        type: 'customer',
        isChainOverview: false,
        currentCustomer: {
          id: targetCustomer.id,
          name: targetCustomer.name,
          phone: targetCustomer.phone,
          address: targetCustomer.address
        },
        summary: {
          debt,
          totalPurchase,
          totalPaid
        },
        transactions: safeTxs,
        prices: safePrices,
        payments: safePayments,
        branches: portalLink.customers.map((item) => ({
          id: item.customer.id,
          name: item.customer.name,
          phone: item.customer.phone
        })),
        publishInfo: {
          isOwner,
          lastPublishedAt: portalLink.lastPublishedAt ? portalLink.lastPublishedAt.toISOString() : null,
          unpublishedCount,
        }
      };

      return res.status(200).json({ success: true, data: singleCustomerData });
    }

    // ─── B. CASE: NHÀ CUNG CẤP (TIỀN MUA HÀNG NỢ NCC) ───
    if (portalLink.type === 'supplier') {
      if (!portalLink.supplierId || !portalLink.supplier) {
        throw new NotFoundError('Chưa gán nhà cung cấp cho link này.');
      }

      const supp = portalLink.supplier;

      const [txSum, paySum, transactions, payments] = await Promise.all([
        prisma.supplierTransaction.aggregate({
          where: { supplierId: supp.id },
          _sum: { totalAmount: true }
        }),
        prisma.supplierPayment.aggregate({
          where: { supplierId: supp.id },
          _sum: { amount: true }
        }),
        prisma.supplierTransaction.findMany({
          where: { supplierId: supp.id },
          orderBy: { date: 'desc' },
          take: 50
        }),
        prisma.supplierPayment.findMany({
          where: { supplierId: supp.id },
          orderBy: { paidAt: 'desc' },
          take: 30
        })
      ]);

      const totalImport = Math.round(Number(txSum._sum.totalAmount || 0));
      const totalPaid = Math.round(Number(paySum._sum.amount || 0));
      const debt = totalImport - totalPaid;

      return res.status(200).json({
        success: true,
        data: {
          type: 'supplier',
          supplier: {
            id: supp.id,
            name: supp.name,
            phone: supp.phone,
            address: supp.address
          },
          summary: {
            debt, // Tiền bên chủ buôn còn nợ NCC
            totalImport,
            totalPaid
          },
          transactions: transactions.map(t => ({
            id: t.id,
            date: t.date,
            totalAmount: Number(t.totalAmount),
            note: t.note
          })),
          payments: payments.map(p => ({
            id: p.id,
            paidAt: p.paidAt,
            amount: Number(p.amount),
            note: p.note
          }))
        }
      });
    }

    throw new BadRequestError('Loại link không hợp lệ.');
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/feedback/:token
// Gửi phản hồi / khiếu nại / báo lệch cân từ trang portal về chủ buôn
const submitPortalFeedback = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { customerId, senderName, phone, type, content, imageUrls } = req.body;

    if (!content || !content.trim()) {
      throw new BadRequestError('Nội dung phản hồi không được để trống.');
    }

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: true,
        user: true
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị thu hồi.');
    }

    // Nếu là link có PIN, xác thực
    if (portalLink.pin && !verifyPortalSession(req, portalLink)) {
      throw new UnauthorizedError('Phiên truy cập đã hết hạn. Vui lòng xác thực mã PIN lại.');
    }

    const feedback = await prisma.portalFeedback.create({
      data: {
        portalLinkId: portalLink.id,
        customerId: customerId || (portalLink.customers[0]?.customerId || null),
        senderName: senderName?.trim() || 'Người trong nhóm Zalo',
        phone: phone?.trim() || null,
        type: type || 'DISCREPANCY',
        content: content.trim(),
        imageUrls: imageUrls ? (typeof imageUrls === 'string' ? imageUrls : JSON.stringify(imageUrls)) : null,
        status: 'pending'
      },
      include: {
        customer: { select: { name: true } }
      }
    });

    // Bắn socket thông báo cho chủ buôn trong app
    emitWorkspaceEvent(portalLink.userId, 'PORTAL_FEEDBACK_RECEIVED', {
      feedbackId: feedback.id,
      groupName: portalLink.name,
      customerName: feedback.customer?.name || null,
      senderName: feedback.senderName,
      type: feedback.type,
      content: feedback.content,
      createdAt: feedback.createdAt
    });

    res.status(201).json({
      success: true,
      message: 'Gửi phản hồi thành công. Chủ buôn đã nhận được thông báo để đối soát.',
      data: feedback
    });
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/branches-debt/:token
// Lấy chi tiết công nợ từng chi nhánh/cửa hàng theo tháng và tổng nợ toàn bộ
const getBranchesDebtByMonth = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { month } = req.query; // 'MM/YYYY' hoặc 'YYYY-MM'

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: {
          include: { customer: true }
        }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị thu hồi.');
    }

    // Kiểm tra bảo mật PIN
    if (portalLink.pin && !verifyPortalSession(req, portalLink)) {
      return res.status(401).json({
        success: false,
        code: 'PIN_REQUIRED',
        message: 'Yêu cầu nhập mã PIN nhóm Zalo để xem số liệu.'
      });
    }

    const isLocalhost = isRequestFromLocalhost(req);
    const isOwner = isLocalhost || checkIsOwner(req, portalLink);
    const cutoffDate = isOwner ? null : (portalLink.lastPublishedAt || null);

    const now = new Date();
    let targetMonth = now.getMonth() + 1;
    let targetYear = now.getFullYear();

    if (month) {
      if (month.includes('/')) {
        const parts = month.split('/');
        targetMonth = parseInt(parts[0], 10);
        targetYear = parseInt(parts[1], 10);
      } else if (month.includes('-')) {
        const parts = month.split('-');
        targetYear = parseInt(parts[0], 10);
        targetMonth = parseInt(parts[1], 10);
      }
    }

    // Chuẩn hóa mốc thời gian bắt đầu và kết thúc tháng theo đúng múi giờ Việt Nam (UTC+7)
    // Đầu tháng: 00:00:00 ngày 1 (giờ VN) = 17:00:00 ngày cuối tháng trước (giờ UTC)
    // Cuối tháng: 23:59:59.999 ngày cuối tháng (giờ VN) = 16:59:59.999 ngày cuối tháng (giờ UTC)
    const startOfMonth = new Date(Date.UTC(targetYear, targetMonth - 1, 1, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
    const endOfMonth = new Date(Date.UTC(targetYear, targetMonth, 0, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
    const formattedMonth = `${String(targetMonth).padStart(2, '0')}/${targetYear}`;

    let grandTotalDebt = 0;
    let grandMonthPurchase = 0;
    let grandMonthReturn = 0;
    let grandMonthPaid = 0;
    let grandMonthDebt = 0;

    const branchesData = [];

    for (const item of portalLink.customers) {
      const c = item.customer;

      // 1. Toàn bộ lịch sử mua và trả của khách hàng
      const [allPurchases, allPayments, monthPurchases, customerPayments] = await Promise.all([
        prisma.transaction.aggregate({
          where: {
            customerId: c.id,
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          _sum: { totalAmount: true }
        }),
        prisma.payment.aggregate({
          where: {
            customerId: c.id,
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          _sum: { amount: true }
        }),
        prisma.transaction.aggregate({
          where: {
            customerId: c.id,
            date: { gte: startOfMonth, lte: endOfMonth },
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          },
          _sum: { totalAmount: true }
        }),
        prisma.payment.findMany({
          where: {
            customerId: c.id,
            ...(cutoffDate ? { createdAt: { lte: cutoffDate } } : {})
          }
        })
      ]);

      const totalPurchase = Math.round(Number(allPurchases._sum.totalAmount || 0));
      const totalPaid = Math.round(Number(allPayments._sum.amount || 0));
      let totalDebt = Math.round(totalPurchase - totalPaid + Number(c.manualDebt || 0));
      if (Math.abs(totalDebt) < 1) totalDebt = 0;

      const monthPurchase = Math.round(Number(monthPurchases._sum.totalAmount || 0));

      // 2. Phân loại tiền thanh toán và tiền trả hàng thuộc về tháng mục tiêu
      let monthPaid = 0;
      let monthReturn = 0;

      for (const pm of customerPayments) {
        const amt = Number(pm.amount) || 0;
        const note = (pm.note || '').trim();
        const noteLower = note.toLowerCase();

        // Nhận diện đơn trả lại hàng (không phải tiền khách thanh toán nợ)
        const isReturn =
          note.includes('[Trả lại hàng]') ||
          note.includes('[Trả hàng nhanh]') ||
          note.includes('[Trả hàng]') ||
          /\b(trả hàng|trả lại|gửi về|trả về|hàng trả|thu hồi|quay đầu|hoàn hàng)\b/i.test(noteLower);

        if (isReturn) {
          if (pm.paidAt) {
            const pDate = new Date(pm.paidAt);
            if (pDate >= startOfMonth && pDate <= endOfMonth) {
              monthReturn += amt;
            }
          }
        } else {
          // Khoản khách thực tế thanh toán tiền nợ (tiền mặt / chuyển khoản)
          const monthMatch = note.match(/Thanh toán (?:nợ|hóa đơn)?\s*[Tt]háng (\d{2})\/(\d{4})/i);

          if (monthMatch) {
            const pM = parseInt(monthMatch[1], 10);
            const pY = parseInt(monthMatch[2], 10);
            if (pM === targetMonth && pY === targetYear) {
              monthPaid += amt;
            }
          } else if (pm.paidAt) {
            const pDate = new Date(pm.paidAt);
            if (pDate >= startOfMonth && pDate <= endOfMonth) {
              monthPaid += amt;
            }
          }
        }
      }
      monthPaid = Math.round(monthPaid);
      monthReturn = Math.round(monthReturn);

      let monthDebt = Math.round(monthPurchase - monthReturn - monthPaid);
      if (monthDebt < 0) monthDebt = 0;

      grandTotalDebt += totalDebt;
      grandMonthPurchase += monthPurchase;
      grandMonthReturn += monthReturn;
      grandMonthPaid += monthPaid;
      grandMonthDebt += monthDebt;

      branchesData.push({
        id: c.id,
        name: c.name,
        phone: c.phone,
        address: c.address,
        monthPurchase,
        monthReturn,
        monthPaid,
        monthDebt,
        totalDebt
      });
    }

    const branchesRes = {
      success: true,
      data: {
        month: formattedMonth,
        targetMonth,
        targetYear,
        summary: {
          monthDebt: grandMonthDebt,
          monthPurchase: grandMonthPurchase,
          monthReturn: grandMonthReturn,
          monthPaid: grandMonthPaid,
          totalDebt: grandTotalDebt,
          branchCount: branchesData.length
        },
        branches: branchesData,
        publishInfo: {
          isOwner,
          lastPublishedAt: portalLink.lastPublishedAt ? portalLink.lastPublishedAt.toISOString() : null,
        }
      }
    };

    res.status(200).json(branchesRes);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// 2. CÁC API QUẢN TRỊ DÀNH CHO CHỦ BUÔN (YÊU CẦU ĐĂNG NHẬP JWT)
// ─────────────────────────────────────────────────────────────

// [GET] /api/v1/portal/manage/links
// Lấy danh sách toàn bộ Link Ghim Zalo của chủ buôn
const getPortalLinks = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;

    const links = await prisma.portalLink.findMany({
      where: { userId },
      include: {
        customers: {
          where: {
            customer: {
              isActive: true,
            },
          },
          include: {
            customer: { select: { id: true, name: true, phone: true } }
          }
        },
        supplier: {
          select: { id: true, name: true }
        },
        _count: {
          select: {
            feedbacks: { where: { status: 'pending' } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = await Promise.all(links.map(async (l) => {
      let unpublishedCount = 0;
      if (l.type === 'customer' && l.customers.length > 0) {
        const cIds = l.customers.map(c => c.customer.id);
        const [txCount, payCount] = await Promise.all([
          prisma.transaction.count({
            where: {
              customerId: { in: cIds },
              ...(l.lastPublishedAt ? { createdAt: { gt: l.lastPublishedAt } } : {})
            }
          }),
          prisma.payment.count({
            where: {
              customerId: { in: cIds },
              ...(l.lastPublishedAt ? { createdAt: { gt: l.lastPublishedAt } } : {})
            }
          })
        ]);
        unpublishedCount = txCount + payCount;
      }
      return {
        id: l.id,
        name: l.name,
        token: l.token,
        type: l.type,
        pin: l.pin,
        isActive: l.isActive,
        note: l.note,
        viewCount: l.viewCount,
        lastViewedAt: l.lastViewedAt,
        lastPublishedAt: l.lastPublishedAt,
        unpublishedCount,
        createdAt: l.createdAt,
        customers: l.customers.map(c => c.customer),
        supplier: l.supplier,
        pendingFeedbacksCount: l._count.feedbacks
      };
    }));

    res.status(200).json({
      success: true,
      data: formatted
    });
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/manage/links
// Tạo một Link Ghim Zalo mới
const createPortalLink = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { name, type = 'customer', pin, customerIds = [], supplierId, note } = req.body;

    if (!name || !name.trim()) {
      throw new BadRequestError('Tên nhóm Zalo là bắt buộc (ví dụ: Nhóm Trường Hoàng).');
    }

    if (type === 'customer' && (!customerIds || customerIds.length === 0)) {
      throw new BadRequestError('Vui lòng chọn ít nhất một khách hàng/chi nhánh cho link này.');
    }

    if (type === 'supplier' && !supplierId) {
      throw new BadRequestError('Vui lòng chọn nhà cung cấp cho link này.');
    }

    const token = generatePortalToken();

    const newLink = await prisma.$transaction(async (tx) => {
      const link = await tx.portalLink.create({
        data: {
          userId,
          name: name.trim(),
          token,
          type,
          pin: pin ? String(pin).trim() : null,
          supplierId: type === 'supplier' ? supplierId : null,
          note: note?.trim() || null,
          isActive: true
        }
      });

      if (type === 'customer' && customerIds.length > 0) {
        await tx.portalLinkCustomer.createMany({
          data: customerIds.map(cId => ({
            portalLinkId: link.id,
            customerId: cId
          }))
        });
      }

      return link;
    });

    res.status(201).json({
      success: true,
      message: 'Tạo Link Ghim Zalo thành công.',
      data: newLink
    });
  } catch (err) {
    next(err);
  }
};

// [PUT] /api/v1/portal/manage/links/:id
// Cập nhật thông tin Link Ghim Zalo (Sửa tên, đổi PIN, thêm/bớt cơ sở, bật/tắt)
const updatePortalLink = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { name, pin, customerIds, supplierId, isActive, note } = req.body;

    const existing = await prisma.portalLink.findFirst({
      where: { id, userId }
    });

    if (!existing) {
      throw new NotFoundError('Không tìm thấy link cần sửa.');
    }

    let syncPriceResult = null;

    const updated = await prisma.$transaction(async (tx) => {
      const link = await tx.portalLink.update({
        where: { id },
        data: {
          name: name !== undefined ? name.trim() : undefined,
          pin: pin !== undefined ? (pin ? String(pin).trim() : null) : undefined,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
          note: note !== undefined ? note?.trim() : undefined,
          supplierId: supplierId !== undefined ? supplierId : undefined
        }
      });

      if (customerIds && Array.isArray(customerIds)) {
        // Lấy danh sách thành viên hiện tại của nhóm trước khi cập nhật
        const existingMembers = await tx.portalLinkCustomer.findMany({
          where: { portalLinkId: id },
          select: { customerId: true }
        });
        const existingCustomerIds = existingMembers.map(m => m.customerId);

        // Phát hiện các nhà hàng mới được thêm vào nhóm
        const newCustomerIds = customerIds.filter(cId => !existingCustomerIds.includes(cId));

        // Kiểm tra thêm các nhà hàng đã có trong nhóm nhưng chưa có bản ghi giá riêng nào
        const existingWithoutPrice = [];
        for (const cId of customerIds) {
          if (!newCustomerIds.includes(cId)) {
            const count = await tx.customerProductPrice.count({
              where: { customerId: cId }
            });
            if (count === 0) {
              existingWithoutPrice.push(cId);
            }
          }
        }

        const targetIdsToSync = [...newCustomerIds, ...existingWithoutPrice];
        const sourceIds = customerIds.filter(cId => !targetIdsToSync.includes(cId));

        // Tự động thiết lập bộ giá riêng của nhóm cho các nhà hàng cần áp dụng
        if (targetIdsToSync.length > 0 && sourceIds.length > 0) {
          syncPriceResult = await syncGroupCustomPricesToNewCustomers({
            userId,
            groupName: name || existing.name,
            sourceCustomerIds: sourceIds,
            targetCustomerIds: targetIdsToSync,
            tx,
          });
        }

        await tx.portalLinkCustomer.deleteMany({ where: { portalLinkId: id } });
        if (customerIds.length > 0) {
          await tx.portalLinkCustomer.createMany({
            data: customerIds.map(cId => ({
              portalLinkId: id,
              customerId: cId
            }))
          });
        }
      }

      return link;
    });

    const successMessage = syncPriceResult?.syncedProductCount > 0
      ? `Cập nhật nhóm thành công. Đã tự động thiết lập bộ giá riêng (${syncPriceResult.syncedProductCount} loại thịt) cho ${syncPriceResult.syncedCustomerCount} nhà hàng mới!`
      : 'Cập nhật link thành công.';

    res.status(200).json({
      success: true,
      message: successMessage,
      data: updated,
      syncPriceResult: syncPriceResult || null,
    });
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/manage/links/:id/regenerate-token
// Cơ chế bảo mật: Thu hồi link cũ và tạo ngay mã link mới (xoay vòng link)
const regeneratePortalToken = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const existing = await prisma.portalLink.findFirst({
      where: { id, userId }
    });

    if (!existing) {
      throw new NotFoundError('Không tìm thấy link.');
    }

    const newToken = generatePortalToken();

    const updated = await prisma.portalLink.update({
      where: { id },
      data: {
        token: newToken,
        viewCount: 0 // Reset lại lượt xem cho link mới
      }
    });

    res.status(200).json({
      success: true,
      message: 'Đã thu hồi link cũ và sinh link mới thành công. Link cũ trên Zalo đã vô hiệu hóa hoàn toàn.',
      data: {
        id: updated.id,
        newToken: updated.token
      }
    });
  } catch (err) {
    next(err);
  }
};

// [DELETE] /api/v1/portal/manage/links/:id
// Xóa vĩnh viễn một link
const deletePortalLink = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const existing = await prisma.portalLink.findFirst({
      where: { id, userId }
    });

    if (!existing) {
      throw new NotFoundError('Không tìm thấy link.');
    }

    await prisma.portalLink.delete({ where: { id } });

    res.status(200).json({
      success: true,
      message: 'Đã xóa link ghim Zalo thành công.'
    });
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/manage/feedbacks
// Lấy danh sách phản hồi / khiếu nại gửi từ các nhóm Zalo về
const getPortalFeedbacks = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { status, portalLinkId } = req.query;

    const whereFilter = {
      portalLink: { userId }
    };

    if (status) {
      whereFilter.status = status;
    }

    if (portalLinkId) {
      whereFilter.portalLinkId = portalLinkId;
    }

    const feedbacks = await prisma.portalFeedback.findMany({
      where: whereFilter,
      include: {
        portalLink: { select: { id: true, name: true } },
        customer: { select: { id: true, name: true, phone: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.status(200).json({
      success: true,
      data: feedbacks
    });
  } catch (err) {
    next(err);
  }
};

// [PUT] /api/v1/portal/manage/feedbacks/:id
// Xử lý phản hồi (Đánh dấu đã giải quyết hoặc bác bỏ)
const resolvePortalFeedback = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { status = 'resolved', adminNote } = req.body;

    const feedback = await prisma.portalFeedback.findFirst({
      where: {
        id,
        portalLink: { userId }
      }
    });

    if (!feedback) {
      throw new NotFoundError('Không tìm thấy phản hồi.');
    }

    const updated = await prisma.portalFeedback.update({
      where: { id },
      data: {
        status,
        adminNote: adminNote?.trim() || null,
        resolvedAt: status === 'resolved' ? new Date() : null
      }
    });

    res.status(200).json({
      success: true,
      message: 'Cập nhật trạng thái phản hồi thành công.',
      data: updated
    });
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/manage/links/:id/publish
// Chủ buôn bấm công bố số liệu mới cho 1 link ghim Zalo
const publishPortalData = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const link = await prisma.portalLink.findFirst({
      where: { id, userId, isActive: true }
    });

    if (!link) {
      throw new NotFoundError('Không tìm thấy link nhóm Zalo hoặc link đã bị khóa.');
    }

    const now = new Date();
    const updated = await prisma.portalLink.update({
      where: { id },
      data: { lastPublishedAt: now }
    });

    res.status(200).json({
      success: true,
      message: 'Đã công bố số liệu mới nhất cho khách hàng xem thành công!',
      data: {
        id: updated.id,
        lastPublishedAt: updated.lastPublishedAt
      }
    });
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/manage/links/publish-all
// Chủ buôn bấm công bố số liệu mới cho TẤT CẢ các link ghim Zalo
const publishAllPortalData = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const now = new Date();

    const result = await prisma.portalLink.updateMany({
      where: { userId, isActive: true },
      data: { lastPublishedAt: now }
    });

    res.status(200).json({
      success: true,
      message: `Đã công bố số liệu mới cho toàn bộ ${result.count} nhóm Zalo!`,
      data: {
        count: result.count,
        lastPublishedAt: now
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * [POST] /api/v1/portal/sync-invoice/:token/:invoiceId
 * Đồng bộ video hóa đơn TransactionInvoice lên Cloudinary qua portal công khai.
 * Xác thực bằng portal token + session token (không cần Bearer token của chủ buôn).
 */
const syncInvoiceViaPortal = async (req, res, next) => {
  try {
    const { token, invoiceId } = req.params;
    const fs = require('fs');
    const path = require('path');
    const { uploadToCloudinary } = require('../utils/cloudinary');

    // Xác thực portal link
    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị thu hồi.');
    }

    // Xác thực session PIN nếu link có PIN
    if (portalLink.pin && !verifyPortalSession(req, portalLink)) {
      return res.status(401).json({
        success: false,
        code: 'PIN_REQUIRED',
        message: 'Phiên truy cập đã hết hạn. Vui lòng xác thực mã PIN lại.',
      });
    }

    // Tìm invoice và xác thực nó thuộc về chủ buôn sở hữu portal link
    const invoice = await prisma.transactionInvoice.findFirst({
      where: {
        id: invoiceId,
        userId: portalLink.userId,
      },
    });

    if (!invoice) {
      throw new NotFoundError('Không tìm thấy ảnh hóa đơn hoặc bạn không có quyền truy cập.');
    }

    // Nếu đã có link Cloudinary (HTTP/HTTPS) rồi thì trả về luôn
    if (invoice.imageUrl && (invoice.imageUrl.startsWith('http://') || invoice.imageUrl.startsWith('https://'))) {
      return res.json({
        success: true,
        message: 'Tệp đã được lưu trữ trên đám mây.',
        data: { id: invoice.id, imageUrl: invoice.imageUrl },
      });
    }

    // Nếu vẫn còn link /uploads/ cục bộ — thử upload Cloudinary
    if (invoice.imageUrl && invoice.imageUrl.startsWith('/uploads/')) {
      const relativePath = invoice.imageUrl.replace(/^\//, '');
      const diskPath = path.join(__dirname, '../../', relativePath);

      if (fs.existsSync(diskPath)) {
        const isVideo = /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(diskPath);
        const uploadRes = await uploadToCloudinary(diskPath, {
          filePath: diskPath,
          folder: 'meat_invoices/videos',
          resource_type: isVideo ? 'video' : 'image',
        });

        if (uploadRes && uploadRes.secure_url) {
          const cloudUrl = uploadRes.secure_url;
          // Cập nhật TransactionInvoice sang URL Cloudinary
          await prisma.transactionInvoice.update({
            where: { id: invoice.id },
            data: { imageUrl: cloudUrl },
          });
          // Đồng bộ ngược sang StaffSubmission nếu có liên kết
          await prisma.staffSubmission.updateMany({
            where: { fileUrl: invoice.imageUrl },
            data: { fileUrl: cloudUrl },
          });

          return res.json({
            success: true,
            message: 'Đồng bộ video lên Cloudinary thành công!',
            data: { id: invoice.id, imageUrl: cloudUrl },
          });
        }
      }

      // File hết hạn trên server (bị xóa sau khi server restart)
      return res.json({
        success: false,
        isMissingFile: true,
        message: 'Tệp video tạm trên máy chủ đã hết hạn. Dữ liệu đơn nợ vẫn còn nguyên vẹn trong hệ thống.',
        data: { id: invoice.id, imageUrl: invoice.imageUrl },
      });
    }

    return res.json({
      success: true,
      data: { id: invoice.id, imageUrl: invoice.imageUrl },
    });
  } catch (error) {
    next(error);
  }
};

const publishByToken = async (req, res, next) => {
  try {
    const { token } = req.params;
    const portalLink = await prisma.portalLink.findUnique({
      where: { token }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị thu hồi.');
    }

    const isOwner = checkIsOwner(req, portalLink);
    if (!isOwner) {
      throw new ForbiddenError('Chỉ có chủ buôn mới có quyền bấm công bố số liệu mới.');
    }

    const now = new Date();
    const updated = await prisma.portalLink.update({
      where: { id: portalLink.id },
      data: { lastPublishedAt: now }
    });

    res.status(200).json({
      success: true,
      message: 'Đã công bố số liệu mới nhất cho khách hàng xem thành công!',
      data: {
        id: updated.id,
        lastPublishedAt: updated.lastPublishedAt
      }
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// 3. TÍNH NĂNG BÁO HÀNG & CHỐT ĐƠN CHO NHÀ HÀNG (HÔM NAY / HÔM SAU)
// ─────────────────────────────────────────────────────────────

// Helper chuẩn hóa ngày theo giờ Việt Nam (UTC+7)
const getVnDateRange = (dateInput, dateType = 'today') => {
  const now = new Date();
  const vnNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);

  let targetYear = vnNow.getUTCFullYear();
  let targetMonth = vnNow.getUTCMonth();
  let targetDay = vnNow.getUTCDate();

  if (dateInput) {
    let cleanStr = String(dateInput).trim();
    if (cleanStr.includes('/')) {
      const parts = cleanStr.split('/');
      if (parts.length === 3) {
        cleanStr = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
    }
    const match = cleanStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      targetYear = parseInt(match[1], 10);
      targetMonth = parseInt(match[2], 10) - 1;
      targetDay = parseInt(match[3], 10);
    }
  } else if (dateType === 'tomorrow') {
    const tomorrow = new Date(Date.UTC(targetYear, targetMonth, targetDay + 1));
    targetYear = tomorrow.getUTCFullYear();
    targetMonth = tomorrow.getUTCMonth();
    targetDay = tomorrow.getUTCDate();
  }

  // startOfDay và endOfDay theo giờ Việt Nam UTC+7
  const startOfDay = new Date(Date.UTC(targetYear, targetMonth, targetDay, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
  const endOfDay = new Date(Date.UTC(targetYear, targetMonth, targetDay, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
  const normalizedDate = new Date(Date.UTC(targetYear, targetMonth, targetDay, 0, 0, 0, 0));
  const yyyy = String(targetYear);
  const mm = String(targetMonth + 1).padStart(2, '0');
  const dd = String(targetDay).padStart(2, '0');
  const dateString = `${yyyy}-${mm}-${dd}`;
  const displayDate = `${dd}/${mm}/${yyyy}`;

  return {
    startOfDay,
    endOfDay,
    normalizedDate,
    dateString,
    displayDate,
  };
};

// [POST] /api/v1/portal/delivery-request/:token
// Khách hàng / Nhà hàng gửi hoặc cập nhật báo hàng từ Portal
const submitDeliveryRequest = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { customerId, customerIds, dateType = 'today', deliveryDate, note } = req.body;

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: {
          include: { customer: true }
        }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị thu hồi.');
    }

    // Xác định danh sách khách hàng báo hàng (hỗ trợ cả mảng customerIds hoặc customerId đơn lẻ)
    let targetCustomerIds = [];
    if (Array.isArray(customerIds) && customerIds.length > 0) {
      targetCustomerIds = Array.from(new Set(customerIds.filter(Boolean)));
    } else if (customerId) {
      targetCustomerIds = [customerId];
    } else if (portalLink.customers && portalLink.customers.length > 0) {
      targetCustomerIds = [portalLink.customers[0].customerId];
    } else {
      throw new BadRequestError('Không tìm thấy thông tin khách hàng liên kết với đường dẫn này.');
    }

    // Lọc các khách hàng hợp lệ thuộc portalLink
    const validPortalCustMap = new Map(portalLink.customers.map(c => [c.customerId, c.customer]));
    const validTargetIds = targetCustomerIds.filter(id => validPortalCustMap.has(id));

    if (validTargetIds.length === 0) {
      throw new BadRequestError('Các khách hàng được chọn không thuộc danh sách quản lý của nhóm này.');
    }

    const { startOfDay, endOfDay, normalizedDate, dateString, displayDate } = getVnDateRange(deliveryDate, dateType);

    const results = [];
    for (const targetCustomerId of validTargetIds) {
      // Tìm đơn báo hàng đã có trong ngày đó
      const existing = await prisma.portalDeliveryRequest.findFirst({
        where: {
          portalLinkId: portalLink.id,
          customerId: targetCustomerId,
          deliveryDate: {
            gte: startOfDay,
            lte: endOfDay
          }
        }
      });

      let itemResult;
      if (existing) {
        itemResult = await prisma.portalDeliveryRequest.update({
          where: { id: existing.id },
          data: {
            dateType: dateType || existing.dateType,
            deliveryDate: normalizedDate,
            note: note !== undefined ? note : existing.note,
            status: 'pending',
            isConfirmed: false,
            confirmedAt: null,
            updatedAt: new Date()
          },
          include: {
            customer: { select: { id: true, name: true, phone: true } }
          }
        });
      } else {
        itemResult = await prisma.portalDeliveryRequest.create({
          data: {
            userId: portalLink.userId,
            portalLinkId: portalLink.id,
            customerId: targetCustomerId,
            deliveryDate: normalizedDate,
            dateType: dateType || 'today',
            note: note || '',
            status: 'pending',
            isConfirmed: false
          },
          include: {
            customer: { select: { id: true, name: true, phone: true } }
          }
        });
      }

      // Gửi thông báo real-time qua Socket nếu có kết nối
      try {
        emitWorkspaceEvent(portalLink.userId, 'PORTAL_DELIVERY_REQUEST', {
          type: 'PORTAL_DELIVERY_REQUEST',
          requestId: itemResult.id,
          customerId: targetCustomerId,
          customerName: itemResult.customer?.name,
          deliveryDate: dateString,
          displayDate
        });
      } catch (_) {}

      results.push(itemResult);
    }

    const firstResult = results[0];
    const successMsg = results.length > 1
      ? `Đã gửi báo lấy hàng cho ${results.length} cơ sở vào ngày ${displayDate} thành công!`
      : `Đã gửi báo lấy hàng cho ngày ${displayDate} thành công!`;

    res.status(200).json({
      success: true,
      message: successMsg,
      data: {
        ...firstResult,
        formattedDeliveryDate: displayDate,
        dateString,
        results
      }
    });
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/delivery-request/:token
// Lấy các lượt báo hàng gần đây trên cổng portal
const getPortalDeliveryRequests = async (req, res, next) => {
  try {
    const { token } = req.params;
    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      select: { id: true, isActive: true }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị thu hồi.');
    }

    // Lấy các request trong khoảng 7 ngày qua và tương lai
    const now = new Date();
    const pastDate = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
    const futureDate = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);

    const requests = await prisma.portalDeliveryRequest.findMany({
      where: {
        portalLinkId: portalLink.id,
        status: { not: 'cancelled' },
        deliveryDate: {
          gte: pastDate,
          lte: futureDate
        }
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } }
      },
      orderBy: { deliveryDate: 'asc' }
    });

    const formatted = requests.map(r => {
      const d = new Date(r.deliveryDate);
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = d.getUTCFullYear();
      return {
        ...r,
        formattedDeliveryDate: `${dd}/${mm}/${yyyy}`,
        dateString: `${yyyy}-${mm}-${dd}`
      };
    });

    res.status(200).json({
      success: true,
      data: formatted
    });
  } catch (err) {
    next(err);
  }
};

// [DELETE] /api/v1/portal/delivery-request/:token/:id
// Khách hủy báo hàng
const cancelDeliveryRequest = async (req, res, next) => {
  try {
    const { token, id } = req.params;
    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      select: { id: true, isActive: true }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị thu hồi.');
    }

    const request = await prisma.portalDeliveryRequest.findFirst({
      where: {
        id,
        portalLinkId: portalLink.id
      }
    });

    if (!request) {
      throw new NotFoundError('Không tìm thấy yêu cầu báo hàng.');
    }

    await prisma.portalDeliveryRequest.update({
      where: { id: request.id },
      data: {
        status: 'cancelled',
        updatedAt: new Date()
      }
    });

    res.status(200).json({
      success: true,
      message: 'Đã hủy báo hàng thành công!'
    });
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/manage/delivery-requests
// Chủ buôn lấy danh sách nhà hàng báo hàng theo ngày và đối soát công nợ
const getAdminDeliveryRequests = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { date, dateType = 'today' } = req.query;

    const { startOfDay, endOfDay, normalizedDate, dateString, displayDate } = getVnDateRange(date, dateType);

    // Lấy tất cả request báo hàng trong ngày của chủ buôn
    const requests = await prisma.portalDeliveryRequest.findMany({
      where: {
        userId,
        deliveryDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        status: { not: 'cancelled' }
      },
      include: {
        customer: { select: { id: true, name: true, phone: true, address: true } },
        portalLink: { select: { id: true, name: true, token: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Lấy thông tin công nợ phát sinh trong ngày này cho các khách hàng trên
    const customerIds = requests.map(r => r.customerId);
    let transactionsMap = {};

    if (customerIds.length > 0) {
      const transactions = await prisma.transaction.findMany({
        where: {
          userId,
          customerId: { in: customerIds },
          date: {
            gte: startOfDay,
            lte: endOfDay
          }
        },
        select: {
          id: true,
          customerId: true,
          totalAmount: true
        }
      });

      transactions.forEach(tx => {
        if (!transactionsMap[tx.customerId]) {
          transactionsMap[tx.customerId] = {
            count: 0,
            totalAmount: 0
          };
        }
        transactionsMap[tx.customerId].count += 1;
        transactionsMap[tx.customerId].totalAmount += Number(tx.totalAmount || 0);
      });
    }

    const items = requests.map(r => {
      const txInfo = transactionsMap[r.customerId];
      const hasDebt = Boolean(txInfo && txInfo.count > 0);
      return {
        ...r,
        formattedDeliveryDate: displayDate,
        dateString,
        hasDebt,
        debtCount: txInfo ? txInfo.count : 0,
        debtAmount: txInfo ? txInfo.totalAmount : 0
      };
    });

    const totalRequests = items.length;
    const confirmedCount = items.filter(i => i.isConfirmed).length;
    const billedCount = items.filter(i => i.hasDebt).length;
    const unbilledCount = totalRequests - billedCount;
    const unbilledCustomers = items.filter(i => !i.hasDebt).map(i => ({
      requestId: i.id,
      customerId: i.customerId,
      name: i.customer?.name,
      phone: i.customer?.phone,
      note: i.note,
      isConfirmed: i.isConfirmed
    }));

    res.status(200).json({
      success: true,
      data: {
        date: dateString,
        formattedDate: displayDate,
        summary: {
          totalRequests,
          confirmedCount,
          billedCount,
          unbilledCount
        },
        requests: items,
        unbilledCustomers
      }
    });
  } catch (err) {
    next(err);
  }
};

// [PUT] /api/v1/portal/manage/delivery-requests/:id/confirm
// Chủ buôn chốt / hủy chốt có hàng cho nhà hàng
const confirmDeliveryRequest = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { isConfirmed = true } = req.body;

    const request = await prisma.portalDeliveryRequest.findFirst({
      where: { id, userId }
    });

    if (!request) {
      throw new NotFoundError('Không tìm thấy yêu cầu báo hàng.');
    }

    const updated = await prisma.portalDeliveryRequest.update({
      where: { id },
      data: {
        isConfirmed: Boolean(isConfirmed),
        status: isConfirmed ? 'confirmed' : 'pending',
        confirmedAt: isConfirmed ? new Date() : null,
        updatedAt: new Date()
      },
      include: {
        customer: { select: { id: true, name: true } }
      }
    });

    res.status(200).json({
      success: true,
      message: isConfirmed ? 'Đã chốt có hàng cho nhà hàng thành công!' : 'Đã hủy chốt hàng.',
      data: updated
    });
  } catch (err) {
    next(err);
  }
};

// [PUT] /api/v1/portal/manage/delivery-requests/bulk-confirm
// Chủ buôn chốt hàng loạt
const bulkConfirmDeliveryRequests = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { ids, date, dateType = 'today', isConfirmed = true } = req.body;

    let whereClause = { userId, status: { not: 'cancelled' } };

    if (Array.isArray(ids) && ids.length > 0) {
      whereClause.id = { in: ids };
    } else {
      const { startOfDay, endOfDay } = getVnDateRange(date, dateType);
      whereClause.deliveryDate = {
        gte: startOfDay,
        lte: endOfDay
      };
    }

    const result = await prisma.portalDeliveryRequest.updateMany({
      where: whereClause,
      data: {
        isConfirmed: Boolean(isConfirmed),
        status: isConfirmed ? 'confirmed' : 'pending',
        confirmedAt: isConfirmed ? new Date() : null,
        updatedAt: new Date()
      }
    });

    res.status(200).json({
      success: true,
      message: `Đã ${isConfirmed ? 'chốt' : 'hủy chốt'} ${result.count} nhà hàng có hàng!`,
      data: { count: result.count }
    });
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/manage/delivery-requests/unbilled
// Kiểm tra danh sách các khách hàng đã báo hàng nhưng CHƯA CÓ CÔNG NỢ trong ngày
const checkUnbilledDeliveryRequests = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { date, dateType = 'today' } = req.query;

    const { startOfDay, endOfDay, dateString, displayDate } = getVnDateRange(date, dateType);

    const requests = await prisma.portalDeliveryRequest.findMany({
      where: {
        userId,
        deliveryDate: {
          gte: startOfDay,
          lte: endOfDay
        },
        status: { not: 'cancelled' }
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        portalLink: { select: { id: true, name: true } }
      }
    });

    if (requests.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          date: dateString,
          formattedDate: displayDate,
          totalRequests: 0,
          billedCount: 0,
          unbilledCount: 0,
          unbilledCustomers: []
        }
      });
    }

    const customerIds = requests.map(r => r.customerId);
    const existingTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        customerId: { in: customerIds },
        date: {
          gte: startOfDay,
          lte: endOfDay
        }
      },
      select: { customerId: true }
    });

    const billedCustomerSet = new Set(existingTransactions.map(t => t.customerId));

    const unbilledCustomers = requests
      .filter(r => !billedCustomerSet.has(r.customerId))
      .map(r => ({
        requestId: r.id,
        customerId: r.customerId,
        customerName: r.customer?.name || 'Khách hàng',
        phone: r.customer?.phone,
        portalName: r.portalLink?.name,
        note: r.note,
        isConfirmed: r.isConfirmed
      }));

    res.status(200).json({
      success: true,
      data: {
        date: dateString,
        formattedDate: displayDate,
        totalRequests: requests.length,
        billedCount: requests.length - unbilledCustomers.length,
        unbilledCount: unbilledCustomers.length,
        unbilledCustomers
      }
    });
  } catch (err) {
    next(err);
  }
};

// [DELETE] /api/v1/portal/manage/delivery-requests/:id
// Chủ buôn xóa lượt báo hàng
const deleteAdminDeliveryRequest = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;

    const request = await prisma.portalDeliveryRequest.findFirst({
      where: { id, userId }
    });

    if (!request) {
      throw new NotFoundError('Không tìm thấy yêu cầu báo hàng.');
    }

    await prisma.portalDeliveryRequest.delete({
      where: { id }
    });

    res.status(200).json({
      success: true,
      message: 'Đã xóa lượt báo hàng thành công!'
    });
  } catch (err) {
    next(err);
  }
};

// Helper lấy số ngày trong tháng
const getDaysInMonthForSalary = (year, month) => {
  return new Date(year, month, 0).getDate();
};

// Helper parse monthKey "MM/YYYY"
const parseMonthKeyForSalary = (monthKey) => {
  if (!monthKey || typeof monthKey !== 'string') return null;
  const parts = monthKey.split('/');
  if (parts.length !== 2) return null;
  const month = parseInt(parts[0], 10);
  const year = parseInt(parts[1], 10);
  if (isNaN(month) || isNaN(year) || month < 1 || month > 12) return null;
  return { month, year };
};

// [GET] /api/v1/portal/employee-salary/info/:token
// Lấy thông tin cơ bản để xác thực PIN tra cứu lương nhân viên
const getEmployeeSalaryPortalInfo = async (req, res, next) => {
  try {
    const { token } = req.params;
    let decoded;
    try {
      decoded = jwt.verify(token, PORTAL_SESSION_SECRET);
    } catch (e) {
      throw new NotFoundError('Đường dẫn tra cứu không hợp lệ hoặc đã hết hạn.');
    }

    if (decoded.type !== 'EMPLOYEE_SALARY' || !decoded.employeeId) {
      throw new BadRequestError('Loại đường dẫn tra cứu không hợp lệ.');
    }

    const employee = await prisma.employee.findUnique({
      where: { id: decoded.employeeId },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!employee || !employee.isActive) {
      throw new NotFoundError('Nhân viên không tồn tại hoặc đã ngừng hoạt động.');
    }

    const cleanPhone = (employee.phone || '').replace(/[^0-9]/g, '');
    const hasPin = cleanPhone.length >= 4;

    res.status(200).json({
      success: true,
      data: {
        employeeName: employee.name,
        role: employee.role || 'Nhân viên',
        merchantName: employee.user?.name || 'Cửa hàng',
        hasPin,
        pinHint: hasPin ? `Nhập 4 số cuối số điện thoại (...${cleanPhone.slice(-4)})` : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/employee-salary/data/:token
// Lấy chi tiết lương, các đợt tạm ứng, chấm công và ngày nghỉ theo tháng
const getEmployeeSalaryPortalData = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { monthKey, pin } = req.query;
    const headerPin = req.headers['x-portal-pin'];
    const clientPin = (headerPin || pin || '').toString().trim();

    let decoded;
    try {
      decoded = jwt.verify(token, PORTAL_SESSION_SECRET);
    } catch (e) {
      throw new NotFoundError('Đường dẫn tra cứu không hợp lệ hoặc đã hết hạn.');
    }

    if (decoded.type !== 'EMPLOYEE_SALARY' || !decoded.employeeId) {
      throw new BadRequestError('Loại đường dẫn tra cứu không hợp lệ.');
    }

    const employee = await prisma.employee.findUnique({
      where: { id: decoded.employeeId },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!employee || !employee.isActive) {
      throw new NotFoundError('Nhân viên không tồn tại hoặc đã ngừng hoạt động.');
    }

    const cleanPhone = (employee.phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length >= 4) {
      const correctPin = cleanPhone.slice(-4);
      if (clientPin !== correctPin) {
        throw new ForbiddenError('Mã PIN không chính xác. Vui lòng nhập 4 số cuối số điện thoại của bạn.');
      }
    }

    // Xác định tháng xem
    let targetMonthKey = monthKey;
    if (!targetMonthKey) {
      const now = new Date();
      targetMonthKey = `${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
    }

    const parsed = parseMonthKeyForSalary(targetMonthKey);
    if (!parsed) {
      throw new BadRequestError('Định dạng tháng không hợp lệ (MM/YYYY).');
    }

    const { month, year } = parsed;
    const totalDaysInMonth = getDaysInMonthForSalary(year, month);
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    // 1. Chấm công trong tháng
    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: employee.id,
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      orderBy: { date: 'asc' },
    });

    const { eligibleDays, joinedMidMonth, startDayInMonth } = getEligibleDaysForEmployee(
      employee.startDate,
      year,
      month,
      totalDaysInMonth
    );

    let workingDays = eligibleDays;
    let fullDaysCount = 0;
    let halfDaysCount = 0;
    let absentDaysCount = 0;

    attendances.forEach((att) => {
      const attD = new Date(att.date);
      if (attD.getDate() >= startDayInMonth) {
        if (att.status === 'ABSENT') {
          workingDays -= 1.0;
          absentDaysCount += 1;
        } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
          workingDays -= 0.5;
          halfDaysCount += 1;
        } else if (att.status === 'PRESENT') {
          fullDaysCount += 1;
        }
      }
    });

    workingDays = Math.max(0, workingDays);

    // 2. Tạm ứng trong tháng
    const advances = await prisma.salaryAdvance.findMany({
      where: {
        employeeId: employee.id,
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      orderBy: { date: 'asc' },
    });
    const totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);

    // 3. Chốt thanh toán lương (nếu chủ đã chốt)
    const payment = await prisma.salaryPayment.findFirst({
      where: {
        employeeId: employee.id,
        monthKey: targetMonthKey,
      },
    });

    const baseSalary = parseFloat(employee.baseSalary);
    const dailySalary = Math.round(baseSalary / totalDaysInMonth);
    let calculatedSalary = 0;
    if (eligibleDays > 0) {
      if (joinedMidMonth) {
        calculatedSalary = Math.round(dailySalary * workingDays);
      } else {
        const leaveDays = absentDaysCount + halfDaysCount * 0.5;
        calculatedSalary = Math.max(0, baseSalary - Math.round(leaveDays * dailySalary));
      }
    }
    const bonus = payment ? parseFloat(payment.bonus) : 0;
    const deductions = payment ? parseFloat(payment.deductions) : 0;
    const finalAmount = payment
      ? parseFloat(payment.finalAmount)
      : Math.max(0, calculatedSalary - totalAdvances);

    // Danh sách ngày nghỉ / nửa buổi đối soát
    const leaves = attendances
      .filter((att) => {
        const attD = new Date(att.date);
        return attD.getDate() >= startDayInMonth && (att.status === 'ABSENT' || (att.status === 'PRESENT' && att.shift === 'HALF'));
      })
      .map((att) => ({
        id: att.id,
        date: att.date.toISOString().split('T')[0],
        status: att.status,
        shift: att.shift,
        note: att.note || '',
      }));

    res.status(200).json({
      success: true,
      data: {
        employee: {
          id: employee.id,
          name: employee.name,
          role: employee.role || 'Nhân viên',
          phone: employee.phone,
        },
        merchant: {
          name: employee.user?.name || 'Cửa hàng',
          phone: employee.user?.phone,
        },
        monthKey: targetMonthKey,
        totalDaysInMonth,
        workingDays,
        stats: {
          fullDaysCount,
          halfDaysCount,
          absentDaysCount,
        },
        salary: {
          baseSalary,
          dailySalary,
          calculatedSalary,
          totalAdvances,
          bonus,
          deductions,
          finalAmount,
          isPaid: !!payment,
          paidAt: payment ? payment.paidAt : null,
          paymentNote: payment ? payment.note : null,
        },
        advances: advances.map((adv) => ({
          id: adv.id,
          amount: parseFloat(adv.amount),
          date: adv.date.toISOString().split('T')[0],
          note: adv.note || '',
        })),
        leaves,
        attendances: attendances.map((att) => ({
          id: att.id,
          date: att.date.toISOString().split('T')[0],
          status: att.status,
          shift: att.shift,
          note: att.note || '',
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/staff/info/:token
// Lấy thông tin cổng nhân sự chung hoặc riêng (danh sách nhân viên để chọn tra cứu & tên cửa hàng)
const getStaffPortalInfo = async (req, res, next) => {
  try {
    const { token } = req.params;
    let decoded;
    try {
      decoded = jwt.verify(token, PORTAL_SESSION_SECRET);
    } catch (e) {
      throw new NotFoundError('Đường dẫn tra cứu không hợp lệ hoặc đã hết hạn.');
    }

    if (decoded.type === 'STAFF_PORTAL') {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, name: true, phone: true },
      });

      if (!user) {
        throw new NotFoundError('Không tìm thấy thông tin cửa hàng.');
      }

      const employees = await prisma.employee.findMany({
        where: { userId: decoded.userId, isActive: true },
        select: { id: true, name: true, role: true, phone: true },
        orderBy: { name: 'asc' },
      });

      return res.status(200).json({
        success: true,
        data: {
          isGeneral: true,
          merchantName: user.name || 'Cửa hàng',
          employees: employees.map((e) => {
            const cleanPhone = (e.phone || '').replace(/[^0-9]/g, '');
            return {
              id: e.id,
              name: e.name,
              role: e.role || 'Nhân viên',
              hasPin: cleanPhone.length >= 4,
            };
          }),
        },
      });
    } else if (decoded.type === 'EMPLOYEE_SALARY') {
      // Tương thích ngược với link cũ của 1 nhân viên
      const employee = await prisma.employee.findUnique({
        where: { id: decoded.employeeId },
        include: { user: { select: { id: true, name: true, phone: true } } },
      });

      if (!employee || !employee.isActive) {
        throw new NotFoundError('Nhân viên không tồn tại hoặc đã ngừng hoạt động.');
      }

      const cleanPhone = (employee.phone || '').replace(/[^0-9]/g, '');
      const hasPin = cleanPhone.length >= 4;

      return res.status(200).json({
        success: true,
        data: {
          isGeneral: false,
          employeeId: employee.id,
          employeeName: employee.name,
          role: employee.role || 'Nhân viên',
          merchantName: employee.user?.name || 'Cửa hàng',
          hasPin,
          pinHint: hasPin ? `Nhập 4 số cuối số điện thoại (...${cleanPhone.slice(-4)})` : null,
        },
      });
    }

    throw new BadRequestError('Loại đường dẫn tra cứu không hợp lệ.');
  } catch (err) {
    next(err);
  }
};

// [GET] /api/v1/portal/staff/salary/:token
// Tra cứu bảng lương của nhân viên (có xác thực PIN cá nhân)
const getStaffPortalSalaryData = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { employeeId, monthKey, pin } = req.query;
    const headerPin = req.headers['x-portal-pin'];
    const clientPin = (headerPin || pin || '').toString().trim();

    let decoded;
    try {
      decoded = jwt.verify(token, PORTAL_SESSION_SECRET);
    } catch (e) {
      throw new NotFoundError('Đường dẫn tra cứu không hợp lệ hoặc đã hết hạn.');
    }

    let targetEmployeeId = employeeId;
    if (decoded.type === 'EMPLOYEE_SALARY') {
      targetEmployeeId = decoded.employeeId;
    } else if (decoded.type !== 'STAFF_PORTAL') {
      throw new BadRequestError('Loại đường dẫn tra cứu không hợp lệ.');
    }

    if (!targetEmployeeId) {
      throw new BadRequestError('Vui lòng chọn nhân viên cần tra cứu.');
    }

    const employee = await prisma.employee.findUnique({
      where: { id: targetEmployeeId },
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!employee || !employee.isActive) {
      throw new NotFoundError('Nhân viên không tồn tại hoặc đã ngừng hoạt động.');
    }

    // Nếu token chung, kiểm tra nhân viên phải thuộc cửa hàng của token
    if (decoded.type === 'STAFF_PORTAL' && employee.userId !== decoded.userId) {
      throw new ForbiddenError('Nhân viên không thuộc cửa hàng này.');
    }

    // Xác thực PIN (4 số cuối SĐT)
    const cleanPhone = (employee.phone || '').replace(/[^0-9]/g, '');
    if (cleanPhone.length >= 4) {
      const correctPin = cleanPhone.slice(-4);
      if (clientPin !== correctPin) {
        throw new ForbiddenError('Mã PIN không chính xác. Vui lòng nhập 4 số cuối số điện thoại của bạn.');
      }
    }

    // Xác định tháng xem
    let targetMonthKey = monthKey;
    if (!targetMonthKey) {
      const now = new Date();
      targetMonthKey = `${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getFullYear()}`;
    }

    const parsed = parseMonthKeyForSalary(targetMonthKey);
    if (!parsed) {
      throw new BadRequestError('Định dạng tháng không hợp lệ (MM/YYYY).');
    }

    const { month, year } = parsed;
    const totalDaysInMonth = getDaysInMonthForSalary(year, month);
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    // 1. Ngày nghỉ trong tháng
    const attendances = await prisma.attendance.findMany({
      where: {
        employeeId: employee.id,
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      orderBy: { date: 'asc' },
    });

    const { eligibleDays, joinedMidMonth, startDayInMonth } = getEligibleDaysForEmployee(
      employee.startDate,
      year,
      month,
      totalDaysInMonth
    );

    let leaveDays = 0;
    attendances.forEach((att) => {
      const attD = new Date(att.date);
      if (attD.getDate() >= startDayInMonth) {
        if (att.status === 'ABSENT') {
          leaveDays += (att.shift === 'HALF' ? 0.5 : 1.0);
        } else if (att.status === 'PRESENT' && att.shift === 'HALF') {
          leaveDays += 0.5;
        }
      }
    });

    const workingDays = Math.max(0, eligibleDays - leaveDays);

    // 2. Lương 1 ngày và tổng lương sau khi trừ ngày nghỉ
    const baseSalary = parseFloat(employee.baseSalary);
    const dailySalary = Math.round(baseSalary / totalDaysInMonth);
    const leaveDeduction = Math.round(leaveDays * dailySalary);
    let calculatedSalary = 0;
    if (eligibleDays > 0) {
      if (joinedMidMonth) {
        calculatedSalary = Math.round(dailySalary * workingDays);
      } else {
        calculatedSalary = Math.max(0, baseSalary - leaveDeduction);
      }
    }

    // 3. Tạm ứng trong tháng
    const advances = await prisma.salaryAdvance.findMany({
      where: {
        employeeId: employee.id,
        date: { gte: startOfMonth, lte: endOfMonth },
      },
      orderBy: { date: 'asc' },
    });
    const totalAdvances = advances.reduce((sum, adv) => sum + parseFloat(adv.amount), 0);

    // 4. Lương thực lĩnh
    const finalAmount = Math.max(0, calculatedSalary - totalAdvances);

    // 5. Kiểm tra chốt lương
    const payment = await prisma.salaryPayment.findFirst({
      where: {
        employeeId: employee.id,
        monthKey: targetMonthKey,
      },
    });

    const leaves = attendances
      .filter((att) => {
        const attD = new Date(att.date);
        return attD.getDate() >= startDayInMonth && (att.status === 'ABSENT' || (att.status === 'PRESENT' && att.shift === 'HALF'));
      })
      .map((att) => ({
        id: att.id,
        date: att.date.toISOString().split('T')[0],
        status: att.status,
        shift: att.shift,
        note: att.note || '',
      }));

    res.status(200).json({
      success: true,
      data: {
        employee: {
          id: employee.id,
          name: employee.name,
          phone: employee.phone,
          role: employee.role,
        },
        merchantName: employee.user?.name || 'Cửa hàng',
        monthKey: targetMonthKey,
        totalDaysInMonth,
        workingDays,
        stats: {
          leaveDays,
          leaveDeduction,
          totalAdvances,
        },
        salary: {
          baseSalary,
          dailySalary,
          calculatedSalary,
          totalAdvances,
          finalAmount,
        },
        payment: payment
          ? {
              isPaid: true,
              paidAt: payment.paidAt,
              finalAmount: parseFloat(payment.finalAmount),
              note: payment.note,
            }
          : { isPaid: false },
        advances: advances.map((adv) => ({
          id: adv.id,
          date: adv.date.toISOString().split('T')[0],
          amount: parseFloat(adv.amount),
          note: adv.note || '',
        })),
        leaves,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────
// CÁC API THAO TÁC CÔNG NỢ TRỰC TIẾP TỪ ZALO PORTAL (CẦN MÃ PIN BẢO MẬT)
// ─────────────────────────────────────────────────────────────

// Helper ký action token cho thao tác công nợ trên portal khi đã xác thực PIN chủ buôn
const signDebtActionToken = (portalLinkId, userId) => {
  return jwt.sign(
    { portalLinkId, userId, type: 'PORTAL_DEBT_ACTION' },
    PORTAL_SESSION_SECRET,
    { expiresIn: '12h' }
  );
};

// Helper xác thực session thao tác công nợ của chủ buôn
const verifyDebtActionSession = (req, portalLink) => {
  const headers = req.headers || {};
  const query = req.query || {};

  let actionToken = headers['x-portal-action-token'] || query.actionToken;
  if (!actionToken && headers['authorization'] && headers['authorization'].startsWith('Bearer ')) {
    actionToken = headers['authorization'].split(' ')[1];
  }

  if (!actionToken) {
    throw new UnauthorizedError('Yêu cầu mã xác thực thao tác công nợ. Vui lòng nhập mã PIN.');
  }

  try {
    const decoded = jwt.verify(actionToken, PORTAL_SESSION_SECRET);
    if (decoded.type !== 'PORTAL_DEBT_ACTION' || decoded.portalLinkId !== portalLink.id) {
      throw new ForbiddenError('Phiên thao tác công nợ không hợp lệ hoặc đã hết hạn.');
    }
    return decoded;
  } catch (err) {
    throw new ForbiddenError('Phiên thao tác công nợ không hợp lệ hoặc đã hết hạn. Vui lòng nhập lại mã PIN.');
  }
};

// [POST] /api/v1/portal/debt-action/verify-pin/:token
// Xác thực mã PIN để mở khóa thao tác chỉnh sửa / thu công nợ trên Portal
const verifyPortalDebtActionPin = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { pin } = req.body;

    if (!pin) {
      throw new BadRequestError('Vui lòng nhập mã PIN bảo mật.');
    }

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        user: {
          select: { id: true, name: true, pin: true }
        }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị khóa.');
    }

    let isPinMatch = false;

    // 1. Mã PIN xác thực quyền chủ buôn riêng cho phần này: 031070
    if (String(pin).trim() === '031070') {
      isPinMatch = true;
    }

    // 2. So khớp mã PIN với mã PIN của tài khoản chủ buôn (được băm bcrypt)
    if (!isPinMatch && portalLink.user?.pin) {
      try {
        isPinMatch = await bcrypt.compare(String(pin).trim(), portalLink.user.pin);
      } catch (e) {
        isPinMatch = false;
      }
    }

    // 3. Fallback: Nếu chủ buôn có cài mã PIN riêng cho link này (4 số)
    if (!isPinMatch && portalLink.pin) {
      isPinMatch = String(portalLink.pin).trim() === String(pin).trim();
    }

    if (!isPinMatch) {
      throw new BadRequestError('Mã PIN bảo mật không chính xác. Vui lòng thử lại.');
    }

    const actionToken = signDebtActionToken(portalLink.id, portalLink.userId);

    res.json({
      success: true,
      message: 'Xác thực mã PIN thành công. Đã mở khóa quyền thao tác công nợ.',
      actionToken,
    });
  } catch (err) {
    next(err);
  }
};

// Helper tính toán các ngày còn nợ của một khách hàng phục vụ trả nợ theo ngày
const computeUnpaidDaysForCustomer = (transactions, payments) => {
  const dayMap = {};

  // 1. Gom nhóm transactions theo ngày DD/MM/YYYY
  transactions.forEach((tx) => {
    const d = new Date(tx.date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const dateKey = `${day}/${month}/${year}`;
    const dateStr = `${year}-${month}-${day}`;

    if (!dayMap[dateKey]) {
      const weekdays = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
      const weekday = weekdays[d.getDay()];

      dayMap[dateKey] = {
        dateKey,
        dateStr,
        dateObj: d,
        weekday,
        totalDebt: 0,
        paidAmount: 0,
        remainingDebt: 0,
        itemsList: [],
      };
    }

    const txAmt = parseFloat(tx.totalAmount) || 0;
    dayMap[dateKey].totalDebt += txAmt;

    if (tx.items && tx.items.length > 0) {
      tx.items.forEach((it) => {
        const pName = it.product?.name || it.productName || 'Thịt';
        const q = parseFloat(it.quantity) || 0;
        const u = it.product?.unit || 'kg';
        dayMap[dateKey].itemsList.push(`${pName} (${q}${u})`);
      });
    }
  });

  const sortedDays = Object.values(dayMap).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  // Chuẩn bị danh sách thanh toán
  const cashPayments = payments.map((p) => ({
    id: p.id,
    amount: parseFloat(p.amount) || 0,
    remaining: parseFloat(p.amount) || 0,
    paidAt: new Date(p.paidAt),
    note: p.note || '',
  })).sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime());

  // Helper trừ tiền thanh toán vào ngày
  const applyPayment = (pm, day) => {
    if (pm.remaining <= 0 || day.paidAmount >= day.totalDebt) return;
    const toPay = day.totalDebt - day.paidAmount;
    const used = Math.min(pm.remaining, toPay);
    day.paidAmount += used;
    pm.remaining -= used;
  };

  // Bước A: Thanh toán theo ngày cụ thể: "Thanh toán nợ ngày DD/MM/YYYY"
  cashPayments.forEach((pm) => {
    if (pm.remaining <= 0) return;
    const trimNote = (pm.note || '').trim();
    const dateMatch = trimNote.match(/^Thanh toán (?:nợ\s+)?ngày (\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (dateMatch) {
      const dKey = `${String(dateMatch[1]).padStart(2, '0')}/${String(dateMatch[2]).padStart(2, '0')}/${dateMatch[3]}`;
      const targetDay = dayMap[dKey];
      if (targetDay) {
        applyPayment(pm, targetDay);
      }
    }
  });

  // Bước B: Thanh toán theo tháng cụ thể: "Thanh toán nợ Tháng MM/YYYY"
  cashPayments.forEach((pm) => {
    if (pm.remaining <= 0) return;
    const trimNote = (pm.note || '').trim();
    const monthMatch = trimNote.match(/^Thanh toán (?:nợ|hóa đơn)?\s*[Tt]háng (\d{1,2})\/(\d{4})/i);
    if (monthMatch) {
      const targetMKey = `${String(monthMatch[1]).padStart(2, '0')}/${monthMatch[2]}`;
      const monthDays = sortedDays.filter((d) => {
        const dm = String(d.dateObj.getMonth() + 1).padStart(2, '0');
        const dy = d.dateObj.getFullYear();
        return `${dm}/${dy}` === targetMKey;
      });
      for (const day of monthDays) {
        if (pm.remaining <= 0) break;
        applyPayment(pm, day);
      }
    }
  });

  // Bước C: Phân bổ chung FIFO cho các khoản thanh toán còn lại
  sortedDays.forEach((day) => {
    while (day.paidAmount < day.totalDebt) {
      const pm = cashPayments.find((p) => p.remaining > 0);
      if (!pm) break;
      applyPayment(pm, day);
    }
  });

  // Lọc ra các ngày còn nợ (> 0) và sắp xếp ngày mới nhất lên đầu
  const unpaidDays = sortedDays
    .map((day) => {
      const remainingDebt = Math.max(0, Math.round(day.totalDebt - day.paidAmount));
      return {
        dateKey: day.dateKey,
        dateStr: day.dateStr,
        weekday: day.weekday,
        totalDebt: Math.round(day.totalDebt),
        paidAmount: Math.round(day.paidAmount),
        remainingDebt,
        itemsSummary: day.itemsList.slice(0, 3).join(', ') + (day.itemsList.length > 3 ? '...' : ''),
      };
    })
    .filter((day) => day.remainingDebt > 0)
    .sort((a, b) => b.dateStr.localeCompare(a.dateStr));

  return unpaidDays;
};

// [GET] /api/v1/portal/debt-action/bootstrap/:token
// Lấy danh mục hàng hóa, danh sách khách hàng và đơn giá riêng phục vụ ghi nợ / thu nợ trên portal
const getPortalDebtActionBootstrap = async (req, res, next) => {
  try {
    const { token } = req.params;
    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: {
          include: {
            customer: true
          }
        }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị khóa.');
    }

    verifyDebtActionSession(req, portalLink);

    const customerIds = portalLink.customers.map(c => c.customerId);
    const userId = portalLink.userId;

    const [products, customPrices, recentTransactions, recentPayments] = await Promise.all([
      prisma.product.findMany({
        where: { userId, isActive: true },
        select: { id: true, name: true, defaultPrice: true, costPrice: true, unit: true },
        orderBy: { name: 'asc' }
      }),
      prisma.customerProductPrice.findMany({
        where: { customerId: { in: customerIds } },
        include: {
          product: { select: { id: true, name: true, unit: true } }
        }
      }),
      prisma.transaction.findMany({
        where: { customerId: { in: customerIds } },
        include: {
          customer: { select: { id: true, name: true } },
          items: {
            include: {
              product: { select: { id: true, name: true, unit: true } }
            }
          }
        },
        orderBy: { date: 'desc' },
        take: 200
      }),
      prisma.payment.findMany({
        where: { customerId: { in: customerIds } },
        include: {
          customer: { select: { id: true, name: true } }
        },
        orderBy: { paidAt: 'desc' },
        take: 200
      })
    ]);

    // Tính công nợ hiện tại và các ngày nợ còn lại của từng khách
    const customersWithDebt = await Promise.all(portalLink.customers.map(async (pc) => {
      const c = pc.customer;
      const [purchases, payments] = await Promise.all([
        prisma.transaction.aggregate({
          where: { customerId: c.id },
          _sum: { totalAmount: true }
        }),
        prisma.payment.aggregate({
          where: { customerId: c.id },
          _sum: { amount: true }
        })
      ]);
      const totalPurchase = Math.round(Number(purchases._sum.totalAmount || 0));
      const totalPaid = Math.round(Number(payments._sum.amount || 0));
      let debt = Math.round(totalPurchase - totalPaid + Number(c.manualDebt || 0));
      if (Math.abs(debt) < 1) debt = 0;

      // Tính danh sách các ngày còn nợ theo chuẩn FIFO & specific matching
      const custTransactions = recentTransactions.filter((tx) => tx.customerId === c.id);
      const custPayments = recentPayments.filter((p) => p.customerId === c.id);
      const unpaidDays = computeUnpaidDaysForCustomer(custTransactions, custPayments);

      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        address: c.address,
        debt,
        unpaidDays,
      };
    }));

    res.json({
      success: true,
      data: {
        customers: customersWithDebt,
        products,
        customPrices,
        recentTransactions,
        recentPayments
      }
    });
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/debt-action/collect-debt/:token
// Thu tiền công nợ khách hàng trực tiếp từ Portal (hỗ trợ cả thu theo số tiền hoặc theo nhiều ngày)
const submitPortalCollectDebt = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { customerId, amount, paidAt, note, payments } = req.body;

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: true,
        user: { select: { id: true, name: true } }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị khóa.');
    }

    verifyDebtActionSession(req, portalLink);

    if (!customerId) {
      throw new BadRequestError('Vui lòng chọn khách hàng.');
    }

    const allowedIds = portalLink.customers.map(c => c.customerId);
    if (!allowedIds.includes(customerId)) {
      throw new ForbiddenError('Khách hàng này không thuộc phạm vi của nhóm Zalo Portal.');
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });
    if (!customer) throw new NotFoundError('Không tìm thấy khách hàng.');

    // ─── TRƯỜNG HỢP 1: THU NỢ THEO NHIỀU NGÀY (BATCH/BY_DAY) ───
    if (Array.isArray(payments) && payments.length > 0) {
      const createdPayments = [];
      let totalCollected = 0;
      for (const item of payments) {
        const itemAmt = parseFloat(item.amount);
        if (isNaN(itemAmt) || itemAmt <= 0) continue;
        const itemPaidAt = item.paidAt ? new Date(item.paidAt) : new Date();
        const pRecord = await prisma.payment.create({
          data: {
            customerId,
            createdBy: portalLink.userId,
            amount: itemAmt,
            paidAt: itemPaidAt,
            note: item.note ? item.note.trim() : null,
          },
        });
        createdPayments.push(pRecord);
        totalCollected += itemAmt;
      }

      await prisma.portalLink.update({
        where: { id: portalLink.id },
        data: { lastPublishedAt: new Date() }
      });

      logActivity(
        portalLink.userId,
        'PORTAL_COLLECT_DEBT',
        `Thu nợ qua Zalo Portal (${createdPayments.length} ngày): ${customer.name} trả tổng ${new Intl.NumberFormat('vi-VN').format(totalCollected)}đ`
      );

      emitWorkspaceEvent(portalLink.userId, 'CUSTOMER_UPDATED', {
        action: 'PORTAL_COLLECT_DEBT',
        userId: portalLink.userId,
        customerId,
        totalCollected,
      });

      return res.json({
        success: true,
        message: `Thu tiền công nợ thành công cho ${createdPayments.length} ngày.`,
        data: createdPayments,
      });
    }

    // ─── TRƯỜNG HỢP 2: THU NỢ THEO SỐ TIỀN ĐƠN LẺ ───
    if (amount === undefined) {
      throw new BadRequestError('Vui lòng nhập số tiền thanh toán.');
    }

    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      throw new BadRequestError('Số tiền thanh toán phải lớn hơn 0.');
    }

    const paymentPaidAt = paidAt ? new Date(paidAt) : new Date();

    const payment = await prisma.payment.create({
      data: {
        customerId,
        createdBy: portalLink.userId,
        amount: payAmount,
        paidAt: paymentPaidAt,
        note: note ? note.trim() : null,
      },
      include: {
        customer: { select: { name: true, phone: true } }
      }
    });

    // Cập nhật lastPublishedAt để portal phản ánh số liệu mới ngay lập tức
    await prisma.portalLink.update({
      where: { id: portalLink.id },
      data: { lastPublishedAt: new Date() }
    });

    logActivity(
      portalLink.userId,
      'PORTAL_COLLECT_DEBT',
      `Thu nợ qua Zalo Portal: ${customer.name} trả ${new Intl.NumberFormat('vi-VN').format(payAmount)}đ`
    );

    emitWorkspaceEvent(portalLink.userId, 'CUSTOMER_UPDATED', {
      action: 'PORTAL_COLLECT_DEBT',
      userId: portalLink.userId,
      customerId,
      paymentId: payment.id,
      amount: payAmount
    });

    res.json({
      success: true,
      message: 'Thu tiền công nợ thành công.',
      data: payment
    });
  } catch (err) {
    next(err);
  }
};

// [POST] /api/v1/portal/debt-action/create-debt/:token
// Ghi nợ đơn hàng mới trực tiếp từ Portal
const submitPortalCreateDebt = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { customerId, date, note, items, invoiceImage } = req.body;

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: true,
        user: { select: { id: true, name: true } }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị khóa.');
    }

    verifyDebtActionSession(req, portalLink);

    if (!customerId) {
      throw new BadRequestError('Vui lòng chọn khách hàng.');
    }

    const allowedIds = portalLink.customers.map(c => c.customerId);
    if (!allowedIds.includes(customerId)) {
      throw new ForbiddenError('Khách hàng này không thuộc phạm vi của nhóm Zalo Portal.');
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Đơn nợ phải có ít nhất một mặt hàng.');
    }

    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });
    if (!customer) throw new NotFoundError('Không tìm thấy khách hàng.');

    const userId = portalLink.userId;
    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true }
    });
    const productMap = new Map(allUserProducts.map(p => [p.id, p]));

    let calculatedTotal = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, productName, quantity: reqQuantity, price: reqPrice, costPrice: reqCostPrice } = item;
      if (reqQuantity === undefined || reqPrice === undefined) {
        throw new BadRequestError('Mỗi dòng mặt hàng phải chứa thông tin số lượng và giá bán.');
      }

      let finalProductId = productId;
      if (productName && productName.trim()) {
        const trimmedName = productName.trim();
        const norm = trimmedName.toLowerCase().replace(/\s+/g, '');
        let matched = allUserProducts.find(p => p.name.toLowerCase().replace(/\s+/g, '') === norm);
        if (!matched) {
          matched = await prisma.product.create({
            data: {
              userId,
              createdBy: userId,
              name: trimmedName,
              defaultPrice: parseFloat(reqPrice) || 0,
              costPrice: reqCostPrice !== undefined ? parseFloat(reqCostPrice) : 0,
              unit: 'kg'
            }
          });
          allUserProducts.push(matched);
          productMap.set(matched.id, matched);
        }
        finalProductId = matched.id;
      }

      if (!finalProductId) {
        throw new BadRequestError('Không thể xác định sản phẩm cho dòng mặt hàng này.');
      }

      const product = productMap.get(finalProductId);
      if (!product) throw new NotFoundError('Sản phẩm thịt không tồn tại.');

      const qty = parseFloat(reqQuantity);
      const prc = parseFloat(reqPrice);
      const cp = reqCostPrice !== undefined ? parseFloat(reqCostPrice) : (parseFloat(product.costPrice) || 0);

      const subtotal = Math.round(qty * prc);
      const itemCost = Math.round(qty * cp);
      const itemProfit = subtotal - itemCost;
      calculatedTotal += subtotal;

      formattedItems.push({
        productId: finalProductId,
        quantity: qty,
        price: prc,
        costPrice: cp,
        amount: subtotal,
        profit: itemProfit,
      });
    }

    const txDate = date ? new Date(date) : new Date();

    const transaction = await prisma.transaction.create({
      data: {
        userId,
        customerId,
        createdBy: userId,
        date: txDate,
        totalAmount: calculatedTotal,
        note: note ? note.trim() : null,
        items: {
          create: formattedItems
        }
      },
      include: {
        customer: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, unit: true } }
          }
        }
      }
    });

    await prisma.portalLink.update({
      where: { id: portalLink.id },
      data: { lastPublishedAt: new Date() }
    });

    logActivity(
      portalLink.userId,
      'PORTAL_CREATE_DEBT',
      `Ghi nợ qua Zalo Portal: ${customer.name} - Tổng tiền: ${new Intl.NumberFormat('vi-VN').format(calculatedTotal)}đ`
    );

    emitWorkspaceEvent(portalLink.userId, 'CUSTOMER_UPDATED', {
      action: 'PORTAL_CREATE_DEBT',
      userId: portalLink.userId,
      customerId,
      transactionId: transaction.id,
      amount: calculatedTotal
    });

    let invoiceRecord = null;
    if (invoiceImage && typeof invoiceImage === 'string' && invoiceImage.trim()) {
      try {
        const savedImageUrl = await processPortalMediaUpload(invoiceImage);
        if (savedImageUrl) {
          invoiceRecord = await prisma.transactionInvoice.create({
            data: {
              userId,
              customerId,
              transactionId: transaction.id,
              date: txDate,
              imageUrl: savedImageUrl,
              note: note ? `Hóa đơn: ${note}` : 'Ảnh hóa đơn Zalo Portal',
            },
          });
        }
      } catch (imgErr) {
        console.warn('[PORTAL_CREATE_DEBT] Lỗi lưu ảnh hóa đơn:', imgErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Ghi nợ đơn hàng thành công.',
      data: {
        ...transaction,
        invoice: invoiceRecord,
      }
    });
  } catch (err) {
    next(err);
  }
};

// [PUT] /api/v1/portal/debt-action/update-debt/:token/:transactionId
// Cập nhật đơn nợ trực tiếp từ Portal
const submitPortalUpdateDebt = async (req, res, next) => {
  try {
    const { token, transactionId } = req.params;
    const { date, note, items } = req.body;

    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: {
        customers: true,
        user: { select: { id: true, name: true } }
      }
    });

    if (!portalLink || !portalLink.isActive) {
      throw new NotFoundError('Đường dẫn không tồn tại hoặc đã bị khóa.');
    }

    verifyDebtActionSession(req, portalLink);

    const allowedIds = portalLink.customers.map(c => c.customerId);
    const existingTx = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        customerId: { in: allowedIds },
        userId: portalLink.userId
      },
      include: {
        customer: true,
        items: true
      }
    });

    if (!existingTx) {
      throw new NotFoundError('Không tìm thấy đơn nợ hoặc đơn nợ không thuộc quyền quản lý của link này.');
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw new BadRequestError('Đơn nợ phải có ít nhất một mặt hàng.');
    }

    const userId = portalLink.userId;
    const allUserProducts = await prisma.product.findMany({
      where: { userId, isActive: true }
    });
    const productMap = new Map(allUserProducts.map(p => [p.id, p]));

    let calculatedTotal = 0;
    const formattedItems = [];

    for (const item of items) {
      const { productId, productName, quantity: reqQuantity, price: reqPrice, costPrice: reqCostPrice } = item;
      if (reqQuantity === undefined || reqPrice === undefined) {
        throw new BadRequestError('Mỗi dòng mặt hàng phải chứa thông tin số lượng và giá bán.');
      }

      let finalProductId = productId;
      if (productName && productName.trim()) {
        const trimmedName = productName.trim();
        const norm = trimmedName.toLowerCase().replace(/\s+/g, '');
        let matched = allUserProducts.find(p => p.name.toLowerCase().replace(/\s+/g, '') === norm);
        if (!matched) {
          matched = await prisma.product.create({
            data: {
              userId,
              createdBy: userId,
              name: trimmedName,
              defaultPrice: parseFloat(reqPrice) || 0,
              costPrice: reqCostPrice !== undefined ? parseFloat(reqCostPrice) : 0,
              unit: 'kg'
            }
          });
          allUserProducts.push(matched);
          productMap.set(matched.id, matched);
        }
        finalProductId = matched.id;
      }

      if (!finalProductId) {
        throw new BadRequestError('Không thể xác định sản phẩm cho dòng mặt hàng này.');
      }

      const product = productMap.get(finalProductId);
      if (!product) throw new NotFoundError('Sản phẩm thịt không tồn tại.');

      const qty = parseFloat(reqQuantity);
      const prc = parseFloat(reqPrice);
      const cp = reqCostPrice !== undefined ? parseFloat(reqCostPrice) : (parseFloat(product.costPrice) || 0);

      const subtotal = Math.round(qty * prc);
      const itemCost = Math.round(qty * cp);
      const itemProfit = subtotal - itemCost;
      calculatedTotal += subtotal;

      formattedItems.push({
        productId: finalProductId,
        quantity: qty,
        price: prc,
        costPrice: cp,
        amount: subtotal,
        profit: itemProfit,
      });
    }

    // Xóa items cũ và tạo items mới trong transaction
    await prisma.$transaction([
      prisma.transactionItem.deleteMany({
        where: { transactionId }
      }),
      prisma.transaction.update({
        where: { id: transactionId },
        data: {
          date: date ? new Date(date) : existingTx.date,
          totalAmount: calculatedTotal,
          note: note !== undefined ? (note ? note.trim() : null) : existingTx.note,
          items: {
            create: formattedItems
          }
        }
      })
    ]);

    const updatedTx = await prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        customer: { select: { id: true, name: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, unit: true } }
          }
        }
      }
    });

    await prisma.portalLink.update({
      where: { id: portalLink.id },
      data: { lastPublishedAt: new Date() }
    });

    logActivity(
      portalLink.userId,
      'PORTAL_UPDATE_DEBT',
      `Sửa đơn nợ qua Zalo Portal: ${existingTx.customer.name} - Tổng tiền: ${new Intl.NumberFormat('vi-VN').format(calculatedTotal)}đ`
    );

    emitWorkspaceEvent(portalLink.userId, 'CUSTOMER_UPDATED', {
      action: 'PORTAL_UPDATE_DEBT',
      userId: portalLink.userId,
      customerId: existingTx.customerId,
      transactionId
    });

    res.json({
      success: true,
      message: 'Cập nhật đơn nợ thành công.',
      data: updatedTx
    });
  } catch (err) {
    next(err);
  }
};

// [DELETE] /api/v1/portal/debt-action/delete-debt/:token/:transactionId
// Xóa đơn nợ trực tiếp từ Portal
const submitPortalDeleteDebt = async (req, res, next) => {
  try {
    const { token, transactionId } = req.params;
    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: { customers: true }
    });
    if (!portalLink || !portalLink.isActive) throw new NotFoundError('Đường dẫn không tồn tại.');
    verifyDebtActionSession(req, portalLink);

    const allowedIds = portalLink.customers.map(c => c.customerId);
    const tx = await prisma.transaction.findFirst({
      where: { id: transactionId, customerId: { in: allowedIds }, userId: portalLink.userId },
      include: { customer: true }
    });
    if (!tx) throw new NotFoundError('Không tìm thấy đơn nợ.');

    await prisma.transactionItem.deleteMany({ where: { transactionId } });
    await prisma.transaction.delete({ where: { id: transactionId } });

    await prisma.portalLink.update({
      where: { id: portalLink.id },
      data: { lastPublishedAt: new Date() }
    });

    logActivity(portalLink.userId, 'PORTAL_DELETE_DEBT', `Xóa đơn nợ qua Zalo Portal: ${tx.customer.name}`);
    emitWorkspaceEvent(portalLink.userId, 'CUSTOMER_UPDATED', {
      action: 'PORTAL_DELETE_DEBT',
      userId: portalLink.userId,
      customerId: tx.customerId,
      transactionId
    });

    res.json({ success: true, message: 'Đã xóa đơn nợ thành công.' });
  } catch (err) {
    next(err);
  }
};

// [DELETE] /api/v1/portal/debt-action/delete-payment/:token/:paymentId
// Xóa khoản thanh toán trực tiếp từ Portal
const submitPortalDeletePayment = async (req, res, next) => {
  try {
    const { token, paymentId } = req.params;
    const portalLink = await prisma.portalLink.findUnique({
      where: { token },
      include: { customers: true }
    });
    if (!portalLink || !portalLink.isActive) throw new NotFoundError('Đường dẫn không tồn tại.');
    verifyDebtActionSession(req, portalLink);

    const allowedIds = portalLink.customers.map(c => c.customerId);
    const payment = await prisma.payment.findFirst({
      where: { id: paymentId, customerId: { in: allowedIds } },
      include: { customer: true }
    });
    if (!payment) throw new NotFoundError('Không tìm thấy khoản thanh toán.');

    await prisma.payment.delete({ where: { id: paymentId } });

    await prisma.portalLink.update({
      where: { id: portalLink.id },
      data: { lastPublishedAt: new Date() }
    });

    logActivity(portalLink.userId, 'PORTAL_DELETE_PAYMENT', `Xóa khoản thanh toán qua Zalo Portal: ${payment.customer.name}`);
    emitWorkspaceEvent(portalLink.userId, 'CUSTOMER_UPDATED', {
      action: 'PORTAL_DELETE_PAYMENT',
      userId: portalLink.userId,
      customerId: payment.customerId,
      paymentId
    });

    res.json({ success: true, message: 'Đã xóa khoản thanh toán thành công.' });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  // Public
  getPublicPortalInfo,
  verifyPortalPin,
  getPublicPortalData,
  getBranchesDebtByMonth,
  submitPortalFeedback,
  publishByToken,
  syncInvoiceViaPortal,
  submitDeliveryRequest,
  getPortalDeliveryRequests,
  cancelDeliveryRequest,
  getEmployeeSalaryPortalInfo,
  getEmployeeSalaryPortalData,
  getStaffPortalInfo,
  getStaffPortalSalaryData,
  // Thao tác công nợ trực tiếp từ Zalo Portal
  verifyPortalDebtActionPin,
  getPortalDebtActionBootstrap,
  submitPortalCollectDebt,
  submitPortalCreateDebt,
  submitPortalUpdateDebt,
  submitPortalDeleteDebt,
  submitPortalDeletePayment,
  // Private Manage
  getPortalLinks,
  createPortalLink,
  updatePortalLink,
  regeneratePortalToken,
  deletePortalLink,
  getPortalFeedbacks,
  resolvePortalFeedback,
  publishPortalData,
  publishAllPortalData,
  getAdminDeliveryRequests,
  confirmDeliveryRequest,
  bulkConfirmDeliveryRequests,
  checkUnbilledDeliveryRequests,
  deleteAdminDeliveryRequest
};
