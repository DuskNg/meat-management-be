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

  const systemPrompt = `Bạn là hệ thống trích xuất dữ liệu cho ứng dụng quản lý sổ nợ bán thịt. Nhiệm vụ của bạn là phân tích câu nói (đã được chuyển từ giọng nói sang văn bản) và trả về dữ liệu có cấu trúc dưới dạng JSON.

## PHÂN LOẠI GIAO DỊCH
Có 3 loại giao dịch, xác định dựa trên các dấu hiệu sau:
1. ghi_no_nhanh (Ghi nợ nhanh): Câu nói có ngày + tên khách + số tiền, KHÔNG đề cập số kg thịt hoặc loại thịt.
   Ví dụ: "Ngày 5 tháng 7, chị Lan, nợ 200 nghìn"
2. ghi_no_thu_cong (Ghi nợ thủ công): Câu nói có đầy đủ ngày + tên khách + số kg thịt + số tiền.
   Ví dụ: "Ngày 5 tháng 7, chị Lan, 2 cân ba chỉ, 150 nghìn"
3. tra_tien (Trả tiền): Câu nói có ngày + tên khách + số tiền, và mang ý nghĩa thanh toán/trả nợ (không phải phát sinh nợ mới).
   - Nếu người nói dùng các từ "trả đủ", "đã trả đủ", "đã trả" (không kèm số tiền cụ thể, hoặc có ý nghĩa thanh toán toàn bộ) → đánh dấu paid_full = true, amount = null (hệ thống sẽ tự tính số dư nợ hiện tại).
   - Nếu có số tiền cụ thể đi kèm (ví dụ "trả 100 nghìn") → paid_full = false, amount = 100000.

## QUY TẮC NHẬN DIỆN
- Ngày (date): Nhận diện định dạng ngày tháng nói bằng lời (VD: "ngày 5 tháng 7", "hôm nay", "hôm qua", "mùng 5"). Nếu không đọc ngày, mặc định là ngày hiện tại (${formattedCurrentDate}) và ghi rõ trong trường "date_inferred": true.
- Tên khách (customer_name): Trích xuất chính xác tên/danh xưng được nói (VD: "chị Lan", "anh Tuấn", "cô Ba"). Giữ nguyên danh xưng nếu có.
- Số kg thịt (weight_kg): Chuyển đổi các cách nói như "2 cân", "2 ký", "2kg" thành số (2). Nếu không đọc → null.
- Loại thịt (meat_type): Trích xuất tên loại thịt nếu có (VD: "ba chỉ", "nạc vai", "sườn"). Nếu không đọc → null.
- Số tiền (amount): Chuyển đổi cách nói tiền tệ Việt Nam sang số nguyên (VNĐ):
  - "150 nghìn" / "150k" → 150000
  - "1 triệu 2" → 1200000
  - "hai trăm nghìn" → 200000
- Nếu câu nói không đủ thông tin bắt buộc (thiếu tên khách hoặc thiếu số tiền khi không phải trường hợp trả đủ), đặt "status": "incomplete" và liệt kê trường còn thiếu trong "missing_fields".

## ĐỊNH DẠNG OUTPUT
Chỉ trả về JSON, không thêm giải thích, không thêm markdown code fence. Cấu trúc:
{
  "transaction_type": "ghi_no_nhanh" | "ghi_no_thu_cong" | "tra_tien",
  "date": "YYYY-MM-DD",
  "date_inferred": boolean,
  "customer_name": string,
  "weight_kg": number | null,
  "meat_type": string | null,
  "amount": number | null,
  "paid_full": boolean,
  "status": "complete" | "incomplete",
  "missing_fields": string[],
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
}

run();
