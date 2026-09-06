require('dotenv').config();
const fs = require('fs');
const path = require('path');
const prisma = require('../src/utils/db');

async function main() {
  const userPhone = '0327747340';
  const user = await prisma.user.findUnique({
    where: { phone: userPhone }
  });

  if (!user) {
    console.error('Không tìm thấy người dùng với số điện thoại:', userPhone);
    process.exit(1);
  }

  console.log(`Tìm thấy user: ${user.name} (ID: ${user.id}, SĐT: ${user.phone})`);

  // 1. Lấy tất cả khách hàng của user
  const customers = await prisma.customer.findMany({
    where: { userId: user.id },
    include: {
      customPrices: {
        include: { product: true }
      }
    },
    orderBy: { name: 'asc' }
  });

  console.log(`Tổng số khách hàng của user: ${customers.length}`);

  // 2. Backup bảng CustomerProductPrice hiện tại
  const allCurrentPrices = await prisma.customerProductPrice.findMany({
    where: {
      customer: { userId: user.id }
    },
    include: {
      customer: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, defaultPrice: true } }
    }
  });

  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const backupFile = path.join(backupDir, `backup_customer_product_prices_${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(allCurrentPrices, null, 2), 'utf-8');
  console.log(`Đã sao lưu ${allCurrentPrices.length} bản ghi CustomerProductPrice vào: ${backupFile}`);

  // 3. Mốc thời gian trước ngày 01/09/2026 (GMT+7)
  // Ngày 01/09/2026 00:00:00 GMT+7 tương đương 2026-08-31T17:00:00.000Z
  const cutoffDate = new Date('2026-08-31T17:00:00.000Z');

  let totalUpdated = 0;
  let totalCreated = 0;
  let totalUnchanged = 0;
  const changeReport = [];

  for (const customer of customers) {
    // Tìm tất cả item giao dịch trước 01/09 của khách hàng này
    const txItems = await prisma.transactionItem.findMany({
      where: {
        transaction: {
          customerId: customer.id,
          date: { lt: cutoffDate }
        }
      },
      include: {
        transaction: true,
        product: true
      },
      orderBy: [
        { transaction: { date: 'desc' } },
        { transaction: { createdAt: 'desc' } }
      ]
    });

    // Lọc lấy giá gần nhất cho từng productId
    const latestPriceMap = new Map();
    for (const item of txItems) {
      if (item.productId && !latestPriceMap.has(item.productId)) {
        latestPriceMap.set(item.productId, {
          productId: item.productId,
          productName: item.product?.name || item.customProductName || 'Không rõ',
          price: Number(item.price),
          costPrice: item.costPrice ? Number(item.costPrice) : null,
          txDate: item.transaction.date.toISOString().split('T')[0]
        });
      }
    }

    if (latestPriceMap.size === 0) {
      continue;
    }

    const customerChanges = [];

    for (const [productId, itemData] of latestPriceMap.entries()) {
      const existingRecord = customer.customPrices.find(cp => cp.productId === productId);
      const currentPrice = existingRecord ? Number(existingRecord.price) : null;

      if (currentPrice === itemData.price) {
        totalUnchanged++;
        continue;
      }

      // Cập nhật hoặc tạo mới CustomerProductPrice
      if (existingRecord) {
        await prisma.customerProductPrice.update({
          where: { id: existingRecord.id },
          data: {
            price: itemData.price,
            costPrice: itemData.costPrice !== null ? itemData.costPrice : existingRecord.costPrice,
            updatedAt: new Date()
          }
        });
        totalUpdated++;
        customerChanges.push({
          productName: itemData.productName,
          oldPrice: currentPrice,
          newPrice: itemData.price,
          txDate: itemData.txDate,
          action: 'UPDATE'
        });
      } else {
        await prisma.customerProductPrice.create({
          data: {
            customerId: customer.id,
            productId: productId,
            price: itemData.price,
            costPrice: itemData.costPrice,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        });
        totalCreated++;
        customerChanges.push({
          productName: itemData.productName,
          oldPrice: 'Chưa có',
          newPrice: itemData.price,
          txDate: itemData.txDate,
          action: 'CREATE'
        });
      }
    }

    if (customerChanges.length > 0) {
      changeReport.push({
        customerName: customer.name,
        changes: customerChanges
      });
    }
  }

  console.log('\n================ BÁO CÁO KẾT QUẢ CẬP NHẬT ================');
  console.log(`Số bản ghi cập nhật giá mới: ${totalUpdated}`);
  console.log(`Số bản ghi tạo mới giá: ${totalCreated}`);
  console.log(`Số bản ghi không đổi: ${totalUnchanged}`);
  console.log('----------------------------------------------------------');

  for (const report of changeReport) {
    console.log(`Khách hàng: ${report.customerName}`);
    for (const ch of report.changes) {
      console.log(`   - [${ch.action}] ${ch.productName}: ${ch.oldPrice} -> ${ch.newPrice}đ (Đơn ngày: ${ch.txDate})`);
    }
  }

  console.log('==========================================================\n');
}

main()
  .catch((err) => {
    console.error('Lỗi trong quá trình cập nhật:', err);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
