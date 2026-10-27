// Calculadora Combustível: pagamento do plano Pro pelo Mercado Pago (Supabase Edge Function, SEM verificação de JWT)
// Ações (POST JSON, com login): criar {plano}, confirmar {payment_id}.
// Sem "action": aviso (webhook) do Mercado Pago. O pagamento é sempre conferido direto na API do Mercado Pago.
// Segredos (Edge Functions > Secrets): MP_ACCESS_TOKEN (obrigatório), MP_WEBHOOK_SECRET (opcional, assinatura dos avisos)
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const TOKEN = Deno.env.get("MP_ACCESS_TOKEN") ?? "";
const WH_SECRET = Deno.env.get("MP_WEBHOOK_SECRET") ?? "";
const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPA_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ORIGINS = ["https://app.gabreutri.com.br", "https://gabreutri.netlify.app"];
const MP = "https://api.mercadopago.com";
const PLANOS: Record<string, { valor: number; dias: number; titulo: string }> = {
  mensal: { valor: 19.9, dias: 30, titulo: "Combustível Pro · 1 mês" },
  anual: { valor: 119.0, dias: 365, titulo: "Combustível Pro · 1 ano" },
};

function cors(req: Request) {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

async function mp(method: string, path: string, body?: unknown, idem?: string) {
  const r = await fetch(MP + path, {
    method,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(idem ? { "X-Idempotency-Key": idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const STATUS: Record<string, string> = {
  approved: "aprovado", authorized: "pendente", pending: "pendente", in_process: "pendente", in_mediation: "pendente",
  rejected: "recusado", cancelled: "recusado", refunded: "estornado", charged_back: "estornado",
};

// Confere o pagamento na API do Mercado Pago e atualiza o banco. Retorna o status gravado.
async function aplicar(paymentId: string, onlyUser?: string) {
  const { ok, data: p } = await mp("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
  if (!ok || !p?.id) return { error: "pagamento_nao_encontrado" };
  const ref = String(p.external_reference ?? "");
  const { data: row } = await admin.from("pagamentos").select("*").eq("id", ref).maybeSingle();
  if (!row) return { error: "referencia" };
  if (onlyUser && row.user_id !== onlyUser) return { error: "outro_usuario" };
  const st = STATUS[p.status] ?? "pendente";
  const pid = String(p.id);
  // valor e moeda precisam bater com o que foi cobrado
  if (st === "aprovado" && (p.currency_id !== "BRL" || Math.abs(Number(p.transaction_amount) - Number(row.valor)) > 0.01)) {
    return { error: "valor" };
  }
  // um aviso de outra tentativa recusada não derruba um pagamento já aprovado
  if (row.status === "aprovado" && row.mp_payment_id && row.mp_payment_id !== pid && st !== "aprovado") {
    return { status: row.status };
  }
  const upd: Record<string, unknown> = { status: st, mp_payment_id: pid, metodo: p.payment_type_id ?? null };
  if (st === "aprovado") upd.pago_em = p.date_approved ?? new Date().toISOString();
  const { error } = await admin.from("pagamentos").update(upd).eq("id", row.id);
  if (error) return { error: "banco" };
  const { data: ate } = await admin.rpc("recalcular_acesso", { p_user: row.user_id });
  return { status: st, ate };
}

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assinaturaOk(req: Request, dataId: string) {
  if (!WH_SECRET) return true;
  const parts = Object.fromEntries((req.headers.get("x-signature") ?? "").split(",").map((s) => s.trim().split("=", 2)));
  const rid = req.headers.get("x-request-id") ?? "";
  if (!parts.ts || !parts.v1) return false;
  let man = "";
  if (dataId) man += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
  if (rid) man += `request-id:${rid};`;
  man += `ts:${parts.ts};`;
  return (await hmacHex(WH_SECRET, man)) === parts.v1;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (!TOKEN) return json(req, { error: "config" }, 500);
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));

  try {
    // Aviso do Mercado Pago (webhook ou IPN)
    if (!body.action) {
      const type = url.searchParams.get("type") ?? url.searchParams.get("topic") ?? body.type ?? body.topic ?? "";
      const id = url.searchParams.get("data.id") ?? (url.searchParams.get("topic") ? url.searchParams.get("id") : null) ??
        body?.data?.id ?? "";
      if (type !== "payment" || !id) return json(req, { ok: true });
      if (!(await assinaturaOk(req, String(id)))) return json(req, { error: "assinatura" }, 401);
      const r = await aplicar(String(id));
      return json(req, { ok: true, ...r });
    }

    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json(req, { error: "login" }, 401);

    switch (body.action) {
      case "criar": {
        const pl = PLANOS[body.plano];
        if (!pl) return json(req, { error: "plano" }, 400);
        const origin = req.headers.get("origin") ?? "";
        const site = ORIGINS.includes(origin) ? origin : ORIGINS[0];
        const { data: row, error } = await admin.from("pagamentos")
          .insert({ user_id: user.id, plano: body.plano, valor: pl.valor, dias: pl.dias }).select().single();
        if (error || !row) return json(req, { error: "banco" }, 500);
        const back = (s: string) => `${site}/?pagamento=${s}`;
        const pref = await mp("POST", "/checkout/preferences", {
          items: [{ id: `pro-${body.plano}`, title: pl.titulo, quantity: 1, unit_price: pl.valor, currency_id: "BRL" }],
          payer: { email: user.email },
          external_reference: row.id,
          back_urls: { success: back("ok"), pending: back("pendente"), failure: back("falhou") },
          auto_return: "approved",
          notification_url: `${SUPA_URL}/functions/v1/pagamento`,
          statement_descriptor: "GABREUTRI",
          payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }], installments: body.plano === "anual" ? 3 : 1 },
          metadata: { pagamento_id: row.id },
        }, row.id);
        if (!pref.ok || !pref.data?.init_point) {
          await admin.from("pagamentos").update({ status: "recusado" }).eq("id", row.id);
          return json(req, { error: "mercadopago", detail: pref.data?.message ?? pref.status }, 502);
        }
        await admin.from("pagamentos").update({ mp_preference_id: pref.data.id }).eq("id", row.id);
        return json(req, { url: pref.data.init_point });
      }
      case "confirmar": {
        if (!body.payment_id) return json(req, { error: "params" }, 400);
        return json(req, await aplicar(String(body.payment_id), user.id));
      }
      default:
        return json(req, { error: "acao" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json(req, { error: "interno" }, 500);
  }
});
