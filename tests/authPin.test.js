// Kiểm thử tự động: Xác thực người dùng và Bảo mật mã PIN (Auth & PIN Security)
const request = require('supertest');
const { app } = require('../src/index');
const {
  prisma,
  createTestUser,
  cleanupTestUser,
} = require('./helpers/testHelper');

describe('Luồng Nghiệp Vụ: Đăng Nhập Xác Thực & Thiết Lập Mã PIN', () => {
  let testUser;
  let testToken;
  let testPhone;

  beforeAll(async () => {
    // Arrange: Khởi tạo user kiểm thử
    const userRes = await createTestUser('ChuBuon_XacThuc');
    testUser = userRes.user;
    testToken = userRes.token;
    testPhone = testUser.phone;
  });

  afterAll(async () => {
    // Dọn dẹp dữ liệu
    await cleanupTestUser(testUser?.id);
  });

  it('1. Đăng nhập / Yêu cầu OTP với số điện thoại Việt Nam hợp lệ', async () => {
    // Act: Gửi yêu cầu đăng nhập bằng SĐT
    const res = await request(app)
      .post('/api/v1/auth/request-otp')
      .send({
        phone: testPhone,
      });

    // Assert: Phải đăng nhập thành công và cấp Access Token
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tokens.accessToken).toBeDefined();
    expect(res.body.user.phone).toBe(testPhone);
  });

  it('2. Chặn đăng nhập với số điện thoại không đúng định dạng', async () => {
    // Act: Gửi số điện thoại không hợp lệ
    const res = await request(app)
      .post('/api/v1/auth/request-otp')
      .send({
        phone: '123456',
      });

    // Assert: Trả về lỗi 400
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('3. Thiết lập mã PIN 4 chữ số thành công', async () => {
    // Act: Cài đặt mã PIN mới "8888"
    const res = await request(app)
      .post('/api/v1/auth/pin/setup')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        pin: '8888',
      });

    // Assert: Phải thiết lập thành công
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Kiểm tra trực tiếp trong DB xem pin đã được băm (hash) chưa
    const userInDb = await prisma.user.findUnique({
      where: { id: testUser.id },
    });
    expect(userInDb.pin).toBeDefined();
    expect(userInDb.pin).not.toBe('8888'); // Bắt buộc phải được mã hóa bcrypt, không lưu plain text!
  });

  it('4. Chặn thiết lập mã PIN không đủ 4 chữ số', async () => {
    // Act: Gửi mã PIN 6 số hoặc chứa chữ
    const res = await request(app)
      .post('/api/v1/auth/pin/setup')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        pin: '123456',
      });

    // Assert: Phải báo lỗi 400
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('5. Xác minh mã PIN: Đúng mã PIN thì thành công, sai thì từ chối', async () => {
    // Act 1: Xác minh với đúng mã PIN "8888"
    const correctRes = await request(app)
      .post('/api/v1/auth/pin/verify')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        pin: '8888',
      });
    expect(correctRes.status).toBe(200);
    expect(correctRes.body.success).toBe(true);

    // Act 2: Xác minh với sai mã PIN "9999"
    const wrongRes = await request(app)
      .post('/api/v1/auth/pin/verify')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        pin: '9999',
      });
    expect(wrongRes.status).toBe(200);
    expect(wrongRes.body.success).toBe(false);
  });
});
