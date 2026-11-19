// [Level 3] NAVER Maps Directions 5 — 자동차 경로
// 문서: https://api.ncloud-docs.com/docs/application-maps-directions5
//  - GET https://maps.apigw.ntruss.com/map-direction/v1/driving
//  - 헤더: x-ncp-apigw-api-key-id / x-ncp-apigw-api-key
//  - start, goal: "경도,위도" (lng,lat) 순서
//  - summary.distance: 미터(m), summary.duration: 밀리초(ms)
//  - 응답 code: 0 성공 / 1 출발지=도착지 / 2 도로 주변 아님 / 3 자동차 경로 없음
//               4 경유지 도로 주변 아님 / 5 직선거리 합 1500km 이상
// 이 API는 자동차 경로만 제공합니다. 도보·대중교통 경로는 만들지 않습니다.
import { config } from '../config.js';

export const DIRECTIONS_URL = 'https://maps.apigw.ntruss.com/map-direction/v1/driving';
const OPTIONS = ['traoptimal', 'trafast', 'tracomfort', 'traavoidtoll', 'traavoidcaronly'];

const ROUTE_CODE_REASON = {
  1: '출발지와 도착지가 같습니다.',
  2: '출발지 또는 도착지가 도로 주변이 아닙니다.',
  3: '자동차로 갈 수 있는 경로가 없습니다.',
  4: '경유지가 도로 주변이 아닙니다.',
  5: '요청한 경로가 너무 깁니다(직선거리 합 1500km 이상).',
};

const HTTP_REASON = {
  401: 'NAVER Maps 인증 실패 또는 권한 없음 (Client ID/Secret, Directions 5 사용 설정 확인)',
  429: 'NAVER Maps 호출 한도 초과 또는 콘솔에서 Directions 5 미선택',
};

function validPoint(p) {
  return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

const toParam = (p) => `${Number(p.lng)},${Number(p.lat)}`; // 경도,위도 순서

/**
 * 두 장소 사이 자동차 이동 거리·시간
 * @param {{name?: string, lat: number, lng: number}} origin
 * @param {{name?: string, lat: number, lng: number}} destination
 * @param {{option?: string}} [opts]
 * @returns {Promise<{
 *   status: 'ok'|'same_place'|'unavailable'|'error',
 *   mode: 'driving', from: string, to: string,
 *   distanceM: number|null, distanceKm: number|null, durationMin: number|null,
 *   tollFare: number|null, fuelPrice: number|null, reason: string|null
 * }>}
 */
export async function get_routes(origin, destination, { option = 'traoptimal' } = {}) {
  const base = {
    mode: 'driving',
    from: origin?.name || '출발지',
    to: destination?.name || '도착지',
    distanceM: null,
    distanceKm: null,
    durationMin: null,
    tollFare: null,
    fuelPrice: null,
  };
  const fail = (status, reason, extra = {}) => ({ status, ...base, reason, label: '확인 불가', ...extra });

  const { clientId, clientSecret } = config.naverMaps;
  if (!clientId || !clientSecret) return fail('error', 'NAVER Maps 인증 정보가 .env에 없습니다.');
  if (!validPoint(origin) || !validPoint(destination)) return fail('error', '출발지·도착지 좌표(lat, lng)가 올바르지 않습니다.');

  const opt = OPTIONS.includes(option) ? option : 'traoptimal';
  const params = new URLSearchParams({ start: toParam(origin), goal: toParam(destination), option: opt });

  let res;
  let data;
  try {
    res = await fetch(`${DIRECTIONS_URL}?${params}`, {
      headers: {
        'x-ncp-apigw-api-key-id': clientId,
        'x-ncp-apigw-api-key': clientSecret,
      },
      signal: AbortSignal.timeout(8000),
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    return fail('error', `NAVER Maps에 연결하지 못했습니다: ${err.message}`);
  }

  // 경로 관련 응답 코드
  // 실제 응답: 성공 시 최상위 code=0, 실패 시 HTTP 400 + { error: { errorCode: 400, code: 1~5, message } }
  const routeCode = typeof data.code === 'number' ? data.code : data.error?.code;
  if (typeof routeCode === 'number' && routeCode !== 0) {
    if (routeCode === 1) {
      return { status: 'same_place', ...base, distanceM: 0, distanceKm: 0, durationMin: 0, reason: ROUTE_CODE_REASON[1], label: '같은 장소' };
    }
    if (ROUTE_CODE_REASON[routeCode]) {
      return fail('unavailable', ROUTE_CODE_REASON[routeCode], { apiCode: routeCode });
    }
  }

  if (!res.ok) {
    const reason = HTTP_REASON[res.status] || data.error?.message || data.errorMessage || `요청 실패 (HTTP ${res.status})`;
    return fail('error', reason, { httpStatus: res.status });
  }

  const route = data.route?.[opt]?.[0];
  const summary = route?.summary;
  if (!summary) return fail('unavailable', '응답에 자동차 경로가 없습니다.');

  // 실제 경로 좌표 [lng, lat] — 지도 표시용으로 최대 300개로 줄임
  const rawPath = Array.isArray(route.path) ? route.path : [];
  const step = Math.max(1, Math.ceil(rawPath.length / 300));
  const path = rawPath.filter((_, i) => i % step === 0 || i === rawPath.length - 1);

  // 카페리 구간 감지 (guide type 48: 페리항로 진입, 49: 페리항로 출구)
  // 배편 요금·운항 시간은 API가 제공하지 않으므로 별도 확인 필요
  const includesFerry = (route.guide || []).some((g) => g.type === 48 || g.type === 49);

  return {
    status: 'ok',
    ...base,
    option: opt,
    distanceM: summary.distance,
    distanceKm: Math.round(summary.distance / 100) / 10,
    durationMin: Math.round(summary.duration / 60000),
    // 아래 두 값은 API 제공 추정치 (실시간 교통·평균 유가 기준)
    tollFare: summary.tollFare ?? null,
    fuelPrice: summary.fuelPrice ?? null,
    includesFerry,
    path, // [[lng, lat], ...] NAVER Directions 실제 경로
    reason: includesFerry ? '카페리 구간 포함 — 배편 요금·운항 시간은 API에서 제공하지 않아 별도 확인이 필요합니다.' : null,
    label: `${Math.round(summary.distance / 100) / 10}km · 약 ${Math.round(summary.duration / 60000)}분${includesFerry ? ' (페리 포함)' : ''}`,
  };
}
