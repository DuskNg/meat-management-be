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
});
