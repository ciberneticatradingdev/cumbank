import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';

interface EventRow {
  id: number;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  created_at: Date;
}

const router = Router();

// SSE clients
const sseClients = new Set<Response>();

router.get('/events', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const offset = (page - 1) * limit;
    const type = req.query.type as string | undefined;

    let countQuery = 'SELECT COUNT(*) as count FROM events';
    let dataQuery = 'SELECT * FROM events';
    const params: (string | number)[] = [];

    if (type) {
      countQuery += ' WHERE type = $1';
      dataQuery += ' WHERE type = $1';
      params.push(type);
    }

    dataQuery += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const countParams = type ? [type] : [];
    const [countResult, dataResult] = await Promise.all([
      pool.query<{ count: string }>(countQuery, countParams),
      pool.query<EventRow>(dataQuery, params),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      events: dataResult.rows.map((row: EventRow) => ({
        id: row.id,
        type: row.type,
        message: row.message,
        data: row.data,
        createdAt: row.created_at.toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to fetch events', details: errorMessage });
  }
});

router.get('/events/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  res.write('data: {"type":"connected","message":"SSE stream connected"}\n\n');

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

export function broadcastEvent(event: { type: string; message: string; data?: Record<string, unknown> }): void {
  const payload = JSON.stringify(event);
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

export default router;
