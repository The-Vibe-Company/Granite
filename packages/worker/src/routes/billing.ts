import { Hono } from 'hono';
import type { Env } from '../env.js';
import { StripeClient, verifyWebhookSignature } from '../lib/stripe.js';

const billing = new Hono<{ Bindings: Env }>();

/**
 * GET /billing/checkout — Create a Stripe Checkout session and redirect.
 */
billing.get('/billing/checkout', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required. Run: granite cloud login' }, 401);

  if (user.tier === 'pro') {
    return c.json({ error: 'Already on Pro tier', tier: 'pro' }, 400);
  }

  if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_PRICE_ID) {
    return c.json({ error: 'Stripe not configured' }, 503);
  }

  const stripe = new StripeClient(c.env.STRIPE_SECRET_KEY);

  const session = await stripe.createCheckoutSession({
    priceId: c.env.STRIPE_PRICE_ID,
    customerId: user.stripe_customer_id || undefined,
    customerEmail: !user.stripe_customer_id ? (user.email || undefined) : undefined,
    metadata: { granite_user_id: user.id },
    successUrl: `${c.env.BASE_URL}/billing/success`,
    cancelUrl: `${c.env.BASE_URL}/billing/cancel`,
  });

  return c.redirect(session.url);
});

/**
 * GET /billing/portal — Redirect to Stripe Customer Portal.
 */
billing.get('/billing/portal', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Authentication required' }, 401);

  if (!user.stripe_customer_id) {
    return c.json({ error: 'No billing account found. Upgrade first: granite cloud upgrade' }, 400);
  }

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json({ error: 'Stripe not configured' }, 503);
  }

  const stripe = new StripeClient(c.env.STRIPE_SECRET_KEY);

  const session = await stripe.createPortalSession({
    customerId: user.stripe_customer_id,
    returnUrl: c.env.BASE_URL + '/billing/portal-return',
  });

  return c.redirect(session.url);
});

function billingPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Granite Cloud - ${title}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; text-align: center; color: #1a1a1a; }
  code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #e5e5e5; }
    code { background: #2a2a2a; color: #e5e5e5; }
  }
</style></head>
<body><main>${body}</main></body></html>`;
}

billing.get('/billing/success', (c) => {
  return c.html(billingPage('Upgrade successful', `
    <h1>Welcome to Pro!</h1>
    <p>Your Granite Cloud account has been upgraded. You now have:</p>
    <ul style="text-align:left;display:inline-block;">
      <li>Multi-device sync</li>
      <li>1 GB of cloud storage</li>
      <li>Up to 10 vaults</li>
      <li>Remote MCP access</li>
    </ul>
    <p>You can close this tab and continue using <code>granite</code>.</p>`));
});

billing.get('/billing/cancel', (c) => {
  return c.html(billingPage('Checkout cancelled', `
    <h1>Checkout cancelled</h1>
    <p>No worries! You can upgrade anytime by running <code>granite cloud upgrade</code>.</p>`));
});

billing.get('/billing/portal-return', (c) => {
  return c.html(billingPage('Billing', `
    <h1>Billing updated</h1>
    <p>Your billing changes have been saved. You can close this tab.</p>`));
});

/**
 * POST /webhooks/stripe — Handle Stripe webhook events.
 */
billing.post('/webhooks/stripe', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ error: 'Webhook secret not configured' }, 503);
  }

  const sigHeader = c.req.header('Stripe-Signature');
  if (!sigHeader) {
    return c.json({ error: 'Missing Stripe-Signature header' }, 400);
  }

  const body = await c.req.text();

  const isValid = await verifyWebhookSignature(body, sigHeader, c.env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  const event = JSON.parse(body) as {
    type: string;
    data: { object: Record<string, unknown> };
  };

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = (session.metadata as Record<string, string>)?.granite_user_id;
      const customerId = session.customer as string;
      const subscriptionId = session.subscription as string;

      if (!userId) {
        console.error('Webhook: checkout.session.completed without granite_user_id');
        break;
      }

      await c.env.DB.prepare(`
        UPDATE users
        SET stripe_customer_id = ?, stripe_subscription_id = ?, tier = 'pro', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).bind(customerId, subscriptionId, userId).run();

      console.log(`User ${userId} upgraded to Pro (customer: ${customerId})`);
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const subscriptionId = subscription.id as string;

      await c.env.DB.prepare(`
        UPDATE users
        SET tier = 'free', stripe_subscription_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE stripe_subscription_id = ?
      `).bind(subscriptionId).run();

      console.log(`Subscription ${subscriptionId} cancelled — user downgraded to free`);
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const subscriptionId = subscription.id as string;
      const status = subscription.status as string;

      if (['past_due', 'unpaid', 'canceled', 'incomplete_expired'].includes(status)) {
        await c.env.DB.prepare(`
          UPDATE users SET tier = 'free', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE stripe_subscription_id = ?
        `).bind(subscriptionId).run();
        console.log(`Subscription ${subscriptionId} status ${status} — downgraded to free`);
      } else if (status === 'active') {
        await c.env.DB.prepare(`
          UPDATE users SET tier = 'pro', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE stripe_subscription_id = ?
        `).bind(subscriptionId).run();
        console.log(`Subscription ${subscriptionId} active — upgraded to pro`);
      }
      break;
    }

    default:
      break;
  }

  return c.json({ received: true });
});

export default billing;
