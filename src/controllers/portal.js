// meat-management-be/src/controllers/portal.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError, ForbiddenError, UnauthorizedError } = require('../utils/errors');
const { emitWorkspaceEvent } = require('../utils/socket');

const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'meat_manager_portal_secret_key_2026';

// Helper sinh chuỗi token URL-safe ngẫu nhiên 16 ký tự
const generatePortalToken = () => {
  return crypto.randomBytes(12).toString('base64url');
};

// Helper ký session token cho portal khi đã xác thực PIN
const signPortalSession = (portalLinkId, token) => {
  return jwt.sign(
    { portalLinkId, token, type: 'PORTAL_SESSION' },
    JWT_SECRET,
    { expiresIn: '60d' }
  );
};

// Helper xác thực session token của portal
const verifyPortalSession = (req, portalLink) => {
  if (!portalLink.pin) return true; // Không cài PIN thì luôn hợp lệ

  const headers = req.headers || {};
  const query = req.query || {};

  const authHeader = headers['authorization'];
  let sessionToken = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
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
    const decoded = jwt.verify(sessionToken, JWT_SECRET);
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

// [GET] /api/v1/portal/data/:token
// Lấy dữ liệu công nợ, đơn hàng, bảng giá thịt an toàn (Zero-leakage)
const getPublicPortalData = async (req, res, next) => {
  try {
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

    // ─── A. CASE: KHÁCH HÀNG / NHÀ HÀNG (BÁN THỊT RA) ───
    if (portalLink.type === 'customer') {
      const allowedCustomerIds = portalLink.customers.map(c => c.customerId);
      if (allowedCustomerIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: { type: 'customer', customers: [], summary: { totalDebt: 0 }, transactions: [] }
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

        // Lấy 30 giao dịch gần nhất của toàn chuỗi
        const recentTxs = await prisma.transaction.findMany({
          where: {
            customerId: { in: allowedCustomerIds },
            ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {})
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
          take: 50
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

        return res.status(200).json({
          success: true,
          data: {
            type: 'customer',
            isChainOverview: true,
            summary: {
              totalDebt: grandTotalDebt,
              totalPurchase: grandTotalPurchase,
              totalPaid: grandTotalPaid,
              branchCount: allowedCustomerIds.length
            },
            branches: allCustomersData,
            transactions: safeTxs
          }
        });
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
          where: { customerId: targetCustomerId },
          _sum: { totalAmount: true }
        }),
        prisma.payment.aggregate({
          where: { customerId: targetCustomerId },
          _sum: { amount: true }
        }),
        prisma.transaction.findMany({
          where: {
            customerId: targetCustomerId,
            ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {})
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
            ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {})
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
        price: Number(cp.price)
      }));

      const safePayments = payments.map(p => ({
        id: p.id,
        paidAt: p.paidAt,
        amount: Number(p.amount),
        note: p.note
      }));

      return res.status(200).json({
        success: true,
        data: {
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
          }))
        }
      });
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

    const startOfMonth = new Date(targetYear, targetMonth - 1, 1, 0, 0, 0, 0);
    const endOfMonth = new Date(targetYear, targetMonth, 0, 23, 59, 59, 999);
    const formattedMonth = `${String(targetMonth).padStart(2, '0')}/${targetYear}`;

    let grandTotalDebt = 0;
    let grandMonthPurchase = 0;
    let grandMonthPaid = 0;
    let grandMonthDebt = 0;

    const branchesData = [];

    for (const item of portalLink.customers) {
      const c = item.customer;

      // 1. Toàn bộ lịch sử mua và trả của khách hàng
      const [allPurchases, allPayments, monthPurchases, customerPayments] = await Promise.all([
        prisma.transaction.aggregate({
          where: { customerId: c.id },
          _sum: { totalAmount: true }
        }),
        prisma.payment.aggregate({
          where: { customerId: c.id },
          _sum: { amount: true }
        }),
        prisma.transaction.aggregate({
          where: {
            customerId: c.id,
            date: { gte: startOfMonth, lte: endOfMonth }
          },
          _sum: { totalAmount: true }
        }),
        prisma.payment.findMany({
          where: { customerId: c.id }
        })
      ]);

      const totalPurchase = Math.round(Number(allPurchases._sum.totalAmount || 0));
      const totalPaid = Math.round(Number(allPayments._sum.amount || 0));
      let totalDebt = Math.round(totalPurchase - totalPaid + Number(c.manualDebt || 0));
      if (Math.abs(totalDebt) < 1) totalDebt = 0;

      const monthPurchase = Math.round(Number(monthPurchases._sum.totalAmount || 0));

      // 2. Tính tiền thanh toán thuộc về tháng mục tiêu
      let monthPaid = 0;
      for (const pm of customerPayments) {
        const amt = Number(pm.amount) || 0;
        const note = (pm.note || '').trim();
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
      monthPaid = Math.round(monthPaid);

      let monthDebt = Math.round(monthPurchase - monthPaid);
      if (monthDebt < 0) monthDebt = 0;

      grandTotalDebt += totalDebt;
      grandMonthPurchase += monthPurchase;
      grandMonthPaid += monthPaid;
      grandMonthDebt += monthDebt;

      branchesData.push({
        id: c.id,
        name: c.name,
        phone: c.phone,
        address: c.address,
        monthPurchase,
        monthPaid,
        monthDebt,
        totalDebt
      });
    }

    res.status(200).json({
      success: true,
      data: {
        month: formattedMonth,
        targetMonth,
        targetYear,
        summary: {
          monthDebt: grandMonthDebt,
          monthPurchase: grandMonthPurchase,
          monthPaid: grandMonthPaid,
          totalDebt: grandTotalDebt,
          branchCount: branchesData.length
        },
        branches: branchesData
      }
    });
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

    const formatted = links.map(l => ({
      id: l.id,
      name: l.name,
      token: l.token,
      type: l.type,
      pin: l.pin,
      isActive: l.isActive,
      note: l.note,
      viewCount: l.viewCount,
      lastViewedAt: l.lastViewedAt,
      createdAt: l.createdAt,
      customers: l.customers.map(c => c.customer),
      supplier: l.supplier,
      pendingFeedbacksCount: l._count.feedbacks
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

module.exports = {
  // Public
  getPublicPortalInfo,
  verifyPortalPin,
  getPublicPortalData,
  getBranchesDebtByMonth,
  submitPortalFeedback,
  // Private Manage
  getPortalLinks,
  createPortalLink,
  updatePortalLink,
  regeneratePortalToken,
  deletePortalLink,
  getPortalFeedbacks,
  resolvePortalFeedback
};
