// Kiểm thử tự động: Bảo toàn đơn giá riêng của khách hàng (Customer Price Integrity)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Bảo Toàn Đơn Giá Riêng Của Khách Hàng (Customer Custom Price)', () => {
  let testUser;
  let testToken;
  let testCustomer;
  let testProduct;

  beforeAll(async () => {
    // 1. Arrange: Khởi tạo chủ buôn, khách hàng và sản phẩm thịt mẫu
    const userRes = await createTestUser('ChuBuon_GiaRieng');
    testUser = userRes.user;
    testToken = userRes.token;

    testCustomer = await createTestCustomer(testUser.id, 'QuanAn_ChiLan');
    testProduct = await createTestProduct(testUser.id, 'ThitBaChi', 100000, 80000);
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu test sạch sẽ khỏi hệ thống
    await cleanupTestUser(testUser?.id);
  });

  it('1. Khi chưa có giá riêng: Lấy sản phẩm phải trả về giá chung mặc định', async () => {
    // Act: Gọi API lấy sản phẩm kèm customerId
    const res = await request(app)
      .get(`/api/v1/products?customerId=${testCustomer.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    // Assert: Kiểm tra trạng thái và giá trị
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const productInList = res.body.data.find((p) => p.id === testProduct.id);
    expect(productInList).toBeDefined();
    expect(productInList.hasCustomPrice).toBe(false);
    expect(Number(productInList.defaultPrice)).toBe(100000);
  });

  it('2. Thiết lập giá riêng cho khách hàng thành công (90.000đ thay vì giá chung 100.000đ)', async () => {
    // Act: Gọi API cập nhật giá riêng
    const res = await request(app)
      .post('/api/v1/products/customer-price')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        productId: testProduct.id,
        price: 90000,
        costPrice: 75000,
      });

    // Assert: API trả về thành công
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Kiểm tra trực tiếp trong Database bảng customer_product_prices
    const dbPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: testCustomer.id,
          productId: testProduct.id,
        },
      },
    });
    expect(dbPrice).not.toBeNull();
    expect(Number(dbPrice.price)).toBe(90000);
  });

  it('3. Lấy sản phẩm sau khi đặt giá riêng: Hệ thống phải ưu tiên giá riêng', async () => {
    // Act: Gọi API lấy sản phẩm kèm customerId
    const res = await request(app)
      .get(`/api/v1/products?customerId=${testCustomer.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    // Assert: Giá hiển thị phải là giá riêng 90.000đ
    expect(res.status).toBe(200);
    const productInList = res.body.data.find((p) => p.id === testProduct.id);
    expect(productInList.hasCustomPrice).toBe(true);
    expect(Number(productInList.customPrice)).toBe(90000);
    expect(Number(productInList.defaultPrice)).toBe(90000);
    expect(Number(productInList.baseDefaultPrice)).toBe(100000);
  });

  it('4. BẢO TOÀN GIÁ RIÊNG: Khi chủ buôn thay đổi giá chung, giá riêng của khách KHÔNG được phép thay đổi', async () => {
    // Act: Cập nhật giá chung của sản phẩm lên 130.000đ
    const updateRes = await request(app)
      .put(`/api/v1/products/${testProduct.id}`)
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        defaultPrice: 130000,
      });
    expect(updateRes.status).toBe(200);

    // Assert 1: Kiểm tra giá riêng trong Database vẫn là 90.000đ
    const dbPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: testCustomer.id,
          productId: testProduct.id,
        },
      },
    });
    expect(Number(dbPrice.price)).toBe(90000);

    // Assert 2: Gọi API lấy sản phẩm của khách, giá bán cho khách này vẫn tuyệt đối là 90.000đ
    const fetchRes = await request(app)
      .get(`/api/v1/products?customerId=${testCustomer.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    const productInList = fetchRes.body.data.find((p) => p.id === testProduct.id);
    expect(Number(productInList.defaultPrice)).toBe(90000);
    expect(Number(productInList.baseDefaultPrice)).toBe(130000); // Giá chung đã đổi lên 130k
  });

  it('5. Lưu lý do thay đổi giá riêng: Hệ thống phải lưu đúng lý do vào Database và trả về qua API', async () => {
    // Act: Cập nhật giá riêng từ 90k lên 95k kèm lý do "Thịt loại 1 chất lượng cao"
    const res = await request(app)
      .post('/api/v1/products/customer-price')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        productId: testProduct.id,
        price: 95000,
        changeReason: 'Thịt loại 1 chất lượng cao',
      });

    expect(res.status).toBe(200);

    // Assert trong DB
    const dbPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: testCustomer.id,
          productId: testProduct.id,
        },
      },
    });
    expect(Number(dbPrice.price)).toBe(95000);
    expect(dbPrice.changeReason).toBe('Thịt loại 1 chất lượng cao');

    // Assert qua API lấy danh sách
    const fetchRes = await request(app)
      .get(`/api/v1/products?customerId=${testCustomer.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    const productInList = fetchRes.body.data.find((p) => p.id === testProduct.id);
    expect(productInList.changeReason).toBe('Thịt loại 1 chất lượng cao');
  });

  it('6. GHI ĐÈ LÝ DO MỚI NHẤT: Khi đổi giá từ b->c thì bỏ lý do cũ, chỉ lưu lý do mới nhất', async () => {
    // Act: Đổi giá tiếp từ 95k lên 105k kèm lý do mới "Giá heo tăng đợt mới"
    const res = await request(app)
      .post('/api/v1/products/customer-price')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        productId: testProduct.id,
        price: 105000,
        changeReason: 'Giá heo tăng đợt mới',
      });

    expect(res.status).toBe(200);

    // Assert trong DB: Chỉ lưu lý do mới nhất, lý do cũ bị ghi đè hoàn toàn
    const dbPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: testCustomer.id,
          productId: testProduct.id,
        },
      },
    });
    expect(Number(dbPrice.price)).toBe(105000);
    expect(dbPrice.changeReason).toBe('Giá heo tăng đợt mới');
    expect(dbPrice.changeReason).not.toContain('Thịt loại 1 chất lượng cao');

    // Assert qua API
    const fetchRes = await request(app)
      .get(`/api/v1/products?customerId=${testCustomer.id}`)
      .set('Authorization', `Bearer ${testToken}`);

    const productInList = fetchRes.body.data.find((p) => p.id === testProduct.id);
    expect(productInList.changeReason).toBe('Giá heo tăng đợt mới');
  });

  it('7. Khi tạo đơn nợ có thay đổi đơn giá kèm priceChangeReason: Tự động lưu lý do mới nhất', async () => {
    // Act: Tạo đơn nợ với đơn giá 110.000đ và gửi kèm priceChangeReason "Khách lấy giờ cao điểm"
    const txRes = await request(app)
      .post('/api/v1/transactions')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        date: new Date().toISOString(),
        items: [
          {
            productId: testProduct.id,
            quantity: 2,
            price: 110000,
          },
        ],
        priceChangeReason: 'Khách lấy giờ cao điểm',
      });

    expect(txRes.status).toBe(201);
    expect(txRes.body.success).toBe(true);

    // Assert trong DB CustomerProductPrice: Đã cập nhật giá 110k và lý do mới nhất
    const dbPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: testCustomer.id,
          productId: testProduct.id,
        },
      },
    });
    expect(Number(dbPrice.price)).toBe(110000);
    expect(dbPrice.changeReason).toBe('Khách lấy giờ cao điểm');
  });

  it('8. Khi duyệt hóa đơn nhân viên (approve StaffSubmission) có kèm priceChangeReason: Tự động cập nhật lý do mới nhất', async () => {
    // Tạo 1 submission nhân viên mẫu
    const sub = await prisma.staffSubmission.create({
      data: {
        userId: testUser.id,
        senderName: 'Nhân viên test',
        fileUrl: 'https://example.com/test.jpg',
        status: 'PENDING',
        matchedCustomerId: testCustomer.id,
        date: new Date(),
        items: {
          create: [
            {
              rawName: testProduct.name,
              matchedProductId: testProduct.id,
              quantity: 5,
              price: 125000,
              amount: 625000,
            },
          ],
        },
      },
    });

    // Act: Duyệt hóa đơn với giá mới 125.000đ và lý do "Duyệt từ hóa đơn Zalo"
    const approveRes = await request(app)
      .post(`/api/v1/staff-submissions/${sub.id}/approve`)
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        customerId: testCustomer.id,
        date: new Date().toISOString(),
        orderMode: 'detail',
        items: [
          {
            matchedProductId: testProduct.id,
            rawName: testProduct.name,
            quantity: 5,
            price: 125000,
            amount: 625000,
          },
        ],
        priceChangeReason: 'Duyệt từ hóa đơn Zalo nhân viên',
      });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);

    // Assert trong CustomerProductPrice: Đã cập nhật giá 125.000đ và lý do mới nhất
    const dbPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: testCustomer.id,
          productId: testProduct.id,
        },
      },
    });
    expect(Number(dbPrice.price)).toBe(125000);
    expect(dbPrice.changeReason).toBe('Duyệt từ hóa đơn Zalo nhân viên');

    // Dọn dẹp bản ghi submission test
    await prisma.staffSubmissionItem.deleteMany({ where: { submissionId: sub.id } });
    if (approveRes.body.data?.transactionId) {
      await prisma.transactionItem.deleteMany({ where: { transactionId: approveRes.body.data.transactionId } });
      await prisma.transaction.deleteMany({ where: { id: approveRes.body.data.transactionId } });
    }
    await prisma.staffSubmission.deleteMany({ where: { id: sub.id } });
  });

  it('6. Lấy danh sách biến động giá thịt (GET /products/daily-price-updates) thành công', async () => {
    // Act: Gọi API daily-price-updates với định dạng ngày
    const res = await request(app)
      .get('/api/v1/products/daily-price-updates?fromDate=30/09/2026&toDate=30/09/2026')
      .set('Authorization', `Bearer ${testToken}`);

    // Assert: Thành công 200, trả về dữ liệu đúng định dạng
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.fromDate).toBe('2026-09-30');
    expect(res.body.data.toDate).toBe('2026-09-30');
    expect(Array.isArray(res.body.data.customers)).toBe(true);
  });
});

