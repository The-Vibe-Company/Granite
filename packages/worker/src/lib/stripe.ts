/**
 * Minimal Stripe API client using fetch.
 * No SDK needed — Cloudflare Workers calls the Stripe REST API directly.
 */
export class StripeClient {
  private secretKey: string;
  private baseUrl = 'https://api.stripe.com/v1';

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? new URLSearchParams(body).toString() : undefined,
    });

    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const error = data.error as { message?: string } | undefined;
      throw new Error(error?.message || `Stripe API error: ${response.status}`);
    }
    return data;
  }

  async createCheckoutSession(params: {
    priceId: string;
    customerId?: string;
    customerEmail?: string;
    metadata: Record<string, string>;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }> {
    const body: Record<string, string> = {
      'mode': 'subscription',
      'line_items[0][price]': params.priceId,
      'line_items[0][quantity]': '1',
      'success_url': params.successUrl,
      'cancel_url': params.cancelUrl,
    };

    if (params.customerId) {
      body['customer'] = params.customerId;
    } else if (params.customerEmail) {
      body['customer_email'] = params.customerEmail;
    }

    for (const [key, value] of Object.entries(params.metadata)) {
      body[`metadata[${key}]`] = value;
    }

    const data = await this.request('POST', '/checkout/sessions', body);
    return { id: data.id as string, url: data.url as string };
  }

  async createPortalSession(params: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const data = await this.request('POST', '/billing_portal/sessions', {
      'customer': params.customerId,
      'return_url': params.returnUrl,
    });
    return { url: data.url as string };
  }

  async getSubscription(subscriptionId: string): Promise<{
    id: string;
    status: string;
    customer: string;
  }> {
    const data = await this.request('GET', `/subscriptions/${subscriptionId}`);
    return {
      id: data.id as string,
      status: data.status as string,
      customer: data.customer as string,
    };
  }
}

/**
 * Verify Stripe webhook signature (no SDK needed).
 */
export async function verifyWebhookSignature(
  payload: string,
  sigHeader: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  const parts = sigHeader.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));

  if (!timestamp || signatures.length === 0) return false;

  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload),
  );
  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return signatures.some(sig => timingSafeEqual(sig, expectedSignature));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
