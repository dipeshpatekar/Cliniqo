import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MailService } from './mail.service.js';
import { ConfigService } from '../config/config.service.js';

describe('MailService', () => {
  let mailService: MailService;
  let mockTransporter: any;

  beforeEach(() => {
    mockTransporter = {
      sendMail: vi.fn(),
    };
  });

  it('should format and send password reset email when SMTP is configured', async () => {
    const config = new ConfigService({
      SMTP_HOST: 'smtp.mailtrap.io',
      SMTP_PORT: '2525',
      SMTP_FROM: 'security@cliniqo.app',
    });

    mailService = new MailService(config);
    mailService.setTransporter(mockTransporter);
    mockTransporter.sendMail.mockResolvedValue({ messageId: 'msg-123' });

    const sent = await mailService.sendPasswordResetEmail(
      'doctor@clinic.com',
      'secret-reset-token-123',
    );

    expect(sent).toBe(true);
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'security@cliniqo.app',
        to: 'doctor@clinic.com',
        subject: 'Cliniqo Password Reset Request',
        text: expect.stringContaining('secret-reset-token-123'),
        html: expect.stringContaining('secret-reset-token-123'),
      }),
    );
  });

  it('should catch SMTP transport errors safely without throwing', async () => {
    const config = new ConfigService({
      SMTP_HOST: 'smtp.mailtrap.io',
    });

    mailService = new MailService(config);
    mailService.setTransporter(mockTransporter);
    mockTransporter.sendMail.mockRejectedValue(
      new Error('ECONNREFUSED 127.0.0.1:25'),
    );

    const sent = await mailService.sendPasswordResetEmail(
      'doctor@clinic.com',
      'token-abc',
    );

    expect(sent).toBe(false);
  });

  it('should skip email delivery safely when SMTP is unconfigured', async () => {
    const config = new ConfigService({});
    mailService = new MailService(config);

    const sent = await mailService.sendPasswordResetEmail(
      'doctor@clinic.com',
      'token-abc',
    );
    expect(sent).toBe(false);
  });
});
