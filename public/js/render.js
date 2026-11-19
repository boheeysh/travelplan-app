// 결과 화면 렌더링 (Agent 결과 → HTML)
// 이동시간·가격은 서버가 Tool 결과로 검증한 값만 표시합니다.
import { DAY_COLORS } from './map.js';

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const STATUS_LABEL = { confirmed: '확인됨', estimated: '추정치', unknown: '미확인' };

export const won = (n) => `${Math.round(n).toLocaleString()}원`;

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d + n);
}

export function formatDate(date, withYear = false) {
  const base = `${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEK[date.getDay()]})`;
  return withYear ? `${date.getFullYear()}년 ${base}` : base;
}

export function tripLabel(nights) {
  return nights === 0 ? '당일치기' : `${nights}박 ${nights + 1}일`;
}

const safeUrl = (u) => (/^https?:\/\//.test(u || '') ? u : '');

/* ───────── 요약 ───────── */
export function renderSummary(el, input, plan) {
  const end = addDays(input.startDate, input.nights);
  const tags = [`👥 ${input.people}명`, `💰 ${won(input.budget)}`, `🚗 ${input.transport}`, ...input.prefs.map((p) => `#${p}`)];
  const m = plan.meta || {};
  el.innerHTML = `
    <h2>${esc(plan.title)}</h2>
    <p class="sub">${formatDate(addDays(input.startDate, 0), true)} ~ ${formatDate(end)} · ${tripLabel(input.nights)}</p>
    <div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <p class="overview">${esc(plan.overview)}</p>
    ${plan.notes?.length ? `
      <details class="notes" open>
        <summary>📌 확인이 필요한 내용 ${plan.notes.length}개</summary>
        <ul>${plan.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </details>` : ''}
    <p class="meta-line">${esc(m.model)} · LLM 판단 ${m.iterations}회 · Tool 호출 ${m.toolCalls}회 · ${((m.elapsedMs || 0) / 1000).toFixed(0)}초</p>`;
}

/* ───────── 날짜 탭 ───────── */
export function renderDayTabs(el, days, active, onChange) {
  const tabs = [{ id: 'all', label: '전체 일정' }].concat(
    days.map((d, i) => {
      const md = /^\d{4}-(\d{2})-(\d{2})\s*(\(.\))?/.exec(d.date || '');
      return { id: i, label: `Day ${i + 1}${md ? ` · ${Number(md[1])}/${Number(md[2])} ${md[3] || ''}` : ''}`, color: DAY_COLORS[i % DAY_COLORS.length] };
    }),
  );
  el.innerHTML = tabs
    .map((t) => `<button type="button" role="tab" class="day-tab ${t.id === active ? 'is-on' : ''}" data-day="${t.id}">
      ${t.color ? `<span class="dot" style="background:${t.color}"></span>` : ''}${esc(t.label)}</button>`)
    .join('');
  el.onclick = (e) => {
    const btn = e.target.closest('.day-tab');
    if (!btn) return;
    onChange(btn.dataset.day === 'all' ? 'all' : Number(btn.dataset.day));
  };
}

/* ───────── 날짜별 일정 ───────── */
function costBadge(cost) {
  if (!cost || cost.status === 'unknown' || cost.amount === null) return '<span class="cost unknown">💳 가격 미확인</span>';
  const title = cost.basis ? ` title="근거: ${esc(cost.basis)}"` : '';
  const badge = `<span class="cost ${cost.status}"${title}>💳 ${cost.amount === 0 ? '무료' : won(cost.amount)} · ${STATUS_LABEL[cost.status]}</span>`;
  if (!cost.basis) return badge;
  // 웹 검색 가격: 근거(메뉴 × 인원)와 출처 링크를 함께 표시
  const basis = esc(cost.basis);
  return safeUrl(cost.url)
    ? `${badge}<a class="price-src" href="${esc(cost.url)}" target="_blank" rel="noopener noreferrer">${basis} ↗</a>`
    : `${badge}<span class="price-src">${basis}</span>`;
}

// 가격 표시: Agent가 확인한 금액 > 숙소 요금(웹 검색) > 메뉴판 단가(웹 검색) > 미확인
function priceArea(s) {
  const unknown = !s.cost || s.cost.status === 'unknown' || s.cost.amount === null;
  if (!unknown) return costBadge(s.cost);
  if (s.lodgingPrice) return lodgingBadge(s.lodgingPrice);
  if (s.menuPrices) return menuBadge(s.menuPrices);
  return costBadge(s.cost);
}

// 숙소 1박 요금 (웹 검색 · 추정치)
function lodgingBadge(lp) {
  const src = safeUrl(lp.url)
    ? `<a class="price-src" href="${esc(lp.url)}" target="_blank" rel="noopener noreferrer">웹 검색 · ${esc(lp.source)} ↗</a>`
    : `<span class="price-src">웹 검색 · ${esc(lp.source)}</span>`;
  const title = `${lp.roomType || '기본 객실'}${lp.note ? ` · ${lp.note}` : ''} · 객실 1개 기준, 날짜·객실별로 다름`;
  return `<span class="cost estimated" title="${esc(title)}">🛏 1박 약 ${won(lp.price)} · 추정치</span>${src}`;
}

// 메뉴판 단가 (웹 검색) — 1인분 금액이 아니라 메뉴판에 적힌 가격 그대로
function menuBadge(mp) {
  const items = mp.menus
    .map((m) => `<li>${esc(m.name)}${m.unit ? ` <small>${esc(m.unit)}</small>` : ''} <b>${won(m.price)}</b></li>`)
    .join('');
  const src = safeUrl(mp.url)
    ? `<a href="${esc(mp.url)}" target="_blank" rel="noopener noreferrer">${esc(mp.source)} ↗</a>`
    : esc(mp.source);
  return `<div class="menu-board"><span class="menu-head">📋 메뉴판 가격 <small>웹 검색 · ${src}</small></span><ul>${items}</ul></div>`;
}

function sourceBadge(s) {
  if (!s.coordVerified || !s.source) return '<span class="unverified">📍 위치 미확인</span>';
  const label = `📍 NAVER 검색: ${esc(s.source.name)}`;
  return safeUrl(s.source.link)
    ? `<a class="verified" href="${esc(s.source.link)}" target="_blank" rel="noopener noreferrer" title="장소 상세 링크 (검색 결과 제공)">${label} ↗</a>`
    : `<span class="verified">${label}</span>`;
}

function driveLine(r) {
  if (!r || r.status === 'same_place') return '';
  if (r.status === 'ok') {
    return `<li class="drive ok">🚗 다음 장소까지 ${r.distanceKm}km · 약 ${r.durationMin}분${r.includesFerry ? ' <span class="ferry">⛴ 페리 포함 · 배편 별도 확인</span>' : ''} <span class="src">NAVER 경로</span></li>`;
  }
  if (r.status === 'not_checked') return '<li class="drive muted">🚗 이동시간 미확인</li>';
  return `<li class="drive warn">🚗 자동차 경로 확인 불가${r.reason ? ` · ${esc(r.reason)}` : ''}</li>`;
}

export function renderItinerary(el, days, active) {
  el.innerHTML = days
    .map((day, i) => ({ day, i }))
    .filter(({ i }) => active === 'all' || i === active)
    .map(({ day, i }) => {
      const color = DAY_COLORS[i % DAY_COLORS.length];
      const stops = day.stops
        .map((s, n) => `
          <li class="stop">
            <span class="time">${esc(s.time)}</span>
            <span class="rail"><span class="num" style="background:${s.coordVerified ? color : '#b5bdcc'}">${n + 1}</span></span>
            <div class="body">
              <div class="title">${s.meal ? `<span class="meal">🍽 ${esc(s.meal)}</span>` : ''}${esc(s.name)} <span class="cat">${esc(s.category)}</span></div>
              ${s.address ? `<p class="addr">${esc(s.address)}</p>` : ''}
              <p class="desc"><span class="why">추천 이유</span>${esc(s.description)}</p>
              <div class="meta">
                ${priceArea(s)}
                ${sourceBadge(s)}
              </div>
            </div>
          </li>
          ${driveLine(s.routeToNext)}`)
        .join('');
      return `
        <section class="day-block">
          <div class="day-head">
            <strong style="color:${color}">Day ${i + 1}</strong>
            <span>${esc(day.date)} · ${esc(day.theme)}</span>
          </div>
          <ol class="timeline">${stops}</ol>
        </section>`;
    })
    .join('');
}

/* ───────── 예산 (calculate_budget 결과) ───────── */
const CAT_COLOR = { 숙박비: '#3b6cf6', 식비: '#ff7a59', 교통비: '#12b886', 관광비: '#a855f7', 기타: '#94a3b8' };

// "30000", "30,000원", "3만", "1만5천", "2.5만" → 원 단위 숫자
export function parseWon(text) {
  const t = String(text || '').replace(/[,\s원]/g, '');
  if (!t) return 0;
  if (/[만천]/.test(t)) {
    const m = /^(?:(\d+(?:\.\d+)?)만)?(?:(\d+(?:\.\d+)?)천)?(\d*)$/.exec(t);
    if (!m) return 0;
    return Math.round((Number(m[1] || 0) * 10000) + (Number(m[2] || 0) * 1000) + Number(m[3] || 0));
  }
  return Math.min(Number(t.replace(/[^\d]/g, '').slice(0, 10)) || 0, 9_999_999_999);
}

// 미확인 항목은 예상 비용 칸에 금액을 직접 입력 → 합계·잔여 예산·막대를 브라우저에서 다시 계산
// (서버 계산 결과 b는 그대로 두고, 직접 입력 금액만 더함)
export function renderBudget(el, b, source) {
  const order = Object.keys(CAT_COLOR);
  const rows = [...b.items].sort((x, y) => order.indexOf(x.category) - order.indexOf(y.category));
  const manual = new Map(); // 행 번호 → 직접 입력 금액(총액)

  el.innerHTML = `
    <div class="budget-total" data-part="total"></div>
    <div class="stack" aria-hidden="true" data-part="stack"></div>
    <div class="table-wrap">
      <table class="budget-table">
        <thead><tr><th>분류</th><th>항목</th><th>상태</th><th class="num">예상 비용</th></tr></thead>
        <tbody>
          ${rows.map((it, i) => `
            <tr data-row="${i}">
              <td><span class="sw" style="background:${CAT_COLOR[it.category] || '#94a3b8'}"></span>${esc(it.category)}</td>
              <td>${esc(it.name)}${it.source ? `<small>${esc(it.source)}</small>` : ''}</td>
              <td><span class="st ${it.status}" data-part="status">${STATUS_LABEL[it.status]}</span></td>
              <td class="num">${it.total === null
                ? `<label class="manual-input"><input type="text" inputmode="numeric" placeholder="예: 3만" aria-label="${esc(it.name)} 금액 직접 입력" data-row="${i}" /><span>원</span></label>`
                : won(it.total)}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="empty">비용 항목이 없어요.</td></tr>'}
        </tbody>
        <tfoot data-part="foot"></tfoot>
      </table>
    </div>
    <div class="budget-warn" data-part="unknown"></div>
    ${b.warnings
      .filter((w) => !/합계에 포함되지/.test(w)) // 미확인 개수 안내는 아래에서 입력에 맞춰 다시 씀
      .map((w) => `<div class="budget-warn">⚠️ ${esc(w)}</div>`).join('')}
    <p class="meta-line">${source === 'agent' ? 'Agent가 calculate_budget Tool로 계산' : 'Agent가 예산 Tool을 쓰지 않아 일정 비용으로 서버에서 계산'}${rows.some((it) => it.total === null) ? ' · 미확인 항목은 금액을 직접 입력할 수 있어요 (전체 인원 기준 총액)' : ''}</p>`;

  const part = (name) => el.querySelector(`[data-part="${name}"]`);

  function update() {
    const manualSum = [...manual.values()].reduce((s, v) => s + v, 0);
    const planned = b.plannedTotal + manualSum;
    const remaining = b.totalBudget - planned;
    const usage = b.totalBudget ? Math.round((planned / b.totalBudget) * 1000) / 10 : 0;
    const unknownLeft = rows.filter((it, i) => it.total === null && !manual.has(i)).length;

    // 분류별 소계 (+ 직접 입력)
    const sub = Object.fromEntries(Object.entries(b.byCategory).map(([k, c]) => [k, c.subtotal]));
    manual.forEach((v, i) => (sub[rows[i].category] = (sub[rows[i].category] || 0) + v));
    const base = Math.max(b.totalBudget, planned) || 1;

    part('total').innerHTML = `
      <div><small>잔여 예산</small><strong class="${remaining < 0 ? 'over' : ''}">${won(remaining)}</strong></div>
      <span>총 ${won(b.totalBudget)} 중 ${usage}% 사용</span>`;
    part('stack').innerHTML = order
      .filter((k) => sub[k] > 0)
      .map((k) => `<div style="width:${(sub[k] / base) * 100}%;background:${CAT_COLOR[k]}"></div>`)
      .join('');
    part('foot').innerHTML = `
      <tr><th colspan="3">확인된 금액</th><td class="num">${won(b.confirmedTotal)}</td></tr>
      <tr><th colspan="3">추정치</th><td class="num">${won(b.estimatedTotal)}</td></tr>
      ${manualSum ? `<tr><th colspan="3">직접 입력</th><td class="num">${won(manualSum)}</td></tr>` : ''}
      <tr><th colspan="3">예상 비용 합계</th><td class="num"><b>${won(planned)}</b></td></tr>
      <tr><th colspan="3">총예산</th><td class="num">${won(b.totalBudget)}</td></tr>
      <tr class="remain ${remaining < 0 ? 'over' : ''}"><th colspan="3">잔여 예산</th><td class="num"><b>${won(remaining)}</b></td></tr>`;
    part('unknown').hidden = unknownLeft === 0;
    part('unknown').textContent = `⚠️ 금액이 비어 있는 미확인 항목 ${unknownLeft}개는 합계에 포함되지 않아 실제 잔여 예산은 더 적을 수 있어요.`;
  }

  el.querySelectorAll('.manual-input input').forEach((input) => {
    const i = Number(input.dataset.row);
    const status = el.querySelector(`tr[data-row="${i}"] [data-part="status"]`);
    input.addEventListener('blur', () => {
      const n = parseWon(input.value);
      input.value = n > 0 ? n.toLocaleString('ko-KR') : '';
    });
    input.addEventListener('input', () => {
      const n = parseWon(input.value);
      if (n > 0) manual.set(i, n);
      else manual.delete(i);
      status.className = `st ${n > 0 ? 'manual' : 'unknown'}`;
      status.textContent = n > 0 ? '직접 입력' : STATUS_LABEL.unknown;
      update();
    });
  });

  update();
}

/* ───────── 출처 ───────── */
export function renderSources(el, plan) {
  // 일정에 실제로 쓰인 NAVER 검색 장소
  const used = plan.days.flatMap((d) => d.stops.filter((s) => s.coordVerified && s.source).map((s) => ({ ...s, day: d.day })));
  const searches = plan.searchLog || [];
  const web = (plan.sources || []).filter((s) => safeUrl(s.url));

  el.innerHTML = `
    <div class="src-grid">
      <section>
        <h3>🔎 NAVER 지역 검색 <span class="count">${searches.length}회</span></h3>
        ${used.length ? `
          <ul class="src-list">
            ${used.map((s) => `<li>
              <span class="src-day">Day ${s.day}</span>
              ${safeUrl(s.source.link) ? `<a href="${esc(s.source.link)}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a>` : esc(s.name)}
              <small>검색 결과 “${esc(s.source.name)}” · 검색어 “${esc(s.source.query)}” · ${esc(s.source.category || '')}</small>
            </li>`).join('')}
          </ul>` : '<p class="muted">일정에 검색으로 확인된 장소가 없어요.</p>'}
        ${searches.length ? `<p class="meta-line">실행한 검색어: ${searches.map((q) => `“${esc(q.query)}”(${q.count})`).join(', ')}</p>` : ''}
      </section>
      <section>
        <h3>🚗 NAVER Directions 5 <span class="count">${plan.routeCount ?? 0}구간</span></h3>
        <p class="muted">이동 거리·시간·경로선은 NAVER Directions 자동차 경로 결과만 표시해요. 유류비·통행료는 API 추정치예요.</p>
      </section>
      <section>
        <h3>🌐 웹 검색 (OpenAI web_search) <span class="count">${web.length}건</span></h3>
        ${web.length ? `<ul class="src-list">${web.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || s.url)}</a><small>${esc(new URL(s.url).hostname)}</small></li>`).join('')}</ul>`
          : '<p class="muted">이번 일정에서는 Agent가 웹 검색이 필요하지 않다고 판단했어요.</p>'}
      </section>
    </div>`;
}

/* ───────── Agent Trace ───────── */
const traceCounts = {};

export function renderTraceSummary(el) {
  const entries = Object.entries(traceCounts);
  el.innerHTML = entries.length
    ? entries.map(([name, c]) => `<span class="tchip ${c.error ? 'has-error' : ''}">${TOOL_ICON[name] || '🌐'} ${esc(name)} <b>×${c.n}</b>${c.error ? ` <em>오류 ${c.error}</em>` : ''}</span>`).join('')
    : '<span class="muted">아직 호출된 Tool이 없어요.</span>';
}

export function resetTraceSummary(el) {
  Object.keys(traceCounts).forEach((k) => delete traceCounts[k]);
  renderTraceSummary(el);
}
const KIND_ICON = { llm: '🧠', tool: '🛠️', web_search: '🌐', system: '⚙️', error: '❌' };
const TOOL_ICON = { search_places: '🔎', get_routes: '🚗', calculate_budget: '💰' };

export function clearLog(el) {
  el.innerHTML = '';
}

export function appendTrace(el, t, summaryEl) {
  if (t.kind === 'tool' || t.kind === 'web_search') {
    const c = (traceCounts[t.name] ||= { n: 0, error: 0 });
    c.n++;
    if (t.status === 'error') c.error++;
    if (summaryEl) renderTraceSummary(summaryEl);
  }
  const li = document.createElement('li');
  li.className = `log-item ${t.kind} ${t.status || ''}`;
  const icon = t.status === 'error' ? '⚠️' : TOOL_ICON[t.name] || KIND_ICON[t.kind] || '•';
  const title = t.kind === 'tool' || t.kind === 'web_search' ? `<span class="log-tool">${esc(t.name)}</span>` : esc(t.title);
  li.innerHTML = `
    <span class="log-icon">${icon}</span>
    <div>
      <div class="log-title">${title}${t.detail ? ` <span class="log-args">${esc(t.detail)}</span>` : ''}</div>
      ${t.summary ? `<div class="log-detail">${esc(t.summary)}</div>` : ''}
      ${t.args ? `<details class="log-raw"><summary>호출 인자 보기</summary><pre>${esc(JSON.stringify(t.args, null, 2))}</pre></details>` : ''}
    </div>
    <span class="log-time">${t.ms !== undefined ? `${(t.ms / 1000).toFixed(1)}s` : ''}</span>`;
  const pending = el.querySelector('.log-pending');
  el.insertBefore(li, pending);
}

export function setPending(el, on, text = 'Agent가 다음 행동을 고르는 중…') {
  let p = el.querySelector('.log-pending');
  if (!on) return p?.remove();
  if (!p) {
    p = document.createElement('li');
    p.className = 'log-item log-pending';
    el.appendChild(p);
  }
  p.innerHTML = `<span class="log-icon"><span class="spinner dark"></span></span><div class="log-detail">${esc(text)}</div><span></span>`;
}
