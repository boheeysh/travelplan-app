// Agent가 쓸 수 있는 Tool: 스키마(LLM에 등록) + 실행기(Node.js에서 실제 실행)
import { search_places } from '../services/naverSearch.js';
import { get_routes } from '../services/naverMaps.js';
import { calculate_budget, CATEGORIES } from '../services/budget.js';

const won = (n) => `${Math.round(n).toLocaleString()}원`;

const point = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'lat', 'lng'],
  properties: {
    name: { type: 'string', description: '장소명' },
    lat: { type: 'number', description: '위도 (search_places 결과의 lat 그대로)' },
    lng: { type: 'number', description: '경도 (search_places 결과의 lng 그대로)' },
  },
};

/* ───────── 1. LLM에 등록할 함수 스키마 (Responses API 형식) ───────── */
export const functionTools = [
  {
    type: 'function',
    name: 'search_places',
    description:
      'NAVER 지역 검색으로 실제 장소(관광지, 음식점, 카페, 숙소 등)를 찾는다. 한 번에 최대 5곳. ' +
      '장소명·주소·카테고리·좌표만 제공하며 영업시간·평점·가격은 제공하지 않는다.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['region', 'keyword', 'sort'],
      properties: {
        region: { type: 'string', description: '검색 지역. 예: "부산 해운대", "강릉"' },
        keyword: { type: 'string', description: '검색 키워드 (region과 중복하지 말 것). 예: "맛집", "카페", "관광지", "돼지국밥"' },
        sort: { type: 'string', enum: ['random', 'comment'], description: 'random=정확도순, comment=리뷰 많은 순' },
      },
    },
  },
  {
    type: 'function',
    name: 'get_routes',
    description:
      'NAVER Directions 5로 두 장소 사이의 자동차 이동 거리(km)와 예상 시간(분), 통행료·유류비 추정치를 구한다. ' +
      '자동차 경로만 제공한다(도보·대중교통 없음). 좌표는 반드시 search_places 결과의 값을 사용한다.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['origin', 'destination', 'option'],
      properties: {
        origin: point,
        destination: point,
        option: {
          type: 'string',
          enum: ['traoptimal', 'trafast', 'tracomfort', 'traavoidtoll'],
          description: 'traoptimal=실시간 최적(기본), trafast=빠른 길, tracomfort=편한 길, traavoidtoll=무료 우선',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'calculate_budget',
    description:
      '항목별 비용을 합산하고 총예산과 비교해 잔여 예산을 계산한다. ' +
      '출처가 있는 가격만 confirmed/estimated로 넣고, 가격을 모르면 amount=null, status="unknown"으로 넣는다.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['totalBudget', 'people', 'items'],
      properties: {
        totalBudget: { type: 'number', description: '사용자 총예산(원)' },
        people: { type: 'integer', description: '여행 인원' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'category', 'amount', 'perPerson', 'quantity', 'status', 'source'],
            properties: {
              name: { type: 'string' },
              category: { type: 'string', enum: CATEGORIES },
              amount: { type: ['number', 'null'], description: '1회(또는 1인) 금액. 모르면 null' },
              perPerson: { type: 'boolean', description: 'true면 amount × 인원' },
              quantity: { type: 'integer', description: '횟수·박수 (기본 1)' },
              status: { type: 'string', enum: ['confirmed', 'estimated', 'unknown'] },
              source: { type: ['string', 'null'], description: '가격 근거. 예: "사용자 입력", "NAVER Directions fuelPrice", 웹 검색 출처' },
            },
          },
        },
      },
    },
  },
];

// OpenAI 내장 웹 검색 (최신 관광 정보·행사·입장료 확인용)
export const builtInTools = [{ type: 'web_search', search_context_size: 'low', user_location: { type: 'approximate', country: 'KR' } }];

/* ───────── 2. 실행 컨텍스트 (한 번의 Agent 실행 동안 공유) ───────── */
// 사용자 요청 문장에 들어 있는 금액 (예: "숙소 15만원" → 150000)
// 지원: "15만원", "15만", "1만5천원", "1만 5천 원", "1.5만원", "5천원", "15,000원"
export function extractAmounts(text = '') {
  const out = new Set();
  const s = String(text);
  const num = (v) => Number(String(v).replace(/,/g, ''));
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*만\s*(?:(\d+)\s*천)?/g)) {
    out.add(Math.round(num(m[1]) * 10000 + (m[2] ? num(m[2]) * 1000 : 0)));
  }
  for (const m of s.matchAll(/(?<![\d만]\s*)(\d[\d,]*)\s*천\s*원?/g)) out.add(num(m[1]) * 1000);
  for (const m of s.matchAll(/(\d[\d,]*)\s*원/g)) out.add(num(m[1]));
  out.delete(0);
  return out;
}

export function createToolContext(input = {}) {
  return {
    people: Math.max(1, Number(input.people) || 1),
    places: [],             // search_places로 확인한 장소 (좌표 검증용)
    searches: [],           // 실행한 검색어 기록 (출처 표시용)
    routes: new Map(),      // get_routes 결과 캐시 (좌표쌍 → 결과)
    routeAmounts: new Set(), // Directions가 준 유류비·통행료 (가격 근거 검증용)
    userAmounts: extractAmounts(input.request), // 사용자가 직접 말한 금액
    webSearchCount: 0,      // 내장 web_search 실행 횟수
    budget: null,           // 마지막 calculate_budget 결과
  };
}

export const routeKey = (a, b) => `${a.lng.toFixed(5)},${a.lat.toFixed(5)}>${b.lng.toFixed(5)},${b.lat.toFixed(5)}`;

// 장소명 비교용 정규화: 괄호 내용·공백·기호 제거, 소문자
const normName = (s) => String(s ?? '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[\s·・,.\-_/&'"!~]/g, '').toLowerCase();

// 두 글자 묶음(bigram) Dice 유사도 0~1
function bigramDice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2));
  const bs = grams(b);
  let common = 0;
  for (const g of grams(a)) {
    const i = bs.indexOf(g);
    if (i >= 0) { common++; bs.splice(i, 1); }
  }
  return (2 * common) / (a.length + b.length - 2);
}

/**
 * 일정 장소명(stopName)이 검색 결과 장소명(placeName)과 같은 장소를 가리키는지
 *  - 일정명이 검색 결과명을 통째로 포함 (예: "광안리해수욕장 산책" ⊃ "광안리해수욕장")
 *  - 검색 결과명이 일정명을 포함하되 절반 이상을 차지 (예: "블루라인파크" ⊂ "해운대블루라인파크")
 *    → "해운대" ⊂ "해운대암소갈비집" 같은 지역명 오매칭은 제외
 *  - 표기 차이: bigram 유사도 0.5 이상
 */
export function namesMatch(stopName, placeName) {
  const a = normName(stopName);
  const b = normName(placeName);
  if (a.length < 2 || b.length < 2) return false;
  if (a === b || a.includes(b)) return true;
  if (b.includes(a) && a.length / b.length >= 0.5) return true;
  return bigramDice(a, b) >= 0.5;
}

// 좌표가 search_places 결과에 있는 장소인지 — 약 200m 이내 + 이름 일치 둘 다 필요
// (거리만 가까운 다른 장소를 출처로 붙이지 않음)
export function findKnownPlace(ctx, lat, lng, name = '') {
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const near = nearbyPlaces(ctx, lat, lng)
      .filter((p) => namesMatch(name, p.name))
      .map((p) => ({ p, dist: Math.hypot(p.lat - lat, p.lng - lng) }))
      .sort((a, b) => a.dist - b.dist);
    if (near.length) return near[0].p;
  }
  // 복구: 이름이 검색 결과명과 정확히 같고 그런 장소가 하나뿐이면, 좌표가 어긋나거나 비어 있어도 인정
  const n = normName(name);
  if (n.length < 2) return null;
  const exact = uniqueBy(ctx.places.filter((p) => p.lat !== null && normName(p.name) === n));
  return exact.length === 1 ? exact[0] : null;
}

// 같은 장소가 여러 검색어로 중복 수집된 경우 하나로
function uniqueBy(list) {
  const seen = new Map();
  for (const p of list) seen.set(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`, p);
  return [...seen.values()];
}

// 좌표 주변(약 200m)의 검색 결과
export function nearbyPlaces(ctx, lat, lng) {
  return uniqueBy(ctx.places.filter((p) => p.lat !== null && Math.abs(p.lat - lat) < 0.002 && Math.abs(p.lng - lng) < 0.002));
}

// LLM이 준 좌표를 검색 결과의 정확한 좌표로 맞춤
function snapPoint(ctx, p) {
  const known = findKnownPlace(ctx, p.lat, p.lng, p.name);
  return { point: known ? { name: p.name, lat: known.lat, lng: known.lng } : p, known };
}

/**
 * 가격 근거 검증 — 근거를 확인할 수 없는 금액은 미확인으로 바꿈
 *  - 0원(무료)은 허용
 *  - Directions 유류비·통행료와 같은 금액 → 추정치로 허용
 *  - 사용자 요청에 적힌 금액 → 허용
 *  - web_search를 실제로 실행했고 근거(source)를 적은 경우 → 허용
 */
export function verifyPrice(ctx, { amount, status, source }) {
  if (status === 'unknown' || amount === null || amount === undefined) return { amount: null, status: 'unknown', changed: false };
  const n = Number(amount);
  if (n === 0) return { amount: 0, status, changed: false };
  const src = String(source || '');
  if (ctx.routeAmounts.has(n)) {
    return { amount: n, status: 'estimated', changed: status !== 'estimated' };
  }
  // 사용자 금액 그대로, 또는 1인 금액 × 인원
  if (ctx.userAmounts.has(n) || ctx.userAmounts.has(n / ctx.people)) return { amount: n, status, changed: false };
  if (ctx.webSearchCount > 0 && /웹|web|http|검색|공식|홈페이지/i.test(src)) return { amount: n, status, changed: false };
  return { amount: null, status: 'unknown', changed: true, dropped: true };
}

/* ───────── 3. 실행기: 실제 함수 실행 + Trace용 요약 ───────── */
const executors = {
  async search_places(args, ctx) {
    // keyword에 region 단어가 반복되면 제거 ("경주" + "경주 맛집" → "경주 맛집")
    const regionWords = new Set(String(args.region).split(/\s+/));
    const keyword = String(args.keyword).split(/\s+/).filter((w) => !regionWords.has(w)).join(' ') || args.keyword;
    const result = await search_places({ region: args.region, keyword, sort: args.sort, display: 5 });
    for (const p of result.places) {
      if (!ctx.places.some((q) => q.name === p.name && q.roadAddress === p.roadAddress)) ctx.places.push({ ...p, query: result.query });
    }
    ctx.searches.push({ query: result.query, count: result.places.length });
    const names = result.places.map((p) => p.name);
    return {
      output: {
        query: result.query,
        places: result.places.map(({ name, category, roadAddress, address, lat, lng }) => ({
          name, category, address: roadAddress || address, lat, lng,
        })),
        note: '영업시간·평점·가격 정보는 제공되지 않음',
      },
      summary: names.length ? `"${result.query}" → ${names.length}곳: ${names.join(', ')}` : `"${result.query}" → 결과 없음`,
    };
  },

  async get_routes(args, ctx) {
    const o = snapPoint(ctx, args.origin);
    const d = snapPoint(ctx, args.destination);
    // 검색으로 확인하지 않은 좌표(LLM이 지어낸 좌표)로는 경로를 조회하지 않음
    const unknownNames = [!o.known && args.origin.name, !d.known && args.destination.name].filter(Boolean);
    if (unknownNames.length) {
      return {
        output: { status: 'error', error: `${unknownNames.join(', ')}의 좌표가 search_places 결과에 없습니다. 먼저 search_places로 장소를 확인하거나, 이 구간은 이동시간 미확인으로 두세요.` },
        summary: `${args.origin.name} → ${args.destination.name}: 실행 거부 (검색으로 확인되지 않은 좌표: ${unknownNames.join(', ')})`,
        isError: true,
      };
    }
    const r = await get_routes(o.point, d.point, { option: args.option });
    if (r.status === 'ok' || r.status === 'same_place' || r.status === 'unavailable') {
      ctx.routes.set(routeKey(o.point, d.point), r);
    }
    if (r.fuelPrice) ctx.routeAmounts.add(r.fuelPrice);
    if (r.tollFare) ctx.routeAmounts.add(r.tollFare);
    const unverified = !o.known || !d.known;
    const output = {
      status: r.status,
      from: r.from,
      to: r.to,
      distanceKm: r.distanceKm,
      durationMin: r.durationMin,
      tollFare: r.tollFare,
      fuelPrice: r.fuelPrice,
      includesFerry: r.includesFerry ?? false,
      reason: r.reason,
      ...(unverified && { warning: '좌표가 search_places 결과와 일치하지 않습니다. 검색으로 확인한 좌표를 사용하세요.' }),
    };
    const body = r.status === 'ok' ? r.label : r.status === 'same_place' ? '같은 장소' : `확인 불가 (${r.reason})`;
    return { output, summary: `${r.from} → ${r.to}: ${body}`, isError: r.status === 'error' };
  },

  async calculate_budget(args, ctx) {
    // Directions 유류비 합계(여러 구간 합)도 근거로 인정
    const fuelSum = [...ctx.routes.values()].reduce((s, r) => s + (r.fuelPrice || 0), 0);
    const tollSum = [...ctx.routes.values()].reduce((s, r) => s + (r.tollFare || 0), 0);
    if (fuelSum) ctx.routeAmounts.add(fuelSum);
    if (tollSum) ctx.routeAmounts.add(tollSum);

    const dropped = [];
    const items = (args.items || []).map((it) => {
      const v = verifyPrice(ctx, it);
      if (v.dropped) dropped.push(it.name);
      return { ...it, amount: v.amount, status: v.status };
    });
    const r = calculate_budget({ ...args, items });
    if (dropped.length) {
      r.warnings.unshift(`근거를 확인할 수 없는 가격 ${dropped.length}개(${dropped.join(', ')})는 미확인으로 처리했습니다. 가격이 필요하면 web_search로 확인하세요.`);
    }
    ctx.budget = r;
    ctx.budgetArgs = args; // 서버가 경로를 보완한 뒤 유류비를 다시 계산할 때 사용
    return {
      output: r,
      summary: `계획 ${won(r.plannedTotal)} (확인 ${won(r.confirmedTotal)} + 추정 ${won(r.estimatedTotal)}) · 잔여 ${won(r.remaining)}` +
        (r.unknownItems.length ? ` · 미확인 ${r.unknownItems.length}개` : '') +
        (dropped.length ? ` · 근거 없는 가격 ${dropped.length}개 미확인 처리` : ''),
    };
  },
};

/** LLM의 function_call 하나를 실행. 오류도 결과로 돌려줘 LLM이 대응할 수 있게 함 */
export async function executeTool(name, rawArgs, ctx) {
  const fn = executors[name];
  if (!fn) return { output: { error: `알 수 없는 Tool: ${name}` }, summary: `알 수 없는 Tool: ${name}`, isError: true, args: null };

  let args;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return { output: { error: 'arguments가 올바른 JSON이 아닙니다.' }, summary: '인자 JSON 파싱 실패', isError: true, args: null };
  }

  try {
    const res = await fn(args, ctx);
    return { ...res, args };
  } catch (err) {
    return { output: { error: err.message }, summary: `오류: ${err.message}`, isError: true, args };
  }
}
