// get_routes 단독 테스트 (실제 NAVER Directions 5 호출)
//   npm run test:routes
import assert from 'node:assert/strict';
import { get_routes } from '../server/services/naverMaps.js';

const P = {
  haeundae: { name: '해운대해수욕장', lat: 35.1587, lng: 129.1604 },
  yonggungsa: { name: '해동용궁사', lat: 35.1884, lng: 129.2234 },
  busanStation: { name: '부산역', lat: 35.1151, lng: 129.0414 },
  gwangalli: { name: '광안리해수욕장', lat: 35.1532, lng: 129.1186 },
  jejuAirport: { name: '제주국제공항', lat: 33.5070, lng: 126.4930 },
  seaPoint: { name: '동해 바다 한가운데', lat: 37.5, lng: 130.2 },
};

let failed = 0;
async function test(name, fn) {
  try {
    const r = await fn();
    console.log(`✅ ${name}`);
    if (r) console.log('   →', JSON.stringify({ status: r.status, label: r.label, distanceKm: r.distanceKm, durationMin: r.durationMin, tollFare: r.tollFare, fuelPrice: r.fuelPrice, reason: r.reason }));
  } catch (err) {
    failed++;
    console.log(`❌ ${name}\n   ${err.message}`);
  }
}

await test('해운대해수욕장 → 해동용궁사 (자동차 경로 있음)', async () => {
  const r = await get_routes(P.haeundae, P.yonggungsa);
  assert.equal(r.status, 'ok', r.reason);
  assert.equal(r.mode, 'driving');
  assert.ok(r.distanceKm > 3 && r.distanceKm < 30, `거리 이상: ${r.distanceKm}`);
  assert.ok(r.durationMin > 3 && r.durationMin < 90, `시간 이상: ${r.durationMin}`);
  return r;
});

await test('부산역 → 광안리 (빠른 길 옵션)', async () => {
  const r = await get_routes(P.busanStation, P.gwangalli, { option: 'trafast' });
  assert.equal(r.status, 'ok', r.reason);
  assert.equal(r.option, 'trafast');
  return r;
});

await test('같은 장소 → same_place (거리 0)', async () => {
  const r = await get_routes(P.haeundae, P.haeundae);
  assert.equal(r.status, 'same_place', r.reason);
  assert.equal(r.distanceKm, 0);
  return r;
});

await test('제주 → 부산 (API가 카페리 포함 경로 제공 → 페리 표시)', async () => {
  const r = await get_routes(P.jejuAirport, P.busanStation);
  assert.equal(r.status, 'ok', `status=${r.status} ${r.reason}`);
  assert.equal(r.includesFerry, true);
  assert.ok(r.reason.includes('별도 확인'));
  return r;
});

await test('바다 위 좌표 (도로 없음 → 확인 불가)', async () => {
  const r = await get_routes(P.seaPoint, P.haeundae);
  assert.equal(r.status, 'unavailable', `status=${r.status} ${r.reason}`);
  assert.equal(r.label, '확인 불가');
  assert.equal(r.distanceKm, null);
  assert.equal(r.durationMin, null);
  return r;
});

await test('육지 내 일반 경로는 페리 없음', async () => {
  const r = await get_routes(P.haeundae, P.gwangalli);
  assert.equal(r.includesFerry, false);
});

await test('잘못된 좌표 → error (API 호출 안 함)', async () => {
  const r = await get_routes({ name: 'x', lat: 'abc', lng: null }, P.haeundae);
  assert.equal(r.status, 'error');
  return r;
});

await test('도보·대중교통 결과를 만들지 않음', async () => {
  const r = await get_routes(P.haeundae, P.yonggungsa);
  for (const k of ['walking', 'transit', 'walkMin', 'transitMin']) assert.ok(!(k in r), `${k} 필드가 있으면 안 됨`);
  assert.equal(r.mode, 'driving');
});

console.log(failed ? `\n${failed}개 실패` : '\n모든 테스트 통과');
process.exit(failed ? 1 : 0);
