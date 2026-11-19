// 최종 일정 출력 형식 (Structured Outputs)
// 이동 거리·시간은 LLM이 쓰지 않고, 서버가 get_routes 결과로만 채웁니다.

const stop = {
  type: 'object',
  additionalProperties: false,
  required: ['time', 'name', 'meal', 'category', 'address', 'lat', 'lng', 'description', 'placeSource', 'cost'],
  properties: {
    time: { type: 'string', description: 'HH:MM' },
    name: { type: 'string' },
    meal: { type: ['string', 'null'], enum: ['점심', '저녁', null], description: '점심·저녁 식사 장소면 표시, 아니면 null' },
    category: { type: 'string', description: '관광, 맛집, 카페, 숙박, 자연, 쇼핑 등' },
    address: { type: ['string', 'null'] },
    lat: { type: ['number', 'null'], description: 'search_places 결과 좌표만. 없으면 null' },
    lng: { type: ['number', 'null'], description: 'search_places 결과 좌표만. 없으면 null' },
    description: { type: 'string', description: '할 일·추천 이유 (확인되지 않은 영업시간·평점·가격 금지)' },
    placeSource: { type: 'string', enum: ['search_places', 'web_search', 'user_request', 'none'] },
    cost: {
      type: 'object',
      additionalProperties: false,
      required: ['amount', 'status', 'basis'],
      properties: {
        amount: { type: ['number', 'null'], description: '전체 인원 기준 금액(원). 모르면 null' },
        status: { type: 'string', enum: ['confirmed', 'estimated', 'unknown'] },
        basis: { type: ['string', 'null'], description: '가격 근거' },
      },
    },
  },
};

export const planSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'overview', 'days', 'notes'],
  properties: {
    title: { type: 'string' },
    overview: { type: 'string', description: '여행 전체 소개 2~3문장' },
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'date', 'theme', 'stops'],
        properties: {
          day: { type: 'integer' },
          date: { type: 'string' },
          theme: { type: 'string' },
          stops: { type: 'array', items: stop },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: '주의사항, 확인 필요 사항' },
  },
};

export const textFormat = { format: { type: 'json_schema', name: 'travel_plan', schema: planSchema, strict: true } };
