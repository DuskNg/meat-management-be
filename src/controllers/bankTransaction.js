// meat-management-be/src/controllers/bankTransaction.js
const prisma = require('../utils/db');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { logActivity } = require('../utils/activityLogger');
const { emitWorkspaceEvent } = require('../utils/socket');

const { removeDiacritics } = require('../utils/searchHelper');

/**
 * 1. Webhook nhận biến động số dư từ SePay
 * Endpoint: POST /api/v1/bank-transactions/webhook
 * SePay gửi payload dạng JSON:
 * {
 *   "id": 123456,
 *   "gateway": "Vietcombank",
 *   "transactionDate": "2026-03-29 14:30:00",
 *   "accountNumber": "0123456789",
 *   "subAccount": null,
 *   "transferType": "in",
 *   "transferAmount": 500000,
 *   "accumulated": 15000000,
 *   "code": null,
 *   "content": "Nguyen Van A chuyen tien mua thit",
 *   "referenceCode": "FT26088...",
 *   "description": "..."
 * }
 */
const handleSepayWebhook = async (req, res, next) => {
  try {
    // 0. Xác thực bảo mật Webhook (Nếu hệ thống có thiết lập SEPAY_API_KEY trong biến môi trường)
    const expectedApiKey = process.env.SEPAY_API_KEY ? process.env.SEPAY_API_KEY.trim() : null;
    if (expectedApiKey) {
      const authHeader = req.headers.authorization || '';
      let providedKey = '';
      if (authHeader.startsWith('Apikey ')) {
        providedKey = authHeader.substring(7).trim();
      } else if (authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.substring(7).trim();
      } else {
        providedKey = authHeader.trim();
      }

      if (!providedKey || providedKey !== expectedApiKey) {
        console.warn('[SEPAY_WEBHOOK_AUTH] Yêu cầu bị từ chối: API Key không khớp hoặc thiếu header Authorization.');
        return res.status(401).json({
          success: false,
          message: 'Unauthorized: SePay API Key không hợp lệ hoặc không khớp.',
        });
      }
    }

    const payload = req.body || {};
    console.log('[SEPAY_WEBHOOK] Nhận dữ liệu webhook:', JSON.stringify(payload));

    const sepayId = payload.id ? String(payload.id) : null;
    const gateway = payload.gateway || null;
    const accountNumber = payload.accountNumber || null;
    const subAccount = payload.subAccount || null;
    const transferType = payload.transferType || 'in';
    const transferAmount = payload.transferAmount ? parseFloat(payload.transferAmount) : 0;
    const accumulated = payload.accumulated ? parseFloat(payload.accumulated) : null;
    const code = payload.code || null;
    const content = payload.content || payload.description || '';
    const referenceCode = payload.referenceCode || null;
    const description = payload.description || null;

    // Chuẩn hóa ngày giao dịch
    let txDate = new Date();
    if (payload.transactionDate) {
      const parsed = new Date(payload.transactionDate);
      if (!isNaN(parsed.getTime())) {
        txDate = parsed;
      }
    }

    // 1. Kiểm tra Idempotency chống trùng lặp (dựa theo sepayId)
    if (sepayId) {
      const existing = await prisma.bankTransaction.findUnique({
        where: { sepayId },
        include: {
          customer: {
            select: { id: true, name: true, phone: true },
          },
          payment: true,
        },
      });
      if (existing) {
        console.log(`[SEPAY_WEBHOOK] Bỏ qua giao dịch đã tồn tại (sepayId: ${sepayId})`);
        return res.status(200).json({
          success: true,
          message: 'Giao dịch đã tồn tại trong hệ thống.',
          data: existing,
        });
      }
    }

    // 2. Tìm chủ buôn (User) sở hữu để gán:
    // Ưu tiên userId từ query parameter (URL SePay cấu hình ?userId=...) hoặc payload
    let targetUserId = req.query?.userId || req.query?.user_id || payload.userId || null;

    // Nếu không có userId truyền vào, tự động tìm theo lịch sử số tài khoản ngân hàng (accountNumber)
    if (!targetUserId && accountNumber) {
      const lastTxWithAccount = await prisma.bankTransaction.findFirst({
        where: { accountNumber, userId: { not: null } },
        orderBy: { transactionDate: 'desc' },
        select: { userId: true },
      });
      if (lastTxWithAccount?.userId) {
        targetUserId = lastTxWithAccount.userId;
      }
    }

    if (!targetUserId) {
      const defaultUser = await prisma.user.findFirst({
        where: { isActive: true, isAdmin: false },
        orderBy: { createdAt: 'asc' },
      });
      targetUserId = defaultUser?.id || null;
    }

    // 3. Tự động nhận diện khách hàng (Auto-matching thông minh)
    let matchedCustomerId = null;
    let matchConfidence = null; // 'EXACT_PHONE' | 'EXACT_CODE' | 'NAME_SUGGESTION'

    if (transferType === 'in' && transferAmount > 0 && targetUserId) {
      const activeCustomers = await prisma.customer.findMany({
        where: { userId: targetUserId, isActive: true },
        select: { id: true, name: true, phone: true },
      });

      const fullText = `${code || ''} ${content || ''} ${description || ''}`.trim();
      const normFullText = removeDiacritics(fullText).toLowerCase();

      // Ưu tiên 1: Khớp chính xác theo Số điện thoại của khách hàng trong nội dung (Độ tin cậy 100%)
      for (const cust of activeCustomers) {
        if (cust.phone) {
          const cleanPhone = cust.phone.replace(/[^0-9]/g, '');
          if (cleanPhone.length >= 9 && fullText.includes(cleanPhone)) {
            matchedCustomerId = cust.id;
            matchConfidence = 'EXACT_PHONE';
            break;
          }
        }
      }

      // Ưu tiên 2: Khớp theo Mã thanh toán SePay bóc tách (code)
      if (!matchedCustomerId && code && code.trim()) {
        const cleanCode = code.trim().toLowerCase();
        for (const cust of activeCustomers) {
          if (cust.phone && cleanCode.includes(cust.phone.toLowerCase())) {
            matchedCustomerId = cust.id;
            matchConfidence = 'EXACT_CODE';
            break;
          }
          const normCustName = removeDiacritics(cust.name).toLowerCase().replace(/\s+/g, '');
          if (normCustName && normCustName.length >= 4 && cleanCode.includes(normCustName)) {
            matchedCustomerId = cust.id;
            matchConfidence = 'EXACT_CODE';
            break;
          }
        }
      }

      // Ưu tiên 3: Gợi ý theo Tên khách hàng xuất hiện trong nội dung chuyển khoản
      if (!matchedCustomerId) {
        const matchedByName = [];
        for (const cust of activeCustomers) {
          const normCustName = removeDiacritics(cust.name).toLowerCase().trim();
          if (normCustName && normCustName.length >= 4 && normFullText.includes(normCustName)) {
            matchedByName.push(cust);
          }
        }
        if (matchedByName.length === 1) {
          matchedCustomerId = matchedByName[0].id;
          matchConfidence = 'NAME_SUGGESTION';
        }
      }
    }

    // 4. Nếu khớp chính xác 100% qua SĐT hoặc Mã SePay: Tự động tạo phiếu thu tiền trừ nợ Payment
    let paymentId = null;
    let initialStatus = 'UNPROCESSED';

    if (matchedCustomerId && (matchConfidence === 'EXACT_PHONE' || matchConfidence === 'EXACT_CODE')) {
      const autoPayment = await prisma.payment.create({
        data: {
          customerId: matchedCustomerId,
          createdBy: targetUserId,
          amount: transferAmount,
          paidAt: txDate,
          note: `Tự động gán & trừ nợ từ SePay (${gateway || 'NH'}): ${content || code || ''}`.trim(),
        },
      });
      paymentId = autoPayment.id;
      initialStatus = 'PROCESSED';

      const matchedCustObj = await prisma.customer.findUnique({
        where: { id: matchedCustomerId },
        select: { name: true },
      });

      await logActivity(
        targetUserId,
        'AUTO_ASSIGN_BANK_TRANSACTION',
        `Tự động cấn trừ công nợ ${transferAmount.toLocaleString('vi-VN')}đ cho khách hàng ${matchedCustObj?.name || ''} từ SePay (Khớp ${matchConfidence === 'EXACT_PHONE' ? 'SĐT' : 'Mã thanh toán'})`
      );

      emitWorkspaceEvent(targetUserId, 'CUSTOMER_UPDATED', {
        action: 'CREATE_PAYMENT',
        customerId: matchedCustomerId,
        paymentId: autoPayment.id,
      });
    }

    // 5. Lưu giao dịch ngân hàng vào cơ sở dữ liệu
    const newBankTx = await prisma.bankTransaction.create({
      data: {
        userId: targetUserId,
        sepayId,
        gateway,
        transactionDate: txDate,
        accountNumber,
        subAccount,
        transferType,
        transferAmount,
        accumulated,
        code,
        content,
        referenceCode,
        description,
        status: initialStatus,
        matchedCustomerId,
        paymentId,
        rawPayload: JSON.stringify(payload),
      },
      include: {
        customer: {
          select: { id: true, name: true, phone: true },
        },
        payment: true,
      },
    });

    // 6. Phát socket thông báo cho màn hình Web/App biết có biến động số dư mới tức thì
    if (targetUserId) {
      emitWorkspaceEvent(targetUserId, 'BANK_TRANSACTION_RECEIVED', {
        transaction: newBankTx,
        autoProcessed: initialStatus === 'PROCESSED',
        matchConfidence,
      });
    }

    res.status(201).json({
      success: true,
      message: initialStatus === 'PROCESSED'
        ? `Đã nhận giao dịch và tự động cấn trừ nợ cho khách hàng ${newBankTx.customer?.name}.`
        : 'Nhận và lưu giao dịch SePay thành công.',
      data: newBankTx,
    });
  } catch (error) {
    console.error('[SEPAY_WEBHOOK_ERROR]', error);
    next(error);
  }
};

/**
 * 2. Lấy danh sách giao dịch ngân hàng (Dành cho chủ buôn xem trên màn hình quản lý)
 * Endpoint: GET /api/v1/bank-transactions
 */
const getBankTransactions = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { status, transferType, search, limit = 100, page = 1 } = req.query;

    const whereClause = {};

    // Nếu có userId thì lọc theo userId (hoặc cho xem các giao dịch chưa gán userId)
    if (userId) {
      whereClause.OR = [
        { userId },
        { userId: null },
      ];
    }

    if (status && status !== 'ALL') {
      whereClause.status = status;
    }

    if (transferType && transferType !== 'ALL') {
      whereClause.transferType = transferType;
    }

    if (search && search.trim()) {
      const q = search.trim();
      whereClause.AND = [
        {
          OR: [
            { content: { contains: q, mode: 'insensitive' } },
            { accountNumber: { contains: q, mode: 'insensitive' } },
            { gateway: { contains: q, mode: 'insensitive' } },
            { referenceCode: { contains: q, mode: 'insensitive' } },
            { customer: { name: { contains: q, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    const take = Math.min(parseInt(limit, 10) || 100, 200);
    const skip = ((parseInt(page, 10) || 1) - 1) * take;

    const [transactions, totalCount] = await Promise.all([
      prisma.bankTransaction.findMany({
        where: whereClause,
        include: {
          customer: {
            select: { id: true, name: true, phone: true },
          },
          payment: {
            select: { id: true, amount: true, paidAt: true },
          },
        },
        orderBy: {
          transactionDate: 'desc',
        },
        take,
        skip,
      }),
      prisma.bankTransaction.count({ where: whereClause }),
    ]);

    // Thống kê tổng số tiền vào/ra
    const allMatching = await prisma.bankTransaction.findMany({
      where: whereClause,
      select: { transferAmount: true, transferType: true, status: true },
    });

    let totalIn = 0;
    let totalOut = 0;
    let unprocessedCount = 0;

    for (const item of allMatching) {
      const amt = parseFloat(item.transferAmount || 0);
      if (item.transferType === 'in') {
        totalIn += amt;
      } else {
        totalOut += amt;
      }
      if (item.status === 'UNPROCESSED') {
        unprocessedCount++;
      }
    }

    res.status(200).json({
      success: true,
      data: transactions,
      pagination: {
        totalCount,
        page: parseInt(page, 10) || 1,
        limit: take,
      },
      summary: {
        totalIn,
        totalOut,
        unprocessedCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 3. Gán giao dịch ngân hàng vào khách hàng (Tạo phiếu thu tiền trừ nợ Payment)
 * Endpoint: POST /api/v1/bank-transactions/:id/assign-customer
 */
const assignCustomerAndDeductDebt = async (req, res, next) => {
  try {
    const userId = req.effectiveUserId;
    const { id } = req.params;
    const { customerId, note } = req.body;

    if (!customerId) {
      throw new BadRequestError('Vui lòng chọn khách hàng để gán giao dịch.');
    }

    const bankTx = await prisma.bankTransaction.findUnique({
      where: { id },
    });
    if (!bankTx) {
      throw new NotFoundError('Không tìm thấy giao dịch ngân hàng.');
    }

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, userId, isActive: true },
    });
    if (!customer) {
      throw new NotFoundError('Khách hàng không tồn tại hoặc không thuộc quyền quản lý.');
    }

    const amount = parseFloat(bankTx.transferAmount);
    if (amount <= 0) {
      throw new BadRequestError('Số tiền giao dịch không hợp lệ để tạo phiếu thu nợ.');
    }

    // 1. Tạo phiếu thu nợ Payment cho khách
    const payment = await prisma.payment.create({
      data: {
        customerId,
        createdBy: req.user.id,
        amount,
        paidAt: bankTx.transactionDate || new Date(),
        note: note || `Thu nợ tự động qua CK ${bankTx.gateway || 'Ngân hàng'}: ${bankTx.content || ''}`,
      },
    });

    // 2. Cập nhật trạng thái giao dịch ngân hàng sang PROCESSED
    const updatedBankTx = await prisma.bankTransaction.update({
      where: { id },
      data: {
        userId,
        status: 'PROCESSED',
        matchedCustomerId: customerId,
        paymentId: payment.id,
      },
      include: {
        customer: {
          select: { id: true, name: true, phone: true },
        },
        payment: true,
      },
    });

    await logActivity(
      userId,
      'ASSIGN_BANK_TRANSACTION',
      `Gán giao dịch ngân hàng ${amount.toLocaleString('vi-VN')}đ cho khách hàng ${customer.name} (Tạo phiếu thu nợ)`
    );

    emitWorkspaceEvent(userId, 'CUSTOMER_UPDATED', {
      action: 'CREATE_PAYMENT',
      customerId,
      paymentId: payment.id,
    });

    emitWorkspaceEvent(userId, 'BANK_TRANSACTION_UPDATED', {
      transaction: updatedBankTx,
    });

    res.status(200).json({
      success: true,
      message: `Đã gán thành công vào khách hàng ${customer.name} và trừ nợ ${amount.toLocaleString('vi-VN')}đ.`,
      data: updatedBankTx,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 4. Bỏ qua giao dịch (Chuyển trạng thái IGNORED)
 * Endpoint: PUT /api/v1/bank-transactions/:id/ignore
 */
const ignoreBankTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const bankTx = await prisma.bankTransaction.findUnique({ where: { id } });
    if (!bankTx) {
      throw new NotFoundError('Không tìm thấy giao dịch ngân hàng.');
    }

    const updated = await prisma.bankTransaction.update({
      where: { id },
      data: { status: 'IGNORED' },
    });

    res.status(200).json({
      success: true,
      message: 'Đã đánh dấu bỏ qua giao dịch.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 5. Khôi phục giao dịch về trạng thái chưa xử lý (UNPROCESSED)
 * Endpoint: PUT /api/v1/bank-transactions/:id/restore
 */
const restoreBankTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const bankTx = await prisma.bankTransaction.findUnique({ where: { id } });
    if (!bankTx) {
      throw new NotFoundError('Không tìm thấy giao dịch ngân hàng.');
    }

    // Nếu trước đó đã tạo Payment, xóa Payment đó để hoàn nợ
    if (bankTx.paymentId) {
      await prisma.payment.deleteMany({
        where: { id: bankTx.paymentId },
      });
    }

    const updated = await prisma.bankTransaction.update({
      where: { id },
      data: {
        status: 'UNPROCESSED',
        matchedCustomerId: null,
        paymentId: null,
      },
    });

    if (bankTx.userId && bankTx.matchedCustomerId) {
      emitWorkspaceEvent(bankTx.userId, 'CUSTOMER_UPDATED', {
        action: 'DELETE_PAYMENT',
        customerId: bankTx.matchedCustomerId,
      });
    }

    res.status(200).json({
      success: true,
      message: 'Đã đưa giao dịch về danh sách chờ xử lý.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  handleSepayWebhook,
  getBankTransactions,
  assignCustomerAndDeductDebt,
  ignoreBankTransaction,
  restoreBankTransaction,
};
