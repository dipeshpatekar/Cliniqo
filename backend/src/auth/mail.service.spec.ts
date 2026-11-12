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

  describe("Gmail API OAuth2 Delivery (HTTPS)", () => {
    const originalFetch = globalThis.fetch

    beforeEach(() => {
      vi.restoreAllMocks()
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it("should successfully obtain access token and send OTP email via Gmail API", async () => {
      const config = new ConfigService({
        GMAIL_CLIENT_ID: "test-client-id",
        GMAIL_CLIENT_SECRET: "test-client-secret",
        GMAIL_REFRESH_TOKEN: "test-refresh-token",
        GMAIL_USER: "support@cliniqo.app",
      })

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "mock-access-token-xyz",
              expires_in: 3600,
            }),
          } as Response)
        }
        if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              id: "gmail-msg-id-12345",
            }),
          } as Response)
        }
        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`))
      })

      globalThis.fetch = mockFetch

      mailService = new MailService(config)

      const sent = await mailService.sendPasswordResetOtpEmail(
        "patient@example.com",
        "765432",
      )

      expect(sent).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Check token request
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://oauth2.googleapis.com/token",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: expect.stringContaining("refresh_token=test-refresh-token"),
        }),
      )

      // Check Gmail API send request
      const sendCallArgs = mockFetch.mock.calls[1]
      expect(sendCallArgs[0]).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
      expect(sendCallArgs[1].headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer mock-access-token-xyz",
          "Content-Type": "application/json",
        }),
      )
      const body = JSON.parse(sendCallArgs[1].body as string)
      expect(body.raw).toBeDefined()
      // Decode raw to confirm OTP 765432 is contained in MIME
      const decodedMime = Buffer.from(body.raw, "base64url").toString("utf-8")
      expect(decodedMime).toContain("To: patient@example.com")
      // Check that the text base64 part contains 765432
      const textBase64Match = decodedMime.match(/Content-Type: text\/plain[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/)
      expect(textBase64Match).toBeTruthy()
      const decodedText = Buffer.from(textBase64Match![1], "base64").toString("utf-8")
      expect(decodedText).toContain("765432")
      expect(decodedText).toContain("expire in 5 minutes")
    })

    it("caches access token across multiple calls without re-fetching", async () => {
      const config = new ConfigService({
        GMAIL_CLIENT_ID: "test-client-id",
        GMAIL_CLIENT_SECRET: "test-client-secret",
        GMAIL_REFRESH_TOKEN: "test-refresh-token",
        GMAIL_USER: "support@cliniqo.app",
      })

      let tokenFetchCount = 0
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url === "https://oauth2.googleapis.com/token") {
          tokenFetchCount++
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "mock-cached-access-token",
              expires_in: 3600,
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: "msg-1" }),
        } as Response)
      })

      globalThis.fetch = mockFetch
      mailService = new MailService(config)

      await mailService.sendPasswordResetOtpEmail("doc1@clinic.com", "111111")
      await mailService.sendPasswordResetOtpEmail("doc2@clinic.com", "222222")

      expect(tokenFetchCount).toBe(1)
    })

    it("sanitizes error logs and fails safely if Gmail API returns error status", async () => {
      const config = new ConfigService({
        GMAIL_CLIENT_ID: "test-client-id",
        GMAIL_CLIENT_SECRET: "test-client-secret",
        GMAIL_REFRESH_TOKEN: "test-refresh-token",
        GMAIL_USER: "support@cliniqo.app",
      })

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url === "https://oauth2.googleapis.com/token") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              access_token: "sensitive-token-123",
              expires_in: 3600,
            }),
          } as Response)
        }
        return Promise.resolve({
          ok: false,
          status: 403,
          text: async () => '{"error": "access_denied", "secret": "leaked-secret-value"}',
        } as Response)
      })

      globalThis.fetch = mockFetch
      mailService = new MailService(config)

      const loggerSpy = vi
        .spyOn((mailService as any).logger, "error")
        .mockImplementation(() => {})

      const sent = await mailService.sendPasswordResetOtpEmail(
        "doc@clinic.com",
        "999999",
      )

      expect(sent).toBe(false)
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send email via Gmail API"),
      )
      expect(loggerSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("leaked-secret-value"),
      )
      loggerSpy.mockRestore()
    })
  })
})
