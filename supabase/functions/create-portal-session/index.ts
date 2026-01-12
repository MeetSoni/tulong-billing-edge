import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2023-10-16" });

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401 });
    }
    const jwt = authHeader.replace("Bearer ", "");

    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    }
    const user = userRes.user;

    const { return_url } = await req.json().catch(() => ({}));

    const { data: customerRow } = await supabaseAdmin
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .maybeSingle();

    if (!customerRow?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: "Stripe customer not found. Subscribe first." }), { status: 400 });
    }

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerRow.stripe_customer_id,
      return_url: return_url ?? "https://YOUR-BUBBLE-DOMAIN.com/account",
    });

    return new Response(JSON.stringify({ url: portal.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
