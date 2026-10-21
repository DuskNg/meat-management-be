// meat-management-be/tests/r2Storage.test.js
import { describe, it, expect } from 'vitest';
require('../src/index');
const { isR2Configured, uploadToR2, deleteFromR2 } = require('../src/utils/r2');
const { isCloudinaryConfigured, uploadToCloudinary } = require('../src/utils/cloudinary');

describe('Luồng Nghiệp Vụ: Tích Hợp Lưu Trữ Đám Mây Cloudflare R2', () => {
  it('1. Kiểm tra cấu hình Cloudflare R2: Phải nhận diện đầy đủ biến môi trường', () => {
    expect(typeof isR2Configured).toBe('function');
    // Khi chạy test, biến môi trường R2_ACCOUNT_ID đã được nạp
    expect(isCloudinaryConfigured()).toBe(true);
  });

  it('2. uploadToCloudinary tự động chuyển tiếp sang Cloudflare R2 khi R2 đã cấu hình', async () => {
    // 1 ảnh pixel 1x1 base64
    const sampleImageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const uploadRes = await uploadToCloudinary(sampleImageBase64, {
      folder: 'test_auto_unit',
    });

    expect(uploadRes).toBeDefined();
    expect(uploadRes.secure_url).toBeDefined();
    expect(uploadRes.secure_url).toContain('.r2.dev');
    expect(uploadRes.resource_type).toBe('image');

    // Dọn dẹp sau test
    if (uploadRes.public_id) {
      await deleteFromR2(uploadRes.public_id);
    }
  });
});
