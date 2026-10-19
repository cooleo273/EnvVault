/** Content of a workspace invitation email. Contains a one-time link: never log it. */
export interface InvitationEmail {
  to: string;
  workspaceName: string;
  inviterName: string | null;
  roleName: string;
  acceptUrl: string;
  expiresAt: Date;
}

export type DeliveryStatus = 'sent' | 'not_configured' | 'failed';

/**
 * Outbound email. Implementations must not log message bodies or links.
 * Providers (SMTP, SES, Postmark, ...) plug in here once one is approved.
 */
export interface Mailer {
  readonly configured: boolean;
  sendInvitation(message: InvitationEmail): Promise<DeliveryStatus>;
}

export const MAILER = Symbol('MAILER');

/**
 * Used while no email provider is configured. It sends nothing and says so:
 * callers report `not_configured` and hand the inviter a link to share
 * instead of claiming the invitation was emailed.
 */
export class UnconfiguredMailer implements Mailer {
  readonly configured = false;

  sendInvitation(): Promise<DeliveryStatus> {
    return Promise.resolve('not_configured');
  }
}
