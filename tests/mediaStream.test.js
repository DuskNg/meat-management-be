// tests/mediaStream.test.js
// Kiểm thử tự động: API Media Streaming Proxy (Hỗ trợ phát video Range 206 mượt mà)
const request = require('supertest');
const { app } = require('../src/index');

describe('Luồng Nghiệp Vụ: Proxy Media Streaming Hỗ Trợ HTTP Range 206', () => {
  it('1. Chặn request khi thiếu tham số url (400 Bad Request)', async () => {
    const res = await request(app).get('/api/v1/media/stream');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('2. Chặn request khi URL không đúng định dạng (400 Bad Request)', async () => {
    const res = await request(app).get('/api/v1/media/stream?url=invalid-url');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('3. Trả về header CORS cho phép stream liên trang web', async () => {
    const res = await request(app)
      .options('/api/v1/media/stream?url=https://example.com/test.mp4');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
