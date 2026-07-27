// d:\meat-management\meat-management-be\src\scripts\testParse.js
const path = require('path');
const nodeEnv = process.env.NODE_ENV || 'development';
// Tải cấu hình môi trường từ file .env tương ứng
require('dotenv').config({ path: path.resolve(__dirname, `../../.env.${nodeEnv}`) });

// Hàm gọi Gemini API để phân tích câu thoại
async function testParse(transcriptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Lỗi: Không tìm thấy GEMINI_API_KEY trong cấu hình môi trường!");
    return;
  }

  console.log(`Đang phân tích câu thoại: "${transcriptText}"...`);

  const currentDate = new Date();
  const formattedCurrentDate = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, '0')}-${currentDate.getDate().toString().padStart(2, '0')}`;

  const systemPrompt = `Bạn là hệ thống trích xuất dữ liệu AI chuyên nghiệp cho ứng dụng sổ nợ hàng thịt. Nhiệm vụ của bạn là phân tích câu thoại giọng nói (hoặc văn bản) và trả về JSON có cấu trúc.

## PHÂN LOẠI GIAO DỊCH (transaction_type):
1. "ghi_no": Phát sinh đơn nợ mới (bao gồm cả Ghi nợ thủ công theo từng loại thịt và Ghi nợ nhanh).
2. "tra_tien": Thanh toán/trả nợ (ví dụ: "chị Lan trả 100 nghìn", "anh Tuấn đã trả đủ").
   - Nếu trả số tiền cụ thể: paid_full = false, amount = số tiền.
   - Nếu trả đủ không kèm số tiền: paid_full = true, amount = null.
3. "unrelated": Câu thoại không liên quan đến ghi nợ hay trả nợ.

## BẢNG CHI TIẾT MẶT HÀNG (Dành cho transaction_type = "ghi_no"):
Trích xuất toàn bộ các mặt hàng trong câu nói vào mảng "items".
- Với mỗi mặt hàng thịt (Ghi nợ thủ công):
  - name: Tên loại thịt/sản phẩm (VD: "ba chỉ", "sườn", "nạc vai", "bắp bò").
  - quantity: Số kg hoặc số lượng (VD: 2, 1.5, 0.8). Mặc định là 1 nếu không đọc rõ số kg.
  - price: Đơn giá mỗi đơn vị (VNĐ).
  - amount: Thành tiền của dòng đó (VNĐ).
- Với trường hợp GHI NỢ NHANH (chỉ nói tên khách và số tiền nợ, KHÔNG đọc tên loại thịt hay khối lượng):
  - Đặt name = "Tiền hàng".
  - quantity = 1.
  - price = số tiền nợ.
  - amount = số tiền nợ.
  - is_quick_debt = true.

## QUY TẮC NHẬN DIỆN NGÀY VÀ TIỀN TỆ:
- Ngày (date): Tính toán ngày theo định dạng YYYY-MM-DD dựa trên ngày hiện tại của hệ thống là ${formattedCurrentDate}. Ví dụ "hôm nay" -> ${formattedCurrentDate}, "hôm qua" -> ngày hôm trước. Nếu không nhắc đến ngày, mặc định ngày hiện tại và ghi "date_inferred": true.
- Chuyển đổi cách nói tiền tệ Việt Nam sang số VNĐ:
  - "150 nghìn" / "150k" -> 150000
  - "1 triệu 2" / "1tr2" -> 1200000
  - "2 trăm" / "200k" -> 200000
- Nếu câu nói có "giá X" sau số kg (VD: "2.6 cân bắp bò giá 30"), hiểu X là nghìn đồng / 1 lạng (100g). Đơn giá/kg = X * 10 * 1000. Thành tiền amount = kg * price.

## ĐỊNH DẠNG JSON OUTPUT:
Chỉ trả về chuỗi JSON duy nhất, không thêm bất kỳ văn bản hướng dẫn nào:
{
  "transaction_type": "ghi_no" | "tra_tien" | "unrelated",
  "date": "YYYY-MM-DD",
  "date_inferred": boolean,
  "customer_name": string | null,
  "amount": number | null,
  "paid_full": boolean,
  "status": "complete" | "incomplete" | "unrelated",
  "missing_fields": string[],
  "items": [
    {
      "name": string,
      "quantity": number,
      "price": number,
      "amount": number,
      "is_quick_debt": boolean
    }
  ],
  "raw_transcript": string
}

Bây giờ hãy phân tích transcript sau đây và trả về JSON:
"${transcriptText}"`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: systemPrompt
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Lỗi API: ${response.status} - ${errText}`);
      return;
    }

    const result = await response.json();
    const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log("Kết quả nhận được từ Gemini API:");
    console.log(textResponse);
  } catch (error) {
    console.error("Lỗi khi kết nối hoặc xử lý:", error);
  }
}

// Chạy thử với một vài test case thực tế
async function run() {
  await testParse("Ngày 5 tháng 7, chị Lan, 2 cân ba chỉ, 150 nghìn");
  console.log("\n--------------------\n");
  await testParse("Chị Hoa trả 100 nghìn");
  console.log("\n--------------------\n");
  await testParse("Hôm qua chị Lan mua 2 cân sườn nợ 300 nghìn");
  console.log("\n--------------------\n");
  await testParse("Mai anh Tuấn lấy 1.5 cân thịt nạc giá 12");
}

run();
