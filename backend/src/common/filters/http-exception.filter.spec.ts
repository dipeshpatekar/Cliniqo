import { describe, it, expect, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter.js';

describe('HttpExceptionFilter', () => {
  it('should format standard HttpException into consistent JSON structure', () => {
    const filter = new HttpExceptionFilter();
    const mockJson = vi.fn();
    const mockStatus = vi.fn().mockReturnValue({ json: mockJson });
    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test/path', method: 'GET' }),
      }),
    } as any;

    const exception = new HttpException(
      'Resource not found',
      HttpStatus.NOT_FOUND,
    );
    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(404);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        error: 'HttpException',
        message: 'Resource not found',
        path: '/test/path',
      }),
    );
  });

  it('should sanitize unhandled errors without leaking stack traces or raw secrets in logs or responses', () => {
    const filter = new HttpExceptionFilter();
    const loggerSpy = vi.spyOn((filter as any).logger, 'error').mockImplementation(() => {});
    const mockJson = vi.fn();
    const mockStatus = vi.fn().mockReturnValue({ json: mockJson });
    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/secure/data', method: 'POST' }),
      }),
    } as any;

    const exception = new Error('Database password leak: secret123 in /var/db');
    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(500);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'An unexpected internal error occurred',
        path: '/secure/data',
      }),
    );
    // Explicitly verify the secret from the error message is NOT in the JSON payload
    const sentPayload = mockJson.mock.calls[0][0];
    expect(JSON.stringify(sentPayload)).not.toContain('secret123');

    // Explicitly verify the secret is ALSO redacted from the logger call
    expect(loggerSpy).toHaveBeenCalled();
    const loggedMessage = loggerSpy.mock.calls[0][0];
    const loggedStack = loggerSpy.mock.calls[0][1];
    expect(loggedMessage).not.toContain('secret123');
    expect(loggedMessage).toContain('[REDACTED]');
    if (loggedStack) {
      expect(loggedStack).not.toContain('secret123');
    }
    loggerSpy.mockRestore();
  });
});
