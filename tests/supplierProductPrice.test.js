// meat-management-be/tests/supplierProductPrice.test.js
// Kiểm thử tự động: Bảng giá nhập riêng của nhà cung cấp tách biệt hoàn toàn với bảng giá bán của khách hàng
require('dotenv').config({ path: '.env.test' });
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');
const { getProductsWithSupplierPrices } = require('../src/utils/supplierPriceHelper');

describe('Luồng Nghiệp Vụ: Bảng Giá Nhập Riêng Nhà Cung Cấp (Tách Biệt Với Giá Khách Hàng)', () => {
  let testUser;
  let testSupplier;
  let testCustomer;
  let testProduct;

  beforeAll(async () => {
    const userRes = await createTestUser('ChuBuon_SupPrice');
    testUser = userRes.user;

    testSupplier = await prisma.supplier.create({
      data: {
        userId: testUser.id,
        name: `[TEST]_NCC_Be_${Date.now()}`,
      },
    });

    testCustomer = await prisma.customer.create({
      data: {
        userId: testUser.id,
        name: `[TEST]_Khach_Hang_${Date.now()}`,
      },
    });

    testProduct = await prisma.product.create({
      data: {
        userId: testUser.id,
        name: `[TEST]_Duoi_${Date.now()}`,
        defaultPrice: 180000, // Giá bán mặc định cho khách
        costPrice: 0,
        unit: 'kg',
      },
    });

    // Thiết lập giá bán riêng cho khách hàng = 190.000
    await prisma.customerProductPrice.create({
      data: {
        customerId: testCustomer.id,
        productId: testProduct.id,
        price: 190000,
      },
    });

    // Thiết lập giá nhập riêng cho NCC = 140.000
    await prisma.supplierProductPrice.create({
      data: {
        supplierId: testSupplier.id,
        productId: testProduct.id,
        price: 140000,
      },
    });
  });

  afterAll(async () => {
    if (testUser) {
      await cleanupTestUser(testUser.id);
    }
    await prisma.$disconnect();
  });

  it('Ưu tiên trả về giá nhập riêng của NCC và không làm thay đổi giá bán của khách hàng', async () => {
    const supplierProducts = await getProductsWithSupplierPrices(testUser.id, testSupplier.id);
    const matched = supplierProducts.find((p) => p.id === testProduct.id);

    expect(matched).toBeDefined();
    expect(matched.hasCustomPrice).toBe(true);
    expect(matched.customPrice).toBe(140000);
    expect(matched.costPrice).toBe(140000);
    expect(Number(matched.baseDefaultPrice)).toBe(180000);

    // Kiểm tra giá bán riêng của khách hàng và giá mặc định trong DB vẫn giữ nguyên
    const dbProduct = await prisma.product.findUnique({ where: { id: testProduct.id } });
    const dbCustomerPrice = await prisma.customerProductPrice.findUnique({
      where: {
        customerId_productId: {
          customerId: testCustomer.id,
          productId: testProduct.id,
        },
      },
    });

    expect(Number(dbProduct.defaultPrice)).toBe(180000);
    expect(Number(dbCustomerPrice.price)).toBe(190000);
  });
});
