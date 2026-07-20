const { logActivity } = require('./activityLogger');

// Đơn giá Standard hiện tại của Gemini, tính theo USD / 1 triệu token.
// Có thể ghi đè bằng biến môi trường khi Google thay đổi bảng giá.
const MODEL_PRICING = {
  'gemini-2.5-flash': {
    textInput: Number(process.env.GEMINI_25_FLASH_TEXT_INPUT_USD_PER_1M || 0.30),
    audioInput: Number(process.env.GEMINI_25_FLASH_AUDIO_INPUT_USD_PER_1M || 1.00),
    imageInput: Number(process.env.GEMINI_25_FLASH_IMAGE_INPUT_USD_PER_1M || 0.30),
    output: Number(process.env.GEMINI_25_FLASH_OUTPUT_USD_PER_1M || 2.50),
  },
  'gemini-2.5-pro': {
    textInput: Number(process.env.GEMINI_25_PRO_TEXT_INPUT_USD_PER_1M || 1.25),
    audioInput: Number(process.env.GEMINI_25_PRO_AUDIO_INPUT_USD_PER_1M || 1.25),
    imageInput: Number(process.env.GEMINI_25_PRO_IMAGE_INPUT_USD_PER_1M || 1.25),
    output: Number(process.env.GEMINI_25_PRO_OUTPUT_USD_PER_1M || 10.00),
  },
  'gemini-3.1-pro-preview': {
    textInput: Number(process.env.GEMINI_31_PRO_TEXT_INPUT_USD_PER_1M || 2.00),
    audioInput: Number(process.env.GEMINI_31_PRO_AUDIO_INPUT_USD_PER_1M || 2.00),
    imageInput: Number(process.env.GEMINI_31_PRO_IMAGE_INPUT_USD_PER_1M || 2.00),
    output: Number(process.env.GEMINI_31_PRO_OUTPUT_USD_PER_1M || 12.00),
  },
};

const getTokenCount = (usageMetadata, key) => Number(usageMetadata?.[key]) || 0;

const calculateAiCost = ({ model, inputType = 'text', usageMetadata }) => {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['gemini-2.5-flash'];
  const inputTokens = getTokenCount(usageMetadata, 'promptTokenCount');
  const outputTokens = getTokenCount(usageMetadata, 'candidatesTokenCount');
  const totalTokens = getTokenCount(usageMetadata, 'totalTokenCount') || inputTokens + outputTokens;
  const inputRate = pricing[`${inputType}Input`] ?? pricing.textInput;
  const costUsd = (inputTokens / 1_000_000) * inputRate
    + (outputTokens / 1_000_000) * pricing.output;

  return {
    model,
    inputType,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: Number(costUsd.toFixed(8)),
    currency: 'USD',
  };
};

const recordAiUsage = async ({ userId, feature, model, inputType, usageMetadata }) => {
  const usageCost = calculateAiCost({ model, inputType, usageMetadata });

  await logActivity(userId, 'AI_USAGE', JSON.stringify({ feature, ...usageCost }));

  return usageCost;
};

module.exports = {
  calculateAiCost,
  recordAiUsage,
};
