// [Level 2] GET /api/places?region=부산&keyword=맛집&sort=random|comment
import { Router } from 'express';
import { search_places } from '../services/naverSearch.js';

const router = Router();

router.get('/', async (req, res) => {
  const { region = '', keyword = '', sort, display } = req.query;
  try {
    const result = await search_places({ region, keyword, sort, display });
    res.json(result);
  } catch (err) {
    console.error('[places]', err.code || '', err.message);
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

export default router;
