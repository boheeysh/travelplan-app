// 장소 이름 매칭 단독 테스트 (API 호출 없음)
//   npm run test:match
import { namesMatch, findKnownPlace } from '../server/agent/tools.js';

const cases = [
  // [일정 이름, 검색 결과 이름, 기대값, 설명]
  ['해운대해수욕장', '해운대해수욕장', true, '완전 일치'],
  ['광안리해수욕장 산책', '광안리해수욕장', true, '일정명이 장소명 포함'],
  ['블루라인파크', '해운대블루라인파크', true, '장소명이 일정명 포함(절반 이상)'],
  ['해운대 블루라인파크 미포정거장', '블루라인파크 해운대미포정거장', true, '표기 순서 차이'],
  ['감천문화마을(포토존)', '감천문화마을', true, '괄호 제거'],
  ['광안리 해변 산책', '광안리바당집', false, '이번 오매칭 사례'],
  ['해운대(지역 이동)', '해운대암소갈비집', false, '지역명 ⊂ 식당명'],
  ['숙소(미정)', '해운대그랜드호텔', false, '미정 숙소'],
  ['저녁 식사', '광안리바당집', false, '일반 활동'],
];

let fail = 0;
for (const [stop, place, expected, label] of cases) {
  const got = namesMatch(stop, place);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}: "${stop}" vs "${place}" → ${got}`);
}

// findKnownPlace: 근처(200m 이내)에 있어도 이름이 다르면 null
const ctx = {
  places: [
    { name: '광안리바당집', lat: 35.1534, lng: 129.1186 },
    { name: '광안리해수욕장', lat: 35.1532, lng: 129.1187 },
  ],
};
const onlyRestaurant = { places: [ctx.places[0]] };
const checks = [
  [onlyRestaurant, '광안리 해변 산책', null, '근처에 식당만 검색됨 → 위치 미확인 (이번 오매칭 사례)'],
  [ctx, '광안리 해변 산책', '광안리해수욕장', '해수욕장도 검색됨 → 식당이 아닌 해수욕장으로 연결'],
  [ctx, '광안리해수욕장 산책', '광안리해수욕장', '대표 장소명 포함 → 해수욕장으로 확인'],
  [ctx, '광안리바당집', '광안리바당집', '정확한 식당명 → 식당으로 확인'],
];
for (const [c, name, expected, label] of checks) {
  const got = findKnownPlace(c, 35.1533, 129.1186, name)?.name ?? null;
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}: "${name}" → ${got ?? '위치 미확인'}`);
}

// 복구: 이름이 검색 결과와 정확히 같으면 좌표가 어긋나거나 비어 있어도 인정 (같은 이름이 하나뿐일 때)
const far = {
  places: [
    { name: '해운대해수욕장', lat: 35.1587, lng: 129.1604 },
    { name: '스타벅스', lat: 35.16, lng: 129.16 },
    { name: '스타벅스', lat: 35.15, lng: 129.12 },
  ],
};
const recover = [
  ['해운대해수욕장', 35.17, 129.18, '해운대해수욕장', '좌표가 2km 어긋남 → 검색 좌표로 복구'],
  ['해운대 해수욕장', null, null, '해운대해수욕장', '좌표 누락 → 검색 좌표로 복구'],
  ['스타벅스', null, null, null, '같은 이름 지점이 여러 곳 → 복구 안 함'],
  ['해운대 해변 산책', null, null, null, '정확히 같은 이름이 아니면 → 복구 안 함'],
];
for (const [name, lat, lng, expected, label] of recover) {
  const got = findKnownPlace(far, lat, lng, name)?.name ?? null;
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${label}: "${name}" → ${got ?? '위치 미확인'}`);
}

console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
