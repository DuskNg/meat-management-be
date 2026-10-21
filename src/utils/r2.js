// meat-management-be/src/utils/r2.js
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let s3ClientInstance = null;

/**
 * Kiểm tra xem các biến môi trường của Cloudflare R2 đã được cấu hình đầy đủ chưa
 * @returns {boolean}
 */
const isR2Configured = () => {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_PUBLIC_DOMAIN
  );
};

/**
 * Khởi tạo hoặc lấy S3Client kết nối Cloudflare R2
 * @returns {S3Client|null}
 */
const getR2Client = () => {
  if (!isR2Configured()) return null;
  if (!s3ClientInstance) {
    s3ClientInstance = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3ClientInstance;
};

/**
 * Helper xác định định dạng và MIME type của dữ liệu
 */
const detectFileInfo = (fileData, options = {}) => {
  let isVideo = options.resource_type === 'video';
  let mimeType = isVideo ? 'video/mp4' : 'image/jpeg';
  let ext = isVideo ? 'mp4' : 'jpg';

  if (typeof fileData === 'string') {
    // Nhận diện qua Data URI Header
    if (fileData.startsWith('data:')) {
      const match = fileData.match(/^data:([^;]+);base64,/i);
      if (match && match[1]) {
        mimeType = match[1].toLowerCase();
        if (mimeType.includes('video') || mimeType.includes('quicktime') || mimeType.includes('mp4')) {
          isVideo = true;
          ext = 'mp4';
        } else if (mimeType.includes('png')) {
          ext = 'png';
        } else if (mimeType.includes('webp')) {
          ext = 'webp';
        }
      }
    } else if (fs.existsSync(fileData)) {
      // Nhận diện qua đuôi file trên đĩa
      const fileExt = path.extname(fileData).toLowerCase().replace('.', '');
      if (['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'].includes(fileExt)) {
        isVideo = true;
        ext = fileExt === 'mov' ? 'mp4' : fileExt;
        mimeType = fileExt === 'webm' ? 'video/webm' : 'video/mp4';
      } else if (fileExt === 'png') {
        ext = 'png';
        mimeType = 'image/png';
      } else if (fileExt === 'webp') {
        ext = 'webp';
        mimeType = 'image/webp';
      }
    }
  }

  return { isVideo, mimeType, ext };
};

const { compressMedia } = require('./mediaCompressor');

/**
 * Tải ảnh hoặc video lên Cloudflare R2
 * Tự động nén và tối ưu hóa dung lượng tối đa trước khi đưa vào kho lưu trữ
 * @param {string|Buffer} fileData - Base64 data URI, đường dẫn file trên đĩa hoặc Buffer
 * @param {Object} [options] - Tùy chọn folder, public_id, filePath, resource_type
 * @returns {Promise<{ secure_url: string, url: string, public_id: string, resource_type: string, bytes: number, originalBytes?: number }>}
 */
const uploadToR2 = async (fileData, options = {}) => {
  if (!isR2Configured()) {
    throw new Error('Chưa cấu hình đầy đủ biến môi trường Cloudflare R2 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_DOMAIN).');
  }

  const client = getR2Client();
  const bucketName = process.env.R2_BUCKET_NAME || 'meat-management';
  const publicDomain = (process.env.R2_PUBLIC_DOMAIN || '').replace(/\/+$/, '');

  // Xác định file path thực tế trên đĩa nếu có
  const localFilePath = options.filePath || (typeof fileData === 'string' && !fileData.startsWith('data:') && !fileData.startsWith('http') && fs.existsSync(fileData) ? fileData : null);

  let { isVideo, mimeType, ext } = detectFileInfo(localFilePath || fileData, options);

  // Chuẩn bị Buffer dữ liệu cần tải lên
  let fileBuffer = null;
  if (Buffer.isBuffer(fileData)) {
    fileBuffer = fileData;
  } else if (localFilePath && fs.existsSync(localFilePath)) {
    fileBuffer = await fs.promises.readFile(localFilePath);
  } else if (typeof fileData === 'string') {
    let cleanBase64 = fileData;
    const commaIdx = fileData.indexOf(',');
    if (commaIdx !== -1) {
      cleanBase64 = fileData.substring(commaIdx + 1);
    }
    fileBuffer = Buffer.from(cleanBase64, 'base64');
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error('Dữ liệu tệp tải lên Cloudflare R2 không hợp lệ hoặc rỗng.');
  }

  const originalBytes = fileBuffer.length;

  // --- BƯỚC NÉN VÀ TỐI ƯU HÓA DUNG LƯỢNG TỐI ĐA TRƯỚC KHI TẢI LÊN CLOUDFLARE R2 ---
  try {
    const compressionResult = await compressMedia(localFilePath || fileBuffer, {
      isVideo,
      resource_type: isVideo ? 'video' : 'image',
      maxDimension: 1920,
      quality: 75,
    });

    if (compressionResult && compressionResult.buffer && compressionResult.buffer.length > 0) {
      fileBuffer = compressionResult.buffer;
      if (compressionResult.mimeType) mimeType = compressionResult.mimeType;
      if (compressionResult.ext) ext = compressionResult.ext;
    }
  } catch (compressErr) {
    console.warn('[CLOUDFLARE_R2] Bỏ qua nén do lỗi, tiếp tục upload dữ liệu gốc:', compressErr.message);
  }

  // Tạo khóa lưu trữ (Key) trên R2
  const folder = (options.folder || 'meat_invoices').replace(/^\/+|\/+$/g, '');
  let objectKey = options.public_id;
  if (!objectKey) {
    const randomHex = crypto.randomBytes(6).toString('hex');
    const prefix = isVideo ? 'vid' : 'img';
    objectKey = `${folder}/${prefix}_${Date.now()}_${randomHex}.${ext}`;
  } else if (!path.extname(objectKey)) {
    objectKey = `${objectKey}.${ext}`;
  }

  // Thực hiện tải lên với cơ chế thử lại (Retry 3 lần)
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
        Body: fileBuffer,
        ContentType: mimeType,
      });

      await client.send(command);

      const publicUrl = `${publicDomain}/${objectKey}`;

      return {
        secure_url: publicUrl,
        url: publicUrl,
        public_id: objectKey,
        resource_type: isVideo ? 'video' : 'image',
        bytes: fileBuffer.length,
      };
    } catch (err) {
      lastError = err;
      console.warn(`[CLOUDFLARE_R2] Lỗi tải file lên R2 (Lần ${attempt}/${maxRetries}):`, err.message);
      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 1000 * attempt));
      }
    }
  }

  console.error('[CLOUDFLARE_R2] Đã thử lại 3 lần nhưng tải file lên R2 vẫn thất bại:', lastError.message);
  throw lastError;
};

/**
 * Xóa ảnh hoặc video trên Cloudflare R2 theo key
 * @param {string} objectKey
 * @returns {Promise<boolean>}
 */
const deleteFromR2 = async (objectKey) => {
  if (!isR2Configured() || !objectKey) return false;
  try {
    const client = getR2Client();
    const bucketName = process.env.R2_BUCKET_NAME || 'meat-management';

    // Xử lý nếu objectKey truyền vào là URL đầy đủ (ví dụ: https://pub-xxx.r2.dev/meat_invoices/img_123.jpg)
    let cleanKey = String(objectKey).trim();
    if (cleanKey.startsWith('http://') || cleanKey.startsWith('https://')) {
      cleanKey = cleanKey.replace(/^https?:\/\/[^\/]+\//, '');
    }
    // Bỏ query string nếu có và loại bỏ dấu gạch chéo đầu chuỗi
    cleanKey = cleanKey.split('?')[0].replace(/^\/+/, '');

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: cleanKey,
    });

    await client.send(command);
    return true;
  } catch (err) {
    console.error('[CLOUDFLARE_R2] Lỗi xóa file trên R2:', err.message);
    return false;
  }
};

module.exports = {
  isR2Configured,
  uploadToR2,
  deleteFromR2,
  getR2Client,
  compressMedia,
};
