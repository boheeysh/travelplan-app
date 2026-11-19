// POST /api/plan — AI Agent 실행
// 응답은 NDJSON 스트림: Agent Trace를 실시간으로 보내고 마지막에 최종 일정을 보냅니다.
//   {"type":"trace","item":{...}}
//   {"type":"done","plan":{...}}
//   {"type":"error","message":"..."}
import { Router } from 'express';
import { runAgent } from '../agent/runAgent.js';
import { configStatus } from '../config.js';

const router = Router();

function validate(b) {
  if (!b || typeof b !== 'object') return '요청 형식이 올바르지 않습니다.';
  if (!String(b.region || '').trim()) return '여행 지역을 입력해 주세요.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.startDate || '')) return '출발일 형식이 올바르지 않습니다.';
  if (![0, 1, 2, 3].includes(Number(b.nights))) return '여행 기간은 당일~3박 4일까지 가능합니다.';
  if (!(Number(b.people) >= 1 && Number(b.people) <= 20)) return '인원은 1~20명이어야 합니다.';
  if (!(Number(b.budget) >= 10000)) return '총예산은 1만 원 이상이어야 합니다.';
  if (String(b.request || '').length > 500) return '추가 요청은 500자 이내로 입력해 주세요.';
  return null;
}

router.post('/', async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ error });

  const keys = configStatus();
  const missing = Object.entries(keys).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) return res.status(500).json({ error: `.env 인증 정보가 없습니다: ${missing.join(', ')}` });

  const input = {
    region: String(req.body.region).trim(),
    startDate: req.body.startDate,
    nights: Number(req.body.nights),
    people: Number(req.body.people),
    budget: Number(req.body.budget),
    prefs: Array.isArray(req.body.prefs) ? req.body.prefs.map(String).slice(0, 10) : [],
    transport: String(req.body.transport || '자동차'),
    request: String(req.body.request || '').trim(),
  };

  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // 사용자가 페이지를 떠나면 Agent 중단
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const send = (obj) => !res.writableEnded && res.write(`${JSON.stringify(obj)}\n`);

  try {
    const { plan } = await runAgent(input, {
      signal: controller.signal,
      onTrace: (item) => send({ type: 'trace', item }),
    });
    send({ type: 'done', plan });
  } catch (err) {
    console.error('[agent]', err.message);
    send({ type: 'error', message: err.status ? err.message : '일정 생성 중 알 수 없는 오류가 발생했습니다.' });
  } finally {
    res.end();
  }
});

export default router;
