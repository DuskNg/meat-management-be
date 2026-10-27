const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Phân Quyền: canManageProfit & canManageTransactions', () => {
  let userNoPerms;
  let tokenNoPerms;
  let userWithPerms;
  let tokenWithPerms;

  beforeAll(async () => {
    // 1. Tạo user không có quyền quản lý lợi nhuận và giao dịch
    const resNoPerms = await createTestUser('User_No_Perms');
    userNoPerms = resNoPerms.user;
    tokenNoPerms = resNoPerms.token;

    await prisma.user.update({
      where: { id: userNoPerms.id },
      data: {
        canManageProfit: false,
        canManageTransactions: false,
      },
    });

    // 2. Tạo user có đầy đủ quyền
    const resWithPerms = await createTestUser('User_With_Perms');
    userWithPerms = resWithPerms.user;
    tokenWithPerms = resWithPerms.token;

    await prisma.user.update({
      where: { id: userWithPerms.id },
      data: {
        canManageProfit: true,
        canManageTransactions: true,
      },
    });
  });

  afterAll(async () => {
    if (userNoPerms) await cleanupTestUser(userNoPerms.id);
    if (userWithPerms) await cleanupTestUser(userWithPerms.id);
    await prisma.$disconnect();
  });

  describe('Phân quyền canManageProfit', () => {
    it('Bị chặn 403 khi truy cập /api/v1/suppliers/profit-report mà không có quyền canManageProfit', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/profit-report')
        .set('Authorization', `Bearer ${tokenNoPerms}`)
        .query({ startDate: '2026-10-01', endDate: '2026-10-27' });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('Truy cập thành công 200 vào /api/v1/suppliers/profit-report khi có quyền canManageProfit', async () => {
      const res = await request(app)
        .get('/api/v1/suppliers/profit-report')
        .set('Authorization', `Bearer ${tokenWithPerms}`)
        .query({ startDate: '2026-10-01', endDate: '2026-10-27' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });
  });

  describe('Phân quyền canManageTransactions', () => {
    it('Bị chặn 403 khi truy cập /api/v1/bank-transactions mà không có quyền canManageTransactions', async () => {
      const res = await request(app)
        .get('/api/v1/bank-transactions')
        .set('Authorization', `Bearer ${tokenNoPerms}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('Truy cập thành công 200 vào /api/v1/bank-transactions khi có quyền canManageTransactions', async () => {
      const res = await request(app)
        .get('/api/v1/bank-transactions')
        .set('Authorization', `Bearer ${tokenWithPerms}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });
  });
});
