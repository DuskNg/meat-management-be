// meat-management-be/tests/portalDeliveryRequest.test.js
// Kiểm thử tự động: Luồng Báo Hàng từ Portal & Chốt Đơn & Cảnh Báo Khách Báo Hàng Chưa Có Công Nợ
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Báo Hàng Qua Portal & Chốt Đơn & Đối Soát Công Nợ', () => {
  let testUser;
  let testToken;
  let testCust1;
  let testCust2;
  let portalLink;

  beforeAll(async () => {
    // 1. Tạo chủ buôn và 2 khách hàng test
    const userRes = await createTestUser('ChuBuon_BaoHang');
    testUser = userRes.user;
    testToken = userRes.token;

    testCust1 = await createTestCustomer(testUser.id, 'NhaHang_Pho1');
    testCust2 = await createTestCustomer(testUser.id, 'NhaHang_BunBo2');

    // 2. Tạo Portal Link
    portalLink = await prisma.portalLink.create({
      data: {
        userId: testUser.id,
        name: 'Nhóm Zalo Đặt Hàng Test',
        token: 'portal_test_' + Date.now(),
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
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu test
    if (portalLink?.id) {
      await prisma.portalDeliveryRequest.deleteMany({
        where: { portalLinkId: portalLink.id }
      }).catch(() => {});
      await prisma.portalLinkCustomer.deleteMany({
        where: { portalLinkId: portalLink.id }
      }).catch(() => {});
      await prisma.portalLink.delete({
        where: { id: portalLink.id }
      }).catch(() => {});
    }
    if (testCust1?.id || testCust2?.id) {
      await prisma.transaction.deleteMany({
        where: { customerId: { in: [testCust1.id, testCust2.id] } }
      }).catch(() => {});
    }
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }
  });

  test('1. Khách hàng gửi báo hàng thành công cho ngày hiện tại (today)', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/delivery-request/${portalLink.token}`)
      .send({
        customerId: testCust1.id,
        dateType: 'today',
        note: 'Giao sáng sớm 6h30'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.customerId).toBe(testCust1.id);
    expect(res.body.data.dateType).toBe('today');
    expect(res.body.data.isConfirmed).toBe(false);
    expect(res.body.data.note).toBe('Giao sáng sớm 6h30');
  });

  test('2. Khách hàng gửi báo hàng thành công cho ngày hôm sau (tomorrow)', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/delivery-request/${portalLink.token}`)
      .send({
        customerId: testCust2.id,
        dateType: 'tomorrow',
        note: 'Lấy thêm 5kg sườn non'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customerId).toBe(testCust2.id);
    expect(res.body.data.dateType).toBe('tomorrow');
  });

  test('2.1. Nhóm portal gửi báo hàng đồng thời cho nhiều nhà hàng trong nhóm (mảng customerIds)', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/delivery-request/${portalLink.token}`)
      .send({
        customerIds: [testCust1.id, testCust2.id],
        dateType: 'tomorrow',
        note: 'Cả 2 quán đều lấy hàng sớm'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results).toBeDefined();
    expect(res.body.data.results.length).toBe(2);
    expect(res.body.message).toContain('Đã gửi báo lấy hàng cho 2 cơ sở');
  });

  test('3. Xem danh sách báo hàng gần đây trên cổng Portal', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/delivery-request/${portalLink.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  test('4. Chủ buôn lấy danh sách báo hàng hôm nay & ban đầu chưa có công nợ', async () => {
    const res = await request(app)
      .get('/api/v1/portal/manage/delivery-requests?dateType=today')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { summary, requests, unbilledCustomers } = res.body.data;
    expect(summary.totalRequests).toBeGreaterThanOrEqual(1);
    expect(summary.unbilledCount).toBeGreaterThanOrEqual(1);

    const target = requests.find(r => r.customerId === testCust1.id);
    expect(target).toBeDefined();
    expect(target.hasDebt).toBe(false);
    expect(target.isConfirmed).toBe(false);

    const isUnbilled = unbilledCustomers.some(c => c.customerId === testCust1.id);
    expect(isUnbilled).toBe(true);
  });

  test('5. Chủ buôn chốt có hàng cho nhà hàng 1', async () => {
    // Tìm requestId của testCust1
    const listRes = await request(app)
      .get('/api/v1/portal/manage/delivery-requests?dateType=today')
      .set('Authorization', `Bearer ${testToken}`);

    const reqItem = listRes.body.data.requests.find(r => r.customerId === testCust1.id);
    expect(reqItem).toBeDefined();

    const res = await request(app)
      .put(`/api/v1/portal/manage/delivery-requests/${reqItem.id}/confirm`)
      .set('Authorization', `Bearer ${testToken}`)
      .send({ isConfirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isConfirmed).toBe(true);
    expect(res.body.data.status).toBe('confirmed');
  });

  test('6. Kiểm tra unbilled: Cảnh báo quán 1 đã báo hàng nhưng chưa có công nợ', async () => {
    const res = await request(app)
      .get('/api/v1/portal/manage/delivery-requests/unbilled?dateType=today')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.unbilledCount).toBeGreaterThanOrEqual(1);
    const found = res.body.data.unbilledCustomers.find(c => c.customerId === testCust1.id);
    expect(found).toBeDefined();
  });

  test('7. Nhập công nợ cho quán 1 -> Quán 1 tự động chuyển sang Đã có công nợ (hasDebt = true)', async () => {
    // Tạo đơn nợ cho testCust1 trong ngày hôm nay
    const now = new Date();
    await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCust1.id,
        totalAmount: 850000,
        date: now,
        note: 'Đơn giao hàng sáng theo báo hàng'
      }
    });

    // Gọi lại API quản lý báo hàng
    const res = await request(app)
      .get('/api/v1/portal/manage/delivery-requests?dateType=today')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    const target = res.body.data.requests.find(r => r.customerId === testCust1.id);
    expect(target).toBeDefined();
    expect(target.hasDebt).toBe(true);
    expect(target.debtAmount).toBe(850000);

    // Gọi lại API check unbilled -> testCust1 không còn trong unbilledCustomers
    const unbilledRes = await request(app)
      .get('/api/v1/portal/manage/delivery-requests/unbilled?dateType=today')
      .set('Authorization', `Bearer ${testToken}`);

    const found = unbilledRes.body.data.unbilledCustomers.find(c => c.customerId === testCust1.id);
    expect(found).toBeUndefined();
  });

  test('8. Chủ buôn xóa lượt báo hàng thành công', async () => {
    // Lấy requestId của testCust2 trong ngày mai
    const listRes = await request(app)
      .get('/api/v1/portal/manage/delivery-requests?dateType=tomorrow')
      .set('Authorization', `Bearer ${testToken}`);

    const reqItem = listRes.body.data.requests[0];
    expect(reqItem).toBeDefined();

    const delRes = await request(app)
      .delete(`/api/v1/portal/manage/delivery-requests/${reqItem.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    // Kiểm tra trong database đã bị xóa
    const checkDb = await prisma.portalDeliveryRequest.findUnique({
      where: { id: reqItem.id }
    });
    expect(checkDb).toBeNull();
  });
});
