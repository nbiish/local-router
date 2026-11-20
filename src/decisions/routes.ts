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
import { TrajectoryTracker, resolveTrajectoryClient } from '../trajectories';

export const DECISION_ROUTES = ['/api/alpha/decisions', '/v1/decisions', '/decisions'] as const;

/** A short, single-line error string for the trajectory record. */
function sanitizeDecisionError(value: unknown): string {
  const text = value instanceof Error
    ? value.message
    : (typeof value === 'string' ? value : JSON.stringify(value ?? ''));
  return text.replace(/\s+/g, ' ').slice(0, 220);
}

export function registerDecisionRoutes(app: express.Express, service: DecisionService): void {
  const handler = async (req: Request, res: Response) => {
    const route = req.path;
    // Decisions are model calls, so they belong in the same trajectory log as
    // chat. Before this they were invisible: `/api/alpha/decisions` is the route
    // ainish-rag's retrieval drivers use, and a failing decision model left no
    // record at all. `routeKind: 'direct'` because there is one upstream call per
    // request and no chain to walk.
    const startedAt = Date.now();
    const presentedModel = String((req.body && (req.body.model as string)) || '');
    const clientResolution = resolveTrajectoryClient(
      req.headers['x-local-router-client'],
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
    );
    const trajectory = presentedModel
      ? new TrajectoryTracker(
          {
            client: clientResolution.client,
            clientSource: clientResolution.clientSource,
            ...(clientResolution.userAgent ? { userAgent: clientResolution.userAgent } : {}),
            presentedModel,
            routeKind: 'direct',
            routeId: 'fallback-decision'
          },
          req.body
        )
      : null;
    try {
      const outcome = await service.execute(req.body, route);
      if (outcome.ok) {
        res.set(outcome.headers);
      }
      res.status(outcome.status).json(outcome.body);

      if (trajectory) {
        const ok = outcome.status >= 200 && outcome.status < 300;
        const body = (outcome.body || {}) as Record<string, any>;
        const providerName = typeof body.provider === 'string' ? body.provider : 'typesafe';
        const servedModel = typeof body.model === 'string' ? body.model : presentedModel;
        trajectory.addStage({
          stage: 'direct',
          targetModel: presentedModel,
          provider: ok ? providerName : null,
          actualModel: servedModel,
          attempt: 1,
          stageAttempts: 1,
          outcome: ok ? 'answered' : 'failed',
          status: outcome.status,
          ...(ok ? {} : { errorType: 'decision_upstream_error', errorMessage: sanitizeDecisionError(body) }),
          ms: Date.now() - startedAt
        });
        trajectory.finish({
          timestamp: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          status: outcome.status,
          ...(ok ? {} : { errorType: 'decision_upstream_error', errorMessage: sanitizeDecisionError(body) })
        });
      }
    } catch (error: any) {
      console.error('[decisions] unhandled error:', error?.stack || error?.message || error);
      trajectory?.addStage({
        stage: 'direct',
        targetModel: presentedModel,
        provider: null,
        actualModel: null,
        attempt: 1,
        stageAttempts: 1,
        outcome: 'failed',
        errorType: 'decision_internal_error',
        status: 500,
        errorMessage: sanitizeDecisionError(error)
      });
      trajectory?.finish({
        timestamp: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        status: 500,
        errorType: 'decision_internal_error',
        errorMessage: sanitizeDecisionError(error)
      });
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
