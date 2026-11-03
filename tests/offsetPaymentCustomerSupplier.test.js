// meat-management-be/tests/offsetPaymentCustomerSupplier.test.js
const request = require('supertest');
const { app } = require('../src/index');
const prisma = require('../src/utils/db');
const { createTestUser, cleanupTestUser } = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Cấn Trừ Công Nợ 2 Đầu (Khách Hàng & Nhà Cung Cấp)', () => {
  let userToken;
  let userId;
  let testCustomer;
  let testSupplier;

  beforeAll(async () => {
    // 1. Tạo User test thông qua helper
    const userRes = await createTestUser();
    userToken = userRes.token;
    userId = userRes.user.id;

    // 2. Tạo Khách Hàng test
    testCustomer = await prisma.customer.create({
      data: {
        userId,
        name: `[TEST]_KhachHang_Offset_${Date.now()}`,
        phone: '0988111222',
        isActive: true,
      },
    });

    // 3. Tạo Nhà Cung Cấp test
    testSupplier = await prisma.supplier.create({
      data: {
        userId,
        name: `[TEST]_NhaCungCap_Offset_${Date.now()}`,
        phone: '0977333444',
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    // Teardown sạch sẽ dữ liệu test
    if (testCustomer) {
      await prisma.transactionInvoice.deleteMany({
        where: { customerId: testCustomer.id },
      });
      await prisma.payment.deleteMany({
        where: { customerId: testCustomer.id },
      });
      await prisma.customer.deleteMany({
        where: { id: testCustomer.id },
      });
    }

    if (testSupplier) {
      await prisma.supplierPayment.deleteMany({
        where: { supplierId: testSupplier.id },
      });
      await prisma.supplier.deleteMany({
        where: { id: testSupplier.id },
      });
    }

    if (userId) {
      await cleanupTestUser(userId);
    }
  });

  it('1. Thu tiền khách hàng có cấn trừ thẳng sang Nhà cung cấp -> Tạo đồng thời 2 bản ghi Payment & SupplierPayment', async () => {
    const res = await request(app)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        customerId: testCustomer.id,
        supplierId: testSupplier.id,
        amount: 5000000,
        paidAt: new Date().toISOString(),
        note: 'Khách A chuyển thẳng vào tài khoản NCC',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(Number(res.body.data.amount)).toBe(5000000);
    expect(res.body.data.note).toContain('[Chuyển thẳng NCC:');
    expect(res.body.data.note).toContain('[offsetSupplierPaymentId:');

    // Kiểm tra bản ghi SupplierPayment được tạo tự động trong DB
    const supplierPayment = await prisma.supplierPayment.findFirst({
      where: {
        supplierId: testSupplier.id,
        note: { contains: `[offsetPaymentId:${res.body.data.id}]` },
      },
    });

    expect(supplierPayment).not.toBeNull();
    expect(Number(supplierPayment.amount)).toBe(5000000);
    expect(supplierPayment.note).toContain('[Khách ');

    // 2. Cập nhật số tiền từ 5.000.000đ lên 6.000.000đ ở bên Payment -> Bên SupplierPayment tự động đồng bộ theo
    const updateRes = await request(app)
      .put(`/api/v1/payments/${res.body.data.id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        amount: 6000000,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);

    const updatedSupplierPayment = await prisma.supplierPayment.findUnique({
      where: { id: supplierPayment.id },
    });
    expect(Number(updatedSupplierPayment.amount)).toBe(6000000);

    // 3. Xóa lượt thu tiền bên Payment -> Tự động xóa luôn bên SupplierPayment
    const deleteRes = await request(app)
      .delete(`/api/v1/payments/${res.body.data.id}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    const deletedSupplierPayment = await prisma.supplierPayment.findUnique({
      where: { id: supplierPayment.id },
    });
    expect(deletedSupplierPayment).toBeNull();
  });

  it('2. Trả tiền Nhà cung cấp có cấn trừ thanh toán từ Khách hàng -> Tạo đồng thời SupplierPayment & Payment và đồng bộ', async () => {
    const res = await request(app)
      .post('/api/v1/suppliers/payments')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        supplierId: testSupplier.id,
        customerId: testCustomer.id,
        amount: 3500000,
        paidAt: new Date().toISOString(),
        note: 'Khách chuyển khoản trực tiếp vào tài khoản',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.note).toContain('[Khách ');
    expect(res.body.data.note).toContain('[offsetPaymentId:');

    // Kiểm tra bản ghi Payment của khách hàng được tạo tự động trong DB
    const custPayment = await prisma.payment.findFirst({
      where: {
        customerId: testCustomer.id,
        note: { contains: `[offsetSupplierPaymentId:${res.body.data.id}]` },
      },
    });

    expect(custPayment).not.toBeNull();
    expect(Number(custPayment.amount)).toBe(3500000);
    expect(custPayment.note).toContain('[Chuyển thẳng NCC:');

    // Cập nhật số tiền bên SupplierPayment -> Bên Payment tự động đồng bộ theo
    const updateRes = await request(app)
      .put(`/api/v1/suppliers/payments/${res.body.data.id}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        amount: 4000000,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);

    const updatedCustPayment = await prisma.payment.findUnique({
      where: { id: custPayment.id },
    });
    expect(Number(updatedCustPayment.amount)).toBe(4000000);

    // Xóa bên SupplierPayment -> Tự động xóa luôn bên Payment
    const deleteRes = await request(app)
      .delete(`/api/v1/suppliers/payments/${res.body.data.id}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    const deletedCustPayment = await prisma.payment.findUnique({
      where: { id: custPayment.id },
    });
    expect(deletedCustPayment).toBeNull();
  });
});
