import { describe, it, expect, beforeEach } from 'vitest';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

describe('HealthController', () => {
  let controller: HealthController;
  let service: HealthService;

  beforeEach(() => {
    service = new HealthService();
    controller = new HealthController(service);
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
    it('should return status ready when healthy', () => {
      const mockRes = { status: () => {} } as any;
      const result = controller.getReadiness(mockRes);
      expect(result.status).toBe('ready');
      expect(result.checks.process).toBe('ok');
    });
  });
});
