// Kiểm thử tự động: Luồng ghi nợ và thu nợ (Debt & Payment Flow)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Ghi Nợ Mua Thịt & Thu Nợ Thanh Toán', () => {
  let testUser;
  let testToken;
  let testCustomer;
  let testProduct;

  beforeAll(async () => {
    // Arrange: Chuẩn bị chủ buôn, khách hàng và loại thịt mẫu
    const userRes = await createTestUser('ChuBuon_GhiNo');
    testUser = userRes.user;
    testToken = userRes.token;

    testCustomer = await createTestCustomer(testUser.id, 'NhaHang_HuongBien');
    testProduct = await createTestProduct(testUser.id, 'SuonNon', 120000, 95000);
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu test sạch sẽ
    await cleanupTestUser(testUser?.id);
  });

  it('1. Chặn tạo đơn nợ nếu danh sách mặt hàng trống (Validation Error)', async () => {
    // Act: Gửi đơn hàng không có items
    const res = await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        items: [],
      });

    // Assert: Phải bị từ chối với lỗi 400
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('2. Tạo đơn ghi nợ mới thành công và tính toán chính xác tổng tiền', async () => {
    // Act: Bán 10.5 kg sườn non với giá 120.000đ/kg -> Tổng tiền phải là 1.260.000đ
    const quantity = 10.5;
    const price = 120000;
    const expectedTotal = quantity * price; // 1.260.000đ

    const res = await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        date: new Date().toISOString(),
        note: 'Đơn giao sáng sớm',
        items: [
          {
            productId: testProduct.id,
            productName: testProduct.name,
            quantity,
            price,
            costPrice: 95000,
          },
        ],
      });

    // Assert 1: Kiểm tra phản hồi HTTP
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(Number(res.body.data.totalAmount)).toBe(expectedTotal);

    // Assert 2: Kiểm tra bản ghi trong Database
    const savedTransaction = await prisma.transaction.findUnique({
      where: { id: res.body.data.id },
      include: { items: true },
    });
    expect(savedTransaction).not.toBeNull();
    expect(Number(savedTransaction.totalAmount)).toBe(expectedTotal);
    expect(savedTransaction.items).toHaveLength(1);
    expect(Number(savedTransaction.items[0].quantity)).toBe(quantity);
    expect(Number(savedTransaction.items[0].price)).toBe(price);
  });

  it('3. Thu tiền trả nợ thành công và ghi nhận vào lịch sử thanh toán', async () => {
    // Act: Thu 600.000đ tiền mặt từ khách
    const paymentAmount = 600000;
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        amount: paymentAmount,
        note: 'Chuyển khoản cọc 600k',
      });

    // Assert 1: Kiểm tra phản hồi HTTP
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.data.amount)).toBe(paymentAmount);

    // Assert 2: Kiểm tra bản ghi thanh toán trong Database
    const savedPayment = await prisma.payment.findUnique({
      where: { id: res.body.data.id },
    });
    expect(savedPayment).not.toBeNull();
    expect(Number(savedPayment.amount)).toBe(paymentAmount);
  });

  it('4. Chặn thu tiền nợ với số tiền không hợp lệ (<= 0)', async () => {
    // Act: Gửi số tiền âm hoặc bằng 0
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        amount: -50000,
      });

    // Assert: Phải báo lỗi 400
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
