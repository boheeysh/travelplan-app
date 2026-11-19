// search_places 단독 테스트 (서버·화면 없이 실행)
//   npm run test:search
import assert from 'node:assert/strict';
import { search_places, parseCoord, toLatLng, cleanText } from '../server/services/naverSearch.js';

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`❌ ${name}\n   ${err.message}`);
  }
}

console.log('── 1. 좌표·텍스트 변환 (오프라인) ──');
await test('정수 ×10^7 좌표 변환', () => assert.equal(parseCoord('1291627052'), 129.1627052));
await test('소수 도 단위 좌표 그대로 사용', () => assert.equal(parseCoord('35.1628151'), 35.1628151));
await test('0/빈 값은 null', () => {
  assert.equal(parseCoord('0'), null);
  assert.equal(parseCoord(''), null);
});
await test('한국 범위 밖 좌표는 제외', () => assert.deepEqual(toLatLng('0', '0'), { lat: null, lng: null }));
await test('<b> 태그·엔티티 제거', () => assert.equal(cleanText('해남짬뽕 <b>해운대</b>점 &amp; 카페'), '해남짬뽕 해운대점 & 카페'));

console.log('\n── 2. 실제 API 호출 ──');
const cases = [
  { region: '부산 해운대', keyword: '맛집' },
  { region: '강릉', keyword: '카페' },
  { region: '경주', keyword: '관광지' },
  { region: '제주', keyword: '흑돼지', sort: 'comment' },
];

for (const c of cases) {
  await test(`"${c.region} ${c.keyword}" 검색`, async () => {
    const result = await search_places(c);
    assert.ok(result.places.length > 0, '결과가 없습니다');
    assert.ok(result.places.length <= 5, 'display 최대 5개 초과');
    for (const p of result.places) {
      assert.ok(p.name && !p.name.includes('<'), `장소명 이상: ${p.name}`);
      assert.ok(p.address || p.roadAddress, `주소 없음: ${p.name}`);
      assert.equal(typeof p.category, 'string');
      assert.ok(p.lat > 33 && p.lat < 39 && p.lng > 124 && p.lng < 132, `좌표 이상: ${p.name} ${p.lat},${p.lng}`);
      // API가 주지 않는 정보가 없는지 확인
      for (const k of ['rating', 'price', 'hours', 'openingHours', 'telephone']) assert.ok(!(k in p), `${k} 필드가 있으면 안 됨`);
    }
    console.table(result.places.map(({ name, category, roadAddress, lat, lng }) => ({ name, category, roadAddress, lat, lng })));
  });
}

console.log('\n── 3. 오류 처리 ──');
await test('빈 검색어는 400 오류', async () => {
  await assert.rejects(search_places({ region: ' ', keyword: '' }), (e) => e.status === 400);
});

console.log(failed ? `\n${failed}개 실패` : '\n모든 테스트 통과');
process.exit(failed ? 1 : 0);
