import { describe, it, expect, beforeEach, vi } from "vitest"
import { MailService } from "./mail.service.js"
import { ConfigService } from "../config/config.service.js"

describe("MailService", () => {
  let mailService: MailService
  let mockTransporter: any

  beforeEach(() => {
    mockTransporter = {
      sendMail: vi.fn(),
    }
  })

  it("should format and send password reset email when SMTP is configured", async () => {
    const config = new ConfigService({
      SMTP_HOST: "smtp.mailtrap.io",
      SMTP_PORT: "2525",
      SMTP_FROM: "security@cliniqo.app",
    })

    mailService = new MailService(config)
    mailService.setTransporter(mockTransporter)
    mockTransporter.sendMail.mockResolvedValue({ messageId: "msg-123" })

    const sent = await mailService.sendPasswordResetEmail(
      "doctor@clinic.com",
      "secret-reset-token-123",
    )

    expect(sent).toBe(true)
    expect(mockTransporter.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "security@cliniqo.app",
        to: "doctor@clinic.com",
        subject: "Cliniqo Password Reset Request",
        text: expect.stringContaining("secret-reset-token-123"),
        html: expect.stringContaining("secret-reset-token-123"),
      }),
    )
  })

  it("should catch SMTP transport errors safely without throwing", async () => {
    const config = new ConfigService({
      SMTP_HOST: "smtp.mailtrap.io",
    })

    mailService = new MailService(config)
    mailService.setTransporter(mockTransporter)
    mockTransporter.sendMail.mockRejectedValue(
      new Error(
        "Simulated SMTP mock transport network failure (expected negative test)",
      ),
    )

    const loggerSpy = vi
      .spyOn((mailService as any).logger, "error")
      .mockImplementation(() => {})

    const sent = await mailService.sendPasswordResetEmail(
      "doctor@clinic.com",
      "token-abc",
    )

    expect(sent).toBe(false)
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining("Simulated SMTP mock transport network failure"),
    )
    loggerSpy.mockRestore()
  })

  it("should skip email delivery safely when SMTP is unconfigured", async () => {
    const config = new ConfigService({})
    mailService = new MailService(config)
    const loggerWarnSpy = vi
      .spyOn((mailService as any).logger, "warn")
      .mockImplementation(() => {})

    const sent = await mailService.sendPasswordResetEmail(
      "doctor@clinic.com",
      "token-abc",
    )
    expect(sent).toBe(false)
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SMTP is not configured"),
    )
    loggerWarnSpy.mockRestore()
  })

  describe("sendPasswordResetOtpEmail", () => {
    it("should format and deliver 6-digit OTP email with 5-minute expiry via SMTP", async () => {
      const config = new ConfigService({
        SMTP_HOST: "smtp.mailtrap.io",
        SMTP_PORT: "587",
        SMTP_USER: "mock-mailer@example.test",
        SMTP_PASS: "mock-test-smtp-token",
        SMTP_FROM: "Cliniqo Security <noreply@cliniqo.app>",
      })

      mailService = new MailService(config)
      mailService.setTransporter(mockTransporter)
      mockTransporter.sendMail.mockResolvedValue({ messageId: "mock-otp-123" })

      const sent = await mailService.sendPasswordResetOtpEmail(
        "doctor@clinic.com",
        "491823",
      )

      expect(sent).toBe(true)
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Cliniqo Security <noreply@cliniqo.app>",
          to: "doctor@clinic.com",
          subject: "Cliniqo Verification Code: 491823",
          text: expect.stringContaining("491823"),
          html: expect.stringContaining("491823"),
        }),
      )

      // Validate that HTML and text explicitly emphasize 5-minute expiry and single-use
      const mailCall = mockTransporter.sendMail.mock.calls[0][0]
      expect(mailCall.text).toContain("expire in 5 minutes")
      expect(mailCall.html).toContain("5 minutes")
      expect(mailCall.text).toContain("can only be used once")
    })

    it("should safely handle SMTP authentication or connection errors without throwing", async () => {
      const config = new ConfigService({
        SMTP_HOST: "smtp.mailtrap.io",
        SMTP_PORT: "587",
        SMTP_USER: "mock-failing-user@example.test",
        SMTP_PASS: "mock-wrong-pass",
      })

      mailService = new MailService(config)
      mailService.setTransporter(mockTransporter)
      mockTransporter.sendMail.mockRejectedValue(
        new Error("Invalid login: 535-5.7.8 Username and Password not accepted"),
      )

      const loggerSpy = vi
        .spyOn((mailService as any).logger, "error")
        .mockImplementation(() => {})

      const sent = await mailService.sendPasswordResetOtpEmail(
        "doctor@clinic.com",
        "123456",
      )

      expect(sent).toBe(false)
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send password reset OTP email"),
      )
      loggerSpy.mockRestore()
    })

    it("should safely return false when SMTP is not configured", async () => {
      const config = new ConfigService({})
      mailService = new MailService(config)
      const loggerWarnSpy = vi
        .spyOn((mailService as any).logger, "warn")
        .mockImplementation(() => {})

      const sent = await mailService.sendPasswordResetOtpEmail(
        "doctor@clinic.com",
        "654321",
      )

      expect(sent).toBe(false)
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SMTP is not configured"),
      )
      loggerWarnSpy.mockRestore()
    })

    it("should initialize Gmail SMTP with STARTTLS and verify connection safely", async () => {
      const config = new ConfigService({
        NODE_ENV: "development",
        SMTP_HOST: "smtp.gmail.com",
        SMTP_PORT: "587",
        SMTP_USER: "doctor@gmail.com",
        SMTP_PASS: "abcd efgh ijkl mnop",
        SMTP_FROM: "Cliniqo <doctor@gmail.com>",
        SMTP_SECURE: "false",
      })

      mailService = new MailService(config)
      const mockVerify = vi.fn().mockResolvedValue(true)
      mailService.setTransporter({
        sendMail: vi.fn(),
        verify: mockVerify,
      } as any)

      await mailService.onModuleInit()
      expect(mockVerify).toHaveBeenCalled()
    })

    it("should handle verify connection failure without throwing and sanitize error logs", async () => {
      const config = new ConfigService({
        NODE_ENV: "development",
        SMTP_HOST: "smtp.gmail.com",
        SMTP_PORT: "587",
        SMTP_USER: "doctor@gmail.com",
        SMTP_PASS: "abcd efgh ijkl mnop",
      })

      mailService = new MailService(config)
      const mockVerify = vi
        .fn()
        .mockRejectedValue(new Error("535 5.7.8 Username and Password not accepted: secret-app-pass"))
      mailService.setTransporter({
        sendMail: vi.fn(),
        verify: mockVerify,
      } as any)

      const loggerSpy = vi
        .spyOn((mailService as any).logger, "error")
        .mockImplementation(() => {})

      await mailService.onModuleInit()
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining("Gmail SMTP connection verification failed"),
      )
      expect(loggerSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("secret-app-pass"),
      )
      loggerSpy.mockRestore()
    })
  })
})
