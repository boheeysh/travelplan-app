import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configStatus } from './config.js';
import planRouter from './routes/plan.js';
import placesRouter from './routes/places.js';
import mapsRouter from './routes/maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 개발 환경 확인용
app.get('/api/health', (req, res) => {
  res.json({ ok: true, keys: configStatus() });
});

app.use('/api/plan', planRouter);     // Level 1
app.use('/api/places', placesRouter); // Level 2
app.use('/api/maps', mapsRouter);     // Level 3

app.listen(config.port, () => {
  // NAVER 지도 인증은 127.0.0.1 주소에서 통과됨 (localhost는 인증 실패)
  console.log(`서버 실행: http://127.0.0.1:${config.port}`);
  console.log('인증 정보 설정 상태:', configStatus());
});
