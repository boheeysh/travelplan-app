// [Level 2] NAVER API HUB 지역 검색
// 문서: https://api.ncloud-docs.com/docs/naver-api-hub-search-local
//  - GET https://naverapihub.apigw.ntruss.com/search/v1/local
//  - query(필수), display 1~5(기본 1), start, sort=random|comment
//  - mapx/mapy: WGS84 기준 x(경도)/y(위도), String 타입
//    문서에 표기 단위가 명시되어 있지 않고, 실제 응답은 "1291627052"처럼 10^7배 정수라
//    두 형식(정수 ×10^7, 소수 도 단위)을 모두 처리합니다.
//  - telephone은 항상 빈 값(하위 호환용)이라 사용하지 않습니다.
//  - 영업시간·평점·가격은 API가 제공하지 않으므로 만들지 않습니다.
import { config } from '../config.js';

export const SEARCH_URL = 'https://naverapihub.apigw.ntruss.com/search/v1/local';
const MAX_DISPLAY = 5;

// 대한민국 대략 범위 (좌표 검증용)
const KOREA = { minLat: 32.5, maxLat: 39.5, minLng: 123.5, maxLng: 132.5 };

const ERROR_MESSAGES = {
  SE01: '잘못된 검색 요청입니다.',
  SE02: 'display 값이 허용 범위(1~5)를 벗어났습니다.',
  SE03: 'start 값이 허용 범위를 벗어났습니다.',
  SE04: 'sort 값이 올바르지 않습니다.',
  SE05: '존재하지 않는 검색 API입니다.',
  SE06: '검색어 인코딩이 올바르지 않습니다.',
  SE99: 'NAVER 검색 서버 오류입니다.',
};

export class SearchError extends Error {
  constructor(message, status = 500, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** HTML 태그(<b>)와 엔티티 제거 */
export function cleanText(str = '') {
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

/**
 * mapx/mapy 문자열 → 도(degree) 단위 숫자
 * "1291627052" → 129.1627052 / "129.1627052" → 129.1627052 / 비정상 → null
 */
export function parseCoord(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  const deg = String(value).includes('.') || Math.abs(n) <= 180 ? n : n / 1e7;
  return Math.abs(deg) <= 180 ? deg : null;
}

export function toLatLng(mapx, mapy) {
  const lng = parseCoord(mapx);
  const lat = parseCoord(mapy);
  const valid =
    lat !== null && lng !== null &&
    lat >= KOREA.minLat && lat <= KOREA.maxLat &&
    lng >= KOREA.minLng && lng <= KOREA.maxLng;
  return valid ? { lat, lng } : { lat: null, lng: null };
}

/** API item → 앱에서 쓰는 장소 객체 (API가 준 값만 사용) */
export function normalizePlace(item) {
  const { lat, lng } = toLatLng(item.mapx, item.mapy);
  return {
    name: cleanText(item.title),
    category: item.category || '',
    address: item.address || '',
    roadAddress: item.roadAddress || '',
    lat,
    lng,
    link: item.link || '',
    description: cleanText(item.description),
  };
}

/**
 * 여행 지역 + 키워드로 장소 검색
 * @param {{region: string, keyword: string, display?: number, sort?: 'random'|'comment'}} params
 * @returns {Promise<{query: string, total: number, places: object[]}>}
 */
export async function search_places({ region = '', keyword = '', display = MAX_DISPLAY, sort = 'random' } = {}) {
  const { clientId, clientSecret } = config.naverSearch;
  if (!clientId || !clientSecret) {
    throw new SearchError('NAVER API HUB 인증 정보가 .env에 없습니다.', 500, 'NO_KEY');
  }

  const query = [region, keyword].map((s) => String(s).trim()).filter(Boolean).join(' ');
  if (!query) throw new SearchError('검색할 지역 또는 키워드를 입력해 주세요.', 400, 'EMPTY_QUERY');

  const params = new URLSearchParams({
    query,
    display: String(Math.min(MAX_DISPLAY, Math.max(1, Number(display) || MAX_DISPLAY))),
    start: '1',
    sort: sort === 'comment' ? 'comment' : 'random',
    format: 'json',
  });

  let res;
  try {
    res = await fetch(`${SEARCH_URL}?${params}`, {
      headers: {
        'X-NCP-APIGW-API-KEY-ID': clientId,
        'X-NCP-APIGW-API-KEY': clientSecret,
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new SearchError(`NAVER 검색 API에 연결하지 못했습니다: ${err.message}`, 502, 'NETWORK');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const code = data.errorCode || data.error?.errorCode;
    const msg =
      ERROR_MESSAGES[code] ||
      (res.status === 401 ? 'NAVER API HUB 인증에 실패했습니다. Client ID/Secret을 확인해 주세요.' : null) ||
      data.errorMessage || data.error?.message || `검색 요청 실패 (HTTP ${res.status})`;
    throw new SearchError(msg, res.status, code);
  }

  return {
    query,
    total: data.total ?? 0,
    places: (data.items || []).map(normalizePlace),
  };
}
