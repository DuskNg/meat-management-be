// meat-management-be/src/utils/geminiHelper.js
/**
 * Hàm gọi Google Gemini API với cơ chế tự động thử lại (Retry with exponential backoff)
 * và chuyển đổi model dự phòng khi gặp lỗi 503 (Overloaded) hoặc 429 (Rate Limit).
 */
const callGeminiWithRetry = async ({
  contents,
  systemInstruction = null,
  generationConfig = {},
  models = ['gemini-2.5-flash', 'gemini-3.1-pro-preview'],
  apiKey,
  maxRetries = 2,
}) => {
  if (!apiKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY.');
  }

  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const payload = {
          contents,
          generationConfig: {
            responseMimeType: 'application/json',
            ...generationConfig,
          },
        };

        if (systemInstruction) {
          payload.systemInstruction = systemInstruction;
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          const result = await response.json();
          const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            throw new Error('Gemini không phản hồi nội dung.');
          }
          return {
            text,
            usageMetadata: result.usageMetadata || {},
            model,
          };
        }

        const errText = await response.text();
        const statusCode = response.status;
        lastError = new Error(`Lỗi Gemini API: ${statusCode} - ${errText}`);

        // Nếu lỗi 503 (Quá tải) hoặc 429 (Giới hạn tốc độ) và còn lượt retry
        if ((statusCode === 503 || statusCode === 429) && attempt < maxRetries) {
          const delayMs = (attempt + 1) * 1000;
          console.warn(`[GEMINI ${model}] Gặp lỗi ${statusCode}, đang thử lại sau ${delayMs}ms (Lần ${attempt + 1}/${maxRetries})...`);
          await new Promise((res) => setTimeout(res, delayMs));
          continue;
        }

        // Nếu là lỗi 404 (Model không tồn tại) hoặc hết lượt retry cho model này, chuyển sang model tiếp theo
        break;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await new Promise((res) => setTimeout(res, 1000));
        }
      }
    }
  }

  throw lastError || new Error('Không thể kết nối đến hệ thống Google Gemini.');
};

module.exports = {
  callGeminiWithRetry,
};
