// tests/quickNote.test.js
// Kiểm thử tự động: Ghi chú cần nhớ (Quick Note) đồng bộ Backend
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Đồng Bộ Ghi Chú Cần Nhớ Lên Server (Quick Note API)', () => {
  let testUser;
  let testToken;
  let otherUser;
  let otherToken;

  beforeAll(async () => {
    // Arrange: Khởi tạo 2 tài khoản chủ buôn kiểm thử độc lập
    const user1 = await createTestUser('ChuBuon_GhiChu1');
    testUser = user1.user;
    testToken = user1.token;

    const user2 = await createTestUser('ChuBuon_GhiChu2');
    otherUser = user2.user;
    otherToken = user2.token;
  });

  afterAll(async () => {
    // Teardown: Dọn dẹp dữ liệu kiểm thử
    if (testUser?.id) {
      await prisma.quickNote.deleteMany({ where: { userId: testUser.id } });
      await cleanupTestUser(testUser.id);
    }
    if (otherUser?.id) {
      await prisma.quickNote.deleteMany({ where: { userId: otherUser.id } });
      await cleanupTestUser(otherUser.id);
    }
  });

  it('1. Chặn truy cập API khi chưa xác thực Token', async () => {
    // Act: Gửi request không có Header Authorization
    const res = await request(app).get('/api/v1/quick-note');

    // Assert: Phải trả về mã lỗi 401 Unauthorized
    expect(res.status).toBe(401);
  });

  it('2. Lấy ghi chú khi tài khoản chưa từng tạo ghi chú (mặc định rỗng)', async () => {
    // Act: Lấy ghi chú lần đầu tiên
    const res = await request(app)
      .get('/api/v1/quick-note')
      .set('Authorization', `Bearer ${testToken}`);

    // Assert: Trả về thành công và content rỗng
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.content).toBe('');
  });

  it('3. Lưu và cập nhật ghi chú cần nhớ lên CSDL Server', async () => {
    const noteText = 'Bún riêu nvl: 220k, Quán phở anh Hùng: lấy nạc vai sáng sớm';

    // Act: Cập nhật nội dung ghi chú
    const putRes = await request(app)
      .put('/api/v1/quick-note')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ content: noteText });

    // Assert: Phải cập nhật thành công
    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);
    expect(putRes.body.content).toBe(noteText);

    // Kiểm tra trực tiếp trong CSDL
    const dbNote = await prisma.quickNote.findUnique({
      where: { userId: testUser.id },
    });
    expect(dbNote).not.toBeNull();
    expect(dbNote.content).toBe(noteText);
  });

  it('4. Đọc lại ghi chú đã lưu từ máy khác / lần đăng nhập sau', async () => {
    // Act: Đọc lại ghi chú từ server
    const getRes = await request(app)
      .get('/api/v1/quick-note')
      .set('Authorization', `Bearer ${testToken}`);

    // Assert: Dữ liệu phải khớp chính xác với nội dung vừa lưu
    expect(getRes.status).toBe(200);
    expect(getRes.body.success).toBe(true);
    expect(getRes.body.content).toBe('Bún riêu nvl: 220k, Quán phở anh Hùng: lấy nạc vai sáng sớm');
  });

  it('5. Đảm bảo tính cách ly dữ liệu giữa các chủ buôn khác nhau', async () => {
    // Act: Tài khoản thứ hai đọc ghi chú
    const res2 = await request(app)
      .get('/api/v1/quick-note')
      .set('Authorization', `Bearer ${otherToken}`);

    // Assert: Tài khoản thứ hai không được thấy dữ liệu của tài khoản thứ nhất
    expect(res2.status).toBe(200);
    expect(res2.body.content).toBe('');
  });

  it('6. Xóa trắng ghi chú trên Server khi người dùng bấm Xóa hết', async () => {
    // Act: Cập nhật nội dung rỗng
    const res = await request(app)
      .put('/api/v1/quick-note')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ content: '' });

    // Assert: CSDL phải cập nhật thành chuỗi rỗng
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('');

    const dbNote = await prisma.quickNote.findUnique({
      where: { userId: testUser.id },
    });
    expect(dbNote.content).toBe('');
  });
});
