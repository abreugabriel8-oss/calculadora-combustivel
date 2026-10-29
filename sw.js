/* Calculadora Combustível: funciona sem internet depois da primeira visita */
const V='cc-v16';
const CORE=['/','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
const BYPASS=/supabase\.co|open-meteo\.com|umami\.is|garmin\.com/;
const STATIC=/fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net/;
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);if(BYPASS.test(u.hostname))return;
  if(r.mode==='navigate'){
    // página: sempre tenta a versão nova; sem internet, abre a guardada
    e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(V).then(c=>c.put('/',cp));return res;}).catch(()=>caches.match('/',{ignoreSearch:true})));
    return;}
  if(u.origin===location.origin||STATIC.test(u.hostname)){
    e.respondWith(caches.open(V).then(c=>c.match(r).then(hit=>{const net=fetch(r).then(res=>{if(res&&(res.ok||res.type==='opaque'))c.put(r,res.clone());return res;}).catch(()=>hit);return hit||net;})));
  }
});

/* notificações: mostra e, ao tocar, abre o app no lugar certo */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch(err){d={t:'Calculadora Combustível',b:e.data?e.data.text():''};}
  e.waitUntil(self.registration.showNotification(d.t||'Calculadora Combustível',{body:d.b||'',tag:d.tag||'cc',data:{u:d.u||'/'},icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',lang:'pt-BR'}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const u=new URL((e.notification.data&&e.notification.data.u)||'/',self.location.origin);
  const alvo=u.origin===self.location.origin?u.href:self.location.origin+'/'+u.search;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    for(const c of cs){if(c.url.startsWith(self.location.origin)&&'navigate' in c)return c.focus().then(()=>c.navigate(alvo));}
    return self.clients.openWindow(alvo);
  }));
});
