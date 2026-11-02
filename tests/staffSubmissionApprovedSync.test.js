// meat-management-be/tests/staffSubmissionApprovedSync.test.js
const request = require('supertest');
const { app } = require('../src/index');
const prisma = require('../src/utils/db');
const { createTestUser, cleanupTestUser } = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Bảo Toàn Dữ Liệu Thực Tế Của Đơn Nhân Viên Đã Duyệt (Staff Submission Approved Sync)', () => {
  let userToken;
  let userId;
  let customerA;
  let customerB;
  let product1;
  let product2;
  let staffSubmissionId;
  let transactionId;

  const testPrefix = `[TEST_SYNC_${Date.now()}]`;

  beforeAll(async () => {
    // 1. Khởi tạo User kiểm thử
    const { user, token } = await createTestUser('Chủ Buôn Test Sync');
    userId = user.id;
    userToken = token;

    // 2. Khởi tạo 2 khách hàng
    customerA = await prisma.customer.create({
      data: {
        userId,
        name: `${testPrefix}_Khach_Cu_AI`,
        phone: `0991${Math.floor(100000 + Math.random() * 900000)}`,
        isActive: true,
      },
    });

    customerB = await prisma.customer.create({
      data: {
        userId,
        name: `${testPrefix}_Khach_Moi_Chon`,
        phone: `0992${Math.floor(100000 + Math.random() * 900000)}`,
        isActive: true,
      },
    });

    // 3. Khởi tạo 2 sản phẩm thịt
    product1 = await prisma.product.create({
      data: {
        userId,
        name: `${testPrefix}_Thit_Cu_AI`,
        defaultPrice: 150000,
        unit: 'kg',
        isActive: true,
      },
    });

    product2 = await prisma.product.create({
      data: {
        userId,
        name: `${testPrefix}_Thit_Moi_Chon`,
        defaultPrice: 180000,
        unit: 'kg',
        isActive: true,
      },
    });

    // 4. Tạo 1 bản ghi StaffSubmission ban đầu mô phỏng AI phân tích
    const sub = await prisma.staffSubmission.create({
      data: {
        userId,
        fileUrl: 'https://res.cloudinary.com/test_sync.jpg',
        fileType: 'IMAGE',
        detectedCustomerName: `${testPrefix}_Khach_Cu_AI`,
        matchedCustomerId: customerA.id,
        status: 'PENDING',
        date: new Date('2026-11-02T00:00:00.000Z'),
        items: {
          create: [
            {
              rawName: `${testPrefix}_Thit_Cu_AI`,
              matchedProductId: product1.id,
              quantity: 10,
              price: 150000,
              amount: 1500000,
            },
          ],
        },
      },
      include: { items: true },
    });
    staffSubmissionId = sub.id;
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu kiểm thử an toàn
    await prisma.transactionItem.deleteMany({
      where: { transaction: { userId } },
    });
    await prisma.transaction.deleteMany({
      where: { userId },
    });
    await prisma.staffSubmissionItem.deleteMany({
      where: { submission: { userId } },
    });
    await prisma.staffSubmission.deleteMany({
      where: { userId },
    });
    await prisma.customerProductPrice.deleteMany({
      where: { customer: { userId } },
    });
    await prisma.customer.deleteMany({
      where: { userId },
    });
    await prisma.product.deleteMany({
      where: { userId },
    });
    await cleanupTestUser(userId);
  });

  it('1. Phê duyệt (approve) đơn với khách hàng mới và món thịt mới -> Tạo Transaction và StaffSubmission được cập nhật chuẩn xác', async () => {
    const approveRes = await request(app)
      .post(`/api/v1/staff-submissions/${staffSubmissionId}/approve`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        customerId: customerB.id,
        date: '2026-11-02',
        note: 'Đơn đã sửa sang khách B và thịt 2',
        items: [
          {
            matchedProductId: product2.id,
            rawName: `${testPrefix}_Thit_Moi_Chon`,
            quantity: 5,
            price: 180000,
            amount: 900000,
          },
        ],
      });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);

    const subDb = await prisma.staffSubmission.findUnique({
      where: { id: staffSubmissionId },
      include: { items: true },
    });
    expect(subDb.status).toBe('APPROVED');
    expect(subDb.matchedCustomerId).toBe(customerB.id);
    expect(subDb.items).toHaveLength(1);
    expect(subDb.items[0].rawName).toBe(`${testPrefix}_Thit_Moi_Chon`);
    expect(Number(subDb.items[0].price)).toBe(180000);
    expect(Number(subDb.items[0].amount)).toBe(900000);

    transactionId = subDb.transactionId;
    expect(transactionId).toBeDefined();
  });

  it('2. Khi người dùng sửa đơn nợ (Transaction) tại màn hình sổ nợ ngoài -> StaffSubmissionItem và StaffSubmission tự động đồng bộ theo', async () => {
    const updateTxRes = await request(app)
      .put(`/api/v1/transactions/${transactionId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        date: '2026-11-02',
        note: 'Đã sửa số kg và đơn giá ngoài sổ nợ',
        items: [
          {
            productId: product2.id,
            productName: `${testPrefix}_Thit_Moi_Chon`,
            quantity: 8,
            price: 175000,
          },
        ],
      });

    expect(updateTxRes.status).toBe(200);
    expect(updateTxRes.body.success).toBe(true);

    // Kiểm tra trong DB: StaffSubmission và StaffSubmissionItem đã được đồng bộ chuẩn xác
    const subDb = await prisma.staffSubmission.findUnique({
      where: { id: staffSubmissionId },
      include: { items: true },
    });
    expect(subDb.items).toHaveLength(1);
    expect(Number(subDb.items[0].quantity)).toBe(8);
    expect(Number(subDb.items[0].price)).toBe(175000);
    expect(Number(subDb.items[0].amount)).toBe(8 * 175000);
  });

  it('3. GET /api/v1/staff-submissions: Đơn đã duyệt luôn ưu tiên 100% dữ liệu thực tế đã sửa, KHÔNG bị đè lại data cũ của AI', async () => {
    const getRes = await request(app)
      .get('/api/v1/staff-submissions?date=2026-11-02')
      .set('Authorization', `Bearer ${userToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.success).toBe(true);

    const found = getRes.body.data.find((s) => s.id === staffSubmissionId);
    expect(found).toBeDefined();
    expect(found.status).toBe('APPROVED');
    // Khách hàng phải là khách hàng B đã chọn, không phải khách hàng cũ của AI
    expect(found.matchedCustomerId).toBe(customerB.id);
    expect(found.matchedCustomer.name).toBe(`${testPrefix}_Khach_Moi_Chon`);
    // Món thịt phải là món thịt mới với số lượng và đơn giá thực tế đã sửa
    expect(found.items).toHaveLength(1);
    expect(found.items[0].rawName).toBe(`${testPrefix}_Thit_Moi_Chon`);
    expect(Number(found.items[0].quantity)).toBe(8);
    expect(Number(found.items[0].price)).toBe(175000);
    expect(Number(found.items[0].amount)).toBe(1400000);
  });
});
