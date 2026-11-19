// 지도 — NAVER Maps Web Dynamic Map (신규 ncpKeyId 인증)
//  - 마커: Agent가 search_places로 확인한 좌표만 표시
//  - 경로: get_routes(NAVER Directions)로 받은 실제 자동차 경로(path)만 그림
//  - NAVER 지도 인증 실패/로딩 실패 시 SVG 미리보기 지도로 대체
//  인증 오류가 나면 NCP 콘솔 > Maps Application > Web 서비스 URL에 http://localhost (포트 없이) 등록 필요

export const DAY_COLORS = ['#3b6cf6', '#ff7a59', '#12b886', '#a855f7'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ───────── NAVER Maps SDK 로딩 ───────── */
let sdkPromise = null;
let authFailed = false;
let failReason = '';

export function loadNaverMaps() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    const res = await fetch('/api/maps/client-id');
    const { clientId } = await res.json();
    if (!clientId) throw new Error('NAVER_MAPS_CLIENT_ID가 설정되지 않았습니다.');

    // 인증 실패 시 NAVER SDK가 호출하는 전역 함수
    window.navermap_authFailure = () => {
      authFailed = true;
      failReason = location.hostname === 'localhost'
        ? `NAVER 지도 인증 실패 — http://127.0.0.1:${location.port || 80} 주소로 열어 보세요.`
        : 'NAVER 지도 인증 실패 — NCP 콘솔의 Web 서비스 URL 등록을 확인해 주세요.';
      window.dispatchEvent(new Event('navermap-auth-failure'));
    };

    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(clientId)}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('NAVER 지도 스크립트를 불러오지 못했습니다.'));
      document.head.appendChild(s);
    });
    if (!window.naver?.maps) throw new Error('NAVER 지도 SDK 초기화 실패');
    return window.naver.maps;
  })();
  sdkPromise.catch((err) => {
    failReason = err.message;
  });
  return sdkPromise;
}

/* ───────── 지도 렌더링 ───────── */
let map = null;
let overlays = [];
let infoWindow = null;
let lastArgs = null;

function visibleDays(days, activeDay) {
  return days
    .map((day, i) => ({
      ...day,
      index: i,
      stops: day.stops.map((s, n) => ({ ...s, n })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)),
      allStops: day.stops,
    }))
    .filter((d) => activeDay === 'all' || d.index === activeDay);
}

function markerHtml(color, label, dim) {
  return `<div class="nmarker" style="background:${color};${dim ? 'opacity:.55' : ''}">${label}</div>`;
}

export async function renderMap(container, days, activeDay = 'all') {
  lastArgs = [container, days, activeDay];
  if (authFailed) return renderPreviewMap(container, days, activeDay, failReason);

  let nmaps;
  try {
    nmaps = await loadNaverMaps();
  } catch (err) {
    return renderPreviewMap(container, days, activeDay, err.message);
  }
  if (authFailed) return renderPreviewMap(container, days, activeDay, failReason);

  const groups = visibleDays(days, activeDay);
  const points = groups.flatMap((g) => g.stops);
  if (!points.length) {
    map = null;
    container.innerHTML = '<p class="empty">위치가 확인된 장소가 없어요.</p>';
    return;
  }

  // 지도 생성 (컨테이너가 바뀌었으면 새로 만듦)
  if (!map || !container.querySelector('.nmap')) {
    container.innerHTML = '<div class="nmap"></div><div class="map-legend" id="map-legend"></div>';
    map = new nmaps.Map(container.querySelector('.nmap'), {
      zoomControl: true,
      zoomControlOptions: { position: nmaps.Position.TOP_RIGHT, style: nmaps.ZoomControlStyle.SMALL },
      mapDataControl: false,
      scaleControl: true,
    });
    infoWindow = new nmaps.InfoWindow({ borderWidth: 0, backgroundColor: 'transparent', disableAnchor: true, pixelOffset: new nmaps.Point(0, -8) });
  }

  overlays.forEach((o) => o.setMap(null));
  overlays = [];
  infoWindow.close();

  const bounds = new nmaps.LatLngBounds();
  let routeLegs = 0;
  let missingLegs = 0;

  for (const g of groups) {
    const color = DAY_COLORS[g.index % DAY_COLORS.length];

    // 실제 자동차 경로 (NAVER Directions path)
    g.allStops.forEach((s) => {
      const r = s.routeToNext;
      if (!r) return;
      if (r.status === 'ok' && Array.isArray(r.path) && r.path.length > 1) {
        const path = r.path.map(([lng, lat]) => new nmaps.LatLng(lat, lng));
        overlays.push(new nmaps.Polyline({ map, path, strokeColor: color, strokeWeight: 5, strokeOpacity: 0.8, strokeLineCap: 'round', strokeLineJoin: 'round' }));
        path.forEach((p) => bounds.extend(p));
        routeLegs++;
      } else if (r.status !== 'same_place') {
        missingLegs++;
      }
    });

    // 마커
    for (const s of g.stops) {
      const pos = new nmaps.LatLng(s.lat, s.lng);
      bounds.extend(pos);
      const marker = new nmaps.Marker({
        map,
        position: pos,
        title: s.name,
        icon: { content: markerHtml(color, s.n + 1), anchor: new nmaps.Point(14, 14) },
        zIndex: 100 + s.n,
      });
      nmaps.Event.addListener(marker, 'click', () => {
        infoWindow.setContent(`
          <div class="ninfo">
            <div class="ninfo-day" style="color:${color}">Day ${g.index + 1} · ${esc(s.time)}</div>
            <strong>${esc(s.name)}</strong>
            ${s.address ? `<div class="ninfo-addr">${esc(s.address)}</div>` : ''}
          </div>`);
        infoWindow.open(map, marker);
      });
      overlays.push(marker);
    }
  }

  map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
  if (points.length === 1) map.setZoom(15);

  const legend = container.querySelector('#map-legend');
  legend.innerHTML = `
    ${groups.map((g) => `<span><i style="background:${DAY_COLORS[g.index % DAY_COLORS.length]}"></i>Day ${g.index + 1}</span>`).join('')}
    <span class="muted">실제 자동차 경로 ${routeLegs}구간${missingLegs ? ` · 경로 미확인 ${missingLegs}구간(선 없음)` : ''}</span>`;
}

// 인증 실패 이벤트가 늦게 오면 미리보기로 전환
window.addEventListener('navermap-auth-failure', () => {
  map = null;
  if (lastArgs) renderPreviewMap(...lastArgs, failReason);
});

/* ───────── 대체: SVG 미리보기 지도 ───────── */
const W = 400;
const H = 320;
const PAD = 36;

export function renderPreviewMap(container, days, activeDay = 'all', reason = '') {
  map = null;
  const visible = visibleDays(days, activeDay);
  const points = visible.flatMap((d) => d.stops);

  if (!points.length) {
    container.innerHTML = '<p class="empty">위치가 확인된 장소가 없어요.</p>';
    return;
  }

  const k = Math.cos((points[0].lat * Math.PI) / 180);
  const xs = points.map((p) => p.lng * k);
  const ys = points.map((p) => p.lat);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const span = Math.max(maxX - minX, (maxY - minY) * ((W - PAD * 2) / (H - PAD * 2)), 0.005);
  const scale = (W - PAD * 2) / span;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const project = (lng, lat) => [W / 2 + (lng * k - cx) * scale, H / 2 - (lat - cy) * scale];

  const showLabels = activeDay !== 'all';
  let routes = '';
  let pins = '';

  for (const day of visible) {
    const color = DAY_COLORS[day.index % DAY_COLORS.length];
    // 실제 경로가 있는 구간만 선으로 그림
    day.allStops.forEach((s) => {
      const r = s.routeToNext;
      if (r?.status === 'ok' && r.path?.length > 1) {
        routes += `<polyline points="${r.path.map(([lng, lat]) => project(lng, lat).join(',')).join(' ')}" fill="none" stroke="${color}"
          stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".8" />`;
      }
    });
    day.stops.forEach((stop) => {
      const [x, y] = project(stop.lng, stop.lat);
      pins += `<g>
        <title>${esc(stop.name)}</title>
        <circle cx="${x}" cy="${y}" r="11" fill="${color}" stroke="#fff" stroke-width="2.5" />
        <text class="pin-label" x="${x}" y="${y + 3.5}" text-anchor="middle">${stop.n + 1}</text>
        ${showLabels
          ? (x > W * 0.6
            ? `<text class="place-label" x="${x - 15}" y="${y + 4}" text-anchor="end">${esc(stop.name)}</text>`
            : `<text class="place-label" x="${x + 15}" y="${y + 4}">${esc(stop.name)}</text>`)
          : ''}
      </g>`;
    });
  }

  const grid = Array.from({ length: 9 }, (_, i) => {
    const g = (i + 1) * 40;
    return `<line x1="${g}" y1="0" x2="${g}" y2="${H}" /><line x1="0" y1="${g}" x2="${W}" y2="${g}" />`;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="여행 동선 지도">
      <g stroke="#dde5ef" stroke-width="1">${grid}</g>
      ${routes}
      ${pins}
    </svg>
    <span class="map-note">미리보기 지도${reason ? ` · ${esc(reason)}` : ''}</span>`;
}
