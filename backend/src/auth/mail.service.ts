import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import nodemailer, { type Transporter } from "nodemailer"
import { ConfigService } from "../config/config.service.js"

interface CachedAccessToken {
  token: string
  expiresAt: number
}

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name)
  private transporter: Transporter | null = null
  private cachedToken: CachedAccessToken | null = null

  constructor(private readonly configService: ConfigService) {
    this.initializeTransporter()
  }

  private initializeTransporter() {
    if (this.configService.isGmailApiConfigured) {
      this.logger.log(
        "Gmail API OAuth2 delivery configured (HTTPS port 443)",
      )
      return
    }

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
        tls: {
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
      })
      this.logger.log(
        `Gmail SMTP mail transport initialized via ${smtp.host}:${smtp.port}`,
      )
    }
  }

  private sanitizeMailError(rawMsg: string): string {
    return rawMsg
      .replace(/\b\d{6}\b/g, "******")
      .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED_TOKEN]")
      .replace(
        /(["']?(?:password|pass|auth|key|secret|token|refresh_token|access_token|client_secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
        "$1[REDACTED]",
      )
      .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, "Bearer [REDACTED]")
      .replace(/accepted[:=\s]+[^\s,]+/gi, "accepted: [REDACTED]")
      .replace(/:\s*([A-Za-z0-9_-]{8,})/g, ": [REDACTED]")
  }

  /**
   * Acquires or reuses a valid Google OAuth2 access token using the configured refresh token.
   * Caches token until 60 seconds before expiration.
   */
  async getGmailAccessToken(): Promise<string> {
    const oauth = this.configService.gmailOAuthConfig
    if (!oauth.clientId || !oauth.clientSecret || !oauth.refreshToken) {
      throw new Error("Gmail API OAuth2 configuration is incomplete")
    }

    const now = Date.now()
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60000) {
      return this.cachedToken.token
    }

    const tokenParams = new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      refresh_token: oauth.refreshToken,
      grant_type: "refresh_token",
    })

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenParams.toString(),
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OAuth2 token exchange failed with status ${response.status}: ${this.sanitizeMailError(errText)}`)
    }

    const data = (await response.json()) as { access_token: string; expires_in: number }
    if (!data.access_token) {
      throw new Error("OAuth2 response missing access_token")
    }

    const expiresInSec = typeof data.expires_in === "number" ? data.expires_in : 3600
    this.cachedToken = {
      token: data.access_token,
      expiresAt: now + expiresInSec * 1000,
    }

    return data.access_token
  }

  /**
   * Builds an RFC 5322 MIME message string and returns its URL-safe base64 encoding.
   */
  buildRfc2822Raw(from: string, to: string, subject: string, text: string, html: string): string {
    const boundary = `====_Part_${Date.now()}_${Math.random().toString(36).substring(2, 10)}====`
    const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
    const dateHeader = new Date().toUTCString()

    const lines = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      `Date: ${dateHeader}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(text, "utf-8").toString("base64"),
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(html, "utf-8").toString("base64"),
      "",
      `--${boundary}--`,
      "",
    ]

    const mimeMessage = lines.join("\r\n")
    return Buffer.from(mimeMessage, "utf-8").toString("base64url")
  }

  /**
   * Sends an email via Google Gmail REST API over HTTPS (port 443).
   * Works on restrictive networks and cloud hosts that block outbound SMTP (such as Render Free).
   */
  async sendViaGmailApi(
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<boolean> {
    try {
      const accessToken = await this.getGmailAccessToken()
      const oauth = this.configService.gmailOAuthConfig
      const from = oauth.from

      const raw = this.buildRfc2822Raw(from, to, subject, text, html)

      const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      })

      if (!response.ok) {
        const errBody = await response.text()
        throw new Error(`Gmail API returned status ${response.status}: ${this.sanitizeMailError(errBody)}`)
      }

      const result = (await response.json()) as { id?: string }
      this.logger.log(
        `Email accepted by Gmail API for: ${to} (messageId: ${result.id || "unknown"})`,
      )
      return true
    } catch (err) {
      const rawMsg = (err as Error)?.message || "Unknown Gmail API delivery failure"
      const sanitized = this.sanitizeMailError(rawMsg)
      this.logger.error(`Failed to send email via Gmail API: ${sanitized}`)
      return false
    }
  }

  async onModuleInit() {
    if (this.configService.isTest) {
      return
    }

    if (this.configService.isGmailApiConfigured) {
      try {
        await this.getGmailAccessToken()
        this.logger.log("Gmail API OAuth2 credentials verified successfully")
      } catch (err) {
        const rawMsg = (err as Error)?.message || "Unknown Gmail API verification error"
        const sanitized = this.sanitizeMailError(rawMsg)
        this.logger.error(`Gmail API OAuth2 verification failed: ${sanitized}`)
      }
      return
    }

    if (this.transporter) {
      try {
        await this.transporter.verify()
        this.logger.log(
          `Gmail SMTP connection verified successfully for host: ${this.configService.smtpConfig.host}`,
        )
      } catch (err) {
        const rawMsg = (err as Error)?.message || "Unknown SMTP connection error"
        const sanitized = this.sanitizeMailError(rawMsg)
        this.logger.error(`Gmail SMTP connection verification failed: ${sanitized}`)
      }
    }
  }

  /**
   * Sets a custom transporter (useful for testing and mocks).
   */
  setTransporter(transporter: Transporter | null) {
    this.transporter = transporter
  }

  /**
   * Dispatches an email through the active provider (Gmail API or SMTP fallback).
   */
  private async dispatchEmail(
    to: string,
    subject: string,
    text: string,
    html: string,
    actionDesc: string,
  ): Promise<boolean> {
    if (this.configService.isGmailApiConfigured) {
      return this.sendViaGmailApi(to, subject, text, html)
    }

    if (this.transporter) {
      const from = this.configService.smtpConfig.from
      try {
        const info = await this.transporter.sendMail({
          from,
          to,
          subject,
          text,
          html,
        })
        this.logger.log(
          `${actionDesc} email accepted by SMTP for: ${to} (messageId: ${info.messageId})`,
        )
        return true
      } catch (err) {
        const rawMsg = (err as Error)?.message || "Unknown SMTP delivery failure"
        const sanitized = this.sanitizeMailError(rawMsg)
        this.logger.error(`Failed to send ${actionDesc} email: ${sanitized}`)
        return false
      }
    }

    this.logger.warn(
      `SMTP is not configured. Skipping ${actionDesc} email delivery for: ${to}`,
    )
    return false
  }

  /**
   * Sends a 6-digit OTP email with 5-minute expiry for password recovery.
   * Uses a clean generic subject to optimize spam filter deliverability,
   * keeping the OTP exclusively in the message body.
   * Fails safely without leaking credentials or errors to the HTTP caller.
   */
  async sendPasswordResetOtpEmail(
    to: string,
    otp: string,
  ): Promise<boolean> {
    const subject = "Your Cliniqo verification code"
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

    return this.dispatchEmail(to, subject, text, html, "password reset OTP")
  }

  /**
   * Sends a password reset email containing a single-use secure reset token.
   * Fails safely without leaking errors to the HTTP caller.
   */
  async sendPasswordResetEmail(
    to: string,
    resetToken: string,
  ): Promise<boolean> {
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

    return this.dispatchEmail(to, subject, text, html, "password reset")
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

    return this.dispatchEmail(to, subject, text, html, "clinic invitation")
  }
}
