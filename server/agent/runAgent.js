// Function Calling 기반 Agent Loop (OpenAI Responses API)
//
//  1) 사용자 요청 + Tool 스키마를 LLM에 전달
//  2) LLM이 function_call을 요청하면 Node.js에서 실제 함수 실행
//  3) 결과(function_call_output)를 LLM에 다시 전달 → 필요하면 추가 Tool 호출
//  4) Tool 호출 없이 최종 답변(JSON)을 내면 종료
//  - 최대 반복 횟수·최대 Tool 호출 수를 넘으면 Tool 없이 최종 답변을 강제
//  - 최종 일정의 이동시간·좌표는 서버가 실제 Tool 결과로만 채움 (환각 방지)
import { openai } from '../services/openai.js';
import { config } from '../config.js';
import { calculate_budget } from '../services/budget.js';
import { functionTools, builtInTools, createToolContext, executeTool, findKnownPlace, nearbyPlaces, verifyPrice } from './tools.js';
import { INSTRUCTIONS, buildUserMessage, tripDates } from './prompt.js';
import { textFormat } from './planSchema.js';
import { lookupMenuPrices, menuText } from './mealPrices.js';
import { lookupLodgingPrices, lodgingBudgetItems, LODGING as LODGING_PLACE } from './lodgingPrices.js';

export class AgentError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const won = (n) => `${Math.round(n).toLocaleString()}원`;

function describeArgs(name, a) {
  if (!a) return '';
  if (name === 'search_places') return `${a.region} ${a.keyword}${a.sort === 'comment' ? ' (리뷰순)' : ''}`;
  if (name === 'get_routes') return `${a.origin?.name} → ${a.destination?.name}`;
  if (name === 'calculate_budget') return `${a.items?.length ?? 0}개 항목 · 총예산 ${won(a.totalBudget || 0)}`;
  return JSON.stringify(a).slice(0, 80);
}

function openAIErrorMessage(err) {
  if (err.name === 'AbortError' || err.constructor?.name === 'APIUserAbortError') return '요청이 취소되었습니다.';
  if (err.status === 401) return 'OpenAI API 키가 올바르지 않습니다. .env의 OPENAI_API_KEY를 확인해 주세요.';
  if (err.status === 429) return 'OpenAI 호출 한도를 초과했거나 크레딧이 부족합니다. 잠시 후 다시 시도해 주세요.';
  if (err.status === 400) return `OpenAI 요청 오류: ${err.message}`;
  if (err.status >= 500) return 'OpenAI 서버 오류입니다. 잠시 후 다시 시도해 주세요.';
  if (err.constructor?.name === 'APIConnectionTimeoutError') return 'OpenAI 응답 시간이 초과되었습니다.';
  return `OpenAI 호출 실패: ${err.message}`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * @param {object} input 사용자 여행 조건
 * @param {{ onTrace?: (item) => void, signal?: AbortSignal }} [opts]
 */
export async function runAgent(input, { onTrace = () => {}, signal } = {}) {
  const { maxIterations, maxToolCalls } = config.agent;
  const ctx = createToolContext(input);
  const trace = [];
  const webSources = new Map();
  let step = 0;
  let toolCallCount = 0;
  const usage = { input: 0, output: 0 };
  const startedAt = Date.now();

  const emit = (item) => {
    const full = { step: ++step, at: Date.now() - startedAt, ...item };
    trace.push(full);
    onTrace(full);
  };

  const base = {
    model: config.openai.model,
    instructions: INSTRUCTIONS,
    tools: [...functionTools, ...builtInTools],
    text: textFormat,
    include: ['web_search_call.action.sources'],
    ...(config.openai.reasoningEffort && { reasoning: { effort: config.openai.reasoningEffort } }),
  };

  async function callModel(params, iteration) {
    if (signal?.aborted) throw new AgentError('요청이 취소되었습니다.', 499);
    const t0 = Date.now();
    let res;
    try {
      res = await openai.responses.create({ ...base, ...params }, { signal });
    } catch (err) {
      const message = openAIErrorMessage(err);
      emit({ kind: 'error', title: 'LLM 호출 실패', detail: message, status: 'error', ms: Date.now() - t0, iteration });
      throw new AgentError(message, err.status === 401 ? 500 : 502);
    }
    usage.input += res.usage?.input_tokens || 0;
    usage.output += res.usage?.output_tokens || 0;

    // LLM이 직접 수행한 web_search 기록
    for (const item of res.output) {
      if (item.type !== 'web_search_call') continue;
      if (item.status !== 'failed') ctx.webSearchCount++;
      const sources = item.action?.sources || [];
      sources.forEach((s) => s.url && webSources.set(s.url, s.title || s.url));
      emit({
        kind: 'web_search', name: 'web_search', title: '웹 검색 (OpenAI 내장)',
        detail: item.action?.query || item.action?.type || '',
        summary: sources.length ? `출처 ${sources.length}건 확인` : item.status, status: item.status === 'failed' ? 'error' : 'ok', iteration,
      });
    }

    const calls = res.output.filter((o) => o.type === 'function_call');
    const counts = calls.reduce((m, c) => ((m[c.name] = (m[c.name] || 0) + 1), m), {});
    emit({
      kind: 'llm', title: `LLM 판단 #${iteration}`,
      summary: calls.length
        ? `Tool ${calls.length}개 선택: ${Object.entries(counts).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ')}`
        : '추가 Tool 없이 최종 일정 작성',
      detail: `토큰 입력 ${res.usage?.input_tokens ?? '-'} / 출력 ${res.usage?.output_tokens ?? '-'}`,
      status: 'ok', ms: Date.now() - t0, iteration,
    });

    if (res.status === 'incomplete') {
      const reason = res.incomplete_details?.reason || 'unknown';
      throw new AgentError(`LLM 응답이 중간에 끊겼습니다 (${reason}).`, 502);
    }
    return { res, calls };
  }

  /* ───────── Agent Loop ───────── */
  let iteration = 1;
  let { res, calls } = await callModel({ input: buildUserMessage(input) }, iteration);
  let forcedFinal = false;
  let reviewed = false;
  let plan;

  for (;;) {
    while (calls.length) {
      if (forcedFinal) throw new AgentError('최대 반복 후에도 LLM이 Tool을 계속 요청했습니다.', 502);

      const overLimit = iteration >= maxIterations || toolCallCount + calls.length > maxToolCalls;
      let outputs;

      if (overLimit) {
        forcedFinal = true;
        emit({
          kind: 'system', title: '반복 한도 도달',
          summary: `반복 ${iteration}/${maxIterations}회, Tool ${toolCallCount}/${maxToolCalls}회 → 요청된 Tool ${calls.length}개는 실행하지 않고 최종 답변 요청`,
          status: 'warn', iteration,
        });
        outputs = calls.map((c) => ({
          type: 'function_call_output',
          call_id: c.call_id,
          output: JSON.stringify({ error: '최대 Tool 호출 한도에 도달해 실행하지 않았습니다. 지금까지 확인한 정보만으로 최종 일정을 작성하고, 확인 못 한 내용은 notes에 적으세요.' }),
        }));
      } else {
        toolCallCount += calls.length;
        outputs = await mapLimit(calls, 4, async (call) => {
          const t0 = Date.now();
          const r = await executeTool(call.name, call.arguments, ctx);
          emit({
            kind: 'tool', name: call.name, title: call.name,
            detail: describeArgs(call.name, r.args), summary: r.summary, args: r.args,
            status: r.isError ? 'error' : 'ok', ms: Date.now() - t0, iteration,
          });
          return { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(r.output) };
        });
      }

      iteration++;
      ({ res, calls } = await callModel(
        { previous_response_id: res.id, input: outputs, ...(forcedFinal && { tool_choice: 'none' }) },
        iteration,
      ));
    }

    /* ───────── 최종 답변 파싱 ───────── */
    const refusal = res.output.flatMap((o) => o.content || []).find((c) => c.type === 'refusal');
    if (refusal) throw new AgentError(`LLM이 응답을 거절했습니다: ${refusal.refusal}`, 502);

    try {
      plan = JSON.parse(res.output_text);
    } catch {
      throw new AgentError('LLM의 최종 일정 형식이 올바르지 않습니다.', 502);
    }
    plan = cleanPlan(plan, ctx, emit);
    const emptyDays = findEmptyDays(plan, input);

    /* ───────── 자체 검토 (1회): 이름이 검색 결과와 맞지 않는 장소 + 이동시간 미확인 구간 ───────── */
    const mismatched = findNameMismatches(plan, ctx);
    const missing = findUncheckedLegs(plan, ctx);
    const mealGaps = findMealGaps(plan, ctx);
    const canReview = !reviewed && !forcedFinal && iteration < maxIterations && toolCallCount + missing.length <= maxToolCalls;
    if ((!emptyDays.length && !missing.length && !mismatched.length && !mealGaps.length) || !canReview) break;

    reviewed = true;
    emit({
      kind: 'system', title: '일정 검토',
      summary: [
        emptyDays.length && `비어 있는 날 ${emptyDays.length}일`,
        mealGaps.length && `빠진 식사 ${mealGaps.length}끼`,
        mismatched.length && `검색 결과와 이름이 맞지 않는 장소 ${mismatched.length}개`,
        missing.length && `이동시간 미확인 구간 ${missing.length}개`,
      ].filter(Boolean).join(' · ') + ' → Agent에게 보완 요청',
      status: 'warn', iteration,
    });
    const parts = ['[서버 검토]'];
    if (emptyDays.length) {
      parts.push(`여행 일수는 ${input.nights + 1}일인데 다음 날짜의 일정이 비어 있습니다: ${emptyDays.join(', ')}. 필요한 Tool로 장소를 확인해 모든 날의 일정을 작성하세요.`);
    }
    if (mealGaps.length) {
      parts.push(
        '아래 식사가 일정에 없거나, 식당이 search_places로 확인되지 않았습니다.\n' +
        mealGaps.map((g) => `- Day ${g.day} ${g.meal}: ${g.reason}`).join('\n') +
        '\n그날 동선 근처 동네 이름으로 search_places를 검색해 실제 식당을 넣고 meal을 표시하세요. 앞뒤 장소와의 get_routes도 확인하세요.',
      );
    }
    if (mismatched.length) {
      parts.push(
        '아래 장소는 좌표가 있지만 이름이 search_places 결과와 맞지 않아 "위치 미확인"으로 처리됩니다.\n' +
        mismatched.map((m) => `- "${m.name}" — 근처 검색 결과: ${m.candidates.length ? m.candidates.map((c) => `"${c}"`).join(', ') : '없음'}`).join('\n') +
        '\n같은 장소라면 name을 검색 결과 장소명 그대로(활동이면 "장소명 + 활동") 고치고, 다른 장소라면 lat/lng를 null로 두세요. 근처 다른 가게의 좌표를 빌리지 마세요.',
      );
    }
    if (missing.length) {
      parts.push(
        '아래 구간은 두 장소 모두 검색 좌표가 있지만 get_routes 결과가 없어 이동시간이 "미확인"으로 표시됩니다.\n' +
        missing.map((l) => `- ${l.from.name} (${l.from.lat}, ${l.from.lng}) → ${l.to.name} (${l.to.lat}, ${l.to.lng})`).join('\n') +
        '\n필요하다고 판단되면 get_routes로 확인하세요.',
      );
    }
    parts.push('이동은 화면이 자동으로 표시하므로 "A → B (이동)", "출발", "귀환" 같은 이동 전용 항목은 만들지 말고, 같은 장소를 연속으로 두 번 넣지 마세요.');
    parts.push('이름을 고쳐 새로 좌표가 확인되는 연속 구간도 get_routes로 확인할 수 있습니다. 그 뒤 같은 방문 순서로 최종 일정 JSON을 다시 작성하세요.');
    iteration++;
    ({ res, calls } = await callModel({
      previous_response_id: res.id,
      input: [{ role: 'user', content: parts.join('\n\n') }],
    }, iteration));
  }

  if (findEmptyDays(plan, input).length === plan.days?.length || !plan.days?.length) {
    throw new AgentError('일정을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.', 502);
  }
  await fillMealGaps(plan, input, ctx, emit);
  await fillMissingRoutes(plan, ctx, emit, signal);
  // 메뉴판 단가·숙소 요금 조사 (동시에). 숙박 금액이 이미 있으면(사용자 입력 등) 숙소 요금은 조사하지 않음
  const resolve = (s) => findKnownPlace(ctx, s.lat, s.lng, s.name);
  const lodgingKnown = hasLodgingAmount(plan, ctx);
  const [menuSources, lodgingResult] = await Promise.all([
    lookupMenuPrices(plan, { resolve, emit, signal }),
    lodgingKnown ? { lodgings: [], used: [] } : lookupLodgingPrices(plan, tripDates(input.startDate, input.nights), { resolve, emit, signal }),
  ]);
  ctx.lodgings = lodgingResult.lodgings;
  attachLodgingPrices(plan, ctx.lodgings, resolve);
  [...menuSources, ...lodgingResult.used].forEach((s) => webSources.set(s.url, s.title));
  if (menuSources.length || ctx.lodgings.length) rebuildBudgetWithPrices(plan, input, ctx, emit);
  const result = postProcess(plan, input, ctx, emit);
  result.sources = [...webSources].map(([url, title]) => ({ url, title }));
  result.meta = {
    model: config.openai.model,
    iterations: iteration,
    toolCalls: toolCallCount,
    tokens: usage,
    elapsedMs: Date.now() - startedAt,
  };
  return { plan: result, trace };
}

// 같은 날 연속된 두 장소가 모두 검색 좌표를 가지는데 get_routes 결과가 없는 구간
/**
 * 서버 보완: Agent 검토 후에도 남은 "두 장소 모두 검색으로 확인됐는데 경로 미조회" 구간을
 * 서버가 get_routes로 직접 조회한다. 확인된 좌표만 쓰므로 값을 지어내지 않음.
 * 새로 조회한 구간이 있으면 유류비·통행료 항목을 갱신해 예산을 다시 계산한다.
 */
const SERVER_ROUTE_LIMIT = 10;
export async function fillMissingRoutes(plan, ctx, emit, signal) {
  const legs = findUncheckedLegs(plan, ctx).slice(0, SERVER_ROUTE_LIMIT);
  if (!legs.length || signal?.aborted) return;

  emit({ kind: 'system', title: '경로 보완', summary: `Agent가 조회하지 않은 확인된 구간 ${legs.length}개 → 서버가 get_routes로 직접 조회`, status: 'warn' });
  const before = { fuel: sumRoutes(ctx, 'fuelPrice'), toll: sumRoutes(ctx, 'tollFare') };

  await mapLimit(legs, 4, async (l) => {
    const t0 = Date.now();
    const args = { origin: l.from, destination: l.to, option: 'traoptimal' };
    const r = await executeTool('get_routes', JSON.stringify(args), ctx);
    emit({
      kind: 'tool', name: 'get_routes', title: 'get_routes (서버 보완)',
      detail: describeArgs('get_routes', r.args), summary: r.summary, args: r.args,
      status: r.isError ? 'error' : 'ok', ms: Date.now() - t0,
    });
  });

  // 예산 재계산: Agent가 넣은 유류비·통행료 항목을 새 합계로 바꿈
  const after = { fuel: sumRoutes(ctx, 'fuelPrice'), toll: sumRoutes(ctx, 'tollFare') };
  if (!ctx.budgetArgs || (after.fuel === before.fuel && after.toll === before.toll)) return;
  // Agent가 넣은 유류비·통행료 항목(근거 표기·이름이 제각각)을 모두 빼고 새 합계로 하나씩 다시 넣음 → 중복 합산 방지
  const items = (ctx.budgetArgs.items || []).filter((it) => !isRouteCostItem(it));
  if (after.fuel) items.push({ name: '유류비 (확인된 구간 합계)', category: '교통비', amount: after.fuel, perPerson: false, quantity: 1, status: 'estimated', source: 'NAVER Directions fuelPrice 합산' });
  if (after.toll) items.push({ name: '통행료 (확인된 구간 합계)', category: '교통비', amount: after.toll, perPerson: false, quantity: 1, status: 'estimated', source: 'NAVER Directions tollFare 합산' });
  const r = await executeTool('calculate_budget', JSON.stringify({ ...ctx.budgetArgs, items }), ctx);
  emit({
    kind: 'tool', name: 'calculate_budget', title: 'calculate_budget (서버 보완)',
    detail: '보완한 경로의 유류비·통행료 반영', summary: r.summary, args: r.args,
    status: r.isError ? 'error' : 'ok', ms: 0,
  });
}

// 유류비·통행료 항목인지 (Directions 근거 or 이름에 유류/연료/통행료/톨)
const isRouteCostItem = (it) =>
  it.category === '교통비' && /fuelPrice|tollFare|directions|get_routes|유류|연료|통행료|톨게이트/i.test(`${it.source || ''} ${it.name || ''}`);
const sumRoutes = (ctx, key) => [...ctx.routes.values()].reduce((s, r) => s + (r[key] || 0), 0);

// 숙박 금액이 이미 있는지 (Agent 예산의 숙박비 금액 or 근거가 확인되는 숙소 일정 비용)
function hasLodgingAmount(plan, ctx) {
  const inBudget = (ctx.budget?.items || []).some((it) => it.category === '숙박비' && (it.unitAmount ?? it.amount) > 0 && it.status !== 'unknown');
  const inStops = plan.days.some((d) => d.stops.some((s) =>
    LODGING_PLACE.test(`${s.category || ''} ${s.name}`) && s.cost?.amount > 0 &&
    verifyPrice(ctx, { amount: s.cost.amount, status: s.cost.status, source: s.cost.basis }).amount > 0));
  return inBudget || inStops;
}

// 일정의 숙소(그날 밤 숙소)에 조사한 요금 표시용 정보 붙이기
function attachLodgingPrices(plan, lodgings, resolve) {
  for (const l of lodgings) {
    if (!l.price) continue;
    for (const i of l.days) {
      const stop = [...plan.days[i].stops].reverse().find((s) => LODGING_PLACE.test(`${s.category || ''} ${s.name}`) && resolve(s)?.name === l.name);
      if (stop) stop.lodgingPrice = { price: l.price, roomType: l.roomType, note: l.note, url: l.url, source: l.source, nights: l.nights };
    }
  }
}

// 식사 식당별 식비 항목 (메뉴판 단가는 참고 → 금액은 미확인)
function mealBudgetItems(plan) {
  return plan.days.flatMap((d, i) =>
    d.stops.filter((s) => s.meal).map((s) => ({
      name: `Day${i + 1} ${s.meal} · ${s.name}`, category: '식비',
      amount: null, perPerson: false, quantity: 1, status: 'unknown',
      source: s.menuPrices ? `메뉴판 참고: ${menuText(s.menuPrices.menus)} (${s.menuPrices.source})` : null,
    })),
  );
}

/**
 * 가격 조사 후 Agent 예산 정리
 *  - 식비: 금액 없는 항목을 빼고 식사 식당별 "미확인" 항목 + 메뉴판 참고 단가 (단가는 1인분 금액이 아니라 합계 미포함)
 *  - 숙박비: 숙소 요금을 조사했으면 금액 없는 숙박 항목을 빼고 숙소별 항목(1박 요금 × 박 수, 추정치)
 *  - Agent가 예산을 계산하지 않았으면 postProcess가 같은 규칙으로 계산
 */
export function rebuildBudgetWithPrices(plan, input, ctx, emit) {
  if (!ctx.budget) return;
  const lodgings = ctx.lodgings || [];
  const keep = ctx.budget.items
    .map(({ name, category, unitAmount, amount, perPerson, quantity, status, source }) => ({
      name, category, amount: unitAmount ?? amount ?? null, perPerson, quantity, status, source,
    }))
    .filter((it) => !(it.category === '식비' && (it.amount === null || it.status === 'unknown')))
    .filter((it) => !(lodgings.length && it.category === '숙박비' && (it.amount === null || it.status === 'unknown')));
  const meals = mealBudgetItems(plan);
  const stays = lodgingBudgetItems(lodgings);
  ctx.budget = calculate_budget({ totalBudget: input.budget, people: input.people, items: [...keep, ...meals, ...stays] });
  const found = lodgings.filter((l) => l.price);
  emit({
    kind: 'system', name: 'calculate_budget', title: '예산 정리',
    summary: [
      meals.length && `식사 ${meals.length}끼는 식비(미확인)로 정리, 메뉴판 단가는 참고용`,
      lodgings.length && `숙소 ${lodgings.length}곳 중 ${found.length}곳 요금을 숙박비 추정치로 반영`,
    ].filter(Boolean).join(' · ') + ` → 잔여 ${won(ctx.budget.remaining)}`,
    status: 'ok',
  });
}

/**
 * 일정 정리 (결정적 규칙)
 *  - "A → B (이동 정보)", "출발", "귀환" 같은 이동 전용 항목 제거 (이동은 get_routes로 화면이 표시)
 *  - 같은 장소가 연속으로 두 번 나오면 하나로 합침 (식사 표시는 유지)
 */
const NOT_A_MEAL_PLACE = /카페|디저트|베이커리|제과|커피|찻집|전통차/;
const LODGING = /숙박|숙소|호텔|게스트하우스|펜션|리조트|민박|스테이/;
export function cleanPlan(plan, ctx, emit = () => {}) {
  let removed = 0;
  let merged = 0;
  for (const day of plan.days || []) {
    const out = [];
    for (const s of day.stops || []) {
      // 숙소·카페는 식사 장소가 아님 (검색 결과 카테고리 우선) → 식사 보완 단계가 근처 식당으로 채움
      if (s.meal) {
        const cat = findKnownPlace(ctx, s.lat, s.lng, s.name)?.category || s.category || '';
        if (LODGING.test(`${cat} ${s.name}`) || NOT_A_MEAL_PLACE.test(cat)) s.meal = null;
      }
      const bare = String(s.name).replace(/\s*\(.*?\)\s*/g, '').trim();
      if (!s.meal && (/→|->/.test(s.name) || /^(출발|귀환|복귀|이동)/.test(bare) || /\((이동[^)]*|귀환[^)]*)\)/.test(s.name) && !findKnownPlace(ctx, s.lat, s.lng, s.name))) {
        removed++;
        continue;
      }
      const prev = out[out.length - 1];
      if (prev && Number.isFinite(s.lat) && prev.lat === s.lat && prev.lng === s.lng) {
        // 식사로 표시된 쪽을 남기고, 둘 다 아니면 앞의 것을 유지
        if (s.meal && !prev.meal) out[out.length - 1] = s;
        merged++;
        continue;
      }
      out.push(s);
    }
    day.stops = out;
  }
  if (removed || merged) {
    emit({ kind: 'system', title: '일정 정리', summary: [removed && `이동 전용 항목 ${removed}개 제거`, merged && `연속 중복 장소 ${merged}개 합침`].filter(Boolean).join(' · '), status: 'warn' });
  }
  return plan;
}

// 일정이 비어 있는 날 (여행 일수보다 적은 경우 포함)
function findEmptyDays(plan, input) {
  const dates = tripDates(input.startDate, input.nights);
  return dates.filter((d, i) => !(plan.days?.[i]?.stops?.length));
}

// 점심·저녁이 빠졌거나 검색으로 확인되지 않은 날
// 첫날 늦은 도착·마지막 날 이른 출발처럼 그 시간대가 일정에 없으면 제외
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export function findMealGaps(plan, ctx) {
  const gaps = [];
  const days = plan.days || [];
  days.forEach((day, i) => {
    const times = day.stops.map((s) => toMin(s.time)).filter((t) => t !== null);
    if (!times.length) return;
    const first = Math.min(...times);
    const last = Math.max(...times);
    const isFirst = i === 0;
    const isLast = i === days.length - 1;
    const need = {
      // 점심 시간(12:30)에 여행 중이면 필요: 첫날은 12:30 전에 시작, 마지막 날은 12:30 이후까지
      점심: (!isFirst || first <= 12 * 60 + 30) && (!isLast || last >= 12 * 60 + 30),
      저녁: first <= 18 * 60 && (!isLast || last >= 18 * 60 + 30),
    };
    for (const meal of ['점심', '저녁']) {
      if (!need[meal]) continue;
      const stop = day.stops.find((s) => s.meal === meal);
      if (!stop) gaps.push({ day: i + 1, meal, reason: '일정에 없음' });
      else if (!findKnownPlace(ctx, stop.lat, stop.lng, stop.name)) gaps.push({ day: i + 1, meal, reason: `"${stop.name}"이(가) 검색으로 확인되지 않음` });
    }
  });
  return gaps;
}

/**
 * 서버 보완: Agent 검토 후에도 빠진 점심·저녁을 실제 검색된 식당으로 채움
 *  - 앞뒤 일정(검색으로 확인된 장소)에서 가장 가까운 식당을 기존 검색 결과에서 고름 (20km 이내, 이미 쓴 곳 제외)
 *  - 없으면 그 동네 이름으로 search_places("맛집")를 새로 실행
 *  - 검색 안 된 식사 항목(예: "저녁(자유식)")은 그 자리를 바꾸고, 없으면 시간 순서에 맞게 끼워 넣음
 */
const RESTAURANT = /음식점|한식|일식|중식|양식|분식|육류|고기|해물|생선|회|국수|국밥|해장국|요리|식당|레스토랑|뷔페|돼지|갈비|칼국수|냉면|치킨|피자|햄버거|초밥|돈가스|백반|찌개|전골/;
const NOT_MEAL = /카페|디저트|베이커리|제과|숙박|호텔|펜션|리조트|게스트|술집|바\(BAR\)|주점|포차/;
const kmBetween = (a, b) => {
  const r = Math.PI / 180;
  const x = (b.lng - a.lng) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
const MEAL_TIME = { 점심: '12:30', 저녁: '18:30' };

export async function fillMealGaps(plan, input, ctx, emit) {
  const gaps = findMealGaps(plan, ctx);
  if (!gaps.length) return;
  const used = new Set(plan.days.flatMap((d) => d.stops.map((s) => normKey(s.name))));

  for (const gap of gaps) {
    const day = plan.days[gap.day - 1];
    const target = toMin(MEAL_TIME[gap.meal]);
    // 바꿀 자리(검색 안 된 같은 식사) 또는 끼워 넣을 위치
    let replaceIdx = day.stops.findIndex((s) => s.meal === gap.meal);
    let insertIdx = day.stops.findIndex((s) => (toMin(s.time) ?? 0) > target);
    if (insertIdx < 0) insertIdx = day.stops.length;
    const at = replaceIdx >= 0 ? replaceIdx : insertIdx;
    // 기준점: 앞(없으면 뒤)의 확인된 장소
    const known = (s) => (s ? findKnownPlace(ctx, s.lat, s.lng, s.name) : null);
    let anchor = null;
    for (let i = at - 1; i >= 0 && !anchor; i--) anchor = known(day.stops[i]);
    for (let i = at + (replaceIdx >= 0 ? 1 : 0); i < day.stops.length && !anchor; i++) anchor = known(day.stops[i]);
    if (!anchor) continue;

    const pick = () => uniquePlaces(ctx.places)
      .filter((p) => RESTAURANT.test(p.category || '') && !NOT_MEAL.test(p.category || '') && !used.has(normKey(p.name)))
      .map((p) => ({ p, km: kmBetween(anchor, p) }))
      .filter((c) => c.km <= 20)
      .sort((a, b) => a.km - b.km)[0];

    let c = pick();
    if (!c) {
      const town = townOf(anchor.roadAddress || anchor.address) || '';
      const args = { region: input.region, keyword: `${town} 맛집`.trim(), display: 5, sort: 'comment' };
      const t0 = Date.now();
      const r = await executeTool('search_places', JSON.stringify(args), ctx);
      emit({ kind: 'tool', name: 'search_places', title: 'search_places (서버 보완)', detail: describeArgs('search_places', r.args), summary: r.summary, args: r.args, status: r.isError ? 'error' : 'ok', ms: Date.now() - t0 });
      c = pick();
    }
    if (!c) {
      emit({ kind: 'system', title: '식사 보완', summary: `Day ${gap.day} ${gap.meal}: 근처 식당을 찾지 못해 비워 둠`, status: 'warn' });
      continue;
    }
    const prevTime = replaceIdx >= 0 ? day.stops[replaceIdx].time : MEAL_TIME[gap.meal];
    const stop = {
      time: prevTime, name: c.p.name, meal: gap.meal, category: c.p.category || '음식점',
      address: c.p.roadAddress || c.p.address || null, lat: c.p.lat, lng: c.p.lng,
      description: `${anchor.name}에서 가까운 식당이에요(직선 약 ${c.km.toFixed(1)}km). Agent 일정에 ${gap.meal}이 빠져 서버가 NAVER 검색 결과로 보완했어요.`,
      placeSource: 'search_places', cost: { amount: null, status: 'unknown', basis: null }, serverFilled: true,
    };
    if (replaceIdx >= 0) day.stops[replaceIdx] = stop;
    else day.stops.splice(insertIdx, 0, stop);
    used.add(normKey(c.p.name));
    emit({ kind: 'system', title: '식사 보완', summary: `Day ${gap.day} ${gap.meal}: ${c.p.name} (${anchor.name}에서 약 ${c.km.toFixed(1)}km) 추가`, status: 'warn' });
  }
}
const normKey = (s) => String(s || '').replace(/\s|\(.*?\)/g, '');
const uniquePlaces = (list) => [...new Map(list.filter((p) => p.lat !== null).map((p) => [normKey(p.name), p])).values()];
// 주소에서 읍·면·동 (없으면 시·군·구)
function townOf(addr = '') {
  const t = addr.split(/\s+/);
  return t.find((w) => /(읍|면|동|가)$/.test(w) && w.length > 1) || t.find((w) => /(시|군|구)$/.test(w) && !/특별|광역/.test(w)) || '';
}

// 좌표는 있는데 이름이 근처 검색 결과와 맞지 않는 장소 (근처 후보 이름 포함)
function findNameMismatches(plan, ctx) {
  const list = [];
  for (const day of plan.days || []) {
    for (const s of day.stops) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
      if (findKnownPlace(ctx, s.lat, s.lng, s.name)) continue;
      list.push({ name: s.name, candidates: nearbyPlaces(ctx, s.lat, s.lng).map((p) => p.name).slice(0, 3) });
    }
  }
  return list;
}

function findUncheckedLegs(plan, ctx) {
  const legs = [];
  for (const day of plan.days || []) {
    const pts = day.stops.map((s) => {
      const k = findKnownPlace(ctx, s.lat, s.lng, s.name);
      return k ? { name: s.name, lat: k.lat, lng: k.lng } : null;
    });
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      if (a && b && (a.lat !== b.lat || a.lng !== b.lng) && !findRoute(ctx, a, b)) legs.push({ from: a, to: b });
    }
  }
  return legs;
}

/* ───────── 후처리: Tool 결과로 검증된 값만 남기기 ───────── */
function findRoute(ctx, a, b) {
  const near = (p, q) => Math.abs(p.lat - q.lat) < 0.0002 && Math.abs(p.lng - q.lng) < 0.0002;
  for (const [key, r] of ctx.routes) {
    const [o, d] = key.split('>').map((s) => {
      const [lng, lat] = s.split(',').map(Number);
      return { lat, lng };
    });
    if (near(o, a) && near(d, b)) return r;
  }
  return null;
}

// 제목에 섞인 내부 작업 표현 제거: "(업데이트)", "— 경로 보완 완료", "[수정]" 등
const WORK_WORDS = '업데이트|보완|수정|재작성|검토|반영|갱신|최종';
export function cleanTitle(title) {
  const t = String(title || '')
    .replace(new RegExp(`\\s*[(\\[][^)\\]]*(${WORK_WORDS})[^)\\]]*[)\\]]`, 'g'), '')
    .replace(new RegExp(`\\s*[—–-]\\s*[^—–-]*(${WORK_WORDS})[^—–-]*$`), '')
    .trim();
  return t || String(title || '').trim();
}

export function postProcess(plan, input, ctx, emit) {
  const dates = tripDates(input.startDate, input.nights);
  let droppedCoords = 0;
  let droppedPrices = 0;
  let checkedLegs = 0;
  let uncheckedLegs = 0;

  plan.days = plan.days.map((day, di) => {
    const stops = day.stops.map((s) => {
      // 1) 좌표: search_places에서 확인된 장소만 유지
      const known = findKnownPlace(ctx, s.lat, s.lng, s.name);
      if (!known && (s.lat !== null || s.lng !== null)) droppedCoords++;
      // 2) 비용: 근거를 확인할 수 없는 금액은 미확인으로
      const v = verifyPrice(ctx, { amount: s.cost.amount, status: s.cost.status, source: s.cost.basis });
      if (v.dropped) droppedPrices++;
      const cost = { ...s.cost, amount: v.amount, status: v.status, ...(v.dropped && { basis: null }) };
      return {
        ...s,
        lat: known ? known.lat : null,
        lng: known ? known.lng : null,
        address: s.address || known?.roadAddress || known?.address || null,
        coordVerified: Boolean(known),
        // 출처: NAVER 지역 검색 결과 (검색어, 상세 링크)
        source: known ? { type: 'naver_local', name: known.name, query: known.query, link: known.link || null, category: known.category } : null,
        cost,
      };
    });

    // 3) 이동시간: get_routes로 실제 확인한 구간만 표시
    stops.forEach((s, i) => {
      const next = stops[i + 1];
      if (!next) return (s.routeToNext = null);
      const r = s.coordVerified && next.coordVerified ? findRoute(ctx, s, next) : null;
      if (r) checkedLegs++;
      else uncheckedLegs++;
      s.routeToNext = r
        ? { status: r.status, distanceKm: r.distanceKm, durationMin: r.durationMin, includesFerry: r.includesFerry ?? false, tollFare: r.tollFare, fuelPrice: r.fuelPrice, reason: r.reason, path: r.path || null }
        : { status: 'not_checked' };
    });

    return { ...day, day: di + 1, date: dates[di] || day.date, stops };
  });

  if (droppedCoords) {
    emit({ kind: 'system', title: '좌표 검증', summary: `검색으로 확인되지 않은 좌표 ${droppedCoords}개를 지도에서 제외`, status: 'warn' });
  }
  if (droppedPrices) {
    emit({ kind: 'system', title: '가격 검증', summary: `근거를 확인할 수 없는 일정 가격 ${droppedPrices}개를 미확인으로 변경`, status: 'warn' });
  }
  emit({ kind: 'system', title: '이동시간 검증', summary: `get_routes로 확인된 구간 ${checkedLegs}개 · 미확인 구간 ${uncheckedLegs}개`, status: 'ok' });

  // 4) 예산: Agent가 calculate_budget을 호출했으면 그 결과, 아니면 일정의 비용 항목으로 서버에서 계산
  let budget = ctx.budget;
  let budgetSource = 'agent';
  if (!budget) {
    budgetSource = 'server';
    const categoryOf = (c = '') =>
      /숙박|호텔|숙소/.test(c) ? '숙박비' : /맛집|식|카페|음식/.test(c) ? '식비' : /교통|주차/.test(c) ? '교통비' : '관광비';
    const lodgings = ctx.lodgings || [];
    const items = plan.days.flatMap((d) =>
      d.stops
        .filter((s) => !s.meal)                                                         // 식사는 아래 식비 항목으로
        .filter((s) => !(lodgings.length && LODGING_PLACE.test(`${s.category || ''} ${s.name}`))) // 조사한 숙소는 아래 숙박 항목으로
        .filter((s) => s.cost.status !== 'unknown' || /맛집|식|카페|숙박|음식/.test(s.category))
        .map((s) => ({
          name: `Day${d.day} ${s.name}`, category: categoryOf(s.category),
          amount: s.cost.amount, status: s.cost.status,
          source: s.cost.basis || (s.menuPrices ? `메뉴판 참고: ${menuText(s.menuPrices.menus)} (${s.menuPrices.source})` : null),
        })),
    );
    const legs = plan.days.flatMap((d) => d.stops.map((s) => s.routeToNext).filter((r) => r?.status === 'ok'));
    const fuel = legs.reduce((sum, r) => sum + (r.fuelPrice || 0), 0);
    const toll = legs.reduce((sum, r) => sum + (r.tollFare || 0), 0);
    items.push(...mealBudgetItems(plan), ...lodgingBudgetItems(lodgings));
    if (fuel) items.push({ name: '유류비 (확인된 구간 합계)', category: '교통비', amount: fuel, status: 'estimated', source: 'NAVER Directions fuelPrice' });
    if (toll) items.push({ name: '통행료 (확인된 구간 합계)', category: '교통비', amount: toll, status: 'estimated', source: 'NAVER Directions tollFare' });
    budget = calculate_budget({ totalBudget: input.budget, people: input.people, items });
    emit({
      kind: 'system', name: 'calculate_budget', title: '예산 후처리',
      summary: `Agent가 예산 계산을 하지 않아 일정의 비용 항목으로 계산: 계획 ${won(budget.plannedTotal)} · 잔여 ${won(budget.remaining)}`,
      status: 'ok',
    });
  }

  return {
    ...plan,
    title: cleanTitle(plan.title),
    budget,
    budgetSource,
    searchLog: ctx.searches,                                        // NAVER 지역 검색 기록
    routeCount: [...ctx.routes.values()].filter((r) => r.status === 'ok').length, // NAVER Directions 조회 성공 구간
  };
}
