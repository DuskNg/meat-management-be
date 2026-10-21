// meat-management-be/src/utils/mediaCompressor.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const sharp = require('sharp');

let isFfmpegAvailableCache = null;

/**
 * Kiểm tra xem công cụ ffmpeg có khả dụng trên hệ điều hành hay không
 * @returns {Promise<boolean>}
 */
const checkFfmpegAvailability = async () => {
  if (isFfmpegAvailableCache !== null) return isFfmpegAvailableCache;
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (error) => {
      isFfmpegAvailableCache = !error;
      resolve(isFfmpegAvailableCache);
    });
  });
};

/**
 * Nén và tối ưu hóa hình ảnh tối đa trước khi lưu trữ
 * Sử dụng thư viện Sharp (libvips C++) cho tốc độ cực nhanh và dung lượng nhẹ nhất
 * 
 * @param {Buffer|string} input - Buffer, đường dẫn tệp hoặc Base64
 * @param {Object} [options]
 * @param {number} [options.maxDimension=1920] - Kích thước tối đa chiều rộng/chiều cao (chuẩn FullHD nét căng)
 * @param {number} [options.quality=75] - Mức chất lượng JPEG tối ưu (75 là chuẩn vàng cho hóa đơn tài liệu)
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string, bytes: number, originalBytes: number, wasCompressed: boolean }>}
 */
const compressImage = async (input, options = {}) => {
  const maxDimension = options.maxDimension || 1920;
  const quality = options.quality || 75;

  let originalBuffer = null;

  try {
    // 1. Chuyển đổi dữ liệu đầu vào về Buffer
    if (Buffer.isBuffer(input)) {
      originalBuffer = input;
    } else if (typeof input === 'string') {
      if (input.startsWith('data:')) {
        const commaIdx = input.indexOf(',');
        const base64Data = commaIdx !== -1 ? input.substring(commaIdx + 1) : input;
        originalBuffer = Buffer.from(base64Data, 'base64');
      } else if (fs.existsSync(input)) {
        originalBuffer = await fs.promises.readFile(input);
      } else {
        originalBuffer = Buffer.from(input, 'base64');
      }
    }

    if (!originalBuffer || originalBuffer.length === 0) {
      return {
        buffer: originalBuffer,
        mimeType: 'image/jpeg',
        ext: 'jpg',
        bytes: 0,
        originalBytes: 0,
        wasCompressed: false,
      };
    }

    const originalBytes = originalBuffer.length;

    // 2. Thực hiện tối ưu hóa qua Sharp:
    // - .rotate(): Tự động xoay ảnh theo đúng chiều chụp của điện thoại (EXIF)
    // - .resize(): Thu gọn kích thước tối đa 1920px (không kéo dãn nếu ảnh nhỏ hơn)
    // - .jpeg(): Nén với thuật toán mozjpeg cho dung lượng siêu nhẹ
    const compressedBuffer = await sharp(originalBuffer)
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality,
        mozjpeg: true,
        chromaSubsampling: '4:2:0',
      })
      .toBuffer();

    // 3. So sánh dung lượng: Chỉ lấy ảnh nén nếu dung lượng thực sự nhỏ hơn ảnh gốc
    if (compressedBuffer && compressedBuffer.length < originalBytes) {
      const savings = Math.round(((originalBytes - compressedBuffer.length) / originalBytes) * 100);
      console.log(
        `[IMAGE_COMPRESS] 📉 Đã nén ảnh thành công: ${(originalBytes / 1024).toFixed(1)}KB ➔ ${(compressedBuffer.length / 1024).toFixed(1)}KB (Giảm ${savings}%)`
      );

      return {
        buffer: compressedBuffer,
        mimeType: 'image/jpeg',
        ext: 'jpg',
        bytes: compressedBuffer.length,
        originalBytes,
        wasCompressed: true,
        savingsPercent: savings,
      };
    }

    // Nếu ảnh gốc ban đầu đã nhẹ hơn, giữ nguyên ảnh gốc
    return {
      buffer: originalBuffer,
      mimeType: 'image/jpeg',
      ext: 'jpg',
      bytes: originalBytes,
      originalBytes,
      wasCompressed: false,
      savingsPercent: 0,
    };
  } catch (error) {
    console.warn('[IMAGE_COMPRESS] Không thể nén ảnh, sử dụng buffer gốc:', error.message);
    return {
      buffer: originalBuffer || input,
      mimeType: 'image/jpeg',
      ext: 'jpg',
      bytes: originalBuffer ? originalBuffer.length : 0,
      originalBytes: originalBuffer ? originalBuffer.length : 0,
      wasCompressed: false,
      error: error.message,
    };
  }
};

/**
 * Nén và chuyển mã video tối ưu dung lượng (nếu máy chủ có ffmpeg)
 * Chuẩn hóa video sang H.264 MP4 với CRF 28 (giảm 80-90% dung lượng video gốc)
 * 
 * @param {Buffer|string} input - Đường dẫn file hoặc Buffer
 * @param {Object} [options]
 * @returns {Promise<{ buffer: Buffer, filePath?: string, mimeType: string, ext: string, bytes: number, wasCompressed: boolean }>}
 */
const compressVideo = async (input, options = {}) => {
  let originalBuffer = null;
  let inputFilePath = null;
  let tempInputCreated = false;

  try {
    if (typeof input === 'string' && fs.existsSync(input)) {
      inputFilePath = input;
      originalBuffer = await fs.promises.readFile(input);
    } else if (Buffer.isBuffer(input)) {
      originalBuffer = input;
    } else if (typeof input === 'string') {
      const commaIdx = input.indexOf(',');
      const base64Data = commaIdx !== -1 ? input.substring(commaIdx + 1) : input;
      originalBuffer = Buffer.from(base64Data, 'base64');
    }

    const originalBytes = originalBuffer ? originalBuffer.length : 0;
    const hasFfmpeg = await checkFfmpegAvailability();

    // Nếu không có ffmpeg trên hệ điều hành, bỏ qua nén và giữ nguyên video gốc
    if (!hasFfmpeg) {
      console.log(
        `[VIDEO_COMPRESS] Máy chủ chưa cấu hình ffmpeg, tải video gốc (${(originalBytes / (1024 * 1024)).toFixed(1)}MB) lên lưu trữ an toàn.`
      );
      return {
        buffer: originalBuffer,
        filePath: inputFilePath,
        mimeType: 'video/mp4',
        ext: 'mp4',
        bytes: originalBytes,
        originalBytes,
        wasCompressed: false,
      };
    }

    // Nếu chưa có file trên đĩa cứng, tạo file tạm để ffmpeg xử lý luồng
    if (!inputFilePath && originalBuffer) {
      inputFilePath = path.join(os.tmpdir(), `raw_vid_${Date.now()}_${Math.random().toString(36).substring(7)}.tmp`);
      await fs.promises.writeFile(inputFilePath, originalBuffer);
      tempInputCreated = true;
    }

    const outputFilePath = path.join(os.tmpdir(), `compressed_vid_${Date.now()}_${Math.random().toString(36).substring(7)}.mp4`);

    // Chạy ffmpeg: Scale tối đa 1280px (720p HD), H.264 CRF 28, AAC 96k, faststart để phát video mượt trên web/mobile
    const ffmpegArgs = [
      '-y',
      '-i', inputFilePath,
      '-vcodec', 'libx264',
      '-crf', '28',
      '-preset', 'fast',
      '-vf', "scale='min(1280,iw)':-2",
      '-acodec', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      outputFilePath,
    ];

    await new Promise((resolve, reject) => {
      execFile('ffmpeg', ffmpegArgs, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (fs.existsSync(outputFilePath)) {
      const compressedBuffer = await fs.promises.readFile(outputFilePath);
      const compressedBytes = compressedBuffer.length;

      // Xóa file output tạm
      fs.unlink(outputFilePath, () => {});

      if (compressedBytes < originalBytes) {
        const savings = Math.round(((originalBytes - compressedBytes) / originalBytes) * 100);
        console.log(
          `[VIDEO_COMPRESS] 📉 Đã nén video thành công: ${(originalBytes / (1024 * 1024)).toFixed(1)}MB ➔ ${(compressedBytes / (1024 * 1024)).toFixed(1)}MB (Giảm ${savings}%)`
        );

        return {
          buffer: compressedBuffer,
          mimeType: 'video/mp4',
          ext: 'mp4',
          bytes: compressedBytes,
          originalBytes,
          wasCompressed: true,
          savingsPercent: savings,
        };
      }
    }

    return {
      buffer: originalBuffer,
      filePath: inputFilePath,
      mimeType: 'video/mp4',
      ext: 'mp4',
      bytes: originalBytes,
      originalBytes,
      wasCompressed: false,
    };
  } catch (error) {
    console.warn('[VIDEO_COMPRESS] Lỗi khi nén video, giữ nguyên video gốc:', error.message);
    return {
      buffer: originalBuffer,
      filePath: inputFilePath,
      mimeType: 'video/mp4',
      ext: 'mp4',
      bytes: originalBuffer ? originalBuffer.length : 0,
      originalBytes: originalBuffer ? originalBuffer.length : 0,
      wasCompressed: false,
    };
  } finally {
    if (tempInputCreated && inputFilePath && fs.existsSync(inputFilePath)) {
      fs.unlink(inputFilePath, () => {});
    }
  }
};

/**
 * Hàm nén đa phương tiện tự động (Tự nhận diện ảnh hoặc video và tối ưu hóa tối đa)
 * 
 * @param {Buffer|string} fileData - Base64, Buffer hoặc file path
 * @param {Object} [options]
 * @param {boolean} [options.isVideo=false] - Cờ nhận diện là video
 * @returns {Promise<{ buffer: Buffer, mimeType: string, ext: string, bytes: number, originalBytes: number, wasCompressed: boolean }>}
 */
const compressMedia = async (fileData, options = {}) => {
  const isVideo =
    options.resource_type === 'video' ||
    options.isVideo ||
    (typeof fileData === 'string' && (
      fileData.startsWith('data:video/') ||
      /\.(mp4|mov|webm|m4v|avi|mkv)($|\?)/i.test(fileData)
    ));

  if (isVideo) {
    return await compressVideo(fileData, options);
  }

  return await compressImage(fileData, options);
};

module.exports = {
  compressImage,
  compressVideo,
  compressMedia,
  checkFfmpegAvailability,
};
