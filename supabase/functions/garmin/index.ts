// Calculadora Combustível: servidor da integração Garmin Connect (Supabase Edge Function)
// Ações: auth_url, token, status, workout, disconnect. Exige usuário logado.
// Segredos (Edge Functions > Secrets): GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const CID = Deno.env.get("GARMIN_CLIENT_ID") ?? "";
const CSEC = Deno.env.get("GARMIN_CLIENT_SECRET") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const ORIGINS = ["https://gabreutri.netlify.app"];
const TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const API = "https://apis.garmin.com";

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

async function tokenRequest(params: Record<string, string>) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": "Basic " + btoa(`${CID}:${CSEC}`),
    },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, ...params }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token ${r.status}: ${JSON.stringify(t).slice(0, 200)}`);
  return t;
}

async function saveTokens(userId: string, t: any, extra: Record<string, unknown> = {}) {
  const now = Date.now();
  const row = {
    user_id: userId,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    // margem de 10 min recomendada pela Garmin
    access_expires_at: new Date(now + (Number(t.expires_in ?? 86400) - 600) * 1000).toISOString(),
    refresh_expires_at: new Date(now + Number(t.refresh_token_expires_in ?? 7776000) * 1000).toISOString(),
    ...extra,
  };
  const { error } = await admin.from("garmin_conexoes").upsert(row);
  if (error) throw error;
  return row;
}

async function accessTokenFor(userId: string): Promise<string | null> {
  const { data: c } = await admin.from("garmin_conexoes").select("*").eq("user_id", userId).maybeSingle();
  if (!c) return null;
  if (new Date(c.access_expires_at).getTime() > Date.now()) return c.access_token;
  const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  return (await saveTokens(userId, t)).access_token;
}

async function garmin(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, {
    method,
    headers: { "Authorization": `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data: any = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (!CID || !CSEC) return json(req, { error: "config" }, 500);
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json(req, { error: "login" }, 401);
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case "auth_url": {
        if (!body.code_challenge || !body.redirect_uri || !body.state) return json(req, { error: "params" }, 400);
        const u = new URL("https://connect.garmin.com/oauth2Confirm");
        u.searchParams.set("response_type", "code");
        u.searchParams.set("client_id", CID);
        u.searchParams.set("code_challenge", body.code_challenge);
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("redirect_uri", body.redirect_uri);
        u.searchParams.set("state", body.state);
        return json(req, { url: u.toString() });
      }
      case "token": {
        const t = await tokenRequest({
          grant_type: "authorization_code",
          code: String(body.code ?? ""),
          code_verifier: String(body.code_verifier ?? ""),
          redirect_uri: String(body.redirect_uri ?? ""),
        });
        const id = await garmin(t.access_token, "GET", "/partner-gateway/rest/user/id");
        const perm = await garmin(t.access_token, "GET", "/partner-gateway/rest/user/permissions");
        const gid = id.data?.userId ?? null;
        // a mesma conta Garmin não pode ficar ligada a duas contas daqui
        if (gid) await admin.from("garmin_conexoes").delete().eq("garmin_user_id", gid).neq("user_id", user.id);
        const permissions = perm.data?.permissions ?? [];
        await saveTokens(user.id, t, { garmin_user_id: gid, permissions });
        return json(req, { connected: true, permissions });
      }
      case "status": {
        const { data: c } = await admin.from("garmin_conexoes").select("permissions, conectado_em").eq("user_id", user.id).maybeSingle();
        return json(req, { connected: !!c, permissions: c?.permissions ?? [], since: c?.conectado_em ?? null });
      }
      case "workout": {
        const tok = await accessTokenFor(user.id);
        if (!tok) return json(req, { error: "not_connected" }, 400);
        const w = await garmin(tok, "POST", "/workoutportal/workout/v2", body.workout);
        if (!w.ok) return json(req, { error: "workout", status: w.status, detail: w.data }, 502);
        const workoutId = w.data?.workoutId ?? null;
        let schedule: unknown = null;
        if (workoutId && /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? ""))) {
          const s = await garmin(tok, "POST", "/training-api/schedule/", { workoutId, date: body.date });
          schedule = s.ok ? s.data : { error: s.status, detail: s.data };
        }
        return json(req, { workoutId, schedule });
      }
      case "agenda": {
        // teste: o Garmin devolve treinos agendados por outros apps (TrainingPeaks, Garmin Coach)?
        const tok = await accessTokenFor(user.id);
        if (!tok) return json(req, { error: "not_connected" }, 400);
        const d0 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
        const d1 = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
        const s = await garmin(tok, "GET", `/training-api/schedule?startDate=${d0}&endDate=${d1}`);
        const list = Array.isArray(s.data) ? s.data : [];
        const workouts = [];
        for (const it of list.slice(0, 10)) {
          const w = it?.workoutId ? await garmin(tok, "GET", `/training-api/workout/v2/${it.workoutId}`) : null;
          workouts.push({
            date: it?.date, workoutId: it?.workoutId,
            status: w?.status ?? null,
            name: w?.data?.workoutName ?? null,
            provider: w?.data?.workoutProvider ?? null,
            sport: w?.data?.sport ?? null,
            steps: w?.data?.segments?.reduce?.((a: number, sg: any) => a + (sg?.steps?.length ?? 0), 0) ?? null,
          });
        }
        return json(req, { range: [d0, d1], status: s.status, count: list.length, workouts, raw: Array.isArray(s.data) ? undefined : s.data });
      }
      case "disconnect": {
        const tok = await accessTokenFor(user.id).catch(() => null);
        if (tok) await garmin(tok, "DELETE", "/partner-gateway/rest/user/registration");
        await admin.from("garmin_conexoes").delete().eq("user_id", user.id);
        await admin.from("garmin_atividades").delete().eq("user_id", user.id).eq("registrado", false);
        return json(req, { connected: false });
      }
    }
    return json(req, { error: "action" }, 400);
  } catch (e) {
    return json(req, { error: "server", detail: String(e).slice(0, 300) }, 500);
  }
});
