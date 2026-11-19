// 접속 비밀번호 — 배포 주소를 아는 누구나 OpenAI 비용을 쓰지 못하게 막음
//  - APP_PASSWORD가 있으면: 요청 헤더 x-app-password가 같아야 통과
//  - APP_PASSWORD가 없으면: 로컬은 통과, Vercel은 거부 (설정을 깜빡해도 비용이 새지 않게)
import crypto from 'node:crypto';
import { config } from './config.js';

export const passwordRequired = () => Boolean(config.appPassword) || config.isVercel;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function requirePassword(req, res, next) {
  if (!config.appPassword) {
    if (!config.isVercel) return next();
    return res.status(503).json({
      error: '서버에 접속 비밀번호(APP_PASSWORD)가 설정되지 않아 이 기능을 막아 두었어요. Vercel 환경 변수에 APP_PASSWORD를 추가해 주세요.',
    });
  }
  // 한글 비밀번호도 쓸 수 있게 브라우저가 encodeURIComponent로 보냄
  let given = '';
  try {
    given = decodeURIComponent(req.get('x-app-password') || '');
  } catch {
    given = '';
  }
  // 길이와 상관없이 같은 시간에 비교 (해시 후 timingSafeEqual)
  if (crypto.timingSafeEqual(digest(given), digest(config.appPassword))) return next();
  // 무차별 대입을 늦추기 위해 실패 응답을 잠깐 지연
  setTimeout(() => {
    res.status(401).json({ error: given ? '접속 비밀번호가 맞지 않아요.' : '접속 비밀번호를 입력해 주세요.', needPassword: true });
  }, 600);
}
