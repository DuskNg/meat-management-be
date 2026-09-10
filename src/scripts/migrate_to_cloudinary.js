require('dotenv').config({ override: true });

const prisma = require('../utils/db');
const { isCloudinaryConfigured, uploadToCloudinary } = require('../utils/cloudinary');

async function migrate() {
  console.log('=== BẮT ĐẦU CHUYỂN ĐỔI ẢNH HÓA ĐƠN SANG CLOUDINARY ===');

  if (!isCloudinaryConfigured()) {
    console.error('❌ LỖI: Chưa tìm thấy cấu hình Cloudinary trong file .env!');
    console.log('👉 Vui lòng thêm các biến môi trường sau vào file .env:');
    console.log('   CLOUDINARY_CLOUD_NAME=your_cloud_name');
    console.log('   CLOUDINARY_API_KEY=your_api_key');
    console.log('   CLOUDINARY_API_SECRET=your_api_secret');
    console.log('   (hoặc CLOUDINARY_URL=cloudinary://...)');
    process.exit(1);
  }

  try {
    const invoices = await prisma.transactionInvoice.findMany({
      orderBy: { createdAt: 'asc' },
    });

    console.log(`Tìm thấy tổng cộng ${invoices.length} hóa đơn trong cơ sở dữ liệu.`);

    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      const prefix = `[${i + 1}/${invoices.length}]`;

      // Nếu ảnh đã là link Cloudinary thì bỏ qua
      if (inv.imageUrl && inv.imageUrl.includes('res.cloudinary.com')) {
        console.log(`${prefix} Đã là link Cloudinary, bỏ qua: ${inv.id}`);
        skippedCount++;
        continue;
      }

      // Nếu không có dữ liệu ảnh
      if (!inv.imageUrl) {
        console.log(`${prefix} Không có dữ liệu ảnh, bỏ qua: ${inv.id}`);
        skippedCount++;
        continue;
      }

      console.log(`${prefix} Đang tải lên Cloudinary hóa đơn ID: ${inv.id}...`);

      try {
        const uploadResult = await uploadToCloudinary(inv.imageUrl, {
          folder: 'meat_invoices',
          public_id: `inv_${inv.id}`,
        });

        if (uploadResult && uploadResult.secure_url) {
          await prisma.transactionInvoice.update({
            where: { id: inv.id },
            data: { imageUrl: uploadResult.secure_url },
          });

          successCount++;
          console.log(`${prefix} ✅ Thành công: ${uploadResult.secure_url}`);
        } else {
          console.error(`${prefix} ❌ Không nhận được URL từ Cloudinary.`);
          errorCount++;
        }
      } catch (uploadErr) {
        console.error(`${prefix} ❌ Lỗi khi tải ảnh:`, uploadErr.message);
        errorCount++;
      }
    }

    console.log('\n=== KẾT QUẢ CHUYỂN ĐỔI ===');
    console.log(`✅ Thành công: ${successCount}`);
    console.log(`⏭️ Bỏ qua: ${skippedCount}`);
    console.log(`❌ Thất bại: ${errorCount}`);
  } catch (err) {
    console.error('Lỗi khi thực thi migrate:', err);
  } finally {
    process.exit(0);
  }
}

migrate();
