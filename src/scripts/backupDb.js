// meat-management-be/src/scripts/backupDb.js
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables từ file .env.production hoặc .env.development hoặc .env
const envPath = fs.existsSync(path.join(__dirname, '../../.env.production')) 
  ? path.join(__dirname, '../../.env.production') 
  : fs.existsSync(path.join(__dirname, '../../.env.development'))
    ? path.join(__dirname, '../../.env.development')
    : path.join(__dirname, '../../.env');

dotenv.config({ path: envPath });
console.log(`Loaded environment variables from: ${envPath}`);

// Import prisma instance đã được cấu hình Driver Adapter đầy đủ
const prisma = require('../utils/db');

async function main() {
  console.log('🔄 Đang khởi tạo kết nối Database để sao lưu dữ liệu...');
  try {
    // Tải toàn bộ các bảng trong hệ thống
    const [
      users,
      customers,
      products,
      transactions,
      transactionItems,
      payments,
      suppliers,
      supplierTransactions,
      supplierPayments,
      employees,
      attendances,
      salaryAdvances,
      salaryPayments,
      activityLogs
    ] = await Promise.all([
      prisma.user.findMany(),
      prisma.customer.findMany(),
      prisma.product.findMany(),
      prisma.transaction.findMany(),
      prisma.transactionItem.findMany(),
      prisma.payment.findMany(),
      prisma.supplier.findMany(),
      prisma.supplierTransaction.findMany(),
      prisma.supplierPayment.findMany(),
      prisma.employee.findMany(),
      prisma.attendance.findMany(),
      prisma.salaryAdvance.findMany(),
      prisma.salaryPayment.findMany(),
      prisma.activityLog.findMany()
    ]);

    const backupData = {
      exportedAt: new Date().toISOString(),
      description: 'Sao lưu dữ liệu trước khi thay đổi logic ngày ghi nhận dòng tiền thanh toán thực tế',
      data: {
        users,
        customers,
        products,
        transactions,
        transactionItems,
        payments,
        suppliers,
        supplierTransactions,
        supplierPayments,
        employees,
        attendances,
        salaryAdvances,
        salaryPayments,
        activityLogs
      }
    };

    const backupDir = path.join(__dirname, '../../backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `db_backup_${timestamp}.json`;
    const filePath = path.join(backupDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf8');

    console.log(`\n✅ Sao lưu dữ liệu thành công!`);
    console.log(`📂 File backup: backups/${fileName}`);
    console.log(`   (Đường dẫn tuyệt đối: ${filePath})`);
    console.log(`📊 Chi tiết số lượng bản ghi:`);
    console.log(`   - Người dùng (Users): ${users.length}`);
    console.log(`   - Khách hàng (Customers): ${customers.length}`);
    console.log(`   - Mặt hàng thịt (Products): ${products.length}`);
    console.log(`   - Hóa đơn nợ (Transactions): ${transactions.length}`);
    console.log(`   - Chi tiết hóa đơn (Transaction Items): ${transactionItems.length}`);
    console.log(`   - Phiếu thu nợ (Payments): ${payments.length}`);
    console.log(`   - Nhà cung cấp (Suppliers): ${suppliers.length}`);
    console.log(`   - Nhân viên (Employees): ${employees.length}`);
    console.log(`   - Lịch sử hoạt động (Activity Logs): ${activityLogs.length}`);

  } catch (error) {
    console.error('❌ Lỗi trong quá trình sao lưu dữ liệu:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
