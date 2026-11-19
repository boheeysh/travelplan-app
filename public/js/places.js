// [Level 2] 장소 검색 UI — /api/places 호출 결과를 그대로 표시
// API가 제공하지 않는 정보(영업시간·평점·가격 등)는 표시하지 않습니다.
import { esc } from './render.js';

const $ = (id) => document.getElementById(id);

function placeCard(p, i) {
  const coord = p.lat !== null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '좌표 없음';
  const safeLink = /^https?:\/\//.test(p.link) ? p.link : '';
  return `
    <article class="place">
      <div class="place-name"><span class="idx">${i + 1}</span>${esc(p.name)}</div>
      ${p.category ? `<span class="cat">${esc(p.category)}</span>` : ''}
      <div class="place-addr">
        ${esc(p.roadAddress || p.address)}
        ${p.roadAddress && p.address ? `<small>지번 ${esc(p.address)}</small>` : ''}
      </div>
      ${p.description ? `<p class="desc" style="margin:0;font-size:.85rem;color:var(--muted)">${esc(p.description)}</p>` : ''}
      <div class="place-foot">
        <span title="WGS84 위도, 경도">📍 ${coord}</span>
        ${safeLink ? `<a href="${esc(safeLink)}" target="_blank" rel="noopener noreferrer">상세 보기 ↗</a>` : ''}
      </div>
    </article>`;
}

async function search() {
  const region = $('region').value.trim();
  const keyword = $('ps-keyword').value.trim();
  const sort = $('ps-sort').value;
  const out = $('ps-results');
  const btn = $('place-form').querySelector('button[type=submit]');

  if (!region && !keyword) {
    out.innerHTML = '<div class="ps-error">여행 지역이나 키워드를 입력해 주세요.</div>';
    return;
  }

  btn.disabled = true;
  out.innerHTML = '<div class="ps-loading"><span class="spinner"></span>NAVER에서 검색하는 중…</div>';

  try {
    const params = new URLSearchParams({ region, keyword, sort });
    const res = await fetch(`/api/places?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '검색에 실패했어요.');

    out.innerHTML = data.places.length
      ? `<p class="ps-meta">“${esc(data.query)}” 검색 결과 ${data.places.length}곳 (전체 ${data.total.toLocaleString()}건 중 상위 ${data.places.length}건)</p>
         <div class="ps-grid">${data.places.map(placeCard).join('')}</div>`
      : `<p class="ps-meta">“${esc(data.query)}” 검색 결과가 없어요. 다른 키워드로 찾아보세요.</p>`;
  } catch (err) {
    out.innerHTML = `<div class="ps-error">⚠️ ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

export function initPlaceSearch() {
  const syncRegion = () => ($('ps-region').textContent = $('region').value.trim() || '지역 미입력');
  $('region').addEventListener('input', syncRegion);
  $('region-suggest').addEventListener('click', () => setTimeout(syncRegion));
  syncRegion();

  $('place-form').addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });
  $('ps-keywords').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-keyword]');
    if (!chip) return;
    $('ps-keyword').value = chip.dataset.keyword;
    search();
  });
}
