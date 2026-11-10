import { Injectable, Logger } from "@nestjs/common"
import nodemailer, { type Transporter } from "nodemailer"
import { ConfigService } from "../config/config.service.js"

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name)
  private transporter: Transporter | null = null

  constructor(private readonly configService: ConfigService) {
    this.initializeTransporter()
  }

  private initializeTransporter() {
    if (this.configService.isSmtpConfigured) {
      const smtp = this.configService.smtpConfig
      this.transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
        auth:
          smtp.user && smtp.pass
            ? {
                user: smtp.user,
                pass: smtp.pass,
              }
            : undefined,
      })
    }
  }

  /**
   * Sets a custom transporter (useful for testing and mocks).
   */
  setTransporter(transporter: Transporter | null) {
    this.transporter = transporter
  }

  /**
   * Sends a 6-digit OTP email with 5-minute expiry for password recovery.
   * Fails safely without leaking credentials or errors to the HTTP caller.
   */
  async sendPasswordResetOtpEmail(
    to: string,
    otp: string,
  ): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn(
        `SMTP is not configured. Skipping password reset OTP email delivery for: ${to}`,
      )
      return false
    }

    const from = this.configService.smtpConfig.from
    const subject = `Cliniqo Verification Code: ${otp}`
    const text = `Hello Doctor,

A password reset request was received for your Cliniqo account.

Your 6-digit verification code is:
${otp}

This code will expire in 5 minutes and can only be used once.

If you did not make this request, please contact clinic administration immediately. Never share this code with anyone.

Regards,
Cliniqo Security Team`

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cliniqo Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f8fafc; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 520px; background-color: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); overflow: hidden;">
          <tr>
            <td style="background-color: #068D94; padding: 24px 32px; text-align: left;">
              <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Cliniqo</h1>
              <p style="margin: 4px 0 0 0; color: #e6fffa; font-size: 13px;">Secure Doctor Workspace</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px;">
              <h2 style="margin: 0 0 16px 0; color: #0f172a; font-size: 18px; font-weight: 600;">Password Reset Verification Code</h2>
              <p style="margin: 0 0 20px 0; color: #475569; font-size: 14px; line-height: 1.6;">
                Hello Doctor,<br>
                A password reset request was received for your Cliniqo account. Enter the following 6-digit verification code to continue:
              </p>

              <div style="margin: 28px 0; text-align: center;">
                <div style="display: inline-block; background-color: #f0fdfa; border: 1.5px solid #068D94; border-radius: 8px; padding: 14px 28px; text-align: center;">
                  <span style="font-family: 'SF Mono', 'Courier New', Courier, monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #068D94;">${otp}</span>
                </div>
              </div>

              <div style="background-color: #f1f5f9; border-left: 3px solid #068D94; padding: 12px 16px; border-radius: 4px; margin: 24px 0;">
                <p style="margin: 0; color: #334155; font-size: 13px; line-height: 1.5;">
                  <strong>⏱ Valid for 5 minutes</strong> &bull; This verification code expires in 5 minutes and can only be used once.
                </p>
              </div>

              <p style="margin: 20px 0 0 0; color: #64748b; font-size: 13px; line-height: 1.5;">
                If you did not request a password reset, please ignore this email or notify your clinic administration. Never share this code with anyone.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8fafc; padding: 20px 32px; border-top: 1px solid #e2e8f0; text-align: center;">
              <p style="margin: 0; color: #94a3b8; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Cliniqo &bull; Clinic Management System
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      })
      this.logger.log(
        `Password reset OTP email accepted by SMTP for: ${to} (messageId: ${info.messageId})`,
      )
      return true
    } catch (err) {
      const rawMsg = (err as Error)?.message || "Unknown SMTP delivery failure"
      const sanitized = rawMsg
        .replace(/\b\d{6}\b/g, "******")
        .replace(
          /(password|pass|auth|key|secret)[:=\s]+[^\s,]+/gi,
          "$1: [REDACTED]",
        )
      this.logger.error(`Failed to send password reset OTP email: ${sanitized}`)
      return false
    }
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
      )
      return false
    }

    const from = this.configService.smtpConfig.from
    const subject = "Cliniqo Password Reset Request"
    const text = `Hello Doctor,

A password reset request was received for your Cliniqo account.

Use the following secure token to reset your password:
${resetToken}

This token will expire in 15 minutes and can only be used once.

If you did not make this request, please contact clinic administration immediately.

Regards,
Cliniqo Security Team`

    const html = `<p>Hello Doctor,</p>
<p>A password reset request was received for your Cliniqo account.</p>
<p>Use the following secure token to reset your password:</p>
<p><strong style="font-size: 16px; font-family: monospace; letter-spacing: 1px;">${resetToken}</strong></p>
<p><em>This token will expire in 15 minutes and can only be used once.</em></p>
<p>If you did not make this request, please contact clinic administration immediately.</p>
<br>
<p>Regards,<br><strong>Cliniqo Security Team</strong></p>`

    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      })
      this.logger.log(
        `Password reset email accepted by SMTP for: ${to} (messageId: ${info.messageId})`,
      )
      return true
    } catch (err) {
      // Log sanitized error without credentials or token leaks
      const rawMsg = (err as Error)?.message || "Unknown SMTP delivery failure"
      const sanitized = rawMsg
        .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED_TOKEN]")
        .replace(
          /(password|pass|auth|key|secret)[:=\s]+[^\s,]+/gi,
          "$1: [REDACTED]",
        )
      this.logger.error(`Failed to send password reset email: ${sanitized}`)
      return false
    }
  }

  /**
   * Sends a clinic membership invitation email containing the single-use invitation token.
   * Fails safely without leaking tokens, credentials, or sensitive headers.
   */
  async sendClinicInvitationEmail(
    to: string,
    clinicName: string,
    role: string,
    invitationToken: string,
  ): Promise<boolean> {
    if (!this.transporter) {
      this.logger.warn(
        `SMTP is not configured. Skipping clinic invitation email delivery for: ${to}`,
      )
      return false
    }

    const from = this.configService.smtpConfig.from
    const subject = `Invitation to join ${clinicName} on Cliniqo`
    const text = `Hello Doctor,

You have been invited to join ${clinicName} on Cliniqo as a ${role}.

Use the following secure invitation token to accept your invitation:
${invitationToken}

This invitation token will expire in 7 days and can only be used once.

To accept, log in to your Cliniqo account and enter this token.

Regards,
Cliniqo Security Team`

    const html = `<p>Hello Doctor,</p>
<p>You have been invited to join <strong>${clinicName}</strong> on Cliniqo as a <strong>${role}</strong>.</p>
<p>Use the following secure invitation token to accept your invitation:</p>
<p><strong style="font-size: 16px; font-family: monospace; letter-spacing: 1px;">${invitationToken}</strong></p>
<p><em>This invitation token will expire in 7 days and can only be used once.</em></p>
<p>To accept, log in to your Cliniqo account with this email address and accept the invitation.</p>
<br>
<p>Regards,<br><strong>Cliniqo Security Team</strong></p>`

    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        text,
        html,
      })
      this.logger.log(
        `Clinic invitation email accepted by SMTP for: ${to} (messageId: ${info.messageId})`,
      )
      return true
    } catch (err) {
      this.logger.error(
        `Failed to send clinic invitation email: ${(err as Error)?.message}`,
      )
      return false
    }
  }
}
