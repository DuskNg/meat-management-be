// meat-management-be/tests/mediaCompressor.test.js
require('../src/index');
const sharp = require('sharp');
const { compressImage, compressMedia, checkFfmpegAvailability } = require('../src/utils/mediaCompressor');
const { uploadToR2, isR2Configured, deleteFromR2 } = require('../src/utils/r2');

describe('Luồng Nghiệp Vụ: Nén Ảnh & Video Tối Đa Trước Khi Tải Lên Cloudflare R2', () => {
  let largeImageBuffer = null;
  let originalSize = 0;

  beforeAll(async () => {
    // Tạo một bức ảnh giả lập độ phân giải lớn (2500x2500px, 3 kênh màu RGB) nặng khoảng 1MB+
    largeImageBuffer = await sharp({
      create: {
        width: 2500,
        height: 2500,
        channels: 3,
        background: { r: 230, g: 100, b: 80 },
      },
    })
      .png({ compressionLevel: 0 }) // Không nén để dung lượng lớn
      .toBuffer();

    originalSize = largeImageBuffer.length;
  });

  test('1. compressImage: Tự động thu gọn kích thước tối đa 1920px và nén giảm dung lượng đáng kể', async () => {
    const result = await compressImage(largeImageBuffer, {
      maxDimension: 1920,
      quality: 75,
    });

    expect(result.wasCompressed).toBe(true);
    expect(result.bytes).toBeLessThan(originalSize);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.ext).toBe('jpg');

    // Kiểm tra kích thước ảnh sau nén
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1920);
    expect(metadata.height).toBeLessThanOrEqual(1920);

    // Mức độ giảm dung lượng phải đạt trên 50%
    const savingsPercent = Math.round(((originalSize - result.bytes) / originalSize) * 100);
    expect(savingsPercent).toBeGreaterThan(50);
  });

  test('2. compressMedia: Tự động nhận diện ảnh và tối ưu hóa', async () => {
    const result = await compressMedia(largeImageBuffer, {
      resource_type: 'image',
    });

    expect(result.wasCompressed).toBe(true);
    expect(result.bytes).toBeLessThan(originalSize);
    expect(result.mimeType).toBe('image/jpeg');
  });

  test('3. Fallback an toàn: Dữ liệu ảnh nhỏ hoặc định dạng lạ không bị crash', async () => {
    // Thử với buffer rỗng hoặc chuỗi text ngẫu nhiên
    const invalidBuffer = Buffer.from('hello world random non-image bytes');
    const result = await compressImage(invalidBuffer);

    // Không throw lỗi, trả về an toàn
    expect(result.wasCompressed).toBe(false);
    expect(result.buffer).toBeDefined();
  });

  test('4. Tích hợp uploadToR2: Ảnh được tự động nén trước khi đưa lên Cloudflare R2', async () => {
    if (!isR2Configured()) {
      console.warn('Bỏ qua test tải lên R2 vì chưa có cấu hình');
      return;
    }

    const uploadRes = await uploadToR2(largeImageBuffer, {
      folder: 'meat_test_compress',
    });

    expect(uploadRes).toBeDefined();
    expect(uploadRes.secure_url).toContain('.r2.dev');
    // Dung lượng tải lên R2 phải nhỏ hơn dung lượng ảnh gốc
    expect(uploadRes.bytes).toBeLessThan(originalSize);

    // Dọn dẹp tệp test trên R2
    if (uploadRes.public_id) {
      await deleteFromR2(uploadRes.public_id);
    }
  });
});
