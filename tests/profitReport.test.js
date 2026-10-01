const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Báo Cáo Quản Lý Lợi Nhuận (Profit Report)', () => {
  let testUser;
  let authToken;
  let testCustomer;
  let testSupplier;
  let testProduct;

  beforeAll(async () => {
    // 1. Tạo user thử nghiệm
    const userRes = await createTestUser('ChuBuon_LoiNhuan');
    testUser = userRes.user;
    authToken = userRes.token;

    // 2. Tạo khách hàng thử nghiệm
    testCustomer = await createTestCustomer(testUser.id, 'Khach_A');


    // 3. Tạo nhà cung cấp thử nghiệm
    testSupplier = await prisma.supplier.create({
      data: {
        userId: testUser.id,
        createdBy: testUser.id,
        name: '[TEST]_Lò Mổ Hùng Vương',
        phone: '0999888125',
      },
    });

    // 4. Tạo sản phẩm thịt
    testProduct = await prisma.product.create({
      data: {
        userId: testUser.id,
        createdBy: testUser.id,
        name: '[TEST]_Ba chỉ bò',
        defaultPrice: 200000,
        unit: 'kg',
      },
    });

    // 5. Tạo đơn bán hàng: 10kg x 200.000 = 2.000.000đ vào ngày 15/09/2026
    const dateSep = new Date('2026-09-15T08:00:00.000Z');
    await prisma.transaction.create({
      data: {
        userId: testUser.id,
        customerId: testCustomer.id,
        createdBy: testUser.id,
        date: dateSep,
        totalAmount: 2000000,
        items: {
          create: [
            {
              productId: testProduct.id,
              quantity: 10,
              price: 200000,
              amount: 2000000,
            },
          ],
        },
      },
    });

    // 6. Tạo thanh toán thu tiền từ khách: 1.200.000đ
    await prisma.payment.create({
      data: {
        customerId: testCustomer.id,
        createdBy: testUser.id,
        amount: 1200000,
        paidAt: dateSep,
        note: 'Khách thanh toán đợt 1',
      },
    });

    // 7. Tạo đơn nhập hàng từ lò: 1.500.000đ
    await prisma.supplierTransaction.create({
      data: {
        supplierId: testSupplier.id,
        createdBy: testUser.id,
        totalAmount: 1500000,
        date: dateSep,
        note: 'Nhập thịt ba chỉ',
      },
    });

    // 8. Tạo thanh toán trả nợ lò: 1.000.000đ
    await prisma.supplierPayment.create({
      data: {
        supplierId: testSupplier.id,
        createdBy: testUser.id,
        amount: 1000000,
        paidAt: dateSep,
        note: 'Chuyển khoản trả lò',
      },
    });
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu thử nghiệm
    if (testSupplier) {
      await prisma.supplierPayment.deleteMany({ where: { supplierId: testSupplier.id } });
      await prisma.supplierTransaction.deleteMany({ where: { supplierId: testSupplier.id } });
      await prisma.supplier.deleteMany({ where: { id: testSupplier.id } });
    }
    await cleanupTestUser(testUser?.id);
  });


  it('1. Lấy báo cáo lợi nhuận Tháng 09/2026 chính xác từng con số', async () => {
    const res = await request(app)
      .get('/api/v1/suppliers/profit-report?month=2026-09')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { sales, withAllSuppliers, dailyBreakdown, suppliersBreakdown } = res.body.data;

    // Doanh số bán ra
    expect(sales.totalAmount).toBe(2000000);
    expect(sales.totalCollected).toBe(1200000);
    expect(sales.customerDebtRemaining).toBe(800000);

    // Tiền nhập lò
    expect(withAllSuppliers.totalImport).toBe(1500000);
    expect(withAllSuppliers.totalPaid).toBe(1000000);
    expect(withAllSuppliers.supplierDebtRemaining).toBe(500000);

    // Kết luận Lãi/Lỗ: Bán 2tr - Nhập 1.5tr = LÃI 500k
    expect(withAllSuppliers.profitOrLoss).toBe(500000);
    expect(withAllSuppliers.status).toBe('PROFIT');
    expect(withAllSuppliers.profitPercent).toBe(25); // 500k / 2tr = 25%

    // Chi tiết từng nhà cung cấp
    expect(suppliersBreakdown.length).toBeGreaterThan(0);
    expect(suppliersBreakdown[0].name).toBe('[TEST]_Lò Mổ Hùng Vương');
    expect(suppliersBreakdown[0].importAmount).toBe(1500000);
  });

  it('2. Lấy báo cáo toàn bộ thời gian (month=ALL)', async () => {
    const res = await request(app)
      .get('/api/v1/suppliers/profit-report?month=ALL')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sales.totalAmount).toBeGreaterThanOrEqual(2000000);
    expect(res.body.data.withAllSuppliers.totalImport).toBeGreaterThanOrEqual(1500000);
  });
});
