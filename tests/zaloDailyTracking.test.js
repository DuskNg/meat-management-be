// meat-management-be/tests/zaloDailyTracking.test.js
// Kiểm thử tự động: Quản lý kiểm soát dòng tiền Nhóm Zalo Báo Hàng Cuốn Chiếu (Chốt theo ngày)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Quản Lý Nhóm Zalo Báo Hàng Cuốn Chiếu & Kiểm Soát Dòng Tiền', () => {
  let testUser;
  let authToken;
  let testGroupCustomer;
  let testPortalLink;
  let testProd;

  beforeAll(async () => {
    const userRes = await createTestUser('ChuBuon_ZaloDaily');
    testUser = userRes.user;
    authToken = userRes.token;
    testProd = await createTestProduct(testUser.id, 'BapBo', 300000, 250000);
  });

  afterAll(async () => {
    if (testPortalLink?.id) {
      await prisma.portalLinkCustomer.deleteMany({ where: { portalLinkId: testPortalLink.id } });
      await prisma.portalLink.deleteMany({ where: { id: testPortalLink.id } });
    }
    if (testGroupCustomer?.id) {
      await prisma.transactionItem.deleteMany({ where: { transaction: { customerId: testGroupCustomer.id } } });
      await prisma.transaction.deleteMany({ where: { customerId: testGroupCustomer.id } });
      await prisma.payment.deleteMany({ where: { customerId: testGroupCustomer.id } });
      await prisma.customer.deleteMany({ where: { id: testGroupCustomer.id } });
    }
    if (testProd?.id) {
      await prisma.product.deleteMany({ where: { id: testProd.id } });
    }
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }
  });

  test('1. Tạo nhóm Zalo siêu tốc -> Tự động sinh Customer type "zalo_daily" và PortalLink', async () => {
    const res = await request(app)
      .post('/api/v1/portal/manage/create-zalo-daily-group')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        groupName: 'Phở Cống Test',
        phone: '0912345678',
        note: 'Báo hàng cuốn chiếu trả trong ngày',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customer).toBeDefined();
    expect(res.body.data.customer.type).toBe('zalo_daily');
    expect(res.body.data.customer.name).toContain('Phở Cống Test');
    expect(res.body.data.portalLink).toBeDefined();
    expect(res.body.data.portalLink.token).toBeDefined();
    expect(res.body.data.portalUrl).toContain('/portal/');

    testGroupCustomer = res.body.data.customer;
    testPortalLink = res.body.data.portalLink;
  });

  test('2. Lấy Dashboard kiểm soát nhóm Zalo hôm nay -> Nhóm mới có trạng thái NO_ORDER', async () => {
    const res = await request(app)
      .get('/api/v1/portal/manage/zalo-daily-dashboard')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary.totalGroups).toBeGreaterThanOrEqual(1);

    const group = res.body.data.groups.find((g) => g.customerId === testGroupCustomer.id);
    expect(group).toBeDefined();
    expect(group.groupName).toContain('Phở Cống Test');
    expect(group.status).toBe('NO_ORDER');
    expect(group.todayOrderAmount).toBe(0);
    expect(group.todayPaidAmount).toBe(0);
  });

  test('3. Tạo đơn hàng hôm nay cho nhóm Zalo -> Dashboard chuyển sang trạng thái UNPAID (Đỏ)', async () => {
    const today = new Date();
    await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testGroupCustomer.id,
        date: today,
        totalAmount: 1500000,
        note: 'Đơn báo hàng hôm nay',
        items: {
          create: [
            {
              productId: testProd.id,
              quantity: 5,
              price: 300000,
              amount: 1500000,
            },
          ],
        },
      },
    });

    const res = await request(app)
      .get('/api/v1/portal/manage/zalo-daily-dashboard')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const group = res.body.data.groups.find((g) => g.customerId === testGroupCustomer.id);
    expect(group).toBeDefined();
    expect(group.status).toBe('UNPAID');
    expect(group.todayOrderAmount).toBe(1500000);
    expect(group.remainingToday).toBe(1500000);
    expect(group.todayPaidAmount).toBe(0);
  });

  test('4. Chốt tiền 1 chạm: Nhận đủ 1.500.000đ -> Dòng tiền vào hệ thống và trạng thái chuyển sang PAID (Xanh)', async () => {
    const res = await request(app)
      .post('/api/v1/portal/manage/zalo-daily-quick-pay')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        customerId: testGroupCustomer.id,
        amount: 1500000,
        note: 'Đã nhận chuyển khoản Vietcombank',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(Number(res.body.data.amount)).toBe(1500000);

    // Kiểm tra DB: Bản ghi Payment đã tạo thành công
    const payment = await prisma.payment.findUnique({
      where: { id: res.body.data.id },
    });
    expect(payment).toBeDefined();
    expect(Number(payment.amount)).toBe(1500000);

    // Kiểm tra Dashboard: Trạng thái nhóm lập tức chuyển sang PAID
    const dashRes = await request(app)
      .get('/api/v1/portal/manage/zalo-daily-dashboard')
      .set('Authorization', `Bearer ${authToken}`);

    const group = dashRes.body.data.groups.find((g) => g.customerId === testGroupCustomer.id);
    expect(group).toBeDefined();
    expect(group.status).toBe('PAID');
    expect(group.todayPaidAmount).toBe(1500000);
    expect(group.remainingToday).toBe(0);
  });
});
