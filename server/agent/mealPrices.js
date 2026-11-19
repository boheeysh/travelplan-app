// 식당 메뉴판 단가 조사 — 일정 확정 후 식사(점심·저녁) 식당마다 OpenAI 내장 web_search로
// 대표 메뉴 2~3개의 "메뉴판 단가"(예: 흑돼지 오겹살 200g 22,000원)를 찾음
//  - 1인분 금액은 정하기 어려우므로(그램·마리·세트 단위) 계산하지 않고, 메뉴판 단가를 그대로 보여 줌
//  - 예산 합계에는 더하지 않음 (식비는 "미확인" + 메뉴판 참고 단가)
//  - 출처 URL이 실제 web_search 결과(sources)에 있을 때만 인정 (LLM이 만든 URL 차단)

import { openai } from '../services/openai.js';
import { config } from '../config.js';

const MAX_LOOKUPS = 8;
const CONCURRENCY = 4;
const MAX_MENUS = 3;

const menuFormat = {
  format: {
    type: 'json_schema',
    name: 'menu_board',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['found', 'menus', 'url'],
      properties: {
        found: { type: 'boolean' },
        menus: {
          type: 'array',
          description: '대표 메뉴 최대 3개 (메뉴판에 적힌 그대로)',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'price', 'unit'],
            properties: {
              name: { type: 'string', description: '메뉴 이름 (가격·단위 제외)' },
              price: { type: 'number', description: '메뉴판 가격(원)' },
              unit: { type: ['string', 'null'], description: '메뉴판에 적힌 단위. 예: "1인분", "200g", "1마리", "2인 세트". 없으면 null' },
            },
          },
        },
        url: { type: ['string', 'null'], description: '가격이 적힌 출처 페이지 URL (web_search 결과 중 하나)' },
      },
    },
  },
};

const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
export const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// "고등어쌈밥 18,000원 · 흑돼지 오겹살(200g) 22,000원"
export const menuText = (menus) =>
  menus.map((m) => `${m.name}${m.unit ? `(${m.unit})` : ''} ${won(m.price)}`).join(' · ');

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

// URL 비교용 정규화 (끝 슬래시·#·utm 파라미터 차이 무시)
export const normUrl = (u) => {
  try {
    const x = new URL(u);
    x.hash = '';
    [...x.searchParams.keys()].filter((k) => k.startsWith('utm_')).forEach((k) => x.searchParams.delete(k));
    return (x.origin + decodeURI(x.pathname).replace(/\/+$/, '') + x.search).toLowerCase();
  } catch {
    return String(u);
  }
};

// 메뉴 정리 (API 응답 → 화면 표시용): 가격 범위 검사, 최대 3개, 이름·단위 중복 정리
export function cleanMenus(menus) {
  return (menus || [])
    .filter((m) => m.name && Number.isFinite(m.price) && m.price >= 500 && m.price <= 1_000_000)
    .slice(0, MAX_MENUS)
    .map((m) => {
      let unit = m.unit?.trim() || null;
      // 이름 끝에 단위가 붙어 있으면 제거: "갈치구이 (1인분)", "초벌생오리구이(반마리) 오리700g" + unit → 단위는 따로 표시
      // 출처 사이트의 "대표" 표시는 단위가 아님
      let name = m.name.replace(/\s*\(?대표\)?\s*$/, '').trim() || m.name.trim();
      if (unit && /^\(?대표\)?$/.test(unit)) unit = null;
      if (unit) unit = unit.replace(/^\(?대표\)?\s*/, '').trim() || null;
      if (unit) {
        const esc = unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        name = name.replace(new RegExp(`\\s*\\(?${esc}\\)?\\s*$`), '').trim() || m.name.trim();
      }
      // 단위의 낱말이 모두 이름에 이미 있으면 단위는 따로 표시하지 않음 ("초벌생오리구이(반마리) 오리700g" + "반마리 오리700g")
      if (unit && unit.split(/[\s(),/]+/).filter(Boolean).every((w) => name.includes(w))) unit = null;
      return { name, price: Math.round(m.price), unit };
    });
}

// 답에 적힌 URL이 실제 검색 출처 중 어느 것인지 찾음
//  - 정확히 같거나, 답에 쿼리가 없으면(모델이 긴 ?쿼리를 잘라 씀) 도메인+경로가 같은 출처
export function matchSource(sources, url) {
  const n = normUrl(url);
  const exact = [...sources.keys()].find((u) => normUrl(u) === n);
  if (exact) return exact;
  let base;
  try {
    const x = new URL(url);
    if (x.search) return null;
    base = (x.origin + decodeURI(x.pathname).replace(/\/+$/, '')).toLowerCase();
  } catch {
    return null;
  }
  return [...sources.keys()].find((u) => {
    try {
      const y = new URL(u);
      return (y.origin + decodeURI(y.pathname).replace(/\/+$/, '')).toLowerCase() === base;
    } catch {
      return false;
    }
  }) || null;
}

async function lookupOne(place, signal) {
  const res = await openai.responses.create({
    model: config.openai.model,
    reasoning: { effort: 'low' },
    tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate', country: 'KR' } }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    text: menuFormat,
    input:
      `"${place.name}"(${place.address || '주소 미상'}, ${place.category || '식당'})의 메뉴판에서 대표 메뉴 2~3개의 가격을 웹 검색으로 찾아 주세요.\n` +
      '- 메뉴판에 적힌 가격과 단위(1인분, 200g, 1마리, 2인 세트 등)를 그대로 씁니다. 1인분으로 환산하거나 나누지 마세요.\n' +
      '- 첫 검색에서 가격이 안 보이면 "<식당명> 메뉴판", "<식당명> 가격 후기" 등으로 1~2번 더 검색합니다.\n' +
      '- 이 식당(같은 지점)의 메뉴판·공식 페이지·최근 리뷰에 적힌 가격만 씁니다. 다른 지점·비슷한 식당·일반 시세는 쓰지 마세요.\n' +
      '- 모든 메뉴는 url 한 페이지에서 확인한 것만 넣습니다.\n' +
      '- 확인하지 못하면 found=false, menus=[], url=null. 추측하지 마세요.',
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
  const menus = cleanMenus(ans.menus);
  if (!ans.found || !menus.length || !ans.url) return { ok: false, reason: '메뉴판 가격을 찾지 못함', query, retry: true };
  const matched = matchSource(sources, ans.url);
  if (!matched) return { ok: false, reason: '출처 URL이 검색 결과에 없음', query, retry: true };
  return { ok: true, menus, url: matched, title: sources.get(matched), query };
}

/**
 * @param plan    최종 일정 (stops에 meal 표시)
 * @param resolve (stop) => 검색으로 확인된 장소 or null
 * @returns 실제로 쓰인 출처 [{url,title}]
 */
export async function lookupMenuPrices(plan, { resolve, emit, signal }) {
  const targets = plan.days
    .flatMap((d) => d.stops)
    .filter((s) => s.meal && !/숙박|숙소|호텔|게스트하우스|펜션|리조트/.test(s.category || ''))
    .map((stop) => ({ stop, place: resolve(stop) }))
    .filter((t) => t.place)
    .slice(0, MAX_LOOKUPS);
  if (!targets.length) return [];

  emit({ kind: 'system', title: '메뉴판 가격 조사', summary: `식사 식당 ${targets.length}곳의 대표 메뉴 단가를 웹 검색으로 조사`, status: 'ok' });
  const used = [];

  await mapLimit(targets, CONCURRENCY, async ({ stop, place }) => {
    const t0 = Date.now();
    const info = { name: place.name, address: place.roadAddress || place.address, category: place.category };
    let r;
    try {
      r = await lookupOne(info, signal);
      if (!r.ok && r.retry) r = await lookupOne(info, signal); // 못 찾음·출처 불일치·형식 오류는 1회 재시도
    } catch (err) {
      r = { ok: false, reason: `웹 검색 실패: ${err.message}`, query: '' };
    }
    if (r.ok) {
      stop.menuPrices = { menus: r.menus, url: r.url, source: hostOf(r.url) };
      used.push({ url: r.url, title: r.title });
    }
    emit({
      kind: 'web_search', name: 'web_search', title: '웹 검색 (메뉴판 가격)',
      detail: `${stop.meal} · ${place.name}${r.query ? ` — "${r.query}"` : ''}`,
      summary: r.ok ? `${menuText(r.menus)} (출처 ${hostOf(r.url)})` : `${r.reason} → 가격 미확인 유지`,
      status: r.ok ? 'ok' : 'warn',
      ms: Date.now() - t0,
    });
  });

  return used;
}
