# Hướng Dẫn Dễ Hiểu Về Thư Mục Prisma 🥩

Thư mục này là nơi quản lý toàn bộ "bản vẽ thiết kế" và dữ liệu của cơ sở dữ liệu (Database) trong dự án Meat Manager.

---

## 📌 Các file trong này dùng làm gì?

- **`schema.prisma` (Bản vẽ thiết kế nhà):** 
  Quy định cơ sở dữ liệu của chúng ta có những bảng nào (ví dụ: bảng chủ buôn, bảng khách hàng, bảng đơn thịt) và các bảng đó liên kết với nhau ra sao.

- **`seed.js` (Nút reset game/bơm dữ liệu mẫu):** 
  Mỗi lần test app, bạn sẽ cần có sẵn vài khách hàng và đơn hàng mẫu để xem giao diện hiển thị thế nào. File này giúp xóa hết dữ liệu cũ bị rác và tự động tạo lại một loạt dữ liệu mẫu (ví dụ: Chị Lan bán phở, đơn 5kg nạc vai...) để bạn test nhanh mà không cần gõ tay lại từ đầu.

- **Thư mục `migrations/` (Lịch sử cập nhật bản vẽ):** 
  Mỗi lần bạn sửa đổi `schema.prisma` (ví dụ: thêm cột SĐT khách hàng), hệ thống sẽ tạo ra một file ghi lại lịch sử thay đổi này. Khi đưa app lên mạng (deploy), hệ thống sẽ nhìn vào đây để tự động nâng cấp cơ sở dữ liệu mà không làm mất dữ liệu cũ của người dùng.

---

## 🚀 5 Lệnh thường dùng nhất (Chạy trong terminal backend)

### 1. Check lỗi bản vẽ
Kiểm tra xem file `schema.prisma` bạn viết có bị sai cú pháp hoặc liên kết sai chỗ nào không:
```bash
npx prisma validate
```

### 2. Tạo code kết nối (Generate)
Dịch bản thiết kế `schema.prisma` thành các hàm Javascript để chúng ta viết code gọi dữ liệu cho dễ. Thay vì viết những câu lệnh SQL dài dòng, bạn chỉ cần gõ `prisma.customer.findMany()` là xong:
```bash
npx prisma generate
```

### 3. Lưu lịch sử và cập nhật Database (Migrate)
Mỗi khi bạn sửa đổi gì đó trong file `schema.prisma`, hãy chạy lệnh này để áp dụng thay đổi đó vào cơ sở dữ liệu thực tế:
```bash
npx prisma migrate dev --name <tên_gợi_nhớ>
# Ví dụ: npx prisma migrate dev --name add_customer_address
```

### 4. Bơm dữ liệu mẫu để test (Seed)
Xóa sạch dữ liệu cũ và nạp lại danh sách khách hàng, đơn thịt mẫu từ file `seed.js` để có dữ liệu sạch để test:
```bash
npm run seed
```

### 5. Mở giao diện xem dữ liệu bằng mắt (Studio)
Mở một trang web quản lý dữ liệu trực quan (nhìn giống như bảng Excel) để bạn xem trực tiếp, thêm hoặc sửa dữ liệu bằng tay mà không cần viết code:
```bash
npx prisma studio
```
Trang web sẽ tự động mở ở địa chỉ: `http://localhost:5555`
