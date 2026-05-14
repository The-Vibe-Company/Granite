import Stripe from 'stripe';
import type { AppDatabase } from './db.js';
import type { Env, User } from './env.js';

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

export interface BillingPortalResult {
  url: string;
}

export interface CheckoutSyncResult {
  billingStatus: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'pending_checkout';
  subscriptionId: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export interface StripeBilling {
  createCustomer(user: User): Promise<string>;
  createVaultCheckout(input: {
    customerId: string;
    vaultId: string;
    userId: string;
    name: string;
  }): Promise<CheckoutSessionResult>;
  createPortal(input: { customerId: string; returnUrl: string }): Promise<BillingPortalResult>;
  syncCheckoutSession(sessionId: string): Promise<CheckoutSyncResult>;
  parseWebhook(body: string, signature: string): Promise<Stripe.Event>;
}

export function stripeBilling(env: Env): StripeBilling {
  if (env.TEST_STRIPE) return env.TEST_STRIPE;
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_VAULT_1GB_PRICE_ID) {
    throw new Error('Stripe is not configured.');
  }
  return new StripeBillingClient(env);
}

export async function ensureStripeCustomer(db: AppDatabase, billing: StripeBilling, user: User): Promise<string> {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customerId = await billing.createCustomer(user);
  await db.execute('UPDATE users SET stripe_customer_id = $2, updated_at = now() WHERE id = $1', [user.id, customerId]);
  return customerId;
}

class StripeBillingClient implements StripeBilling {
  private stripe: Stripe;

  constructor(private env: Env) {
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-02-25.clover' as any,
      httpClient: Stripe.createFetchHttpClient(),
    });
  }

  async createCustomer(user: User): Promise<string> {
    const customer = await this.stripe.customers.create({
      email: user.email ?? undefined,
      name: user.display_name ?? undefined,
      metadata: { granite_user_id: user.id, neon_user_id: user.neon_user_id ?? '' },
    });
    return customer.id;
  }

  async createVaultCheckout(input: {
    customerId: string;
    vaultId: string;
    userId: string;
    name: string;
  }): Promise<CheckoutSessionResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: input.customerId,
      line_items: [{ price: this.env.STRIPE_VAULT_1GB_PRICE_ID!, quantity: 1 }],
      client_reference_id: input.vaultId,
      success_url: `${this.env.BASE_URL}/app?vault_id=${encodeURIComponent(input.vaultId)}&checkout=success`,
      cancel_url: `${this.env.BASE_URL}/app?vault_id=${encodeURIComponent(input.vaultId)}&checkout=canceled`,
      metadata: {
        granite_vault_id: input.vaultId,
        granite_user_id: input.userId,
        granite_vault_name: input.name,
      },
      subscription_data: {
        metadata: {
          granite_vault_id: input.vaultId,
          granite_user_id: input.userId,
        },
      },
    });
    if (!session.url) throw new Error('Stripe did not return a checkout URL.');
    return { id: session.id, url: session.url };
  }

  async createPortal(input: { customerId: string; returnUrl: string }): Promise<BillingPortalResult> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async syncCheckoutSession(sessionId: string): Promise<CheckoutSyncResult> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });
    const subscription = typeof session.subscription === 'object' && session.subscription && !('deleted' in session.subscription)
      ? session.subscription as any
      : null;
    return {
      billingStatus: subscription ? subscriptionStatus(subscription.status) : 'pending_checkout',
      subscriptionId: typeof session.subscription === 'string' ? session.subscription : subscription?.id ?? null,
      currentPeriodEnd: typeof subscription?.current_period_end === 'number' ? subscription.current_period_end : null,
      cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    };
  }

  async parseWebhook(body: string, signature: string): Promise<Stripe.Event> {
    if (!this.env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook secret is not configured.');
    return this.stripe.webhooks.constructEventAsync(
      body,
      signature,
      this.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  }
}

export function subscriptionStatus(status: string): 'active' | 'past_due' | 'canceled' | 'unpaid' | 'pending_checkout' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'unpaid':
      return 'unpaid';
    default:
      return 'pending_checkout';
  }
}
