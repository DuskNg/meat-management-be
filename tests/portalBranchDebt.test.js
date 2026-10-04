// meat-management-be/tests/portalBranchDebt.test.js
// Kiểm thử tự động: Tính toán chi tiết công nợ từng cửa hàng theo tháng (Bảo đảm không tính tiền trả hàng vào tiền thanh toán)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Báo Cáo Công Nợ Từng Cửa Hàng & Tách Biệt Tiền Trả Hàng', () => {
  let testUser;
  let testToken;
  let testCust1;
  let testCust2;
  let portalLink;

  beforeAll(async () => {
    // 1. Khởi tạo người dùng và 2 chi nhánh quán ăn
    const userRes = await createTestUser('ChuBuon_PortalDebt');
    testUser = userRes.user;
    testToken = userRes.token;

    testCust1 = await createTestCustomer(testUser.id, 'ChiNhanh_Quan1');
    testCust2 = await createTestCustomer(testUser.id, 'ChiNhanh_Quan2');

    // 2. Tạo link ghim Zalo cho chuỗi 2 quán
    portalLink = await prisma.portalLink.create({
      data: {
        userId: testUser.id,
        name: 'Chuỗi Quán Ăn Test',
        token: 'test_token_' + Date.now(),
        type: 'customer',
        isActive: true,
        customers: {
          create: [
            { customerId: testCust1.id },
            { customerId: testCust2.id }
          ]
        }
      }
    });

    const targetDate = new Date('2026-09-15T10:00:00.000+07:00');

    // 3. Quán 1: Mua hàng 1.000.000đ, Trả hàng 200.000đ, Thanh toán nợ 500.000đ
    await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCust1.id,
        totalAmount: 1000000,
        date: targetDate,
        note: 'Đơn mua hàng tháng 9 quán 1'
      }
    });

    // Bản ghi trả lại hàng (Payment với tiền tố [Trả lại hàng])
    await prisma.payment.create({
      data: {
        customerId: testCust1.id,
        amount: 200000,
        paidAt: targetDate,
        note: '[Trả lại hàng] 1kg Bò hỏng (200.000đ)'
      }
    });

    // Bản ghi khách thực sự chuyển khoản trả nợ
    await prisma.payment.create({
      data: {
        customerId: testCust1.id,
        amount: 500000,
        paidAt: targetDate,
        note: 'Khách chuyển khoản thanh toán nợ'
      }
    });

    // 4. Quán 2: Mua hàng 2.000.000đ, Thanh toán nợ 1.000.000đ
    await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCust2.id,
        totalAmount: 2000000,
        date: targetDate,
        note: 'Đơn mua hàng tháng 9 quán 2'
      }
    });

    await prisma.payment.create({
      data: {
        customerId: testCust2.id,
        amount: 1000000,
        paidAt: targetDate,
        note: 'Khách chuyển khoản thanh toán nợ'
      }
    });
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu test sạch sẽ
    if (portalLink?.id) {
      await prisma.portalLinkCustomer.deleteMany({ where: { portalLinkId: portalLink.id } });
      await prisma.portalLink.delete({ where: { id: portalLink.id } });
    }
    await cleanupTestUser(testUser?.id);
  });

  it('1. Tiền trả hàng TUYỆT ĐỐI KHÔNG được cộng vào dòng Đã thanh toán (monthPaid)', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/branches-debt/${portalLink.token}?month=09/2026`)
      .set('x-portal-env', 'development');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();

    const summary = res.body.data.summary;
    // Tổng mua của cả chuỗi: 1.000.000 + 2.000.000 = 3.000.000đ
    expect(summary.monthPurchase).toBe(3000000);

    // Tiền trả hàng của cả chuỗi: 200.000đ
    expect(summary.monthReturn).toBe(200000);

    // Tiền đã thanh toán của cả chuỗi: 500.000 + 1.000.000 = 1.500.000đ (KHÔNG ĐƯỢC TÍNH 200.000đ trả hàng vào đây!)
    expect(summary.monthPaid).toBe(1500000);

    // Nợ còn lại tháng: 3.000.000 - 200.000 - 1.500.000 = 1.300.000đ
    expect(summary.monthDebt).toBe(1300000);
  });

  it('2. Kiểm tra chi tiết từng cơ sở: Quán 1 phải tách biệt trả hàng và thanh toán', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/branches-debt/${portalLink.token}?month=09/2026`)
      .set('x-portal-env', 'development');

    const branches = res.body.data.branches;
    const branch1 = branches.find((b) => b.id === testCust1.id);
    expect(branch1).toBeDefined();

    expect(branch1.monthPurchase).toBe(1000000);
    expect(branch1.monthReturn).toBe(200000);
    expect(branch1.monthPaid).toBe(500000);
    // Nợ còn lại tháng quán 1: 1.000.000 - 200.000 - 500.000 = 300.000đ
    expect(branch1.monthDebt).toBe(300000);
  });
});
