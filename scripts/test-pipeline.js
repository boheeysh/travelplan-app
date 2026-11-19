// 일정 후처리 파이프라인 단독 테스트 — OpenAI·NAVER API를 호출하지 않음 (비용 없음)
//   npm run test:pipeline
// 확인 항목: 일정 정리(카페·숙소 식사 표시, 이동 항목, 중복), 식사 판정, 서버 식사 보완,
//           메뉴 정리, 출처 URL 비교, 숙소 박 수, 예산 재계산(Agent 예산 / 서버 계산), 제목 정리

import {
  cleanPlan, findMealGaps, fillMealGaps, rebuildBudgetWithPrices, postProcess, cleanTitle,
} from '../server/agent/runAgent.js';
import { createToolContext } from '../server/agent/tools.js';
import { cleanMenus, matchSource } from '../server/agent/mealPrices.js';
import { lodgingNights } from '../server/agent/lodgingPrices.js';
import { calculate_budget } from '../server/services/budget.js';

let fail = 0;
const check = (label, ok, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const noop = () => {};

// 검색 결과(가짜) — 무주 일대 실제 좌표
const P = {
  resort: { name: '무주 덕유산 리조트', category: '숙박>콘도,리조트', roadAddress: '전북특별자치도 무주군 설천면 만선로 185', lat: 35.8908, lng: 127.7372 },
  duck: { name: '무주오리', category: '한식>오리요리', roadAddress: '전북특별자치도 무주군 설천면 구천동로 1051', lat: 35.8936, lng: 127.7452 },
  tofu: { name: '생두부촌 본점', category: '한식>두부요리', roadAddress: '전북특별자치도 무주군 설천면', lat: 35.9021, lng: 127.7469 },
  ttuk: { name: '무주뚝배기', category: '한식>한정식', roadAddress: '전북특별자치도 무주군 설천면 구천동로 1006', lat: 35.8960, lng: 127.7431 },
  cafe: { name: '무주카페 날망', category: '카페,디저트', roadAddress: '전북특별자치도 무주군 안성면', lat: 35.8452, lng: 127.6631 },
  valley: { name: '구천동 계곡', category: '여행,명소>계곡', roadAddress: '전북특별자치도 무주군 설천면', lat: 35.8790, lng: 127.7620 },
  bandi: { name: '무주반디랜드', category: '여행,명소>테마공원', roadAddress: '전북특별자치도 무주군 설천면 무설로 1324', lat: 35.9407, lng: 127.7520 },
};
const input = { region: '무주', startDate: '2026-12-03', nights: 1, people: 2, budget: 400000, prefs: [], transport: '자동차', request: '' };
const newCtx = () => {
  const ctx = createToolContext(input);
  ctx.places.push(...Object.values(P).map((p) => ({ ...p, query: '테스트', link: null })));
  return ctx;
};
const S = (time, p, extra = {}) => ({
  time, name: p.name, meal: null, category: p.category, address: p.roadAddress, lat: p.lat, lng: p.lng,
  description: '', placeSource: 'search_places', cost: { amount: null, status: 'unknown', basis: null }, ...extra,
});

/* ── 1. 일정 정리 ── */
console.log('── 1. 일정 정리 (cleanPlan) ──');
{
  const ctx = newCtx();
  const plan = { days: [{ stops: [
    S('09:00', P.valley),
    { time: '10:00', name: '구천동 계곡 → 무주오리 (이동 정보)', meal: null, category: '이동', lat: null, lng: null, cost: { amount: null, status: 'unknown' } },
    S('12:00', P.cafe, { meal: '점심' }),            // 카페에 점심 표시
    S('12:30', P.duck), S('12:40', P.duck, { meal: '점심' }), // 같은 식당 연속
    S('19:00', P.resort, { meal: '저녁' }),          // 숙소에 저녁 표시
  ] }] };
  cleanPlan(plan, ctx);
  const st = plan.days[0].stops;
  check('이동 전용 항목 제거', !st.some((s) => s.name.includes('→')));
  check('카페의 점심 표시 제거', st.find((s) => s.name === P.cafe.name)?.meal === null);
  check('숙소의 저녁 표시 제거', st.find((s) => s.name === P.resort.name)?.meal === null);
  check('연속 중복 식당은 하나로 (식사 표시 유지)', st.filter((s) => s.name === P.duck.name).length === 1 && st.find((s) => s.name === P.duck.name).meal === '점심');
}

/* ── 2. 식사 판정 ── */
console.log('── 2. 식사 판정 (findMealGaps) ──');
{
  const ctx = newCtx();
  const gaps = (days) => findMealGaps({ days }, ctx).map((g) => `D${g.day}${g.meal}`).join(',') || '없음';
  // 무주 사례: 마지막 날 08:30~13:00, 점심 없음 → 점심 필요
  check('마지막 날 13:00까지 → 점심 필요', gaps([
    { stops: [S('12:00', P.duck, { meal: '점심' }), S('18:00', P.tofu, { meal: '저녁' }), S('21:00', P.resort)] },
    { stops: [S('08:30', P.resort), S('11:30', P.bandi), S('13:00', P.cafe)] },
  ]) === 'D2점심');
  check('마지막 날 12:00 출발 → 점심 불필요', gaps([
    { stops: [S('12:00', P.duck, { meal: '점심' }), S('18:00', P.tofu, { meal: '저녁' })] },
    { stops: [S('09:00', P.resort), S('12:00', P.bandi)] },
  ]) === '없음');
  check('첫날 14:00 도착 → 점심 불필요, 저녁 필요', gaps([
    { stops: [S('14:00', P.valley), S('16:00', P.resort)] },
    { stops: [S('09:00', P.bandi), S('12:30', P.duck, { meal: '점심' })] },
  ]) === 'D1저녁');
  check('검색 안 된 식사("저녁(자유식)")는 빠진 것으로', gaps([
    { stops: [S('12:00', P.duck, { meal: '점심' }), { time: '19:00', name: '저녁(자유식)', meal: '저녁', lat: null, lng: null }] },
    { stops: [S('09:00', P.bandi)] },
  ]) === 'D1저녁');
}

/* ── 3. 서버 식사 보완 ── */
console.log('── 3. 서버 식사 보완 (fillMealGaps, 기존 검색 결과만 사용) ──');
{
  const ctx = newCtx();
  const plan = { days: [
    { stops: [S('11:00', P.valley), S('15:00', P.bandi), { time: '19:00', name: '저녁(자유식)', meal: '저녁', lat: null, lng: null, category: '식사', cost: { amount: null, status: 'unknown' } }, S('21:00', P.resort)] },
    { stops: [S('09:00', P.resort), S('13:30', P.bandi)] },
  ] };
  const traces = [];
  await fillMealGaps(plan, input, ctx, (t) => traces.push(t));
  const d1 = plan.days[0].stops.map((s) => `${s.time}${s.meal ? `[${s.meal}]` : ''}${s.name}`);
  const d2 = plan.days[1].stops.map((s) => `${s.time}${s.meal ? `[${s.meal}]` : ''}${s.name}`);
  console.log('   Day1:', d1.join(' / '));
  console.log('   Day2:', d2.join(' / '));
  check('Day1 점심을 시간 순서에 맞게 끼워 넣음', /^11:00.*\/ 12:30\[점심\]/.test(d1.join(' / ')));
  check('Day1 "저녁(자유식)" 자리를 실제 식당으로 교체', d1.some((x) => x.startsWith('19:00[저녁]') && !x.includes('자유식')));
  check('Day2 점심 추가', d2.some((x) => x.includes('[점심]')));
  check('점심·저녁에 서로 다른 식당', new Set(plan.days.flatMap((d) => d.stops.filter((s) => s.meal).map((s) => s.name))).size === 3);
  check('카페는 식사로 고르지 않음', !plan.days.some((d) => d.stops.some((s) => s.meal && s.name === P.cafe.name)));
  check('API 검색 없이 처리 (기존 검색 결과 사용)', !traces.some((t) => t.name === 'search_places'));
}

/* ── 4. 메뉴 정리 ── */
console.log('── 4. 메뉴 정리 (cleanMenus) ──');
{
  const m = cleanMenus([
    { name: '초벌생오리구이(반마리) 오리700g', price: 48000, unit: '반마리 오리700g' },
    { name: '갈치구이 (1인분)', price: 16000, unit: '1인분' },
    { name: '마제우동 대표', price: 11000, unit: '대표' },
    { name: '너무 싼 메뉴', price: 100, unit: null },
  ]);
  const txt = m.map((x) => `${x.name}|${x.unit ?? ''}`);
  console.log('   ', txt.join('  '));
  check('단위가 이름에 이미 있으면 단위 생략', txt[0] === '초벌생오리구이(반마리) 오리700g|');
  check('이름 끝 (단위) 제거', txt[1] === '갈치구이|1인분');
  check('"대표" 표시 제거', txt[2] === '마제우동|');
  check('비정상 가격(500원 미만) 제외', m.length === 3);
}

/* ── 5. 출처 URL 비교 ── */
console.log('── 5. 출처 URL 비교 (matchSource) ──');
{
  const src = new Map([['https://www.google.com/travel/hotels/entity/AbC?g2lb=1&x=2', 't'], ['https://blog.naver.com/a/123', 'b']]);
  check('모델이 ?쿼리를 잘라 쓴 URL도 인정', matchSource(src, 'https://www.google.com/travel/hotels/entity/AbC')?.includes('g2lb'));
  check('끝 슬래시 차이 인정', matchSource(src, 'https://blog.naver.com/a/123/') === 'https://blog.naver.com/a/123');
  check('검색 결과에 없는 URL 거부', matchSource(src, 'https://fake.example.com/x') === null);
  check('다른 쿼리가 붙은 URL 거부', matchSource(src, 'https://www.google.com/travel/hotels/entity/AbC?other=1') === null);
}

/* ── 6. 숙소 박 수 ── */
console.log('── 6. 숙소 박 수 (lodgingNights) ──');
{
  const ctx = newCtx();
  const resolve = (s) => ctx.places.find((p) => p.name === s.name) || null;
  const plan = { days: [
    { stops: [S('10:00', P.valley), S('20:00', P.resort)] },
    { stops: [S('09:00', P.resort), S('12:00', P.duck), S('20:00', P.resort)] },
    { stops: [S('09:00', P.resort), S('11:00', P.bandi)] },
  ] };
  const stays = lodgingNights(plan, resolve);
  check('같은 숙소 2박으로 계산 (마지막 날 제외)', stays.length === 1 && stays[0].nights === 2, stays.map((s) => `${s.name} ${s.nights}박`).join(', '));
}

/* ── 7. 예산 재계산: Agent 예산이 있을 때 ── */
console.log('── 7. 예산 재계산 (Agent 예산 있음) ──');
{
  const ctx = newCtx();
  ctx.budget = calculate_budget({ totalBudget: 400000, people: 2, items: [
    { name: '숙박비', category: '숙박비', amount: null, status: 'unknown' },
    { name: '식비', category: '식비', amount: null, status: 'unknown' },
    { name: '유류비', category: '교통비', amount: 14072, status: 'estimated', source: 'NAVER Directions fuelPrice' },
  ] });
  ctx.lodgings = [{ name: P.resort.name, nights: 1, days: [0], price: 104071, roomType: '기본 객실', note: null, url: 'https://x', source: 'x.com' }];
  const plan = { days: [
    { stops: [S('12:00', P.duck, { meal: '점심', menuPrices: { menus: [{ name: '한방오리', price: 95000, unit: null }], url: 'https://y', source: 'y.com' } }), S('20:00', P.resort)] },
    { stops: [S('09:00', P.resort)] },
  ] };
  rebuildBudgetWithPrices(plan, input, ctx, noop);
  const b = ctx.budget;
  const lodging = b.items.filter((i) => i.category === '숙박비');
  check('미확인 숙박비 → 숙소 요금 추정치로 교체 (중복 없음)', lodging.length === 1 && lodging[0].status === 'estimated' && lodging[0].total === 104071);
  check('식비는 식당별 미확인 + 메뉴판 참고', b.items.some((i) => i.category === '식비' && i.status === 'unknown' && /메뉴판 참고/.test(i.source || '')));
  check('유류비 유지', b.items.some((i) => i.name === '유류비' && i.total === 14072));
  check('합계 = 숙박 + 유류 (메뉴판 단가는 미포함)', b.plannedTotal === 104071 + 14072, `${b.plannedTotal}`);
}

/* ── 8. 예산: Agent가 예산을 안 만들었을 때 (서버 계산) ── */
console.log('── 8. 예산 서버 계산 (Agent 예산 없음) ──');
{
  const ctx = newCtx();
  ctx.lodgings = [{ name: P.resort.name, nights: 1, days: [0], price: 104071, roomType: '기본 객실', note: null, url: 'https://x', source: 'x.com' }];
  const plan = {
    title: '무주 1박 2일 (업데이트)', overview: '', notes: [],
    days: [
      { day: 1, date: '', theme: '', stops: [S('12:00', P.duck, { meal: '점심' }), S('15:00', P.valley), S('20:00', P.resort)] },
      { day: 2, date: '', theme: '', stops: [S('09:00', P.resort), S('11:00', P.bandi)] },
    ],
  };
  const r = postProcess(plan, input, ctx, noop);
  const lodging = r.budget.items.filter((i) => i.category === '숙박비');
  check('서버 계산 경로', r.budgetSource === 'server');
  check('숙소 요금이 숙박비 추정치로 1번만 들어감 (체크아웃 일정 중복 없음)', lodging.length === 1 && lodging[0].total === 104071, lodging.map((i) => `${i.name}:${i.total}`).join(', '));
  check('식사는 식비 미확인 항목', r.budget.items.some((i) => i.category === '식비' && i.status === 'unknown' && i.name.includes('점심')));
  check('제목의 "(업데이트)" 제거', r.title === '무주 1박 2일', r.title);
}

/* ── 9. 제목 정리 ── */
console.log('── 9. 제목 정리 (cleanTitle) ──');
{
  const cases = [
    ['강원 고성 1박 2일 바다 드라이브(자동차) — 경로 보완 완료', '강원 고성 1박 2일 바다 드라이브(자동차)'],
    ['[수정] 대전 빵집 투어', '대전 빵집 투어'],
    ['제주 2박3일 (애월 숙소 기준)', '제주 2박3일 (애월 숙소 기준)'],
    ['제주 2박3일 — 맛집 & 오름 산책', '제주 2박3일 — 맛집 & 오름 산책'],
  ];
  for (const [a, b] of cases) check(`"${a}"`, cleanTitle(a) === b, cleanTitle(a));
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과 (API 호출 없음)');
process.exit(fail ? 1 : 0);
