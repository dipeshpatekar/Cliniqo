import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';
import { SyncPushDto } from './dto/sync-push.dto.js';
import { SyncPullQueryDto } from './dto/sync-pull.dto.js';

describe('SyncController Unit Tests', () => {
  let controller: SyncController;
  let mockSyncService: Partial<SyncService>;

  const clinicId = new Types.ObjectId('672bb0000000000000000001');
  const doctorId = new Types.ObjectId('672aa0000000000000000001');

  beforeEach(() => {
    mockSyncService = {
      push: vi.fn(),
      pull: vi.fn(),
    };
    controller = new SyncController(mockSyncService as SyncService);
  });

  describe('POST /sync/push', () => {
    it('should derive clinic and doctor identity from authenticated server session', async () => {
      const dto: SyncPushDto = { mutations: [] };
      const req: any = {
        clinic: { _id: clinicId },
        doctor: { _id: doctorId },
      };

      (mockSyncService.push as any).mockResolvedValue({
        processedAt: new Date().toISOString(),
        clinicId: clinicId.toString(),
        results: [],
      });

      const response = await controller.push(dto, req);
      expect(response.clinicId).toBe(clinicId.toString());
      expect(mockSyncService.push).toHaveBeenCalledWith(clinicId, doctorId, dto);
    });

    it('should throw ForbiddenException if session context is missing', async () => {
      const dto: SyncPushDto = { mutations: [] };
      const req: any = {};

      await expect(controller.push(dto, req)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('GET /sync/pull', () => {
    it('should derive clinic context from authenticated session and invoke pull', async () => {
      const query: SyncPullQueryDto = { sinceSeq: 5, limit: 20 };
      const req: any = {
        clinic: { _id: clinicId },
      };

      (mockSyncService.pull as any).mockResolvedValue({
        clinicId: clinicId.toString(),
        sinceSeq: 5,
        currentSeq: 10,
        hasMore: false,
        changes: [],
      });

      const response = await controller.pull(query, req);
      expect(response.clinicId).toBe(clinicId.toString());
      expect(mockSyncService.pull).toHaveBeenCalledWith(clinicId, query);
    });

    it('should throw ForbiddenException if clinic session is missing on pull', async () => {
      const query: SyncPullQueryDto = {};
      const req: any = {};

      await expect(controller.pull(query, req)).rejects.toThrow(ForbiddenException);
    });
  });
});
