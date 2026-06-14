import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/index.js';
const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Bắt đầu dọn dẹp dữ liệu cũ...');
  // Xóa bảng theo thứ tự để tránh xung đột khóa ngoại
  await prisma.payment.deleteMany();
  await prisma.transactionItem.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.oTP.deleteMany();
  await prisma.user.deleteMany();
  console.log('✅ Đã dọn dẹp dữ liệu cũ xong.');

  console.log('👤 Đang tạo chủ buôn...');
  const user = await prisma.user.create({
    data: {
      name: 'Cô Hoa',
      phone: '0901234567',
    },
  });
  console.log(`✅ Đã tạo chủ buôn: ${user.name} - SĐT: ${user.phone}`);

  console.log('📦 Đang tạo danh mục sản phẩm (thịt)...');
  const products = await Promise.all([
    prisma.product.create({
      data: { userId: user.id, name: 'Ba chỉ', defaultPrice: 130000, unit: 'kg' },
    }),
    prisma.product.create({
      data: { userId: user.id, name: 'Nạc vai', defaultPrice: 120000, unit: 'kg' },
    }),
    prisma.product.create({
      data: { userId: user.id, name: 'Sườn non', defaultPrice: 160000, unit: 'kg' },
    }),
    prisma.product.create({
      data: { userId: user.id, name: 'Móng giò', defaultPrice: 90000, unit: 'kg' },
    }),
    prisma.product.create({
      data: { userId: user.id, name: 'Lòng heo', defaultPrice: 80000, unit: 'kg' },
    }),
  ]);
  console.log(`✅ Đã tạo ${products.length} sản phẩm thịt.`);
  const [baChi, nacVai, suonNon, mongGio, langHeo] = products;

  console.log('👥 Đang tạo danh sách khách hàng quen...');
  const customers = await Promise.all([
    prisma.customer.create({
      data: {
        userId: user.id,
        name: 'Chị Lan Bán Phở',
        phone: '0911222333',
        address: 'Kiosk 12, Chợ Đầu Mối',
        note: 'Mua nạc vai và sườn non vào sáng sớm.',
      },
    }),
    prisma.customer.create({
      data: {
        userId: user.id,
        name: 'Anh Hùng Quán Cơm',
        phone: '0922333444',
        address: '45 Trần Hưng Đạo',
        note: 'Lấy lượng lớn ba chỉ và móng giò.',
      },
    }),
    prisma.customer.create({
      data: {
        userId: user.id,
        name: 'Anh Dũng Bán Hủ Tiếu',
        phone: '0933444555',
        address: '78 Lý Tự Trọng',
        note: 'Mua lòng heo làm hủ tiếu gõ.',
      },
    }),
  ]);
  console.log(`✅ Đã tạo ${customers.length} khách hàng.`);
  const [lanPho, hungCom, dungHuTieu] = customers;

  console.log('📝 Đang tạo các hóa đơn giao dịch (ghi nợ)...');

  // Giao dịch 1: Chị Lan mua hàng cách đây 4 ngày
  const trans1Date = new Date();
  trans1Date.setDate(trans1Date.getDate() - 4);
  const trans1 = await prisma.transaction.create({
    data: {
      userId: user.id,
      customerId: lanPho.id,
      date: trans1Date,
      note: 'Giao sáng sớm cho quán phở',
      totalAmount: 1080000, // 5kg nạc vai (600k) + 3kg sườn non (480k)
      items: {
        create: [
          { productId: nacVai.id, quantity: 5, price: 120000, amount: 600000 },
          { productId: suonNon.id, quantity: 3, price: 160000, amount: 480000 },
        ],
      },
    },
  });

  // Giao dịch 2: Chị Lan mua hàng cách đây 2 ngày
  const trans2Date = new Date();
  trans2Date.setDate(trans2Date.getDate() - 2);
  const trans2 = await prisma.transaction.create({
    data: {
      userId: user.id,
      customerId: lanPho.id,
      date: trans2Date,
      note: 'Lan lấy thêm nạc vai làm phở chiều',
      totalAmount: 480000, // 4kg nạc vai (480k)
      items: {
        create: [
          { productId: nacVai.id, quantity: 4, price: 120000, amount: 480000 },
        ],
      },
    },
  });

  // Giao dịch 3: Anh Hùng mua hàng cách đây 3 ngày
  const trans3Date = new Date();
  trans3Date.setDate(trans3Date.getDate() - 3);
  const trans3 = await prisma.transaction.create({
    data: {
      userId: user.id,
      customerId: hungCom.id,
      date: trans3Date,
      note: 'Lấy sỉ làm quán cơm trưa',
      totalAmount: 1750000, // 10kg ba chỉ (1300k) + 5kg móng giò (450k)
      items: {
        create: [
          { productId: baChi.id, quantity: 10, price: 130000, amount: 1300000 },
          { productId: mongGio.id, quantity: 5, price: 90000, amount: 450000 },
        ],
      },
    },
  });

  // Giao dịch 4: Anh Hùng mua hàng cách đây 1 ngày
  const trans4Date = new Date();
  trans4Date.setDate(trans4Date.getDate() - 1);
  const trans4 = await prisma.transaction.create({
    data: {
      userId: user.id,
      customerId: hungCom.id,
      date: trans4Date,
      note: 'Lấy lòng heo và ba chỉ thêm',
      totalAmount: 550000, // 2kg lòng heo (160k) + 3kg ba chỉ (390k)
      items: {
        create: [
          { productId: langHeo.id, quantity: 2, price: 80000, amount: 160000 },
          { productId: baChi.id, quantity: 3, price: 130000, amount: 390000 },
        ],
      },
    },
  });

  // Giao dịch 5: Anh Dũng mua hàng hôm nay
  const trans5 = await prisma.transaction.create({
    data: {
      userId: user.id,
      customerId: dungHuTieu.id,
      date: new Date(),
      note: 'Lấy đồ làm hủ tiếu chiều tối',
      totalAmount: 650000, // 2kg ba chỉ (260k) + 1.5kg lòng heo (120k) + 3kg móng giò (270k)
      items: {
        create: [
          { productId: baChi.id, quantity: 2, price: 130000, amount: 260000 },
          { productId: langHeo.id, quantity: 1.5, price: 80000, amount: 120000 },
          { productId: mongGio.id, quantity: 3, price: 90000, amount: 270000 },
        ],
      },
    },
  });
  console.log('✅ Đã tạo thành công 5 hóa đơn giao dịch.');

  console.log('💳 Đang tạo nhật ký thu tiền thanh toán...');
  // Chị Lan trả bớt 600k (tổng nợ 1.560k còn 960k)
  await prisma.payment.create({
    data: {
      customerId: lanPho.id,
      amount: 600000,
      paidAt: trans1Date,
      note: 'Trả bớt một phần nợ phở sáng bằng chuyển khoản Vietcombank',
    },
  });

  // Anh Hùng trả 1.500k (tổng nợ 2.300k còn 800k)
  await prisma.payment.create({
    data: {
      customerId: hungCom.id,
      amount: 1500000,
      paidAt: trans3Date,
      note: 'Anh Hùng trả trước một phần tiền mặt',
    },
  });

  // Anh Dũng trả 300k (tổng nợ 650k còn 350k)
  await prisma.payment.create({
    data: {
      customerId: dungHuTieu.id,
      amount: 300000,
      paidAt: new Date(),
      note: 'Trả tiền mặt một phần tại sạp',
    },
  });
  console.log('✅ Đã tạo thành công nhật ký thanh toán.');

  console.log('🎉 Quá trình seed dữ liệu thành công rực rỡ!');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
