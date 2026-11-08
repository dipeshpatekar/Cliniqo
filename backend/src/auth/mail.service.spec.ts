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
})
