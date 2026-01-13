import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function formEncode(data: Record<string, string>) {
  return new URLSearchParams(data).toString();
}

async function stripePost(path: string, body: Record<string, string>) {
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) throw new Error("Missing STRIPE_SECRET_KEY");

  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formEncode(body),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe error: ${JSON.stringify(json)}`);
  }
  return json;
}

Deno.serve(async (req) => {
  // Preflight
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    // 1) Read JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const jwt = authHeader.slice("Bearer ".length).trim();

    // 2) Supabase admin client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } }
    );

    // 3) Validate token
    const { data: userRes, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: "Invalid token", details: userErr?.message }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userRes.user;

    // 4) Parse request body
    const { price_id, success_url, cancel_url } = await req.json();
    if (!price_id) {
      return new Response(JSON.stringify({ error: "price_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5) Find stripe customer in DB
    const { data: existing, error: exErr } = await supabase
      .from("billing_customers")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (exErr) throw new Error(exErr.message);

    let stripeCustomerId = existing?.stripe_customer_id as string | undefined;

    // 6) Create customer if not exists (Stripe REST)
    if (!stripeCustomerId) {
      const customer = await stripePost("/customers", {
        email: user.email ?? "",
        [`metadata[user_id]`]: user.id,
      });

      stripeCustomerId = customer.id;

      const { error: upErr } = await supabase
        .from("billing_customers")
        .upsert({ user_id: user.id, stripe_customer_id: stripeCustomerId });

      if (upErr) throw new Error(upErr.message);
    }

    // 7) Create checkout session (Stripe REST)
    const session = await stripePost("/checkout/sessions", {
      mode: "subscription",
      customer: stripeCustomerId,
      "line_items[0][price]": price_id,
      "line_items[0][quantity]": "1",
      success_url: success_url ?? "https://tulongmedia.tech/account?checkout=success",
      cancel_url: cancel_url ?? "https://tulongmedia.tech/pricing?checkout=cancel",
      [`metadata[user_id]`]: user.id,
    });

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
