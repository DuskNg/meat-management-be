// meat-management-be/tests/groupPriceSync.test.js
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  createTestCustomer,
  createTestProduct,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Thiết Lập Bộ Giá Riêng Nhóm Cho Nhà Hàng Mới (Group Price Sync)', () => {
  let testUser;
  let testToken;
  let customerA;
  let customerB;
  let customerNew;
  let product1;
  let product2;
  let portalLink;

  beforeAll(async () => {
    // 1. Arrange: Khởi tạo chủ buôn, sản phẩm và khách hàng test
    const userRes = await createTestUser('ChuBuon_GiaNhom');
    testUser = userRes.user;
    testToken = userRes.token;

    customerA = await createTestCustomer(testUser.id, '[TEST]_NhaHang_ChiNhanh1');
    customerB = await createTestCustomer(testUser.id, '[TEST]_NhaHang_ChiNhanh2');
    customerNew = await createTestCustomer(testUser.id, '[TEST]_NhaHang_MoiGiaNhap');

    product1 = await createTestProduct(testUser.id, '[TEST]_Thit_ThanBo', 200000, 160000);
    product2 = await createTestProduct(testUser.id, '[TEST]_Thit_SuonBo', 150000, 120000);

    // Thiết lập bộ giá riêng của nhóm cho 2 nhà hàng chi nhánh 1 & 2:
    // Thăn bò: Chi nhánh 1 = 245.000đ, Chi nhánh 2 = 245.000đ (giá chung của nhóm là 245k)
    // Sườn bò: Chi nhánh 1 = 180.000đ, Chi nhánh 2 = 180.000đ (giá chung của nhóm là 180k)
    await prisma.customerProductPrice.createMany({
      data: [
        {
          customerId: customerA.id,
          productId: product1.id,
          price: 245000,
          changeReason: 'Giá riêng nhóm Trường Hoàng',
        },
        {
          customerId: customerA.id,
          productId: product2.id,
          price: 180000,
          changeReason: 'Giá riêng nhóm Trường Hoàng',
        },
        {
          customerId: customerB.id,
          productId: product1.id,
          price: 245000,
          changeReason: 'Giá riêng nhóm Trường Hoàng',
        },
        {
          customerId: customerB.id,
          productId: product2.id,
          price: 180000,
          changeReason: 'Giá riêng nhóm Trường Hoàng',
        },
      ],
    });

    // Tạo link nhóm Zalo Portal ban đầu gồm 2 nhà hàng (Chi nhánh 1 & 2)
    portalLink = await prisma.portalLink.create({
      data: {
        userId: testUser.id,
        name: 'Nhóm Trường Hoàng Test',
        token: `portal_test_${Date.now()}`,
        type: 'customer',
        isActive: true,
      },
    });

    await prisma.portalLinkCustomer.createMany({
      data: [
        { portalLinkId: portalLink.id, customerId: customerA.id },
        { portalLinkId: portalLink.id, customerId: customerB.id },
      ],
    });
  });

  afterAll(async () => {
    // Teardown: Dọn dẹp dữ liệu test sạch sẽ
    if (portalLink?.id) {
      await prisma.portalLinkCustomer.deleteMany({ where: { portalLinkId: portalLink.id } });
      await prisma.portalLink.deleteMany({ where: { id: portalLink.id } });
    }
    await cleanupTestUser(testUser?.id);
  });

  it('1. Nhà hàng mới chưa thuộc nhóm: Ban đầu CHƯA có giá riêng (dùng giá chung mặc định)', async () => {
    const prices = await prisma.customerProductPrice.findMany({
      where: { customerId: customerNew.id },
    });
    expect(prices.length).toBe(0);
  });

  it('2. Khi cập nhật link nhóm Zalo Portal (PUT /portal/manage/links/:id) thêm nhà hàng mới: Hệ thống tự động thiết lập bộ giá riêng của nhóm cho nhà hàng đó', async () => {
    // Act: Gửi PUT cập nhật nhóm, thêm customerNew vào nhóm
    const res = await request(app)
      .put(`/api/v1/portal/manage/links/${portalLink.id}`)
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        name: 'Nhóm Trường Hoàng Test',
        customerIds: [customerA.id, customerB.id, customerNew.id],
      });

    // Assert: API phản hồi thành công và trả về syncPriceResult
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.syncPriceResult).toBeDefined();
    expect(res.body.syncPriceResult.syncedCustomerCount).toBe(1);
    expect(res.body.syncPriceResult.syncedProductCount).toBe(2);

    // Assert trong Database: customerNew đã có đầy đủ 2 bản ghi giá riêng đúng bằng giá nhóm
    const newCustPrices = await prisma.customerProductPrice.findMany({
      where: { customerId: customerNew.id },
    });

    expect(newCustPrices.length).toBe(2);

    const thanBoPrice = newCustPrices.find((p) => p.productId === product1.id);
    expect(thanBoPrice).toBeDefined();
    expect(Number(thanBoPrice.price)).toBe(245000);
    expect(thanBoPrice.changeReason).toContain('Nhóm Trường Hoàng Test');

    const suonBoPrice = newCustPrices.find((p) => p.productId === product2.id);
    expect(suonBoPrice).toBeDefined();
    expect(Number(suonBoPrice.price)).toBe(180000);
    expect(suonBoPrice.changeReason).toContain('Nhóm Trường Hoàng Test');
  });

  it('3. Bảo toàn giá riêng: Giá riêng của các nhà hàng cũ trong nhóm KHÔNG bị thay đổi', async () => {
    const custAPrices = await prisma.customerProductPrice.findMany({
      where: { customerId: customerA.id },
    });
    const thanBoA = custAPrices.find((p) => p.productId === product1.id);
    expect(Number(thanBoA.price)).toBe(245000);

    const custBPrices = await prisma.customerProductPrice.findMany({
      where: { customerId: customerB.id },
    });
    const thanBoB = custBPrices.find((p) => p.productId === product1.id);
    expect(Number(thanBoB.price)).toBe(245000);
  });

  it('4. API trực tiếp (POST /products/apply-group-prices): Đồng bộ bộ giá riêng cho nhà hàng mới độc lập', async () => {
    // Tạo thêm 1 nhà hàng mới khác
    const customerC = await createTestCustomer(testUser.id, '[TEST]_NhaHang_ChiNhanh3');

    // Act: Gọi API apply-group-prices
    const res = await request(app)
      .post('/api/v1/products/apply-group-prices')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        groupName: 'Nhóm Trường Hoàng Test',
        sourceCustomerIds: [customerA.id, customerB.id],
        targetCustomerIds: [customerC.id],
      });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.syncedCustomerCount).toBe(1);
    expect(res.body.data.syncedProductCount).toBe(2);

    // Kiểm tra DB
    const pricesC = await prisma.customerProductPrice.findMany({
      where: { customerId: customerC.id },
    });
    expect(pricesC.length).toBe(2);
    expect(Number(pricesC.find((p) => p.productId === product1.id).price)).toBe(245000);
  });

  it('5. Khi các nhà hàng nguồn có giá khác nhau: Hệ thống tự động chọn mức giá phổ biến nhất (Majority / Mode Price)', async () => {
    // Tạo 3 nhà hàng nguồn: 2 nhà hàng giá 230k, 1 nhà hàng giá 240k
    const cust1 = await createTestCustomer(testUser.id, '[TEST]_Quan_Mode1');
    const cust2 = await createTestCustomer(testUser.id, '[TEST]_Quan_Mode2');
    const cust3 = await createTestCustomer(testUser.id, '[TEST]_Quan_Mode3');
    const custTarget = await createTestCustomer(testUser.id, '[TEST]_Quan_Target');

    await prisma.customerProductPrice.createMany({
      data: [
        { customerId: cust1.id, productId: product1.id, price: 230000 },
        { customerId: cust2.id, productId: product1.id, price: 230000 },
        { customerId: cust3.id, productId: product1.id, price: 240000 },
      ],
    });

    const res = await request(app)
      .post('/api/v1/products/apply-group-prices')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        groupName: 'Nhóm Đa Mức Giá',
        sourceCustomerIds: [cust1.id, cust2.id, cust3.id],
        targetCustomerIds: [custTarget.id],
      });

    expect(res.status).toBe(200);
    const targetPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: custTarget.id,
          productId: product1.id,
        },
      },
    });

    // Mức giá số đông (230k có 2 quán, 240k có 1 quán) => Phải chọn 230.000đ
    expect(Number(targetPrice.price)).toBe(230000);
  });
});
