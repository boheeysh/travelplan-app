# 국내 여행 플래너 AI Agent

OpenAI Responses API의 Function Calling으로 동작하는 국내 여행 일정 Agent입니다.
LLM이 필요한 Tool을 스스로 골라 실행하고, 결과를 보고 추가 Tool을 호출합니다.

## 시작하기
```bash
npm install
cp .env.example .env   # 실제 키 입력
npm run dev            # http://127.0.0.1:3000  (NAVER 지도는 localhost 대신 127.0.0.1 로 접속)
```

## Vercel 배포
1. GitHub 저장소를 Vercel에서 Import (Framework: 자동 감지 Express, 진입점: 루트 `server.js`)
2. **Environment Variables** 에 `.env.example`의 키를 모두 입력
   - `APP_PASSWORD` **필수** — 없으면 일정 생성·장소 검색이 막힘 (배포 주소를 아는 누구나 OpenAI 비용을 쓰는 것 방지)
   - `PORT`는 넣지 않아도 됨
3. NCP 콘솔 > Maps Application > **Web 서비스 URL**에 배포 주소(예: `https://travelplan-app.vercel.app`) 추가
4. OpenAI 대시보드에서 **월 사용 한도** 설정 권장

참고
- 화면 파일은 `public/`을 Vercel CDN이 제공 (`express.static`은 Vercel에서 무시됨)
- 일정 생성은 보통 60~120초 → Hobby 플랜 함수 최대 실행 시간(300초) 안
- 접속 비밀번호는 브라우저 탭에서만 기억(sessionStorage)하고, 요청 헤더 `x-app-password`로 전송


```
사용자 조건 ─▶ LLM (Responses API + Tool 스키마)
                 │  function_call 요청
                 ▼
          Node.js에서 실제 함수 실행 ──▶ search_places   (NAVER 지역 검색)
                 │                     get_routes      (NAVER Directions 5, 자동차)
                 │                     calculate_budget (로컬 JS)
                 │  function_call_output
                 ▼
          LLM이 결과를 보고 추가 Tool 호출 or 최종 일정(JSON) 작성
          (web_search는 OpenAI 내장 Tool — 최신 행사·입장료 등 필요할 때만)
```
- 반복 한도: `AGENT_MAX_ITERATIONS`(LLM↔Tool 왕복), `AGENT_MAX_TOOL_CALLS`(Tool 총 호출 수). 넘으면 Tool 없이 최종 답변을 강제합니다.
- Agent Trace는 `/api/plan`이 NDJSON으로 실시간 전송합니다.

## 환각 방지 (서버 검증)
| 항목 | 규칙 |
|---|---|
| 좌표 | search_places 결과 중 **200m 이내 + 이름 일치**하는 장소만 지도에 표시. 이름이 다르면 "위치 미확인". 확인 안 된 좌표로는 get_routes 실행 거부 |
| 장소 검토 | 이름이 맞지 않는 장소는 Agent에게 1회 재검토 요청(근처 검색 결과 이름을 후보로 제시). 이름이 검색 결과와 정확히 같고 유일하면 좌표가 어긋나도 검색 좌표로 복구 |
| 경로 보완 | Agent 검토 후에도 확인된 두 장소 사이에 조회 안 한 구간이 있으면 서버가 get_routes로 직접 조회하고 유류비·통행료를 예산에 다시 반영 (Trace에 "서버 보완" 표시) |
| 이동 거리·시간 | 서버가 get_routes 결과로만 채움. 조회 안 한 구간은 "이동시간 미확인", 경로 없음은 "확인 불가" |
| 가격 | 사용자 입력 금액, Directions 유류비·통행료, web_search 근거가 있는 금액만 인정. 나머지는 "미확인" |
| 영업시간·평점 | 검색 API가 제공하지 않으므로 표시하지 않음 |

## 구조
```
server.js               Express 진입점 (로컬 listen / Vercel export default)
server/
  config.js             .env 로딩 (키는 여기서만 읽음)
  auth.js               접속 비밀번호 (APP_PASSWORD)
  agent/
    runAgent.js         Agent Loop · Trace · 후처리 검증
    tools.js            Tool 스키마 + 실행기 + 가격/좌표 검증
    prompt.js           Agent 지시문
    planSchema.js       최종 일정 JSON 스키마 (Structured Outputs)
    mealPrices.js       식당 메뉴판 단가 (web_search)
    lodgingPrices.js    숙소 1박 요금 (web_search)
  services/
    naverSearch.js      search_places
    naverMaps.js        get_routes
    budget.js           calculate_budget
    openai.js           OpenAI 클라이언트
  routes/               plan.js · places.js · maps.js
public/                 index.html, css/, js/ (app · render · map · places · api)
scripts/                단독 테스트
```

## 테스트
```bash
npm run test:search    # search_places
npm run test:routes    # get_routes
npm run test:budget    # calculate_budget
npm run test:match     # 장소 이름 매칭 (API 호출 없음)
npm run test:pipeline  # 일정 정리·식사 보완·예산 재계산·제목 정리 (API 호출 없음)
npm run test:agent     # Agent Loop 전체 (OpenAI 호출 비용 발생)
npm run test:agent -- "강릉" 1 "바다 보이는 카페 위주"
```

## 보안
- API 키는 `.env`에만 저장하고, `.env`는 `.gitignore`로 커밋에서 제외됩니다.
- Secret 키는 서버에서만 사용하고, 브라우저에는 지도 SDK용 Client ID만 전달합니다.
- 비용이 드는 API(`/api/plan`, `/api/places`)는 `APP_PASSWORD`로 보호합니다. 로컬에서 비워 두면 비밀번호 없이 사용합니다.
