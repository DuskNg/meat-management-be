// meat-management-be/src/controllers/portal.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError, UnauthorizedError } = require('../utils/errors');
const { emitWorkspaceEvent } = require('../utils/socket');

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

    res.status(200).json({
      success: true,
      message: 'Cập nhật link thành công.',
      data: updated
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
    const { customerId, dateType = 'today', deliveryDate, note } = req.body;

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

    // Xác định khách hàng báo hàng
    let targetCustomerId = customerId;
    if (!targetCustomerId) {
      if (portalLink.customers && portalLink.customers.length > 0) {
        targetCustomerId = portalLink.customers[0].customerId;
      } else {
        throw new BadRequestError('Không tìm thấy thông tin khách hàng liên kết với đường dẫn này.');
      }
    }

    // Kiểm tra xem khách hàng có thuộc portalLink không
    const isValidCustomer = portalLink.customers.some(c => c.customerId === targetCustomerId);
    if (!isValidCustomer) {
      throw new BadRequestError('Khách hàng không thuộc danh sách quản lý của nhóm này.');
    }

    const { startOfDay, endOfDay, normalizedDate, dateString, displayDate } = getVnDateRange(deliveryDate, dateType);

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

    let result;
    if (existing) {
      result = await prisma.portalDeliveryRequest.update({
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
      result = await prisma.portalDeliveryRequest.create({
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
        requestId: result.id,
        customerId: targetCustomerId,
        customerName: result.customer?.name,
        deliveryDate: dateString,
        displayDate
      });
    } catch (_) {}

    res.status(200).json({
      success: true,
      message: `Đã gửi báo lấy hàng cho ngày ${displayDate} thành công!`,
      data: {
        ...result,
        formattedDeliveryDate: displayDate,
        dateString
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
  checkUnbilledDeliveryRequests
};
