import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Replace these with your real price IDs
const INDIVIDUAL_PRICE_ID = "price_INDIVIDUAL";
const ENTERPRISE_PRICE_ID = "price_ENTERPRISE";

function planFromPrice(priceId: string | null) {
  if (!priceId) return "freemium";
  if (priceId === INDIVIDUAL_PRICE_ID) return "individual";
  if (priceId === ENTERPRISE_PRICE_ID) return "enterprise";
  return "freemium";
}

Deno.serve(async (req) => {
  try {
    const sig = req.headers.get("stripe-signature");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

    if (!sig || !webhookSecret) return new Response("Missing signature/secret", { status: 400 });

    const body = await req.text();
    const event = stripe.webhooks.constructEvent(body, sig, webhookSecret);

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object as Stripe.Subscription;

      const stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const subscriptionId = sub.id;
      const status = sub.status;

      const priceId = sub.items.data?.[0]?.price?.id ?? null;

      const { data: customerRow } = await supabaseAdmin
        .from("billing_customers")
        .select("id")
        .eq("stripe_customer_id", stripeCustomerId)
        .maybeSingle();

      const userId = customerRow?.id;
      if (!userId) return new Response("User not found for customer", { status: 200 });

      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      await supabaseAdmin.from("billing_subscriptions").upsert({
        id: subscriptionId,
        user_id: userId,
        status,
        price_id: priceId,
        current_period_end: currentPeriodEnd,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
        updated_at: new Date().toISOString(),
      });

      // Update profiles table (must exist)
      const plan = planFromPrice(priceId);
      await supabaseAdmin.from("profiles").update({
        plan,
        subscription_status: status,
      }).eq("id", userId);
    }

    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(`Webhook Error: ${String(e)}`, { status: 400 });
  }
});
