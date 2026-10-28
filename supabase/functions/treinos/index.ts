// Calculadora Combustível: trazer treino (Supabase Edge Function, COM verificação de JWT)
// Ações (POST JSON, com login):
//   cal_salvar {url}   guarda o link de calendário do TrainingPeaks (webcal:// ou https://)
//   cal_remover        apaga o link
//   cal_eventos        lê o calendário e devolve treinos e provas (7 dias para trás, 60 para frente)
//   ia_ler {texto?, imagem?: {tipo, dados}}  lê um treino escrito ou em foto e devolve a estrutura
// Segredos: ANTHROPIC_API_KEY (para ia_ler)
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const AKEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-5-5";
const LIMITE_IA_DIA = 40;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ORIGINS = ["https://app.gabreutri.com.br", "https://gabreutri.netlify.app"];

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

// ---------- calendário (.ics) ----------
function normUrl(u: string): string | null {
  const s = String(u ?? "").trim().replace(/^webcal:\/\//i, "https://");
  try {
    const x = new URL(s);
    if (x.protocol !== "https:") return null;
    if (!/(^|\.)trainingpeaks\.com$/i.test(x.hostname)) return null;
    if (!/\/ical\/[A-Za-z0-9]+\.ics$/i.test(x.pathname)) return null;
    return x.toString();
  } catch { return null; }
}
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

// ---------- leitura por IA ----------
const FERRAMENTA = {
  name: "treino_estruturado",
  description: "Devolve o treino lido, organizado em sessões e blocos.",
  input_schema: {
    type: "object",
    properties: {
      sessoes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            esporte: { type: "string", enum: ["corrida", "ciclismo", "natacao"] },
            nome: { type: "string", description: "Título curto do treino, em português" },
            duracao_min: { type: ["number", "null"], description: "Duração total estimada em minutos" },
            intensidade_geral: { type: "string", enum: ["leve", "moderado", "forte", "prova"] },
            indoor: { type: "boolean" },
            blocos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tipo: { type: "string", enum: ["aquecimento", "ritmo", "tiro", "recuperacao", "desaquecimento"] },
                  repeticoes: { type: "integer", minimum: 1 },
                  duracao_min: { type: ["number", "null"] },
                  distancia_km: { type: ["number", "null"] },
                  zona: { type: ["integer", "null"], minimum: 1, maximum: 5 },
                  pct_limiar: { type: ["number", "null"], description: "Fração do limiar/FTP, ex.: 0.85" },
                },
                required: ["tipo", "repeticoes"],
              },
            },
          },
          required: ["esporte", "intensidade_geral", "blocos"],
        },
      },
      ilegivel: { type: "boolean", description: "true se não há treino reconhecível" },
    },
    required: ["sessoes"],
  },
};
const SISTEMA = `Você lê treinos de endurance (corrida, ciclismo, natação, triathlon) escritos por treinadores brasileiros, em texto ou foto (prints do TrainingPeaks, planilhas, WhatsApp, quadro da academia).
Organize o treino em sessões e blocos. Regras:
- ' = minutos, " = segundos; "aq/aquec" = aquecimento; "desaq/soltar/solto/trote final" = desaquecimento; "r", "rec", "intervalo", "com 2' fácil" = recuperação entre tiros.
- "5x 1 km Z4 r 2'" vira: um bloco tiro (repeticoes 5, distancia_km 1, zona 4) seguido de um bloco recuperação (repeticoes 5, duracao_min 2, zona 1). Repita as repetições nos dois blocos.
- Zonas Z1 a Z5. Percentuais de FTP ou limiar viram pct_limiar (85% = 0.85). "Race pace"/"ritmo de prova" de meia ou 70.3 ≈ 0.85 a 0.95; "ritmado" ≈ zona 3; "leve/regenerativo/rodagem" = zona 1 ou 2.
- Bike seguida de corrida no mesmo treino ("brick", "transição", "logo após o pedal") = duas sessões: ciclismo e corrida.
- Se só houver duração total e intensidade, use um bloco único do tipo ritmo.
- Estime duracao_min total de cada sessão (para distâncias, use ritmos típicos: corrida ~5 min/km em Z2, pedal ~30 km/h).
- Não invente treino. Se a imagem ou texto não tiver treino reconhecível, devolva sessoes vazias e ilegivel true.`;

async function lerIA(texto: string, imagem: { tipo: string; dados: string } | null) {
  const content: unknown[] = [];
  if (imagem) content.push({ type: "image", source: { type: "base64", media_type: imagem.tipo, data: imagem.dados } });
  content.push({ type: "text", text: texto ? `Treino:\n${texto}` : "Leia o treino desta imagem." });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500, system: SISTEMA,
      tools: [FERRAMENTA], tool_choice: { type: "tool", name: FERRAMENTA.name },
      messages: [{ role: "user", content }],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ia ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  const tu = (d.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  return tu?.input ?? { sessoes: [], ilegivel: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json(req, { error: "login" }, 401);
    const { data: ok } = await admin.rpc("tem_acesso", { p_user: user.id });
    if (!ok) return json(req, { error: "acesso" }, 403);
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case "cal_salvar": {
        const url = normUrl(body.url);
        if (!url) return json(req, { error: "link_invalido" }, 400);
        const t = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!t.ok) return json(req, { error: "link_nao_abre" }, 400);
        const txt = (await t.text()).slice(0, 2_000_000);
        if (!txt.includes("BEGIN:VCALENDAR")) return json(req, { error: "nao_e_calendario" }, 400);
        const { error } = await admin.from("calendarios").upsert({ user_id: user.id, url });
        if (error) return json(req, { error: "banco" }, 500);
        return json(req, { ok: true });
      }
      case "cal_remover": {
        await admin.from("calendarios").delete().eq("user_id", user.id);
        return json(req, { ok: true });
      }
      case "cal_eventos": {
        const { data: c } = await admin.from("calendarios").select("url").eq("user_id", user.id).maybeSingle();
        if (!c) return json(req, { conectado: false });
        const t = await fetch(c.url, { signal: AbortSignal.timeout(12000) }).catch(() => null);
        if (!t || !t.ok) return json(req, { conectado: true, error: "link_nao_abre", eventos: [] });
        const txt = (await t.text()).slice(0, 2_000_000);
        const hoje = new Date(); const a = new Date(hoje); a.setDate(a.getDate() - 7); const b = new Date(hoje); b.setDate(b.getDate() + 60);
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        const eventos = parseIcs(txt).map(evento).filter((e) => e.data && e.data >= iso(a) && e.data <= iso(b) && (e.esporte || e.prova))
          .sort((x, y) => (x.data + (x.hora ?? "")).localeCompare(y.data + (y.hora ?? "")));
        return json(req, { conectado: true, eventos });
      }
      case "ia_ler": {
        if (!AKEY) return json(req, { error: "ia_desligada" }, 503);
        const texto = String(body.texto ?? "").slice(0, 4000);
        const img = body.imagem && /^image\/(jpeg|png|webp)$/.test(body.imagem.tipo) && typeof body.imagem.dados === "string" && body.imagem.dados.length < 4_000_000
          ? { tipo: body.imagem.tipo, dados: body.imagem.dados } : null;
        if (!texto.trim() && !img) return json(req, { error: "vazio" }, 400);
        const { data: n } = await admin.rpc("usar_ia", { p_user: user.id });
        if ((n ?? 0) > LIMITE_IA_DIA) return json(req, { error: "limite" }, 429);
        return json(req, await lerIA(texto, img));
      }
      default:
        return json(req, { error: "acao" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json(req, { error: "interno" }, 500);
  }
});
