// wa-auth-worker: Tech Provider onboarding after Embedded Signup.
// Env: FB_APP_ID, FB_APP_SECRET (secrets), WA_TOKENS (KV namespace binding).
//
// Flow (docs: onboarding-customers-as-a-tech-provider + onboarding-business-app-users):
//   1. exchange code -> business token
//   2. subscribe app to the customer's WABA webhooks
//   3. register the phone number (skipped for WhatsApp Business app / coexistence numbers)

const ALLOWED_ORIGIN = "https://davidlev.dev";
const GRAPH = "https://graph.facebook.com/v24.0";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }
    if (request.headers.get("Origin") !== ALLOWED_ORIGIN) {
      return json({ error: "Forbidden origin" }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const { code, waba_id, coexistence } = body;
    let { phone_number_id } = body;
    if (!code || !waba_id) {
      return json({ error: "Missing code or waba_id" }, 400);
    }

    const steps = [];
    const step = (name, ok, detail) => {
      steps.push({ step: name, ok, ...(detail !== undefined && { detail }) });
      return ok;
    };
    const fail = (status = 502) => json({ success: false, steps }, status);

    // 1. Exchange the code for a business token
    const tokenUrl = new URL(`${GRAPH}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", env.FB_APP_ID);
    tokenUrl.searchParams.set("client_secret", env.FB_APP_SECRET);
    tokenUrl.searchParams.set("code", code);
    const tokenRes = await graph(tokenUrl.toString());
    if (!step("exchange_token", tokenRes.ok, tokenRes.ok ? undefined : tokenRes.data)) return fail(400);
    const token = tokenRes.data.access_token;

    // 2. Subscribe to webhooks on the customer's WABA
    const sub = await graph(`${GRAPH}/${waba_id}/subscribed_apps`, token, { method: "POST" });
    if (!step("subscribe_webhooks", sub.ok, sub.ok ? undefined : sub.data)) return fail();

    // Resolve the phone number ID if Embedded Signup did not return it (coexistence only returns waba_id)
    if (!phone_number_id) {
      const phones = await graph(`${GRAPH}/${waba_id}/phone_numbers`, token);
      phone_number_id = phones.data?.data?.[0]?.id;
      if (!step("resolve_phone_number", Boolean(phone_number_id), phones.ok ? undefined : phones.data)) return fail();
    }

    // Is this number also on the WhatsApp Business app?
    const info = await graph(`${GRAPH}/${phone_number_id}?fields=is_on_biz_app,platform_type`, token);
    const onBizApp = Boolean(coexistence) || info.data?.is_on_biz_app === true;

    // 3. Register the number (not for WhatsApp Business app numbers: already registered)
    let pin = null;
    if (!onBizApp) {
      pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      const reg = await graph(`${GRAPH}/${phone_number_id}/register`, token, {
        method: "POST",
        body: { messaging_product: "whatsapp", pin },
      });
      if (!step("register_phone_number", reg.ok, reg.ok ? undefined : reg.data)) return fail();
    } else {
      step("register_phone_number", true, "skipped (WhatsApp Business app number)");
    }

    // Persist the token (and PIN) before the syncs, so a sync failure doesn't lose them
    if (env.WA_TOKENS) {
      await env.WA_TOKENS.put(
        `waba:${waba_id}`,
        JSON.stringify({ token, waba_id, phone_number_id, pin, coexistence: onBizApp, onboarded_at: new Date().toISOString() }),
      );
      step("store_token", true);
    } else {
      step("store_token", false, "WA_TOKENS KV binding missing; token was not saved");
    }

    const ok = steps.every((s) => s.ok);
    return json({ success: ok, waba_id, phone_number_id, coexistence: onBizApp, steps }, ok ? 200 : 502);
  },
};

async function graph(url, token, { method = "GET", body } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { "Content-Type": "application/json" }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch (err) {
    return { ok: false, data: { error: String(err) } };
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders() });
}
