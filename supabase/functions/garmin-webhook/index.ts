// Calculadora Combustível: recebe os avisos do Garmin (Supabase Edge Function, SEM verificação de JWT)
// Configure em apis.garmin.com/tools/endpoints a URL:
//   https://<projeto>.supabase.co/functions/v1/garmin-webhook?k=<GARMIN_WEBHOOK_KEY>
// para: Activities, Manually Updated Activities, Deregistrations e User Permissions.
// Segredo (Edge Functions > Secrets): GARMIN_WEBHOOK_KEY (qualquer texto longo e aleatório)
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const KEY = Deno.env.get("GARMIN_WEBHOOK_KEY") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function userFor(garminUserId: string): Promise<string | null> {
  const { data } = await admin.from("garmin_conexoes").select("user_id").eq("garmin_user_id", garminUserId).maybeSingle();
  return data?.user_id ?? null;
}

async function processar(body: any) {
  const lists = [...(body.activities ?? []), ...(body.manuallyUpdatedActivities ?? [])];
  for (const a of lists) {
    if (!a?.userId || !a?.summaryId) continue;
    // atividade "pai" de multiesporte não entra; os trechos filhos entram
    if (a.isParent) continue;
    const uid = await userFor(a.userId);
    if (!uid) continue;
    await admin.from("garmin_atividades").upsert(
      { user_id: uid, summary_id: String(a.summaryId), dados: a },
      { onConflict: "user_id,summary_id", ignoreDuplicates: false },
    );
  }
  for (const d of body.deregistrations ?? []) {
    if (d?.userId) await admin.from("garmin_conexoes").delete().eq("garmin_user_id", d.userId);
  }
  for (const p of body.userPermissionsChange ?? []) {
    if (p?.userId) await admin.from("garmin_conexoes").update({ permissions: p.permissions ?? [] }).eq("garmin_user_id", p.userId);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const k = new URL(req.url).searchParams.get("k") ?? "";
  if (!KEY || k !== KEY) return new Response("forbidden", { status: 403 });
  let body: any = null;
  try { body = await req.json(); } catch { return new Response("ok"); }
  // A Garmin exige resposta 200 em até 30 s, antes de processar
  // @ts-ignore EdgeRuntime existe no ambiente do Supabase
  EdgeRuntime.waitUntil(processar(body).catch((e) => console.error("garmin-webhook", e)));
  return new Response("ok", { status: 200 });
});
