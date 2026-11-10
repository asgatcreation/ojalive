/**
 * The payment boundary.
 *
 * Ojà Live never touches a raw card number. Every flow hands off to a provider's
 * hosted checkout and then believes nothing until a signed webhook has been
 * re-verified against the provider's own API.
 *
 * This interface exists so the rest of the system depends on a shape we control
 * rather than on Paystack's or Flutterwave's response bodies. Milestone 8
 * implements it with naija-pay (https://github.com/asgatcreation/naija-pay).
 */

import type { Kobo } from '@ojalive/shared';

export type ProviderName = 'paystack' | 'flutterwave';

export type PaymentPurpose = 'bidding_deposit' | 'invoice_balance' | 'buy_now' | 'deposit_topup';

export interface InitiatePaymentRequest {
  readonly reference: string;
  readonly amountKobo: Kobo;
  readonly purpose: PaymentPurpose;
  readonly customer: {
    readonly userId: string;
    readonly email: string;
    readonly phone?: string;
  };
  readonly callbackUrl: string;
  /** Echoed back by the provider and stored against the payment row. */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface InitiatePaymentResult {
  readonly provider: ProviderName;
  readonly providerReference: string;
  /** Where to send the bidder's browser. */
  readonly checkoutUrl: string;
}

export type PaymentStatus = 'pending' | 'successful' | 'failed' | 'abandoned' | 'reversed';

export interface VerifiedPayment {
  readonly provider: ProviderName;
  readonly providerReference: string;
  readonly reference: string;
  readonly status: PaymentStatus;
  readonly amountKobo: Kobo;
  readonly currency: 'NGN';
  readonly paidAt: Date | null;
  readonly channel: 'card' | 'bank_transfer' | 'ussd' | 'other';
}

export interface RefundRequest {
  readonly providerReference: string;
  readonly amountKobo: Kobo;
  readonly reason: string;
}

export interface PayoutRequest {
  readonly reference: string;
  readonly amountKobo: Kobo;
  readonly recipient: {
    readonly accountNumber: string;
    readonly bankCode: string;
    readonly accountName: string;
  };
  readonly narration: string;
}

/**
 * A webhook as received: raw body plus headers, never a parsed object. The
 * signature must be checked against the exact bytes the provider signed.
 */
export interface IncomingWebhook {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface WebhookVerdict {
  readonly signatureValid: boolean;
  /** Stable per-event id from the provider. Our idempotency key for webhooks. */
  readonly providerEventId: string | null;
  readonly reference: string | null;
}

export interface PaymentGateway {
  readonly name: ProviderName;

  initiate(request: InitiatePaymentRequest): Promise<InitiatePaymentResult>;

  /**
   * Ask the provider what actually happened. Called after every webhook, and on
   * a schedule for anything still pending — a webhook alone is never proof.
   */
  verify(reference: string): Promise<VerifiedPayment>;

  /** Check a webhook's signature without trusting its contents. */
  verifyWebhook(webhook: IncomingWebhook): WebhookVerdict;

  refund(request: RefundRequest): Promise<{ accepted: boolean; providerReference: string }>;

  payout(request: PayoutRequest): Promise<{ accepted: boolean; providerReference: string }>;
}

/** Thrown when a provider is unreachable or returns something unusable. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}
