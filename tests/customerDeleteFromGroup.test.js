// meat-management-be/tests/customerDeleteFromGroup.test.js
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Tự Động Gỡ Khách Hàng Khỏi Nhóm Khi Bị Xóa (Delete Customer Detach From Groups)', () => {
  let testUser;
  let testToken;
  let customerA;
  let customerB;
  let portalLink;

  beforeAll(async () => {
    // Arrange: Khởi tạo chủ buôn test và 2 khách hàng mẫu
    const userRes = await createTestUser('ChuBuon_XoaKhachNhom');
    testUser = userRes.user;
    testToken = userRes.token;

    customerA = await createTestCustomer(testUser.id, '[TEST]_Quan_A_TrongNhom');
    customerB = await createTestCustomer(testUser.id, '[TEST]_Quan_B_TrongNhom');

    // Tạo nhóm Zalo Portal liên kết 2 quán A và B
    portalLink = await prisma.portalLink.create({
      data: {
        userId: testUser.id,
        name: '[TEST]_Nhom_Chuoi_AB',
        token: `test_token_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        type: 'customer',
        customers: {
          create: [
            { customerId: customerA.id },
            { customerId: customerB.id },
          ],
        },
      },
    });

    // Tạo cấu hình nhắc nợ định kỳ cho khách hàng A
    await prisma.periodicReminderConfig.create({
      data: {
        userId: testUser.id,
        customerId: customerA.id,
        groupName: '[TEST]_Nhom_Chuoi_AB',
        reminderDays: '1,15',
      },
    });
  });

  afterAll(async () => {
    // Teardown: Dọn dẹp sạch sẽ toàn bộ dữ liệu test
    try {
      if (portalLink?.id) {
        await prisma.portalLinkCustomer.deleteMany({ where: { portalLinkId: portalLink.id } });
        await prisma.portalLink.delete({ where: { id: portalLink.id } }).catch(() => {});
      }
      if (customerA?.id) {
        await prisma.periodicReminderConfig.deleteMany({ where: { customerId: customerA.id } });
      }
      await cleanupTestUser(testUser?.id);
    } catch (e) {
      console.warn('Lỗi teardown customerDeleteFromGroup test:', e.message);
    }
  });

  it('1. Ban đầu nhóm PortalLink và Cấu hình nhắc nợ phải chứa khách hàng A', async () => {
    const linkCustomerA = await prisma.portalLinkCustomer.findFirst({
      where: { portalLinkId: portalLink.id, customerId: customerA.id },
    });
    expect(linkCustomerA).not.toBeNull();

    const reminderA = await prisma.periodicReminderConfig.findFirst({
      where: { userId: testUser.id, customerId: customerA.id },
    });
    expect(reminderA).not.toBeNull();
  });

  it('2. Khi xóa khách hàng A: Hệ thống phải tự động gỡ khách hàng A khỏi nhóm Zalo Portal và lịch nhắc nợ', async () => {
    const res = await request(app)
      .delete(`/api/v1/customers/${customerA.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Kiểm tra trạng thái khách hàng A là xóa mềm (isActive: false)
    const updatedCustA = await prisma.customer.findUnique({
      where: { id: customerA.id },
    });
    expect(updatedCustA.isActive).toBe(false);

    // Khách hàng A bắt buộc đã bị gỡ hoàn toàn khỏi bảng liên kết nhóm PortalLinkCustomer
    const linkCustomerAfter = await prisma.portalLinkCustomer.findFirst({
      where: { portalLinkId: portalLink.id, customerId: customerA.id },
    });
    expect(linkCustomerAfter).toBeNull();

    // Khách hàng A bắt buộc đã bị gỡ hoàn toàn khỏi cấu hình nhắc nợ định kỳ
    const reminderAfter = await prisma.periodicReminderConfig.findFirst({
      where: { userId: testUser.id, customerId: customerA.id },
    });
    expect(reminderAfter).toBeNull();

    // Quán B vẫn còn nguyên trong nhóm
    const linkCustomerB = await prisma.portalLinkCustomer.findFirst({
      where: { portalLinkId: portalLink.id, customerId: customerB.id },
    });
    expect(linkCustomerB).not.toBeNull();
  });

  it('3. Khi truy vấn danh sách nhóm qua API: Nhóm không còn chứa khách hàng A vừa xóa', async () => {
    const res = await request(app)
      .get('/api/v1/portal/manage/links')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const targetGroup = res.body.data.find((l) => l.id === portalLink.id);
    expect(targetGroup).toBeDefined();

    // Danh sách quán của nhóm chỉ còn quán B, hoàn toàn không còn quán A
    const memberIds = targetGroup.customers.map((c) => c.id);
    expect(memberIds).toContain(customerB.id);
    expect(memberIds).not.toContain(customerA.id);
  });
});
