// calculate_budget — 외부 API 없이 예산 합산
//
// 가격 신뢰도(status)
//   confirmed : 확인된 가격 (사용자 입력, 예약 금액 등)
//   estimated : 추정치 (Directions API의 유류비·통행료, 일반적인 시세 가정 등)
//   unknown   : 미확인 (가격 정보 없음 → 합계에 넣지 않고 따로 표시)
// status를 주지 않으면: 금액이 있으면 estimated, 없으면 unknown

export const CATEGORIES = ['식비', '숙박비', '교통비', '관광비', '기타'];
const STATUSES = ['confirmed', 'estimated', 'unknown'];
export const STATUS_LABEL = { confirmed: '확인됨', estimated: '추정치', unknown: '미확인' };

/**
 * @param {{
 *   totalBudget: number,
 *   people?: number,
 *   items: Array<{
 *     name: string, category: string,
 *     amount?: number|null,      // 1회(또는 1인) 금액
 *     perPerson?: boolean,       // true면 amount × 인원
 *     quantity?: number,         // 횟수·박수 (기본 1)
 *     status?: 'confirmed'|'estimated'|'unknown',
 *     source?: string
 *   }>
 * }} input
 */
export function calculate_budget({ totalBudget, people = 1, items = [] } = {}) {
  const budget = Number(totalBudget);
  if (!Number.isFinite(budget) || budget < 0) throw new Error('totalBudget은 0 이상의 숫자여야 합니다.');
  const headcount = Math.max(1, Math.floor(Number(people) || 1));
  const warnings = [];

  const byCategory = Object.fromEntries(
    CATEGORIES.map((c) => [c, { confirmed: 0, estimated: 0, subtotal: 0, unknownCount: 0 }]),
  );

  const lines = items.map((raw, i) => {
    const name = raw.name || `항목 ${i + 1}`;
    let category = raw.category;
    if (!CATEGORIES.includes(category)) {
      warnings.push(`"${name}"의 분류(${category ?? '없음'})를 알 수 없어 기타로 처리했습니다.`);
      category = '기타';
    }

    const hasAmount = raw.amount !== null && raw.amount !== undefined && raw.amount !== '' && Number.isFinite(Number(raw.amount));
    let status = STATUSES.includes(raw.status) ? raw.status : hasAmount ? 'estimated' : 'unknown';
    if (status !== 'unknown' && !hasAmount) {
      warnings.push(`"${name}"은 금액이 없어 미확인으로 처리했습니다.`);
      status = 'unknown';
    }
    if (hasAmount && Number(raw.amount) < 0) throw new Error(`"${name}"의 금액이 음수입니다.`);

    const quantity = Math.max(1, Number(raw.quantity) || 1);
    const multiplier = (raw.perPerson ? headcount : 1) * quantity;
    const total = status === 'unknown' ? null : Math.round(Number(raw.amount) * multiplier);

    const cat = byCategory[category];
    if (status === 'unknown') cat.unknownCount++;
    else {
      cat[status] += total;
      cat.subtotal += total;
    }

    return {
      name, category, status, statusLabel: STATUS_LABEL[status],
      unitAmount: hasAmount ? Number(raw.amount) : null,
      perPerson: Boolean(raw.perPerson), quantity, total,
      source: raw.source || null,
    };
  });

  const confirmedTotal = lines.reduce((s, l) => s + (l.status === 'confirmed' ? l.total : 0), 0);
  const estimatedTotal = lines.reduce((s, l) => s + (l.status === 'estimated' ? l.total : 0), 0);
  const plannedTotal = confirmedTotal + estimatedTotal;
  const remaining = budget - plannedTotal;
  const unknownItems = lines.filter((l) => l.status === 'unknown').map((l) => `${l.category} · ${l.name}`);

  if (unknownItems.length) warnings.push(`가격 미확인 항목 ${unknownItems.length}개는 합계에 포함되지 않아 실제 잔여 예산은 더 적을 수 있습니다.`);
  if (remaining < 0) warnings.push(`예산을 ${Math.abs(remaining).toLocaleString()}원 초과했습니다.`);

  return {
    totalBudget: budget,
    people: headcount,
    byCategory,
    confirmedTotal,       // 확인된 금액 합계
    estimatedTotal,       // 추정치 합계
    plannedTotal,         // 확인 + 추정
    remaining,            // 총예산 - (확인 + 추정)
    remainingIfConfirmedOnly: budget - confirmedTotal,
    usageRate: budget ? Math.round((plannedTotal / budget) * 1000) / 10 : null, // %
    perPersonPlanned: Math.round(plannedTotal / headcount),
    status: remaining < 0 ? 'over' : 'within',
    unknownItems,
    items: lines,
    warnings,
  };
}
