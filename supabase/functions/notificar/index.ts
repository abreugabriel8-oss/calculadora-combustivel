// Calculadora Combustível: notificações push (Supabase Edge Function, SEM verificação de JWT)
// Ações (POST JSON):
//   chave                      devolve a chave pública para o navegador se inscrever (gera na primeira vez)
//   inscrever {sub}            (com login) guarda este aparelho
//   sair {endpoint}            (com login) remove este aparelho
//   teste                      (com login) manda uma notificação de teste para os aparelhos da pessoa
//   rodar                      (só o agendador, com o cabeçalho x-cron) envia véspera, pós-treino e assinatura
//   pos_agora {user_id,dia,t,b,u} (só servidor, com x-cron) aviso imediato de treino novo (Strava)
// Não precisa de segredo: as chaves ficam na tabela config_push, criadas sozinhas.
import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import webpush from "npm:web-push@3.6.7";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ORIGINS = ["https://app.gabreutri.com.br", "https://gabreutri.netlify.app"];
const SITE = "https://app.gabreutri.com.br";
const LONGO_MIN = 75; // véspera só para treino de 1h15 ou mais (ou prova)
const MAX_DIA = 2;   // no máximo 2 notificações por pessoa em 24 h

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

// ---------- chaves ----------
type Cfg = { vapid_pub: string; vapid_priv: string; cron_segredo: string };
let CFG: Cfg | null = null;
async function cfg(): Promise<Cfg> {
  if (CFG) return CFG;
  const { data, error } = await admin.from("config_push").select("vapid_pub,vapid_priv,cron_segredo").eq("id", 1).single();
  if (error || !data) throw new Error("sem_tabela");
  if (!data.vapid_pub || !data.vapid_priv) {
    const k = webpush.generateVAPIDKeys();
    // só grava se ainda estiver vazio (duas chamadas ao mesmo tempo não trocam a chave)
    await admin.from("config_push").update({ vapid_pub: k.publicKey, vapid_priv: k.privateKey }).eq("id", 1).is("vapid_pub", null);
    const r = await admin.from("config_push").select("vapid_pub,vapid_priv,cron_segredo").eq("id", 1).single();
    CFG = r.data as Cfg;
  } else CFG = data as Cfg;
  return CFG!;
}

// ---------- envio ----------
type Msg = { t: string; b: string; u: string; tag: string };
async function enviar(user: string, m: Msg): Promise<number> {
  const c = await cfg();
  const { data: subs } = await admin.from("push_subs").select("endpoint,p256dh,auth").eq("user_id", user);
  let ok = 0;
  for (const s of subs ?? []) {
    try {
      const d = webpush.generateRequestDetails(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(m),
        { vapidDetails: { subject: "mailto:contato@gabreutri.com.br", publicKey: c.vapid_pub, privateKey: c.vapid_priv }, TTL: 6 * 3600, urgency: "normal" },
      );
      const r = await fetch(d.endpoint, { method: "POST", headers: d.headers as Record<string, string>, body: d.body });
      if (r.status === 404 || r.status === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint);
      else if (r.ok) ok++;
      else console.log("push", r.status, await r.text().catch(() => ""));
    } catch (e) { console.log("push erro", String(e)); }
  }
  return ok;
}
async function jaNoLimite(user: string) {
  const { count } = await admin.from("notif_log").select("chave", { count: "exact", head: true })
    .eq("user_id", user).gt("enviado_em", new Date(Date.now() - 24 * 3600e3).toISOString());
  return (count ?? 0) >= MAX_DIA;
}
// grava antes de enviar: se duas rodadas se cruzarem, só uma consegue
async function marcar(user: string, chave: string) {
  const { error } = await admin.from("notif_log").insert({ user_id: user, chave });
  return !error;
}

// ---------- textos ----------
const durTxt = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}h${m ? String(m).padStart(2, "0") : ""}` : `${m} min`; };
const SPN: Record<string, string> = { ciclismo: "Pedal", corrida: "Corrida", natacao: "Natação", outro: "Treino" };
const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// ---------- calendário (.ics) do TrainingPeaks ----------
const unesc = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
function parseIcs(txt: string) {
  const lines = txt.replace(/\r\n/g, "\n").split("\n");
  const un: string[] = [];
  for (const l of lines) { if ((l.startsWith(" ") || l.startsWith("\t")) && un.length) un[un.length - 1] += l.slice(1); else un.push(l); }
  const evs: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const l of un) {
    if (l === "BEGIN:VEVENT") { cur = {}; continue; }
    if (l === "END:VEVENT") { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = l.indexOf(":"); if (i < 0) continue;
    const key = l.slice(0, i).split(";")[0].toUpperCase();
    cur[key] = l.slice(i + 1);
    if (key === "DTSTART") cur._allday = /VALUE=DATE(?!-)/i.test(l.slice(0, i)) || /^\d{8}$/.test(l.slice(i + 1)) ? "1" : "";
  }
  return evs;
}
const hm2min = (s: string) => { const m = s.match(/(\d+):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };
function evento(e: Record<string, string>) {
  const ds = e.DTSTART ?? "";
  const data = ds.length >= 8 ? `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}` : "";
  const hora = !e._allday && ds.length >= 13 ? `${ds.slice(9, 11)}:${ds.slice(11, 13)}` : null;
  const titulo0 = unesc(e.SUMMARY ?? "").trim();
  const desc = unesc(e.DESCRIPTION ?? "");
  const tipo = (desc.match(/Workout type:\s*([^\n]+)/i)?.[1] ?? "").trim().toLowerCase();
  const esporte = /bike|cycl/.test(tipo) ? "ciclismo" : /run/.test(tipo) ? "corrida" : /swim/.test(tipo) ? "natacao" : tipo ? "outro" : null;
  const plan = hm2min(desc.match(/Planned Time:\s*([^\n]+)/i)?.[1] ?? "");
  const real = hm2min(desc.match(/Actual Time:\s*([^\n]+)/i)?.[1] ?? "");
  const dp = desc.match(/Distance Planned:\s*([\d.,]+)\s*(km|m|mi)\b/i);
  const km = dp ? (dp[2].toLowerCase() === "m" ? +dp[1].replace(",", ".") / 1000 : dp[2].toLowerCase() === "mi" ? +dp[1].replace(",", ".") * 1.609 : +dp[1].replace(",", ".")) : null;
  // o que o treinador escreveu, sem as linhas automáticas do TrainingPeaks
  const notas = desc.split("\n").map((l) => l.trim()).filter((l) => l && !/^(Workout type|Planned Time|Actual Time|Distance Planned|Actual Distance|Speed|Pace|TSS|IF)\s*:/i.test(l)).join("\n");
  const pr = !esporte ? titulo0.match(/^([ABC])\s*:\s*(.+)$/i) : null;
  const titulo = esporte ? titulo0.replace(/^(Bike|Run|Swim|Strength|Other)\s*:\s*/i, "") : titulo0;
  return {
    uid: e.UID ?? "", data, hora, esporte, titulo, notas: notas.slice(0, 1200),
    min_plan: plan, min_real: real, km_plan: km, feito: real != null,
    prova: pr ? { prioridade: pr[1].toUpperCase(), nome: pr[2].trim() } : null,
  };
}

type Ev = ReturnType<typeof evento>;
async function eventosTP(url: string, dia: string): Promise<Ev[]> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "CalculadoraCombustivel/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    return parseIcs(await r.text()).map(evento).filter((e) => e.data === dia);
  } catch { return []; }
}

async function rodar() {
  const out = { vespera: 0, pos: 0, assinatura: 0 };
  const feito = new Set<string>();

  // 1. véspera do treino longo ou da prova
  const { data: vs } = await admin.rpc("notif_alvos_vespera");
  for (const v of vs ?? []) {
    const dia = String(v.amanha);
    const p = v.plano as { titulo: string; dur_min: number; resumo: string; prova: boolean } | null;
    let m: Msg | null = null;
    const tp = v.cal_url ? await eventosTP(v.cal_url, dia) : [];
    const prova = tp.find((e) => e.prova);
    const treinos = tp.filter((e) => e.esporte && !e.feito && e.esporte !== "natacao" && (e.min_plan ?? 0) > 0);
    const tpMin = treinos.reduce((a, e) => a + (e.min_plan ?? 0), 0);
    if (p && (p.prova || p.dur_min >= LONGO_MIN)) {
      m = {
        t: p.prova ? `Amanhã é dia de prova: ${p.titulo}` : `Amanhã: ${p.titulo || "treino"}${/\d\s*h|\d\s*min/i.test(p.titulo) ? "" : ` (${durTxt(p.dur_min)})`}`,
        b: (p.resumo ? p.resumo + ". " : "") + (p.prova ? "Separe tudo hoje e confira o café da manhã." : "Deixe géis e garrafas separados hoje."),
        u: `${SITE}/?n=plano`, tag: "vespera",
      };
    } else if (prova) {
      m = { t: `Amanhã é dia de prova: ${prova.prova!.nome}`, b: "Abra o plano de prova e confira café da manhã, géis e garrafas.", u: `${SITE}/?n=dia&d=${dia}`, tag: "vespera" };
    } else if (tpMin >= LONGO_MIN) {
      const nome = treinos.length > 1 ? treinos.map((e) => `${SPN[e.esporte!]} ${durTxt(e.min_plan!)}`).join(" + ") : `${cap(treinos[0].titulo || SPN[treinos[0].esporte!])} (${durTxt(tpMin)})`;
      m = { t: `Amanhã: ${nome}`.slice(0, 90), b: "Monte o abastecimento agora e deixe géis e garrafas separados.", u: `${SITE}/?n=dia&d=${dia}`, tag: "vespera" };
    }
    if (!m || await jaNoLimite(v.user_id)) continue;
    if (!(await marcar(v.user_id, "vespera:" + dia))) continue;
    if (await enviar(v.user_id, m)) out.vespera++;
  }

  // 2. pós-treino: pesar e registrar
  const { data: ps } = await admin.rpc("notif_alvos_pos");
  for (const p of ps ?? []) {
    const k = "pos:" + p.dia;
    if (feito.has(p.user_id + k)) continue;
    feito.add(p.user_id + k);
    if (await jaNoLimite(p.user_id)) continue;
    if (!(await marcar(p.user_id, k))) continue;
    if (await enviar(p.user_id, { t: "Treino feito? Pese-se agora", b: "O peso logo depois do treino, antes de beber, mostra quanto você suou. Leva 30 segundos.", u: `${SITE}/?n=registrar`, tag: "pos" })) out.pos++;
  }

  // 3. assinatura
  const { data: as } = await admin.rpc("notif_alvos_assinatura");
  for (const a of as ?? []) {
    let k: string, m: Msg;
    if (a.tipo === "teste") {
      const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: a.tz });
      const fimDia = new Date(a.fim).toLocaleDateString("sv-SE", { timeZone: a.tz });
      k = "teste_fim";
      m = { t: `Seu teste grátis acaba ${fimDia === hoje ? "hoje" : "amanhã"}`, b: "Assine o Pro para continuar com os planos, o diário e o TrainingPeaks. Seus dados ficam guardados.", u: `${SITE}/?n=pagar`, tag: "assinatura" };
    } else {
      k = "pro_fim:" + new Date(a.fim).toLocaleDateString("sv-SE", { timeZone: a.tz });
      m = { t: "Seu Pro vence em 3 dias", b: "Renove para não perder o acesso. O pagamento é único, sem renovação automática.", u: `${SITE}/?n=pagar`, tag: "assinatura" };
    }
    if (await jaNoLimite(a.user_id)) continue;
    if (!(await marcar(a.user_id, k))) continue;
    if (await enviar(a.user_id, m)) out.assinatura++;
  }
  return out;
}

// ---------- entrada ----------
async function usuario(req: Request) {
  const tk = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tk) return null;
  const { data } = await admin.auth.getUser(tk);
  return data?.user ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "metodo" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const action = String(body.action ?? "");
  try {
    if (action === "rodar") {
      const c = await cfg();
      if (req.headers.get("x-cron") !== c.cron_segredo) return json(req, { error: "proibido" }, 403);
      return json(req, await rodar());
    }
    // aviso imediato de pós-treino (vem da função strava quando um treino novo chega)
    if (action === "pos_agora") {
      const c = await cfg();
      if (req.headers.get("x-cron") !== c.cron_segredo) return json(req, { error: "proibido" }, 403);
      const uid = String(body.user_id ?? ""), dia = String(body.dia ?? "");
      if (!uid || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) return json(req, { error: "params" }, 400);
      const { data: p } = await admin.from("notif_prefs").select("pos").eq("user_id", uid).maybeSingle();
      if (!p?.pos) return json(req, { enviado: false, motivo: "prefs" });
      const { data: ok } = await admin.rpc("notif_tem_acesso", { p_user: uid });
      if (!ok) return json(req, { enviado: false, motivo: "acesso" });
      const { count } = await admin.from("registros").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("data", dia);
      if ((count ?? 0) > 0) return json(req, { enviado: false, motivo: "registrado" });
      if (await jaNoLimite(uid)) return json(req, { enviado: false, motivo: "limite" });
      if (!(await marcar(uid, "pos:" + dia))) return json(req, { enviado: false, motivo: "repetido" });
      const u = String(body.u ?? "/?n=registrar");
      const n = await enviar(uid, { t: String(body.t ?? "Treino feito? Pese-se agora").slice(0, 90), b: String(body.b ?? "").slice(0, 200), u: SITE + (u.startsWith("/") ? u : "/"), tag: "pos" });
      return json(req, { enviado: n > 0 });
    }
    if (action === "chave") return json(req, { chave: (await cfg()).vapid_pub });
    const u = await usuario(req);
    if (!u) return json(req, { error: "login" }, 401);
    if (action === "inscrever") {
      const s = body.sub as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
      const ep = String(s?.endpoint ?? "");
      if (!/^https:\/\//.test(ep) || ep.length > 1000 || !s?.keys?.p256dh || !s?.keys?.auth) return json(req, { error: "inscricao" }, 400);
      await admin.from("push_subs").upsert({ endpoint: ep, user_id: u.id, p256dh: s.keys.p256dh, auth: s.keys.auth });
      await admin.from("notif_prefs").upsert({ user_id: u.id }, { onConflict: "user_id", ignoreDuplicates: true });
      return json(req, { ok: true });
    }
    if (action === "sair") {
      await admin.from("push_subs").delete().eq("endpoint", String(body.endpoint ?? "")).eq("user_id", u.id);
      return json(req, { ok: true });
    }
    if (action === "teste") {
      const n = await enviar(u.id, { t: "Notificações ativadas", b: "Você vai receber a véspera dos treinos longos, o lembrete de pesar depois do treino e o aviso da assinatura.", u: `${SITE}/?n=hoje`, tag: "teste" });
      return json(req, { ok: n > 0, enviados: n });
    }
    return json(req, { error: "acao" }, 400);
  } catch (e) {
    console.log("erro", String(e));
    return json(req, { error: String(e).includes("sem_tabela") ? "sem_tabela" : "servidor" }, 500);
  }
});
