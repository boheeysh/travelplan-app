// calculate_budget 단독 테스트 (외부 API 없음)
//   npm run test:budget
import assert from 'node:assert/strict';
import { calculate_budget } from '../server/services/budget.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`❌ ${name}\n   ${err.message}`);
  }
}

// 부산 2박 3일, 2명, 총예산 60만 원 예시
const sample = {
  totalBudget: 600000,
  people: 2,
  items: [
    { name: '해운대 호텔', category: '숙박비', amount: 120000, quantity: 2, status: 'confirmed', source: '사용자 입력' },
    { name: '자갈치시장 활어회', category: '식비', amount: 30000, perPerson: true, status: 'estimated', source: '일반 시세 가정' },
    { name: '해남짬뽕 해운대점', category: '식비', amount: null, source: 'NAVER 지역 검색 (가격 정보 없음)' },
    { name: '블루라인파크 스카이캡슐', category: '관광비', amount: 30000, perPerson: true, status: 'confirmed', source: '사용자 입력' },
    { name: '감천문화마을', category: '관광비', amount: 0, status: 'confirmed', source: '무료 입장' },
    { name: '유류비 (전 구간)', category: '교통비', amount: 18000, status: 'estimated', source: 'NAVER Directions fuelPrice' },
    { name: '통행료', category: '교통비', amount: 2500, status: 'estimated', source: 'NAVER Directions tollFare' },
    { name: '주차비', category: '교통비', status: 'unknown' },
  ],
};

const r = calculate_budget(sample);

test('카테고리별 합산', () => {
  assert.equal(r.byCategory['숙박비'].subtotal, 240000);
  assert.equal(r.byCategory['식비'].subtotal, 60000);
  assert.equal(r.byCategory['관광비'].subtotal, 60000);
  assert.equal(r.byCategory['교통비'].subtotal, 20500);
});

test('확인/추정 분리 합계', () => {
  assert.equal(r.confirmedTotal, 300000);
  assert.equal(r.estimatedTotal, 80500);
  assert.equal(r.plannedTotal, 380500);
});

test('잔여 예산 = 총예산 - (확인 + 추정)', () => {
  assert.equal(r.remaining, 219500);
  assert.equal(r.remainingIfConfirmedOnly, 300000);
  assert.equal(r.status, 'within');
});

test('가격 없는 항목은 미확인, 합계 제외', () => {
  assert.deepEqual(r.unknownItems, ['식비 · 해남짬뽕 해운대점', '교통비 · 주차비']);
  const jjambbong = r.items.find((i) => i.name === '해남짬뽕 해운대점');
  assert.equal(jjambbong.status, 'unknown');
  assert.equal(jjambbong.statusLabel, '미확인');
  assert.equal(jjambbong.total, null);
});

test('금액 0원은 미확인이 아니라 확인된 0원', () => {
  const free = r.items.find((i) => i.name === '감천문화마을');
  assert.equal(free.status, 'confirmed');
  assert.equal(free.total, 0);
});

test('예산 초과 감지', () => {
  const over = calculate_budget({ totalBudget: 100000, people: 2, items: sample.items });
  assert.equal(over.status, 'over');
  assert.equal(over.remaining, -280500);
  assert.ok(over.warnings.some((w) => w.includes('초과')));
});

test('status 없이 금액만 있으면 추정치로 처리', () => {
  const x = calculate_budget({ totalBudget: 50000, items: [{ name: '카페', category: '식비', amount: 12000 }] });
  assert.equal(x.items[0].status, 'estimated');
});

test('confirmed인데 금액이 없으면 미확인으로 바꾸고 경고', () => {
  const x = calculate_budget({ totalBudget: 50000, items: [{ name: '숙소', category: '숙박비', status: 'confirmed' }] });
  assert.equal(x.items[0].status, 'unknown');
  assert.ok(x.warnings.length >= 1);
});

test('잘못된 입력은 오류', () => {
  assert.throws(() => calculate_budget({ totalBudget: -1 }));
  assert.throws(() => calculate_budget({ totalBudget: 1000, items: [{ name: 'x', category: '식비', amount: -500 }] }));
});

console.log('\n── 예시 결과 ──');
console.table(r.items.map(({ category, name, statusLabel, total }) => ({ category, name, 상태: statusLabel, 금액: total ?? '미확인' })));
console.log({
  총예산: r.totalBudget, 확인된금액: r.confirmedTotal, 추정치: r.estimatedTotal,
  계획합계: r.plannedTotal, 잔여예산: r.remaining, 사용률: `${r.usageRate}%`, 상태: r.status,
});
console.log('경고:', r.warnings);

console.log(failed ? `\n${failed}개 실패` : '\n모든 테스트 통과');
process.exit(failed ? 1 : 0);
