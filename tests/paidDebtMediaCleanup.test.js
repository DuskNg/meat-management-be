// meat-management-be/tests/paidDebtMediaCleanup.test.js
require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');
const { cleanupPaidDebtMedia, reconcileDebtTransactions } = require('../src/schedulers/paidDebtMediaCleanupScheduler');

describe('Automation Test: Tự động xóa ảnh và video của đơn nợ đã thu sau 15 ngày', () => {
  let testUser = null;
  let testCustomer = null;
  let testProduct = null;

  let oldPaidTxId = null;
  let recentPaidTxId = null;
  let unpaidTxId = null;

  let oldInvoiceId = null;
  let recentInvoiceId = null;
  let unpaidInvoiceId = null;
  let oldSubmissionId = null;

  beforeAll(async () => {
    // 1. Tạo User kiểm thử độc lập
    const userRes = await createTestUser('Chủ Buôn Dọn Media');
    testUser = userRes.user;

    // 2. Tạo Customer kiểm thử
    testCustomer = await createTestCustomer(testUser.id, 'Khách Dọn Dẹp Media');

    // 3. Tạo Product kiểm thử
    testProduct = await createTestProduct(testUser.id, 'Thịt Dọn Media', 100000, 80000);

    const now = new Date();
    const msInDay = 24 * 60 * 60 * 1000;

    // --- KỊCH BẢN 1: Đơn nợ 500.000đ, đã thu nợ cách đây 16 ngày (>= 15 ngày) -> PHẢI BỊ XÓA ẢNH ---
    const oldTxDate = new Date(now.getTime() - 20 * msInDay); // Tạo 20 ngày trước
    const oldPaymentDate = new Date(now.getTime() - 16 * msInDay); // Thu nợ 16 ngày trước

    const oldTx = await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer.id,
        date: oldTxDate,
        totalAmount: 500000,
        note: '[TEST] Đơn nợ cũ đã thu tiền 16 ngày trước',
        items: {
          create: [
            {
              productId: testProduct.id,
              quantity: 5,
              price: 100000,
              amount: 500000,
            },
          ],
        },
      },
    });
    oldPaidTxId = oldTx.id;

    // Tạo ảnh TransactionInvoice đính kèm
    const oldInv = await prisma.transactionInvoice.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer.id,
        transactionId: oldTx.id,
        date: oldTxDate,
        imageUrl: 'https://pub-15ca08a0129e4711958894971cdfd1db.r2.dev/meat_invoices/test_old_inv.jpg',
      },
    });
    oldInvoiceId = oldInv.id;

    // Tạo StaffSubmission liên kết đơn nợ này
    const oldSub = await prisma.staffSubmission.create({
      data: {
        userId: testUser.id,
        matchedCustomerId: testCustomer.id,
        transactionId: oldTx.id,
        status: 'APPROVED',
        fileUrl: 'https://pub-15ca08a0129e4711958894971cdfd1db.r2.dev/meat_invoices/test_old_sub_video.mp4',
        fileType: 'VIDEO',
      },
    });
    oldSubmissionId = oldSub.id;

    // Tạo thanh toán 500.000đ vào 16 ngày trước
    await prisma.payment.create({
      data: {
        customerId: testCustomer.id,
        amount: 500000,
        paidAt: oldPaymentDate,
        note: 'Khách trả đủ 500k cách đây 16 ngày',
      },
    });

    // --- KỊCH BẢN 2: Đơn nợ 300.000đ, mới thu nợ cách đây 5 ngày (< 15 ngày) -> KHÔNG ĐƯỢC XÓA ---
    const recentTxDate = new Date(now.getTime() - 7 * msInDay);
    const recentPaymentDate = new Date(now.getTime() - 5 * msInDay);

    const recentTx = await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer.id,
        date: recentTxDate,
        totalAmount: 300000,
        note: '[TEST] Đơn nợ mới thu tiền 5 ngày trước',
        items: {
          create: [
            {
              productId: testProduct.id,
              quantity: 3,
              price: 100000,
              amount: 300000,
            },
          ],
        },
      },
    });
    recentPaidTxId = recentTx.id;

    const recentInv = await prisma.transactionInvoice.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer.id,
        transactionId: recentTx.id,
        date: recentTxDate,
        imageUrl: 'https://pub-15ca08a0129e4711958894971cdfd1db.r2.dev/meat_invoices/test_recent_inv.jpg',
      },
    });
    recentInvoiceId = recentInv.id;

    await prisma.payment.create({
      data: {
        customerId: testCustomer.id,
        amount: 300000,
        paidAt: recentPaymentDate,
        note: 'Khách trả 300k cách đây 5 ngày',
      },
    });

    // --- KỊCH BẢN 3: Đơn nợ 200.000đ, CHƯA THU NỢ (nợ còn nguyên) -> KHÔNG ĐƯỢC XÓA ---
    const unpaidTxDate = new Date(now.getTime() - 2 * msInDay);

    const unpaidTx = await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer.id,
        date: unpaidTxDate,
        totalAmount: 200000,
        note: '[TEST] Đơn nợ chưa thu tiền',
        items: {
          create: [
            {
              productId: testProduct.id,
              quantity: 2,
              price: 100000,
              amount: 200000,
            },
          ],
        },
      },
    });
    unpaidTxId = unpaidTx.id;

    const unpaidInv = await prisma.transactionInvoice.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer.id,
        transactionId: unpaidTx.id,
        date: unpaidTxDate,
        imageUrl: 'https://pub-15ca08a0129e4711958894971cdfd1db.r2.dev/meat_invoices/test_unpaid_inv.jpg',
      },
    });
    unpaidInvoiceId = unpaidInv.id;
  });

  afterAll(async () => {
    // Teardown sạch sẽ toàn bộ dữ liệu test đã tạo
    try {
      if (testUser) {
        await cleanupTestUser(testUser.id);
      }
    } catch (err) {
      console.warn('Lỗi teardown test:', err.message);
    }
  });

  test('1. Kiểm tra đối soát nợ reconcileDebtTransactions phân bổ chính xác ngày hoàn tất thu nợ', () => {
    const mockTxs = [
      { id: 'tx-1', totalAmount: 500000, date: new Date('2026-10-01') },
      { id: 'tx-2', totalAmount: 300000, date: new Date('2026-10-05') },
      { id: 'tx-3', totalAmount: 200000, date: new Date('2026-10-10') },
    ];
    const mockPayments = [
      { id: 'pm-1', amount: 500000, paidAt: new Date('2026-10-02') }, // Trả đủ tx-1
      { id: 'pm-2', amount: 300000, paidAt: new Date('2026-10-15') }, // Trả đủ tx-2
    ];

    const result = reconcileDebtTransactions(mockTxs, mockPayments);

    expect(result[0].isPaid).toBe(true);
    expect(result[0].fullyPaidAt).toEqual(new Date('2026-10-02'));

    expect(result[1].isPaid).toBe(true);
    expect(result[1].fullyPaidAt).toEqual(new Date('2026-10-15'));

    expect(result[2].isPaid).toBe(false);
    expect(result[2].fullyPaidAt).toBeNull();
  });

  test('2. Chạy dọn dẹp: Đơn nợ đã thu quá 15 ngày bị xóa media, đơn chưa đủ 15 ngày và chưa thu được giữ nguyên', async () => {
    const cleanupResult = await cleanupPaidDebtMedia({
      userId: testUser.id,
      daysThreshold: 15,
      dryRun: false,
    });

    expect(cleanupResult.success).toBe(true);
    expect(cleanupResult.totalTransactionsCleaned).toBeGreaterThanOrEqual(1);

    // 1. Kịch bản 1: Đơn nợ đã thu nợ 16 ngày -> ẢNH PHẢI BỊ XÓA
    const checkOldInv = await prisma.transactionInvoice.findUnique({
      where: { id: oldInvoiceId },
    });
    expect(checkOldInv).toBeNull(); // Đã bị xóa hoàn toàn khỏi DB

    const checkOldSub = await prisma.staffSubmission.findUnique({
      where: { id: oldSubmissionId },
    });
    expect(checkOldSub.fileUrl).toBe(''); // Đã làm rỗng URL media trên đám mây

    // BẢO TOÀN DỮ LIỆU ĐƠN NỢ: Transaction và Items của đơn cũ vẫn NGUYÊN VẸN 100%!
    const checkOldTx = await prisma.transaction.findUnique({
      where: { id: oldPaidTxId },
      include: { items: true },
    });
    expect(checkOldTx).not.toBeNull();
    expect(Number(checkOldTx.totalAmount)).toBe(500000);
    expect(checkOldTx.items.length).toBe(1);
    expect(Number(checkOldTx.items[0].quantity)).toBe(5);

    // 2. Kịch bản 2: Đơn nợ mới thu nợ 5 ngày (< 15 ngày) -> ẢNH KHÔNG BỊ XÓA!
    const checkRecentInv = await prisma.transactionInvoice.findUnique({
      where: { id: recentInvoiceId },
    });
    expect(checkRecentInv).not.toBeNull();
    expect(checkRecentInv.imageUrl).toContain('test_recent_inv.jpg');

    // 3. Kịch bản 3: Đơn nợ CHƯA THU NỢ -> ẢNH KHÔNG BỊ XÓA!
    const checkUnpaidInv = await prisma.transactionInvoice.findUnique({
      where: { id: unpaidInvoiceId },
    });
    expect(checkUnpaidInv).not.toBeNull();
    expect(checkUnpaidInv.imageUrl).toContain('test_unpaid_inv.jpg');
  });
});
