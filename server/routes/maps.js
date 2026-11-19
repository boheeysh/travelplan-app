// [Level 3] 지도 / 경로
import { Router } from 'express';
import { config } from '../config.js';
const router = Router();

// 지도 JS SDK 로딩용 Client ID만 전달 (Secret은 서버에만 보관)
router.get('/client-id', (req, res) => {
  res.json({ clientId: config.naverMaps.clientId || null });
});

// TODO(Level 3): GET /api/maps/directions
router.get('/directions', (req, res) => {
  res.status(501).json({ error: 'Level 3에서 구현 예정' });
});

export default router;
