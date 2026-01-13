// supabase/functions/create-checkout-session/index.ts

import Stripe from "npm:stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- CORS helpers ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // 0) Handle preflight (Bubble browser requests)
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1) Allow only POST
    if (req.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    // 2) Read Authorization header (Supabase access token)
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const jwt = authHeader.slice("Bearer ".length).trim();

    // 3) Create Supabase admin client (service role)
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    // 4) Validate the JWT and fetch user
    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: "Invalid token", details: userErr?.message }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const user = userRes.user;

    // 5) Read body
    const { price_id, success_url, cancel_url } = await req.json();

    if (!price_id) {
      return new Response(JSON.stringify({ error: "price_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 6) Create Stripe client using fetch httpClient (IMPORTANT for Edge runtime)
    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // 7) Find Stripe customer in your DB
    // ✅ IMPORTANT: use user_id (not id) if your table is billing_customers(user_id, stripe_customer_id)
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingErr) {
      return new Response(JSON.stringify({ error: "DB error", details: existingErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let stripeCustomerId = existing?.stripe_customer_id ?? null;

    // 8) Create customer if not exists
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { user_id: user.id },
      });

      stripeCustomerId = customer.id;

      // Upsert into billing_customers
      const { error: upsertErr } = await supabaseAdmin
        .from("billing_customers")
        .upsert({
          user_id: user.id,
          stripe_customer_id: stripeCustomerId,
        });

      if (upsertErr) {
        return new Response(JSON.stringify({ error: "DB upsert error", details: upsertErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 9) Create checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: price_id, quantity: 1 }],
      success_url: success_url ?? "https://tulongmedia.tech/account?checkout=success",
      cancel_url: cancel_url ?? "https://tulongmedia.tech/pricing?checkout=cancel",
      metadata: { user_id: user.id },
    });

    // 10) Return URL
    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
