import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ConfigService } from '../config/config.service.js';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly configService: ConfigService) {
    this.initializeTransporter();
  }

  private initializeTransporter() {
    if (this.configService.isSmtpConfigured) {
      const smtp = this.configService.smtpConfig;
      this.transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth:
          smtp.user && smtp.pass
            ? {
                user: smtp.user,
                pass: smtp.pass,
              }
            : undefined,
      });
    }
  }

  /**
   * Sets a custom transporter (useful for testing and mocks).
   */
  setTransporter(transporter: Transporter | null) {
    this.transporter = transporter;
  }

  /**
   * Sends a password reset email containing a single-use secure reset token.
   * Fails safely without leaking errors to the HTTP caller.
   */
  async sendPasswordResetEmail(
    to: string,
    resetToken: string,
  ): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn(
        `SMTP is not configured. Skipping password reset email delivery for: ${to}`,
      );
      return false;
    }

    const from = this.configService.smtpConfig.from;
    const subject = 'Cliniqo Password Reset Request';
    const text = `Hello Doctor,

A password reset request was received for your Cliniqo account.

Use the following secure token to reset your password:
${resetToken}

This token will expire in 15 minutes and can only be used once.

If you did not make this request, please contact clinic administration immediately.

Regards,
Cliniqo Security Team`;

    const html = `<p>Hello Doctor,</p>
<p>A password reset request was received for your Cliniqo account.</p>
<p>Use the following secure token to reset your password:</p>
<p><strong style="font-size: 16px; font-family: monospace; letter-spacing: 1px;">${resetToken}</strong></p>
<p><em>This token will expire in 15 minutes and can only be used once.</em></p>
<p>If you did not make this request, please contact clinic administration immediately.</p>
<br>
<p>Regards,<br><strong>Cliniqo Security Team</strong></p>`;

    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      });
      this.logger.log(
        `Password reset email accepted by SMTP for: ${to} (messageId: ${info.messageId})`,
      );
      return true;
    } catch (err) {
      // Log sanitized error without credentials
      this.logger.error(
        `Failed to send password reset email: ${(err as Error)?.message}`,
      );
      return false;
    }
  }
}
