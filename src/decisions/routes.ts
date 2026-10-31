/**
 * Decisions HTTP surface.
 *
 * Three equivalent paths are mounted because clients discovered different
 * ones in the wild — ainish-rag probes `/api/alpha/decisions`, then
 * `/v1/decisions`, then `/decisions`, and uses the first that answers a typed
 * probe. All three are the same handler, so discovery cannot land on a
 * degraded surface.
 *
 * Diagnostics live on `/api/decisions/status` (pass `?probe=true` for a live
 * upstream round-trip) and `/api/decisions/probe`.
 */

import express, { Request, Response } from 'express';
import type { DecisionService } from './service';

export const DECISION_ROUTES = ['/api/alpha/decisions', '/v1/decisions', '/decisions'] as const;

export function registerDecisionRoutes(app: express.Express, service: DecisionService): void {
  const handler = async (req: Request, res: Response) => {
    const route = req.path;
    try {
      const outcome = await service.execute(req.body, route);
      if (outcome.ok) {
        res.set(outcome.headers);
      }
      res.status(outcome.status).json(outcome.body);
    } catch (error: any) {
      console.error('[decisions] unhandled error:', error?.stack || error?.message || error);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            type: 'decision_internal_error',
            message: 'Internal error while resolving the decision request.',
            attempts: []
          }
        });
      }
    }
  };

  app.post(DECISION_ROUTES as unknown as string[], handler);

  app.get('/api/decisions/status', async (req: Request, res: Response) => {
    try {
      if (String(req.query.probe || '').toLowerCase() === 'true') {
        await service.probe();
      }
      res.json(service.status());
    } catch (error: any) {
      console.error('[decisions] status error:', error?.stack || error?.message || error);
      if (!res.headersSent) {
        res.status(500).json({ error: { type: 'decision_internal_error', message: 'Status unavailable.' } });
      }
    }
  });

  app.post('/api/decisions/probe', async (_req: Request, res: Response) => {
    try {
      const probe = await service.probe();
      res.json({ ...probe, providers: service.status().providers });
    } catch (error: any) {
      console.error('[decisions] probe error:', error?.stack || error?.message || error);
      if (!res.headersSent) {
        res.status(500).json({ error: { type: 'decision_internal_error', message: 'Probe failed.' } });
      }
    }
  });
}
