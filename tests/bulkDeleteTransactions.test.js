// meat-management-be/tests/bulkDeleteTransactions.test.js
// Kiểm thử tự động: Xóa hàng loạt đơn nợ (Bulk Delete Transactions)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Xóa Hàng Loạt Đơn Nợ Trùng (Bulk Delete Transactions)', () => {
  let testUser;
  let testToken;
  let testCustomer1;
  let testCustomer2;
  let testProduct;

  beforeAll(async () => {
    // Arrange: Chuẩn bị chủ buôn, khách hàng và loại thịt
    const userRes = await createTestUser('ChuBuon_BulkDelete');
    testUser = userRes.user;
    testToken = userRes.token;

    testCustomer1 = await createTestCustomer(testUser.id, 'QuanAn_126NguyenKhanhToan');
    testCustomer2 = await createTestCustomer(testUser.id, 'QuanAn_236XaDan');
    testProduct = await createTestProduct(testUser.id, 'ThitBaChi_Bulk', 100000, 80000);
  });

  afterAll(async () => {
    // Teardown: Xóa sạch dữ liệu bài test
    await cleanupTestUser(testUser?.id);
  });

  it('1. Chặn xóa hàng loạt nếu danh sách IDs trống', async () => {
    const res = await request(app)
      .post('/api/v1/transactions/bulk-delete')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('2. Tạo nhiều đơn nợ và xóa hàng loạt thành công', async () => {
    // Tạo 3 đơn nợ cho khách hàng 1 và 2 đơn cho khách hàng 2
    const tx1 = await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer1.id,
        date: new Date(),
        totalAmount: 500000,
        totalCost: 400000,
        totalProfit: 100000,
        items: {
          create: [{ productId: testProduct.id, quantity: 5, price: 100000, costPrice: 80000, amount: 500000, profit: 100000 }],
        },
      },
    });

    const tx2 = await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer1.id,
        date: new Date(),
        totalAmount: 500000,
        totalCost: 400000,
        totalProfit: 100000,
        items: {
          create: [{ productId: testProduct.id, quantity: 5, price: 100000, costPrice: 80000, amount: 500000, profit: 100000 }],
        },
      },
    });

    const tx3 = await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer2.id,
        date: new Date(),
        totalAmount: 300000,
        totalCost: 240000,
        totalProfit: 60000,
        items: {
          create: [{ productId: testProduct.id, quantity: 3, price: 100000, costPrice: 80000, amount: 300000, profit: 60000 }],
        },
      },
    });

    // Act: Xóa đồng thời tx2 (đơn trùng của khách 1) và tx3 (đơn của khách 2)
    const deleteRes = await request(app)
      .post('/api/v1/transactions/bulk-delete')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ ids: [tx2.id, tx3.id] });

    // Assert: Kết quả xóa thành công
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
    expect(deleteRes.body.deletedCount).toBe(2);

    // Kiểm tra trong DB: tx1 vẫn còn, tx2 và tx3 đã bị xóa
    const checkTx1 = await prisma.transaction.findUnique({ where: { id: tx1.id } });
    const checkTx2 = await prisma.transaction.findUnique({ where: { id: tx2.id } });
    const checkTx3 = await prisma.transaction.findUnique({ where: { id: tx3.id } });

    expect(checkTx1).not.toBeNull();
    expect(checkTx2).toBeNull();
    expect(checkTx3).toBeNull();
  });
});
