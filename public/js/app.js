// 화면 이벤트와 흐름 제어 — POST /api/plan (AI Agent) 결과를 스트리밍으로 받아 표시
import { renderMap, loadNaverMaps } from './map.js';
import { initPlaceSearch } from './places.js';
import { authHeaders, getPassword, setPassword, fetchPasswordRequired } from './api.js';
import {
  won, addDays, formatDate, esc,
  renderSummary, renderDayTabs, renderItinerary, renderBudget, renderSources,
  clearLog, appendTrace, setPending, resetTraceSummary,
} from './render.js';

const $ = (id) => document.getElementById(id);
const form = $('plan-form');

// NAVER 지도 SDK 미리 로드 (실패해도 미리보기 지도로 대체)
loadNaverMaps().catch(() => {});

// 접속 비밀번호: 서버가 요구하면 입력칸 표시, 이 탭에서 입력한 값 복원
fetchPasswordRequired().then((required) => {
  if (!required) return;
  $('pw-field').hidden = false;
  $('app-password').value = getPassword();
});
$('app-password').addEventListener('input', (e) => setPassword(e.target.value));
// 비밀번호 오류(401) 시 입력칸으로 안내
function askPassword(message) {
  $('pw-field').hidden = false;
  $('pw-field').classList.add('is-error');
  $('app-password').focus();
  return message;
}
$('app-password').addEventListener('input', () => $('pw-field').classList.remove('is-error')); // 다시 입력하면 오류 표시 해제

// Agent Trace 필터: 전체 / Tool만
$('trace-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  $('trace-filter').querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === btn));
  $('agent-log').classList.toggle('tools-only', btn.dataset.filter === 'tools');
});

/* ───────── 입력 보조 ───────── */
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
$('startDate').min = toISO(today);
$('startDate').value = toISO(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14));

const parseBudget = () => Number($('budget').value.replace(/[^\d]/g, '')) || 0;

function updateHints() {
  const start = $('startDate').value;
  const nights = Number($('nights').value);
  $('date-hint').textContent = start
    ? `${formatDate(addDays(start, 0))} ~ ${formatDate(addDays(start, nights))}`
    : '출발일을 선택해 주세요.';
  const people = Math.max(1, Number($('people').value) || 1);
  $('budget-hint').textContent = `1인당 약 ${won(parseBudget() / people)}`;
}

$('region-suggest').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-region]');
  if (chip) $('region').value = chip.dataset.region;
});

document.querySelectorAll('.stepper button').forEach((btn) =>
  btn.addEventListener('click', () => {
    const input = $('people');
    input.value = Math.min(20, Math.max(1, (Number(input.value) || 1) + Number(btn.dataset.step)));
    updateHints();
  }),
);

$('budget').addEventListener('input', (e) => {
  const n = parseBudget();
  e.target.value = n ? n.toLocaleString() : '';
  updateHints();
});

$('prefs').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    chip.classList.toggle('is-on');
    chip.setAttribute('aria-pressed', chip.classList.contains('is-on'));
  }
});

['startDate', 'nights', 'people'].forEach((id) => $(id).addEventListener('input', updateHints));
updateHints();
initPlaceSearch();

/* ───────── 폼 → 입력값 ───────── */
function readInput() {
  return {
    region: $('region').value.trim(),
    startDate: $('startDate').value,
    nights: Number($('nights').value),
    people: Math.max(1, Number($('people').value) || 1),
    budget: parseBudget(),
    prefs: [...document.querySelectorAll('#prefs .chip.is-on')].map((c) => c.dataset.value),
    transport: form.querySelector('input[name="transport"]:checked').value,
    request: $('request').value.trim(),
  };
}

function validate(input) {
  if (!input.region) return '여행 지역을 입력해 주세요.';
  if (!input.startDate) return '출발일을 선택해 주세요.';
  if (input.budget < 10000) return '총예산을 1만 원 이상으로 입력해 주세요.';
  if (input.request.length > 500) return '추가 요청은 500자 이내로 입력해 주세요.';
  return null;
}

/* ───────── 결과 표시 ───────── */
let state = null;

function renderPlan() {
  const { plan, activeDay } = state;
  renderDayTabs($('day-tabs'), plan.days, activeDay, (id) => {
    state.activeDay = id;
    renderPlan();
  });
  renderItinerary($('itinerary'), plan.days, activeDay);
  renderMap($('map'), plan.days, activeDay);
}

function showError(message) {
  $('summary').innerHTML = `<div class="ps-error">⚠️ ${esc(message)}</div>`;
}

/* ───────── Agent 실행 (NDJSON 스트림) ───────── */
let controller = null;

async function runAgent(input, onTrace) {
  controller?.abort();
  controller = new AbortController();

  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders($('app-password').value) },
    body: JSON.stringify(input),
    signal: controller.signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error(askPassword(data.error || '접속 비밀번호를 확인해 주세요.'));
    throw new Error(data.error || `서버 오류 (HTTP ${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let plan = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === 'trace') onTrace(msg.item);
      else if (msg.type === 'done') plan = msg.plan;
      else if (msg.type === 'error') throw new Error(msg.message);
    }
  }
  if (!plan) throw new Error('Agent가 일정을 완성하지 못했어요. 다시 시도해 주세요.');
  return plan;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = readInput();
  const error = validate(input);
  if (error) {
    alert(error);
    return;
  }

  const btn = $('submit-btn');
  const logEl = $('agent-log');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Agent가 일정을 짜는 중…';
  $('summary').innerHTML = '<p class="empty">🤖 Agent가 필요한 Tool을 골라 실행하고 있어요. 30초~1분 정도 걸려요.</p>';
  clearLog(logEl);
  resetTraceSummary($('trace-summary'));
  setPending(logEl, true, 'LLM이 요청을 분석하는 중…');
  $('results').scrollIntoView({ behavior: 'smooth' });

  try {
    const plan = await runAgent(input, (t) => {
      appendTrace(logEl, t, $('trace-summary'));
      setPending(logEl, true, t.kind === 'llm' && t.summary.startsWith('Tool') ? 'Tool 실행 중…' : 'Agent가 다음 행동을 고르는 중…');
    });
    state = { input, plan, activeDay: 'all' };
    renderSummary($('summary'), input, plan);
    renderBudget($('budget-view'), plan.budget, plan.budgetSource);
    renderSources($('sources-view'), plan);
    renderPlan();
  } catch (err) {
    if (err.name !== 'AbortError') showError(err.message);
  } finally {
    setPending(logEl, false);
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">🔄 다시 만들기</span>';
  }
});
