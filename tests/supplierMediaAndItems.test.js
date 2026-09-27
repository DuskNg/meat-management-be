// Kiểm thử tự động: Nhà Cung Cấp - Giá Nhập Chi Tiết & Lưu Ảnh/Video
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Nhà Cung Cấp - Giá Nhập Chi Tiết & Lưu Ảnh/Video', () => {
  let testUser;
  let testToken;
  let testSupplierId;
  let createdTransId;
  let createdPaymentId;

  beforeAll(async () => {
    // 1. Tạo User mẫu [TEST]
    const userSetup = await createTestUser();
    testUser = userSetup.user;
    testToken = userSetup.token;

    // 2. Tạo Nhà cung cấp mẫu [TEST]
    const supplier = await prisma.supplier.create({
      data: {
        userId: testUser.id,
        name: `[TEST]_NhaCungCap_${Date.now()}`,
        phone: '0977112233',
        address: 'Trang trại Hòa Bình',
      },
    });
    testSupplierId = supplier.id;
  });

  afterAll(async () => {
    // Dọn dẹp sạch sẽ toàn bộ dữ liệu mẫu sinh ra trong quá trình test
    if (testSupplierId) {
      await prisma.supplierTransaction.deleteMany({ where: { supplierId: testSupplierId } });
      await prisma.supplierPayment.deleteMany({ where: { supplierId: testSupplierId } });
      await prisma.supplier.deleteMany({ where: { id: testSupplierId } });
    }
    if (testUser) {
      await cleanupTestUser(testUser.id);
    }
  });

  it('1. Tạo đơn nhập hàng NCC với chi tiết món thịt (giá nhập, kg) và ảnh/video chứng từ', async () => {
    const items = [
      {
        productName: 'Thịt ba chỉ heo',
        quantity: 50.5,
        price: 85000,
        unit: 'kg',
        amount: 4292500,
      },
      {
        productName: 'Sườn non',
        quantity: 20,
        price: 110000,
        unit: 'kg',
        amount: 2200000,
      },
    ];

    const mediaUrls = [
      {
        url: 'https://res.cloudinary.com/test/image/upload/v1/meat_suppliers/phieu_can.jpg',
        fileType: 'IMAGE',
        fileName: 'phieu_can_heo.jpg',
      },
      {
        url: 'https://res.cloudinary.com/test/video/upload/v1/meat_suppliers/video_can.mp4',
        fileType: 'VIDEO',
        fileName: 'video_can_heo.mp4',
      },
    ];

    const totalAmount = 6492500; // 4.292.500 + 2.200.000

    const res = await request(app)
      .post('/api/v1/suppliers/transactions')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        supplierId: testSupplierId,
        totalAmount,
        note: 'Nhập heo sáng sớm trang trại',
        date: new Date().toISOString(),
        items,
        mediaUrls,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.supplierId).toBe(testSupplierId);
    expect(parseFloat(res.body.data.totalAmount)).toBe(totalAmount);

    createdTransId = res.body.data.id;

    // Kiểm tra trong cơ sở dữ liệu
    const dbTrans = await prisma.supplierTransaction.findUnique({
      where: { id: createdTransId },
    });
    expect(dbTrans).not.toBeNull();
    expect(dbTrans.items).toContain('Thịt ba chỉ heo');
    expect(dbTrans.mediaUrls).toContain('phieu_can_heo.jpg');
    expect(dbTrans.mediaUrls).toContain('video_can_heo.mp4');
  });

  it('2. Lấy lịch sử giao dịch NCC trả về đúng chi tiết món và mediaUrls đã parse', async () => {
    const res = await request(app)
      .get(`/api/v1/suppliers/${testSupplierId}/history`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const transItem = res.body.data.find((it) => it.id === createdTransId);
    expect(transItem).toBeDefined();
    expect(transItem.type).toBe('DEBT');
    expect(Array.isArray(transItem.items)).toBe(true);
    expect(transItem.items.length).toBe(2);
    expect(transItem.items[0].productName).toBe('Thịt ba chỉ heo');
    expect(transItem.items[0].quantity).toBe(50.5);
    expect(transItem.items[0].price).toBe(85000);

    expect(Array.isArray(transItem.mediaUrls)).toBe(true);
    expect(transItem.mediaUrls.length).toBe(2);
    expect(transItem.mediaUrls[0].fileType).toBe('IMAGE');
    expect(transItem.mediaUrls[1].fileType).toBe('VIDEO');
  });

  it('3. Tạo thanh toán trả nợ NCC kèm ảnh bill chuyển khoản', async () => {
    const paymentMedia = [
      {
        url: 'https://res.cloudinary.com/test/image/upload/v1/meat_suppliers/bill_vcb.jpg',
        fileType: 'IMAGE',
        fileName: 'bill_vcb_ck.jpg',
      },
    ];

    const res = await request(app)
      .post('/api/v1/suppliers/payments')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        supplierId: testSupplierId,
        amount: 3000000,
        note: 'Chuyển khoản Vietcombank',
        paidAt: new Date().toISOString(),
        mediaUrls: paymentMedia,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    createdPaymentId = res.body.data.id;

    // Kiểm tra trong lịch sử
    const historyRes = await request(app)
      .get(`/api/v1/suppliers/${testSupplierId}/history`)
      .set('Authorization', `Bearer ${testToken}`);

    const payItem = historyRes.body.data.find((it) => it.id === createdPaymentId);
    expect(payItem).toBeDefined();
    expect(payItem.type).toBe('PAYMENT');
    expect(Array.isArray(payItem.mediaUrls)).toBe(true);
    expect(payItem.mediaUrls.length).toBe(1);
    expect(payItem.mediaUrls[0].fileName).toBe('bill_vcb_ck.jpg');
  });
});
