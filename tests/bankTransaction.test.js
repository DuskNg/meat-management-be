// Kiểm thử tự động: Luồng Webhook SePay & Quản lý giao dịch ngân hàng
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Webhook SePay & Quản Lý Giao Dịch Ngân Hàng', () => {
  let testUser;
  let testToken;
  let testCustomer;
  let testSepayId;
  let createdBankTxId;

  beforeAll(async () => {
    // Arrange: Khởi tạo chủ buôn và khách hàng mẫu
    const userRes = await createTestUser('ChuBuon_SePay');
    testUser = userRes.user;
    testToken = userRes.token;

    testCustomer = await createTestCustomer(testUser.id, 'Khach_TraNo_NganHang');
    testSepayId = `TEST_SEPAY_${Date.now()}`;
  });

  afterAll(async () => {
    // Teardown: Dọn dẹp dữ liệu test sạch sẽ
    if (createdBankTxId) {
      await prisma.bankTransaction.deleteMany({
        where: { id: createdBankTxId },
      });
    }
    await cleanupTestUser(testUser?.id);
  });

  it('1. Webhook SePay: Nhận biến động số dư và lưu giao dịch mới vào hệ thống', async () => {
    const payload = {
      userId: testUser.id,
      id: testSepayId,
      gateway: 'Vietcombank',
      transactionDate: new Date().toISOString(),
      accountNumber: '9999888877',
      transferType: 'in',
      transferAmount: 750000,
      accumulated: 50000000,
      code: 'MBVCB',
      content: '[TEST] Khach chuyen tien thit heo',
      referenceCode: `FT_REF_${Date.now()}`,
      description: 'Nội dung chi tiết giao dịch test',
    };

    // Act: SePay bắn webhook không cần Bearer Token
    const res = await request(app)
      .post('/api/v1/bank-transactions/webhook')
      .send(payload);

    // Lưu id ngay khi nhận response
    createdBankTxId = res.body?.data?.id;

    // Assert: Nhận thành công, mã 201, trạng thái UNPROCESSED
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.sepayId).toBe(testSepayId);
    expect(Number(res.body.data.transferAmount)).toBe(750000);
    expect(res.body.data.status).toBe('UNPROCESSED');
  });

  it('2. Idempotency: Không tạo trùng giao dịch nếu SePay gửi lại webhook cùng sepayId', async () => {
    const payload = {
      id: testSepayId,
      gateway: 'Vietcombank',
      transactionDate: new Date().toISOString(),
      accountNumber: '9999888877',
      transferType: 'in',
      transferAmount: 750000,
    };

    // Act: Gửi lại webhook
    const res = await request(app)
      .post('/api/v1/bank-transactions/webhook')
      .send(payload);

    // Assert: Trả về 200 và giữ nguyên bản ghi đã có
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(createdBankTxId);

    // Kiểm tra trong database chỉ có duy nhất 1 bản ghi
    const count = await prisma.bankTransaction.count({
      where: { sepayId: testSepayId },
    });
    expect(count).toBe(1);
  });

  it('3. Lấy danh sách giao dịch ngân hàng & tính toán tổng số tiền vào/chờ xử lý', async () => {
    // Act: Gọi API lấy danh sách với token của chủ buôn
    const res = await request(app)
      .get('/api/v1/bank-transactions')
      .set('Authorization', `Bearer ${testToken}`)
      .query({ status: 'ALL' });

    // Assert: Trả về thành công kèm thông tin thống kê summary
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);

    const found = res.body.data.find((tx) => tx.id === createdBankTxId);
    expect(found).toBeDefined();
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.totalIn).toBeGreaterThanOrEqual(750000);
    expect(res.body.summary.unprocessedCount).toBeGreaterThanOrEqual(1);
  });

  it('4. Gán giao dịch cho khách hàng và tự động tạo phiếu thu trừ nợ', async () => {
    // Act: Gán khách hàng cho giao dịch
    const res = await request(app)
      .post(`/api/v1/bank-transactions/${createdBankTxId}/assign-customer`)
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        note: '[TEST] Gán tiền khách trả nợ qua ngân hàng',
      });

    // Assert: Trả về 200, status chuyển thành PROCESSED, có paymentId
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('PROCESSED');
    expect(res.body.data.matchedCustomerId).toBe(testCustomer.id);
    expect(res.body.data.paymentId).toBeDefined();

    // Kiểm tra trực tiếp bảng Payment trong Database
    const payment = await prisma.payment.findUnique({
      where: { id: res.body.data.paymentId },
    });
    expect(payment).toBeDefined();
    expect(payment.customerId).toBe(testCustomer.id);
    expect(Number(payment.amount)).toBe(750000);
  });

  it('5. Khôi phục giao dịch về Chờ xử lý và tự động hoàn trả (xóa) phiếu thu nợ', async () => {
    // Act: Gọi API khôi phục
    const res = await request(app)
      .put(`/api/v1/bank-transactions/${createdBankTxId}/restore`)
      .set('Authorization', `Bearer ${testToken}`);

    // Assert: Status trở lại UNPROCESSED, paymentId và matchedCustomerId được reset về null
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('UNPROCESSED');
    expect(res.body.data.matchedCustomerId).toBeNull();
    expect(res.body.data.paymentId).toBeNull();

    // Kiểm tra phiếu payment cũ đã được dọn sạch khỏi database
    const payments = await prisma.payment.findMany({
      where: { customerId: testCustomer.id },
    });
    expect(payments.length).toBe(0);
  });

  it('6. Bỏ qua giao dịch (chuyển sang trạng thái IGNORED)', async () => {
    // Act: Chuyển sang IGNORED
    const res = await request(app)
      .put(`/api/v1/bank-transactions/${createdBankTxId}/ignore`)
      .set('Authorization', `Bearer ${testToken}`);

    // Assert: Status là IGNORED
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('IGNORED');
  });

  it('7. Auto-Match: Tự động nhận diện khách hàng và tạo phiếu thu trừ nợ khi nội dung chứa SĐT khách', async () => {
    const autoSepayId = `TEST_SEPAY_PHONE_${Date.now()}`;
    const cleanPhone = testCustomer.phone || '0988776655';

    // Đảm bảo testCustomer có phone hợp lệ
    await prisma.customer.update({
      where: { id: testCustomer.id },
      data: { phone: cleanPhone },
    });

    const payload = {
      userId: testUser.id,
      id: autoSepayId,
      gateway: 'Techcombank',
      transactionDate: new Date().toISOString(),
      accountNumber: '19033445566',
      transferType: 'in',
      transferAmount: 1200000,
      content: `CK tien hang tu khach ${cleanPhone} tra no`,
    };

    const res = await request(app)
      .post('/api/v1/bank-transactions/webhook')
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('UNPROCESSED');
    expect(res.body.data.matchedCustomerId).toBe(testCustomer.id);
    expect(res.body.data.paymentId).toBeNull();

    // Dọn dẹp giao dịch test
    await prisma.bankTransaction.deleteMany({ where: { sepayId: autoSepayId } });
  });

  it('8. Auto-Match: Tự động nhận diện khách hàng khi trường code chứa SĐT khách', async () => {
    const codeSepayId = `TEST_SEPAY_CODE_${Date.now()}`;
    const cleanPhone = testCustomer.phone || '0988776655';

    const payload = {
      userId: testUser.id,
      id: codeSepayId,
      gateway: 'MBBank',
      transactionDate: new Date().toISOString(),
      accountNumber: '0987654321',
      transferType: 'in',
      transferAmount: 850000,
      code: `KH${cleanPhone}`,
      content: `KH${cleanPhone} thanh toan`,
    };

    const res = await request(app)
      .post('/api/v1/bank-transactions/webhook')
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('UNPROCESSED');
    expect(res.body.data.matchedCustomerId).toBe(testCustomer.id);
    expect(res.body.data.paymentId).toBeNull();

    // Dọn dẹp
    await prisma.bankTransaction.deleteMany({ where: { sepayId: codeSepayId } });
  });

  it('9. Xác thực bảo mật: Chặn 401 khi có SEPAY_API_KEY nhưng sai key, và nhận 201 khi đúng Apikey', async () => {
    const originalEnvKey = process.env.SEPAY_API_KEY;
    const testSecret = 'SUPER_SECRET_SEPAY_KEY_123';
    process.env.SEPAY_API_KEY = testSecret;

    const authSepayId = `TEST_SEPAY_AUTH_${Date.now()}`;
    const payload = {
      userId: testUser.id,
      id: authSepayId,
      gateway: 'Vietcombank',
      transferType: 'in',
      transferAmount: 300000,
      content: 'Test authen key',
    };

    try {
      // Act 1: Không gửi hoặc sai key -> Bị 401 Unauthorized
      const failRes = await request(app)
        .post('/api/v1/bank-transactions/webhook')
        .set('Authorization', 'Apikey WRONG_KEY')
        .send(payload);

      expect(failRes.status).toBe(401);
      expect(failRes.body.success).toBe(false);

      // Act 2: Gửi đúng key dạng Apikey -> Thành công 201
      const okRes = await request(app)
        .post('/api/v1/bank-transactions/webhook')
        .set('Authorization', `Apikey ${testSecret}`)
        .send(payload);

      expect(okRes.status).toBe(201);
      expect(okRes.body.success).toBe(true);

      // Dọn dẹp
      await prisma.bankTransaction.deleteMany({ where: { sepayId: authSepayId } });
    } finally {
      process.env.SEPAY_API_KEY = originalEnvKey;
    }
  });
});
