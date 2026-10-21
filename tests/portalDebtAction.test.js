// meat-management-be/tests/portalDebtAction.test.js
// Kiểm thử tự động: Thao tác chỉnh sửa và thu công nợ trực tiếp từ Zalo Portal có bảo mật bằng mã PIN
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Thao Tác Chỉnh Sửa & Thu Công Nợ Trực Tiếp Từ Zalo Portal', () => {
  let testUser;
  let testCust;
  let testProd;
  let portalLink;
  let actionToken;
  const CORRECT_PIN = '6868';

  beforeAll(async () => {
    // 1. Khởi tạo người dùng có mã PIN bảo mật
    const userRes = await createTestUser('ChuBuon_PortalDebtAction');
    testUser = userRes.user;

    const hashedPin = await bcrypt.hash(CORRECT_PIN, 10);
    await prisma.user.update({
      where: { id: testUser.id },
      data: { pin: hashedPin }
    });

    testCust = await createTestCustomer(testUser.id, 'NhaHang_TruongHoang');
    testProd = await createTestProduct(testUser.id, 'ThitBoTai', 250000, 200000);

    // Cài giá riêng cho khách
    await prisma.customerProductPrice.create({
      data: {
        customerId: testCust.id,
        productId: testProd.id,
        price: 240000
      }
    });

    // 2. Tạo link ghim Zalo cho khách hàng
    portalLink = await prisma.portalLink.create({
      data: {
        userId: testUser.id,
        name: 'Nhóm Zalo Nhà Hàng Trường Hoàng',
        token: 'portal_action_token_' + Date.now(),
        type: 'customer',
        isActive: true,
        customers: {
          create: [{ customerId: testCust.id }]
        }
      }
    });
  });

  afterAll(async () => {
    if (portalLink?.id) {
      await prisma.portalLinkCustomer.deleteMany({ where: { portalLinkId: portalLink.id } });
      await prisma.portalLink.deleteMany({ where: { id: portalLink.id } });
    }
    if (testCust?.id) {
      await prisma.customerProductPrice.deleteMany({ where: { customerId: testCust.id } });
      await prisma.transactionItem.deleteMany({ where: { transaction: { customerId: testCust.id } } });
      await prisma.transaction.deleteMany({ where: { customerId: testCust.id } });
      await prisma.payment.deleteMany({ where: { customerId: testCust.id } });
      await prisma.customer.deleteMany({ where: { id: testCust.id } });
    }
    if (testProd?.id) {
      await prisma.product.deleteMany({ where: { id: testProd.id } });
    }
    if (testUser?.id) {
      await cleanupTestUser(testUser.id);
    }
  });

  test('1. Xác thực mã PIN: Sai mã PIN -> Bị từ chối (400)', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/verify-pin/${portalLink.token}`)
      .send({ pin: '0000' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('không chính xác');
  });

  test('2. Xác thực mã PIN: Đúng mã PIN chủ buôn -> Trả về actionToken (200)', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/verify-pin/${portalLink.token}`)
      .send({ pin: CORRECT_PIN });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.actionToken).toBeDefined();

    actionToken = res.body.actionToken;
  });

  test('2b. Xác thực mã PIN: Sử dụng mã PIN chuyên biệt 031070 -> Trả về actionToken (200)', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/verify-pin/${portalLink.token}`)
      .send({ pin: '031070' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.actionToken).toBeDefined();
  });

  test('3. Bootstrap: Lấy danh mục hàng hóa, khách hàng và giá riêng với actionToken', async () => {
    const res = await request(app)
      .get(`/api/v1/portal/debt-action/bootstrap/${portalLink.token}`)
      .set('x-portal-action-token', actionToken);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customers).toHaveLength(1);
    expect(res.body.data.customers[0].id).toBe(testCust.id);
    expect(res.body.data.products.some(p => p.id === testProd.id)).toBe(true);
    expect(res.body.data.customPrices.some(cp => cp.productId === testProd.id)).toBe(true);
  });

  test('4. Ghi nợ đơn hàng mới từ Portal: Tạo transaction thành công', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/create-debt/${portalLink.token}`)
      .set('x-portal-action-token', actionToken)
      .send({
        customerId: testCust.id,
        date: new Date().toISOString(),
        note: 'Đơn giao hàng sáng sớm từ Zalo Portal',
        items: [
          {
            productId: testProd.id,
            productName: testProd.name,
            quantity: 5,
            price: 240000, // Đơn giá riêng
          }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.data.totalAmount)).toBe(1200000); // 5 * 240.000 = 1.200.000đ

    const createdTxId = res.body.data.id;

    // Kiểm tra trong cơ sở dữ liệu
    const txInDb = await prisma.transaction.findUnique({
      where: { id: createdTxId },
      include: { items: true }
    });
    expect(txInDb).toBeDefined();
    expect(Number(txInDb.totalAmount)).toBe(1200000);
    expect(txInDb.items).toHaveLength(1);
  });

  test('4b. Ghi nợ nhanh từ Portal (Tiền hàng): Tạo transaction với 1 item thành công', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/create-debt/${portalLink.token}`)
      .set('x-portal-action-token', actionToken)
      .send({
        customerId: testCust.id,
        date: new Date().toISOString(),
        note: 'Ghi nợ nhanh tiền hàng phát sinh',
        items: [
          {
            productName: 'Tiền hàng',
            quantity: 1,
            price: 500000,
            costPrice: 0,
          }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.data.totalAmount)).toBe(500000);

    const createdTxId = res.body.data.id;
    const txInDb = await prisma.transaction.findUnique({
      where: { id: createdTxId },
      include: { items: { include: { product: true } } }
    });
    expect(txInDb).toBeDefined();
    expect(Number(txInDb.totalAmount)).toBe(500000);
    expect(txInDb.items[0].product.name).toBe('Tiền hàng');

    // Dọn dẹp đơn test 4b để không làm lệch số dư của test 5 tiếp theo
    await prisma.transaction.delete({ where: { id: createdTxId } });
  });

  test('4c. Ghi nợ kèm ảnh hóa đơn: Tạo Transaction và lưu TransactionInvoice thành công', async () => {
    // 1 pixel transparent png base64
    const sampleBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    const res = await request(app)
      .post(`/api/v1/portal/debt-action/create-debt/${portalLink.token}`)
      .set('x-portal-action-token', actionToken)
      .send({
        customerId: testCust.id,
        date: new Date().toISOString(),
        note: 'Đơn nợ có kèm ảnh tích kê',
        invoiceImage: sampleBase64,
        items: [
          {
            productName: 'Ba rọi có ảnh',
            quantity: 2,
            price: 150000,
            costPrice: 0,
          }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.invoice).toBeDefined();

    const createdTxId = res.body.data.id;
    const invoiceInDb = await prisma.transactionInvoice.findFirst({
      where: { transactionId: createdTxId }
    });
    expect(invoiceInDb).toBeDefined();
    expect(invoiceInDb.customerId).toBe(testCust.id);
    expect(invoiceInDb.imageUrl).toMatch(/^\/uploads\/invoices\/inv_/);

    // Dọn dẹp
    await prisma.transactionInvoice.deleteMany({ where: { transactionId: createdTxId } });
    await prisma.transactionItem.deleteMany({ where: { transactionId: createdTxId } });
    await prisma.transaction.delete({ where: { id: createdTxId } });
  });

  test('5. Thu công nợ từ Portal: Tạo payment thành công và trừ nợ', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/collect-debt/${portalLink.token}`)
      .set('x-portal-action-token', actionToken)
      .send({
        customerId: testCust.id,
        amount: 500000,
        paidAt: new Date().toISOString(),
        note: 'Khách chuyển khoản trả nợ qua ngân hàng'
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.data.amount)).toBe(500000);

    // Kiểm tra số dư công nợ sau khi thu nợ
    const purchases = await prisma.transaction.aggregate({
      where: { customerId: testCust.id },
      _sum: { totalAmount: true }
    });
    const payments = await prisma.payment.aggregate({
      where: { customerId: testCust.id },
      _sum: { amount: true }
    });
    const currentDebt = Number(purchases._sum.totalAmount || 0) - Number(payments._sum.amount || 0);
    expect(currentDebt).toBe(700000); // 1.200.000 - 500.000 = 700.000đ
  });

  test('5b. Thu công nợ theo ngày (chọn nhiều ngày 1 lúc): Tạo các payments với note chuẩn và trừ nợ', async () => {
    // Gửi yêu cầu thu nợ 2 ngày cùng lúc
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/collect-debt/${portalLink.token}`)
      .set('x-portal-action-token', actionToken)
      .send({
        customerId: testCust.id,
        payments: [
          {
            amount: 200000,
            paidAt: new Date().toISOString(),
            note: 'Thanh toán nợ ngày 20/10/2026 - Tiền mặt'
          },
          {
            amount: 300000,
            paidAt: new Date().toISOString(),
            note: 'Thanh toán nợ ngày 21/10/2026'
          }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2);

    // Kiểm tra công nợ còn lại sau khi thu thêm 500.000đ (200k + 300k)
    const payments = await prisma.payment.aggregate({
      where: { customerId: testCust.id },
      _sum: { amount: true }
    });
    // 500k từ test 5 + 200k + 300k = 1.000.000đ đã trả
    expect(Number(payments._sum.amount)).toBe(1000000);
  });

  test('6. Chỉnh sửa đơn nợ từ Portal: Sửa số lượng/đơn giá thành công', async () => {
    const latestTx = await prisma.transaction.findFirst({
      where: { customerId: testCust.id },
      orderBy: { createdAt: 'desc' }
    });
    expect(latestTx).toBeDefined();

    const res = await request(app)
      .put(`/api/v1/portal/debt-action/update-debt/${portalLink.token}/${latestTx.id}`)
      .set('x-portal-action-token', actionToken)
      .send({
        note: 'Đơn giao hàng đã sửa số lượng thành 6kg',
        items: [
          {
            productId: testProd.id,
            productName: testProd.name,
            quantity: 6,
            price: 240000
          }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.data.totalAmount)).toBe(1440000); // 6 * 240.000 = 1.440.000đ
  });

  test('7. Xóa đơn nợ từ Portal: Xóa thành công', async () => {
    const latestTx = await prisma.transaction.findFirst({
      where: { customerId: testCust.id },
      orderBy: { createdAt: 'desc' }
    });
    expect(latestTx).toBeDefined();

    const res = await request(app)
      .delete(`/api/v1/portal/debt-action/delete-debt/${portalLink.token}/${latestTx.id}`)
      .set('x-portal-action-token', actionToken);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deletedTx = await prisma.transaction.findUnique({
      where: { id: latestTx.id }
    });
    expect(deletedTx).toBeNull();
  });

  test('8. Xóa khoản thanh toán từ Portal: Xóa thành công', async () => {
    const latestPayment = await prisma.payment.findFirst({
      where: { customerId: testCust.id },
      orderBy: { createdAt: 'desc' }
    });
    expect(latestPayment).toBeDefined();

    const res = await request(app)
      .delete(`/api/v1/portal/debt-action/delete-payment/${portalLink.token}/${latestPayment.id}`)
      .set('x-portal-action-token', actionToken);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deletedPayment = await prisma.payment.findUnique({
      where: { id: latestPayment.id }
    });
    expect(deletedPayment).toBeNull();
  });

  test('9. Bảo mật: Thiếu actionToken -> Bị từ chối truy cập (401)', async () => {
    const res = await request(app)
      .post(`/api/v1/portal/debt-action/collect-debt/${portalLink.token}`)
      .send({
        customerId: testCust.id,
        amount: 200000
      });

    expect(res.status).toBe(401);
  });
});
