import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

describe('HealthController', () => {
  let controller: HealthController;
  let service: HealthService;

  beforeEach(() => {
    service = new HealthService();
    controller = new HealthController(service);
  });

  describe('getHealth', () => {
    it('should return status ok and valid uptime for root /health endpoint', () => {
      const result = controller.getHealth();
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
      expect(typeof result.timestamp).toBe('string');
    });
  });

  describe('getLiveness', () => {
    it('should return status ok and valid uptime', () => {
      const result = controller.getLiveness();
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
      expect(typeof result.timestamp).toBe('string');
    });
  });

  describe('getReadiness', () => {
    it('should return status ready and 200 when database is healthy', async () => {
      vi.spyOn(service, 'getReadiness').mockResolvedValue({
        status: 'ready',
        timestamp: new Date().toISOString(),
        checks: { process: 'ok', database: 'ok' },
      });

      const mockStatus = vi.fn();
      const mockRes = { status: mockStatus } as unknown as Response;

      const result = await controller.getReadiness(mockRes);
      expect(result.status).toBe('ready');
      expect(result.checks.database).toBe('ok');
      // When healthy, res.status(503) must NOT be called
      expect(mockStatus).not.toHaveBeenCalled();
    });

    it('should set HTTP 503 Service Unavailable when database is disconnected or unavailable', async () => {
      vi.spyOn(service, 'getReadiness').mockResolvedValue({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        checks: { process: 'ok', database: 'unavailable' },
      });

      const mockStatus = vi.fn();
      const mockRes = { status: mockStatus } as unknown as Response;

      const result = await controller.getReadiness(mockRes);
      expect(mockStatus).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(result.status).toBe('not_ready');
      expect(result.checks.process).toBe('ok');
      expect(result.checks.database).toBe('unavailable');
    });

    it('should maintain liveness as ok even when database readiness returns 503', async () => {
      // Simulate database failure
      vi.spyOn(service, 'getReadiness').mockResolvedValue({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        checks: { process: 'ok', database: 'unavailable' },
      });

      const mockStatus = vi.fn();
      const mockRes = { status: mockStatus } as unknown as Response;

      const readyResult = await controller.getReadiness(mockRes);
      expect(mockStatus).toHaveBeenCalledWith(503);
      expect(readyResult.status).toBe('not_ready');

      // Liveness must remain completely healthy
      const liveResult = controller.getLiveness();
      expect(liveResult.status).toBe('ok');
      expect(typeof liveResult.uptime).toBe('number');
    });
  });
});
