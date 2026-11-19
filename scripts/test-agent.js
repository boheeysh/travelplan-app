// Agent Loop 단독 실행 테스트 (실제 OpenAI + NAVER 호출)
//   npm run test:agent
//   npm run test:agent -- "강릉" 1 "카페 위주로, 바다 보이는 곳"
import { runAgent } from '../server/agent/runAgent.js';

const [region = '부산', nights = '1', request = '해운대 근처 위주로, 저녁은 해산물'] = process.argv.slice(2);
const d = new Date(Date.now() + 14 * 864e5);
const input = {
  region, nights: Number(nights), request,
  startDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  people: 2, budget: 500000, prefs: ['맛집', '관광'], transport: '자동차',
};

console.log('입력:', input, '\n');
const icon = { llm: '🧠', tool: '🛠️', web_search: '🌐', system: '⚙️', error: '❌' };
try {
  const { plan } = await runAgent(input, {
    onTrace: (t) => console.log(`${icon[t.kind] || '•'} [${t.step}] ${t.title}${t.detail ? ` (${t.detail})` : ''}${t.summary ? `\n      → ${t.summary}` : ''}${t.ms ? `  ${(t.ms / 1000).toFixed(1)}s` : ''}`),
  });

  console.log(`\n=== ${plan.title} ===\n${plan.overview}\n`);
  for (const day of plan.days) {
    console.log(`Day ${day.day} ${day.date} · ${day.theme}`);
    for (const s of day.stops) {
      const cost = s.cost.amount === null ? '가격 미확인' : `${s.cost.amount.toLocaleString()}원(${s.cost.status})`;
      console.log(`  ${s.time} ${s.name} [${s.category}] ${s.coordVerified ? '📍' : '(좌표 없음)'} · ${cost}`);
      const r = s.routeToNext;
      if (r) console.log(`     🚗 ${r.status === 'ok' ? `${r.distanceKm}km · ${r.durationMin}분` : r.status === 'not_checked' ? '이동시간 미확인' : `확인 불가 ${r.reason || ''}`}`);
    }
  }
  const b = plan.budget;
  console.log(`\n예산(${plan.budgetSource}): 계획 ${b.plannedTotal.toLocaleString()}원 / 잔여 ${b.remaining.toLocaleString()}원 / 미확인 ${b.unknownItems.length}개`);
  console.log('notes:', plan.notes);
  console.log('웹 출처:', plan.sources.length, '건');
  console.log('meta:', plan.meta);
} catch (err) {
  console.error('\n실패:', err.message);
  process.exit(1);
}
