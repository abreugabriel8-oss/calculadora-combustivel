// Calculadora Combustível: integração com o Strava (Supabase Edge Function, SEM verificação de JWT)
// A mesma função atende o app e os avisos do Strava:
//   App (POST JSON, com login): auth_url {state, redirect_uri}, token {code}, status, sincronizar, disconnect
//   Strava (webhook): GET de validação e POST de eventos em .../functions/v1/strava?k=<verify_token>
// Segredos (Edge Functions > Secrets): STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
// O aviso (webhook) é assinado sozinho na primeira conexão. O verify_token fica na tabela config_strava.
// Regras do Strava respeitadas: dados só para o próprio atleta, guardados no máximo 7 dias, sem uso em IA.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const CID = Deno.env.get("STRAVA_CLIENT_ID") ?? "";
const CSEC = Deno.env.get("STRAVA_CLIENT_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ORIGINS = ["https://app.gabreutri.com.br", "https://gabreutri.netlify.app"];
const API = "https://www.strava.com/api/v3";

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

// ---------- tokens ----------
type Conn = { user_id: string; athlete_id: number; access_token: string; refresh_token: string; expires_at: string };
async function tokenReq(params: Record<string, string>) {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, ...params }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token ${r.status}: ${JSON.stringify(t).slice(0, 200)}`);
  return t;
}
async function accessFor(c: Conn): Promise<string> {
  if (new Date(c.expires_at).getTime() - Date.now() > 120_000) return c.access_token;
  const t = await tokenReq({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  await admin.from("strava_conexoes").update({
    access_token: t.access_token, refresh_token: t.refresh_token, expires_at: new Date(t.expires_at * 1000).toISOString(),
  }).eq("user_id", c.user_id);
  return t.access_token;
}
async function strava(tok: string, path: string) {
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${tok}` } });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
}

// ---------- atividade do Strava no formato do diário ----------
const RUN = new Set(["Run", "TrailRun", "VirtualRun"]);
const RIDE = new Set(["Ride", "GravelRide", "MountainBikeRide", "VirtualRide", "Velomobile", "Handcycle"]);
// deno-lint-ignore no-explicit-any
function normaliza(a: any) {
  const t = String(a?.sport_type ?? a?.type ?? "");
  let tipo: string | null = null;
  if (RUN.has(t)) tipo = t === "VirtualRun" ? "VIRTUAL_RUN" : a.trainer ? "TREADMILL_RUNNING" : t === "TrailRun" ? "TRAIL_RUNNING" : "RUNNING";
  else if (RIDE.has(t)) tipo = t === "VirtualRide" ? "VIRTUAL_RIDE" : a.trainer ? "INDOOR_CYCLING" : "CYCLING";
  if (!tipo) return null;
  const ini = Date.parse(String(a.start_date_local ?? a.start_date ?? ""));
  return {
    fonte: "strava",
    activityType: tipo,
    nome: String(a.name ?? "").slice(0, 120),
    durationInSeconds: Math.round(a.moving_time ?? a.elapsed_time ?? 0),
    elapsedInSeconds: Math.round(a.elapsed_time ?? 0),
    distanceInMeters: a.distance ?? null,
    averageHeartRateInBeatsPerMinute: a.average_heartrate ?? null,
    // horário local guardado como se fosse UTC (o app mostra a data em UTC, igual ao Garmin)
    startTimeInSeconds: Number.isFinite(ini) ? Math.round(ini / 1000) : null,
    startTimeOffsetInSeconds: 0,
    deviceName: a.device_name ?? null,
  };
}
// deno-lint-ignore no-explicit-any
async function guardar(userId: string, a: any) {
  const d = normaliza(a);
  if (!d || !a?.id || (d.durationInSeconds ?? 0) < 600) return null;
  // passou do prazo de 7 dias: não guarda
  if (d.startTimeInSeconds && Date.now() / 1000 - d.startTimeInSeconds > 7 * 86400 + 86400) return null;
  const { data: ja } = await admin.from("strava_atividades").select("registrado").eq("user_id", userId).eq("activity_id", a.id).maybeSingle();
  await admin.from("strava_atividades").upsert({ user_id: userId, activity_id: a.id, dados: d }, { onConflict: "user_id,activity_id" });
  return ja ? null : d; // devolve só quando é nova
}

// ---------- aviso do Strava (webhook) ----------
async function cfg() {
  const { data } = await admin.from("config_strava").select("verify_token,webhook_id").eq("id", 1).single();
  return data as { verify_token: string; webhook_id: number | null } | null;
}
async function garantirWebhook() {
  const c = await cfg();
  if (!c) return "sem_tabela";
  const lista = await fetch(`${API}/push_subscriptions?client_id=${CID}&client_secret=${encodeURIComponent(CSEC)}`).then((r) => r.json()).catch(() => []);
  // a chave vai no caminho (e não em ?k=): o Strava acrescenta os próprios parâmetros na validação
  const cb = `${SB_URL}/functions/v1/strava/wh/${c.verify_token}`;
  // deno-lint-ignore no-explicit-any
  const atual = Array.isArray(lista) ? lista.find((s: any) => s.callback_url === cb) : null;
  if (atual) {
    if (c.webhook_id !== atual.id) await admin.from("config_strava").update({ webhook_id: atual.id }).eq("id", 1);
    return "ok";
  }
  // só existe uma assinatura por app: remove outra que esteja apontando para lugar errado
  // deno-lint-ignore no-explicit-any
  for (const s of (Array.isArray(lista) ? lista : []) as any[]) {
    await fetch(`${API}/push_subscriptions/${s.id}?client_id=${CID}&client_secret=${encodeURIComponent(CSEC)}`, { method: "DELETE" });
  }
  const r = await fetch(`${API}/push_subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, callback_url: cb, verify_token: c.verify_token }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.id) { await admin.from("config_strava").update({ webhook_id: j.id }).eq("id", 1); return "ok"; }
  console.log("webhook", r.status, JSON.stringify(j).slice(0, 300));
  return "falhou";
}
async function webhookCerto() {
  const c = await cfg();
  if (!c) return false;
  const lista = await fetch(`${API}/push_subscriptions?client_id=${CID}&client_secret=${encodeURIComponent(CSEC)}`).then((r) => r.json()).catch(() => []);
  // deno-lint-ignore no-explicit-any
  return Array.isArray(lista) && lista.some((s: any) => s.callback_url === `${SB_URL}/functions/v1/strava/wh/${c.verify_token}`);
}
const SPN: Record<string, string> = { RUNNING: "Corrida", TRAIL_RUNNING: "Corrida", TREADMILL_RUNNING: "Corrida na esteira", VIRTUAL_RUN: "Corrida", CYCLING: "Pedal", INDOOR_CYCLING: "Pedal no rolo", VIRTUAL_RIDE: "Pedal no rolo" };
const durTxt = (s: number) => { const m = Math.round(s / 60), h = Math.floor(m / 60), r = m % 60; return h ? `${h}h${r ? String(r).padStart(2, "0") : ""}` : `${r} min`; };
// deno-lint-ignore no-explicit-any
async function evento(ev: any) {
  if (ev?.object_type === "athlete" && ev?.updates?.authorized === "false") {
    const { data: c } = await admin.from("strava_conexoes").select("user_id").eq("athlete_id", ev.owner_id).maybeSingle();
    if (c) {
      await admin.from("strava_atividades").delete().eq("user_id", c.user_id);
      await admin.from("strava_conexoes").delete().eq("user_id", c.user_id);
    }
    return;
  }
  if (ev?.object_type !== "activity") return;
  const { data: c } = await admin.from("strava_conexoes").select("user_id,athlete_id,access_token,refresh_token,expires_at").eq("athlete_id", ev.owner_id).maybeSingle();
  if (!c) return;
  if (ev.aspect_type === "delete") {
    await admin.from("strava_atividades").delete().eq("user_id", c.user_id).eq("activity_id", ev.object_id).eq("registrado", false);
    return;
  }
  const tok = await accessFor(c as Conn);
  const a = await strava(tok, `/activities/${ev.object_id}`);
  if (!a.ok) return;
  await novaAtividade(c.user_id, a.data);
}
/* guarda a atividade e, se for nova e de hoje, avisa para pesar e registrar */
// deno-lint-ignore no-explicit-any
async function novaAtividade(userId: string, a: any) {
  const nova = await guardar(userId, a);
  const iniUtc = Date.parse(String(a?.start_date ?? "")) / 1000;
  const fim = iniUtc + Number(a?.elapsed_time ?? 0);
  if (nova && Number.isFinite(iniUtc) && Date.now() / 1000 - fim < 6 * 3600) {
    const { data: cp } = await admin.from("config_push").select("cron_segredo").eq("id", 1).maybeSingle();
    if (cp?.cron_segredo) {
      const dia = new Date((nova.startTimeInSeconds ?? iniUtc) * 1000).toISOString().slice(0, 10);
      await fetch(`${SB_URL}/functions/v1/notificar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron": cp.cron_segredo },
        body: JSON.stringify({
          action: "pos_agora", user_id: userId, dia,
          t: `${SPN[nova.activityType] ?? "Treino"} de ${durTxt(nova.durationInSeconds)} no Strava`,
          b: "Pese-se agora, antes de beber, e registre o que consumiu. Leva 30 segundos e calibra o seu suor.",
          u: `/?n=registrar&s=${a.id}`,
        }),
      }).catch(() => null);
    }
  }
}

// ---------- entrada ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  // validação do aviso pelo Strava
  if (req.method === "GET") {
    const c = await cfg();
    if (url.searchParams.get("hub.mode") === "subscribe" && c && url.searchParams.get("hub.verify_token") === c.verify_token) {
      return new Response(JSON.stringify({ "hub.challenge": url.searchParams.get("hub.challenge") }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("ok");
  }
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return new Response("metodo", { status: 405 });

  // eventos do Strava: responde em menos de 2 s e processa depois
  const whPath = url.pathname.match(/\/wh\/([A-Za-z0-9]+)$/);
  if (whPath || url.searchParams.has("k")) {
    const c = await cfg();
    const k = whPath ? whPath[1] : url.searchParams.get("k");
    if (!c || k !== c.verify_token) return new Response("proibido", { status: 403 });
    const ev = await req.json().catch(() => null);
    // @ts-ignore EdgeRuntime existe no ambiente do Supabase
    EdgeRuntime.waitUntil(evento(ev).catch((e) => console.error("strava evento", e)));
    return new Response("ok", { status: 200 });
  }

  // busca de segurança (agendador, a cada 15 min): se o aviso do Strava não estiver ativo, procura treinos novos
  if (req.headers.get("x-cron")) {
    const { data: cp } = await admin.from("config_push").select("cron_segredo").eq("id", 1).maybeSingle();
    if (!cp || req.headers.get("x-cron") !== cp.cron_segredo) return new Response("proibido", { status: 403 });
    const c = await cfg();
    let wh = "ok";
    if (CID && CSEC && (!c?.webhook_id || !(await webhookCerto()))) wh = await garantirWebhook().catch(() => "falhou");
    const ativo = wh === "ok" && !!(await cfg())?.webhook_id;
    let novas = 0;
    if (!ativo) {
      const { data: cs } = await admin.from("strava_conexoes").select("user_id,athlete_id,access_token,refresh_token,expires_at");
      const after = Math.floor(Date.now() / 1000) - 8 * 3600;
      for (const cn of cs ?? []) {
        try {
          const tok = await accessFor(cn as Conn);
          const l = await strava(tok, `/athlete/activities?after=${after}&per_page=5`);
          for (const a of (Array.isArray(l.data) ? l.data : [])) { const ja = await admin.from("strava_atividades").select("activity_id").eq("user_id", cn.user_id).eq("activity_id", a.id).maybeSingle(); if (!ja.data) { await novaAtividade(cn.user_id, a); novas++; } }
        } catch (e) { console.log("strava poll", String(e)); }
      }
    }
    return new Response(JSON.stringify({ webhook: ativo ? "ativo" : wh, novas }), { headers: { "Content-Type": "application/json" } });
  }

  // ações do app
  if (!CID || !CSEC) return json(req, { error: "config" }, 500);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json(req, { error: "login" }, 401);
  const body = await req.json().catch(() => ({}));
  try {
    switch (body.action) {
      case "auth_url": {
        const ru = String(body.redirect_uri ?? "");
        if (!body.state || !/^https:\/\/(app\.gabreutri\.com\.br|gabreutri\.netlify\.app)\//.test(ru)) return json(req, { error: "params" }, 400);
        const u = new URL("https://www.strava.com/oauth/authorize");
        u.searchParams.set("client_id", CID);
        u.searchParams.set("redirect_uri", ru);
        u.searchParams.set("response_type", "code");
        u.searchParams.set("approval_prompt", "auto");
        u.searchParams.set("scope", "read,activity:read_all");
        u.searchParams.set("state", String(body.state));
        return json(req, { url: u.toString() });
      }
      case "token": {
        const t = await tokenReq({ grant_type: "authorization_code", code: String(body.code ?? "") });
        const scope = String(body.scope ?? "");
        if (!/activity:read/.test(scope)) return json(req, { error: "escopo" }, 400);
        const aid = t.athlete?.id;
        if (!aid) return json(req, { error: "atleta" }, 400);
        // a mesma conta Strava não fica ligada a duas contas daqui
        await admin.from("strava_conexoes").delete().eq("athlete_id", aid).neq("user_id", user.id);
        await admin.from("strava_conexoes").upsert({
          user_id: user.id, athlete_id: aid, access_token: t.access_token, refresh_token: t.refresh_token,
          expires_at: new Date(t.expires_at * 1000).toISOString(), scope,
        });
        const wh = await garantirWebhook().catch(() => "falhou");
        // traz os treinos dos últimos 3 dias
        const after = Math.floor(Date.now() / 1000) - 3 * 86400;
        const l = await strava(t.access_token, `/athlete/activities?after=${after}&per_page=15`);
        let n = 0;
        for (const a of (Array.isArray(l.data) ? l.data : [])) if (await guardar(user.id, a)) n++;
        return json(req, { connected: true, nome: t.athlete?.firstname ?? "", novas: n, webhook: wh });
      }
      case "status": {
        const { data: c } = await admin.from("strava_conexoes").select("conectado_em").eq("user_id", user.id).maybeSingle();
        // aviso do Strava ainda não assinado (ou assinado no endereço antigo): tenta de novo
        let webhook = "ok";
        if (c) { const cf = await cfg(); if (!cf?.webhook_id) webhook = await garantirWebhook().catch(() => "falhou"); }
        return json(req, { connected: !!c, since: c?.conectado_em ?? null, webhook });
      }
      case "sincronizar": {
        const { data: c } = await admin.from("strava_conexoes").select("user_id,athlete_id,access_token,refresh_token,expires_at").eq("user_id", user.id).maybeSingle();
        if (!c) return json(req, { connected: false });
        const tok = await accessFor(c as Conn);
        const after = Math.floor(Date.now() / 1000) - 3 * 86400;
        const l = await strava(tok, `/athlete/activities?after=${after}&per_page=15`);
        if (l.status === 401) return json(req, { connected: false });
        let n = 0;
        for (const a of (Array.isArray(l.data) ? l.data : [])) if (await guardar(user.id, a)) n++;
        return json(req, { connected: true, novas: n });
      }
      case "disconnect": {
        const { data: c } = await admin.from("strava_conexoes").select("user_id,athlete_id,access_token,refresh_token,expires_at").eq("user_id", user.id).maybeSingle();
        if (c) {
          const tok = await accessFor(c as Conn).catch(() => c.access_token);
          await fetch("https://www.strava.com/oauth/deauthorize", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: tok }) }).catch(() => null);
        }
        await admin.from("strava_atividades").delete().eq("user_id", user.id);
        await admin.from("strava_conexoes").delete().eq("user_id", user.id);
        return json(req, { connected: false });
      }
    }
    return json(req, { error: "acao" }, 400);
  } catch (e) {
    console.log("strava erro", String(e));
    return json(req, { error: "servidor" }, 500);
  }
});
