// OpenAI 클라이언트 (Responses API)
// 429/5xx/네트워크 오류는 SDK가 자동 재시도(maxRetries)합니다.
import OpenAI from 'openai';
import { config } from '../config.js';

export const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  maxRetries: 2,
  timeout: 120_000,
});
