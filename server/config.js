// 모든 인증 정보는 .env에서만 읽습니다. 코드에 키를 직접 쓰지 마세요.
import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 3000,
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || '', // gpt-5 계열: minimal|low|medium|high
  },
  agent: {
    maxIterations: Number(process.env.AGENT_MAX_ITERATIONS) || 10,  // LLM ↔ Tool 왕복 최대 횟수
    maxToolCalls: Number(process.env.AGENT_MAX_TOOL_CALLS) || 30,  // 한 번 실행에서 Tool 호출 최대 개수
  },
  naverSearch: {
    clientId: process.env.NAVER_API_HUB_CLIENT_ID,
    clientSecret: process.env.NAVER_API_HUB_CLIENT_SECRET,
  },
  naverMaps: {
    clientId: process.env.NAVER_MAPS_CLIENT_ID,
    clientSecret: process.env.NAVER_MAPS_CLIENT_SECRET,
  },
};

// 설정 여부만 반환 (값 자체는 절대 노출하지 않음)
export function configStatus() {
  return {
    openai: Boolean(config.openai.apiKey),
    naverSearch: Boolean(config.naverSearch.clientId && config.naverSearch.clientSecret),
    naverMaps: Boolean(config.naverMaps.clientId && config.naverMaps.clientSecret),
  };
}
