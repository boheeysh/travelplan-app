// 숙소 요금 조사 — 일정 확정 후 숙소마다 OpenAI 내장 web_search로 "기준 객실 1박 요금"을 찾음
//  - 숙소 요금은 날짜·객실·예약 사이트마다 달라 정확한 값이 아님 → 항상 "추정치", 객실 1개 기준
//  - 박 수: 마지막 날을 뺀 각 날짜의 마지막 숙소 = 그날 밤 숙소
//  - 출처 URL이 실제 web_search 결과(sources)에 있을 때만 인정
//  - 사용자가 숙박 금액을 이미 줬으면(예산에 숙박비 금액 있음) 조사하지 않음

import { openai } from '../services/openai.js';
import { config } from '../config.js';
import { mapLimit, matchSource, hostOf } from './mealPrices.js';

export const LODGING = /숙박|숙소|호텔|게스트하우스|펜션|리조트|민박|스테이|모텔|한옥|콘도|글램핑|캠핑/;
const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const key = (s) => String(s || '').replace(/\s|\(.*?\)/g, '');

const lodgingFormat = {
  format: {
    type: 'json_schema',
    name: 'lodging_rate',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['found', 'roomType', 'price', 'note', 'url'],
      properties: {
        found: { type: 'boolean' },
        roomType: { type: ['string', 'null'], description: '객실 이름만, 15자 이내 (예: 스탠다드 더블)' },
        price: { type: ['number', 'null'], description: '객실 1개 1박 요금(원)' },
        note: { type: ['string', 'null'], description: '요금 조건만 짧게, 20자 이내, 링크·출처 금지 (예: 일요일 요금, 최저가 기준, 후기 결제 금액)' },
        url: { type: ['string', 'null'], description: '요금이 적힌 출처 페이지 URL (web_search 결과 중 하나)' },
      },
    },
  },
};

/** 숙소별 박 수: [{ place, name, nights, days:[dayIndex] }] */
export function lodgingNights(plan, resolve) {
  const map = new Map();
  plan.days.forEach((day, i) => {
    if (i === plan.days.length - 1) return; // 마지막 날 밤은 숙박 없음
    const stop = [...day.stops].reverse().find((s) => LODGING.test(`${s.category || ''} ${s.name}`));
    const place = stop && resolve(stop);
    if (!place) return;
    const k = key(place.name);
    const cur = map.get(k) || { place, name: place.name, nights: 0, days: [] };
    cur.nights++;
    cur.days.push(i);
    map.set(k, cur);
  });
  return [...map.values()];
}

// 마크다운 링크·URL·괄호 속 출처 제거 후 길이 제한
function shortText(t, max) {
  if (!t) return null;
  let s = String(t)
    .replace(/\(?\[[^\]]*\]\([^)]*\)\)?/g, '')   // ([텍스트](url))
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.,(]+$/, '')
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s || null;
}

async function lookupOne(place, dateText, signal) {
  const res = await openai.responses.create({
    model: config.openai.model,
    reasoning: { effort: 'low' },
    tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate', country: 'KR' } }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    text: lodgingFormat,
    input:
      `"${place.name}"(${place.roadAddress || place.address || '주소 미상'}, ${place.category || '숙소'})의 기준 객실 1박 요금을 웹 검색으로 찾아 주세요. 숙박 예정일: ${dateText}.\n` +
      '- 이 숙소(같은 지점)의 객실 1개 1박 요금만 씁니다. 공식 요금표, 예약 사이트의 "1박 최저가 ~원부터", 최근 숙박 후기에 적힌 결제 금액 모두 인정합니다(어떤 근거인지 note에). 다른 숙소·지역 평균은 쓰지 마세요.\n' +
      '- 여러 객실이면 가장 기본 객실 요금, 날짜별로 다르면 숙박 예정일과 가까운 조건(주중/주말, 성수기/비수기)의 요금을 고르고 조건을 note에 적습니다.\n' +
      '- 첫 검색에서 안 보이면 "<숙소명> 객실 요금", "<숙소명> 1박 가격" 등으로 1~2번 더 검색합니다.\n' +
      '- 확인하지 못하면 found=false, 나머지는 null. 추측하지 마세요.',
  }, { signal });

  const sources = new Map();
  for (const o of res.output) {
    if (o.type === 'web_search_call') (o.action?.sources || []).forEach((s) => s.url && sources.set(s.url, s.title || s.url));
    if (o.type === 'message') {
      for (const c of o.content || []) (c.annotations || []).forEach((a) => a.url && sources.set(a.url, a.title || a.url));
    }
  }
  const query = res.output.find((o) => o.type === 'web_search_call')?.action?.query || '';
  let ans;
  try {
    ans = JSON.parse(res.output_text);
  } catch {
    return { ok: false, reason: '응답 형식 오류', query, retry: true };
  }
  if (!ans.found || !Number.isFinite(ans.price) || !ans.url) return { ok: false, reason: '요금을 찾지 못함', query, retry: true };
  if (ans.price < 10000 || ans.price > 3_000_000) return { ok: false, reason: `1박 요금으로 보기 어려운 금액(${won(ans.price)})`, query };
  const matched = matchSource(sources, ans.url);
  if (!matched) return { ok: false, reason: '출처 URL이 검색 결과에 없음', query, retry: true };
  return { ok: true, roomType: shortText(ans.roomType, 20) || '기본 객실', price: Math.round(ans.price), note: shortText(ans.note, 30), url: matched, title: sources.get(matched), query };
}

/**
 * @returns {{ lodgings: Array, used: Array<{url,title}> }}
 *   lodgings: [{ name, nights, price|null, roomType, note, url, source, days }]
 */
export async function lookupLodgingPrices(plan, dates, { resolve, emit, signal }) {
  const stays = lodgingNights(plan, resolve);
  if (!stays.length) return { lodgings: [], used: [] };

  emit({ kind: 'system', title: '숙소 요금 조사', summary: `숙소 ${stays.length}곳(총 ${stays.reduce((n, s) => n + s.nights, 0)}박)의 1박 요금을 웹 검색으로 조사`, status: 'ok' });
  const used = [];
  const lodgings = await mapLimit(stays, 4, async (stay) => {
    const t0 = Date.now();
    const dateText = stay.days.map((i) => dates[i]).filter(Boolean).join(', ') || '미정';
    let r;
    try {
      r = await lookupOne(stay.place, dateText, signal);
      if (!r.ok && r.retry) r = await lookupOne(stay.place, dateText, signal); // 못 찾음·출처 불일치는 1회 재시도
    } catch (err) {
      r = { ok: false, reason: `웹 검색 실패: ${err.message}`, query: '' };
    }
    if (r.ok) used.push({ url: r.url, title: r.title });
    emit({
      kind: 'web_search', name: 'web_search', title: '웹 검색 (숙소 요금)',
      detail: `${stay.name} · ${stay.nights}박${r.query ? ` — "${r.query}"` : ''}`,
      summary: r.ok
        ? `${r.roomType} 1박 ${won(r.price)}${r.note ? ` (${r.note})` : ''} × ${stay.nights}박 = ${won(r.price * stay.nights)} (추정치 · 출처 ${hostOf(r.url)})`
        : `${r.reason} → 숙박비 미확인 유지`,
      status: r.ok ? 'ok' : 'warn',
      ms: Date.now() - t0,
    });
    return {
      name: stay.name, nights: stay.nights, days: stay.days,
      price: r.ok ? r.price : null, roomType: r.ok ? r.roomType : null, note: r.ok ? r.note : null,
      url: r.ok ? r.url : null, source: r.ok ? hostOf(r.url) : null,
    };
  });
  return { lodgings, used };
}

/** 예산 항목: 숙소별 (찾은 요금 → 추정치, 못 찾음 → 미확인) */
export function lodgingBudgetItems(lodgings) {
  return lodgings.map((l) => ({
    name: `숙박 · ${l.name} (${l.nights}박)`,
    category: '숙박비',
    amount: l.price,
    perPerson: false,
    quantity: l.nights,
    status: l.price ? 'estimated' : 'unknown',
    source: l.price
      ? `웹 검색: ${l.roomType} 1박 ${won(l.price)}${l.note ? `, ${l.note}` : ''} (${l.source}) · 객실 1개 기준, 날짜·객실별로 다름`
      : null,
  }));
}
