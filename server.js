// 앱 진입점 — Vercel은 루트의 server.js(express를 import하는 파일)를 Express 앱으로 인식
//   로컬: npm run dev → app.listen
//   Vercel: export default app (화면 파일은 public/ 폴더를 Vercel CDN이 제공)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configStatus } from './server/config.js';
import { requirePassword, passwordRequired } from './server/auth.js';
import planRouter from './server/routes/plan.js';
import placesRouter from './server/routes/places.js';
import mapsRouter from './server/routes/maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // 로컬용 (Vercel에서는 무시되고 CDN이 제공)

// 상태 확인 + 화면이 비밀번호 입력칸을 보여 줄지 판단
app.get('/api/health', (req, res) => {
  res.json({ ok: true, keys: configStatus(), passwordRequired: passwordRequired() });
});

// 비용이 드는 API(OpenAI·NAVER 검색)는 접속 비밀번호 필요
app.use('/api/plan', requirePassword, planRouter);     // Level 1
app.use('/api/places', requirePassword, placesRouter); // Level 2
app.use('/api/maps', mapsRouter);                       // Level 3 (지도 Client ID는 공개용)

// 처리 안 된 오류 → JSON 응답 (Vercel 함수가 꼬인 상태로 남지 않게)
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '서버 오류가 발생했어요.' });
});

export default app;

if (!config.isVercel) {
  app.listen(config.port, () => {
    // NAVER 지도 인증은 127.0.0.1 주소에서 통과됨 (localhost는 인증 실패)
    console.log(`서버 실행: http://127.0.0.1:${config.port}`);
    console.log('인증 정보 설정 상태:', configStatus(), '| 접속 비밀번호:', passwordRequired() ? '사용' : '사용 안 함');
  });
}
