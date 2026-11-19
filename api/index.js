// Vercel 서버 함수 — /api/* 요청을 Express 앱으로 처리
// (vercel.json의 rewrites가 /api/(.*) → /api 로 보냄. 화면 파일은 public/을 Vercel CDN이 제공)
import app from '../server.js';

export default app;
