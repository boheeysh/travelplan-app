// 백엔드 API 호출 보조 (브라우저에서는 API 키를 다루지 않음)
// 접속 비밀번호: 서버가 요구할 때만 사용, 이 탭에서만 기억(sessionStorage)

const PW_KEY = 'travelplan.appPassword';

export function getPassword() {
  try {
    return sessionStorage.getItem(PW_KEY) || '';
  } catch {
    return '';
  }
}

export function setPassword(pw) {
  try {
    if (pw) sessionStorage.setItem(PW_KEY, pw);
    else sessionStorage.removeItem(PW_KEY);
  } catch {
    /* 저장이 막힌 환경 — 입력칸 값만 사용 */
  }
}

// 비용이 드는 API 요청에 붙일 헤더 (한글 비밀번호도 되도록 인코딩)
export function authHeaders(pw = getPassword()) {
  return pw ? { 'x-app-password': encodeURIComponent(pw) } : {};
}

// 서버가 비밀번호를 요구하는지
export async function fetchPasswordRequired() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    return Boolean(data.passwordRequired);
  } catch {
    return false;
  }
}
