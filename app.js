"use strict";

const RE_ENVIADO = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*?\[ENVIADO\].*?\((\d+)B\).*?\[KEY\]:\s*(\w+)/;
const RE_RECIBIDO = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*?\[RECIBIDO\].*?\|\s*(\d+)B\s*\|\s*(\w+)/;
const RE_TICKET = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[TicketCounterManager\] Número confirmado en BD: fare=(\d+), num=(\d+)/;

// Fallback si el log no trae precios (ni boletos enviados al servidor ni driver_logout); ver detectarTarifas.
const PRECIO_FARE = { 3: 0.5, 4: 0.5, 5: 1.5, 6: 1.5, 7: 2.5 };
let _precioDetectado = {};

const $ = (id) => document.getElementById(id);

function humano(n) {
  n = Number(n);
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n.toLocaleString()} B` : `${n.toFixed(2)} ${u[i]}`;
}

function parseTs(s) {
  const [d, t] = s.split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, sec] = t.split(":").map(Number);
  return new Date(Y, M - 1, D, h, m, sec);
}

function parse(text) {
  const ev = [];
  for (const linea of text.split(/\r?\n/)) {
    let m = RE_ENVIADO.exec(linea);
    if (m) { ev.push({ t: parseTs(m[1]), env: +m[2], rec: 0, key: m[3] }); continue; }
    m = RE_RECIBIDO.exec(linea);
    if (m) ev.push({ t: parseTs(m[1]), env: 0, rec: +m[2], key: m[3] });
  }
  ev.sort((a, b) => a.t - b.t);
  return ev;
}

function parseTickets(text) {
  const vistos = new Set();
  const t = [];
  for (const linea of text.split(/\r?\n/)) {
    const m = RE_TICKET.exec(linea);
    if (!m) continue;
    const clave = `${m[1]}|${m[2]}|${m[3]}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    t.push({ t: parseTs(m[1]), fare: +m[2], num: +m[3] });
  }
  t.sort((a, b) => a.t - b.t);
  return t;
}

// Detector de datos general del APK: consumo REAL de SIM/WiFi (distinto del payload del socket).
const RE_TRAFFIC = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[TrafficMonitor\].*?movil ↑([\d.]+)(\w+) ↓([\d.]+)(\w+) \| wifi ↑([\d.]+)(\w+) ↓([\d.]+)(\w+) \| total ([\d.]+)(\w+)/;
const aBytes = (v, u) => (+v) * ({ B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[u] || 1);

function parseTrafico(text) {
  const out = [];
  for (const linea of text.split(/\r?\n/)) {
    const m = RE_TRAFFIC.exec(linea);
    if (!m) continue;
    out.push({
      t: parseTs(m[1]),
      movilTx: aBytes(m[2], m[3]), movilRx: aBytes(m[4], m[5]),
      wifiTx: aBytes(m[6], m[7]), wifiRx: aBytes(m[8], m[9]),
      total: aBytes(m[10], m[11]),
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function precio(fare) {
  return _precioDetectado[fare] ?? PRECIO_FARE[fare] ?? 0;
}

// --- Liquidación (driver_logout) : fuente real de cierre y tarifas ---
// La 1.0.65 manda claves en español (sesion, fin, primero, ultimo, resumen) y la 1.0.71 volvió a las inglesas
// (session, end_time, first, last, resume); se aceptan ambos formatos.
const RE_LOGOUT = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*?\[ENVIADO\].*?\[KEY\]:\s*driver_logout\s*\[DATA\]:\s*(\{.*\})/;

function parseLiquidaciones(text) {
  const out = [];
  for (const linea of text.split(/\r?\n/)) {
    const m = RE_LOGOUT.exec(linea);
    if (!m) continue;
    const d = m[2];
    const top = d.replace(/resumen?=\[.*\]/, ""); // sin el detalle por tarifa: sus cash/digital no son los de la sesión
    const g = (re) => { const x = re.exec(top); return x ? x[1] : null; };
    const resume = [];
    const re = /\{digital=(\d+),\s*start=(\d+),\s*fare=(\d+),\s*end=(\d+),\s*cash=(\d+)/g;
    let r;
    while ((r = re.exec(d))) resume.push({ digital: +r[1], start: +r[2], fare: +r[3], end: +r[4], cash: +r[5] });
    out.push({
      t: parseTs(m[1]),
      session: +(g(/[{,\s]sess?ion=(\d+)/) || 0),
      endTime: g(/[{,\s](?:end_time|fin)=([\dT:.\-]+)/),
      cash: +(g(/[{,\s]cash=(\d+)/) || 0),
      first: +(g(/[{,\s](?:first|primero)=(\d+)/) || 0),
      last: +(g(/[{,\s](?:last|ultimo)=(\d+)/) || 0),
      digital: +(g(/[{,\s]digital=(\d+)/) || 0),
      resume,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Precio unitario por tarifa: el `price` (céntimos) más frecuente de los boletos enviados al servidor. Si la tarifa no
// salió en el log: importe de la liquidación / boletos impresos en su rango de n°. Esa división sobrestima el precio
// cuando hubo cobrados sin papel (la liquidación los suma y no figuran como impresos), por eso va en segundo lugar.
function detectarTarifas(liqs, tickets, env) {
  const p = {}, frec = new Map();
  for (const r of env?.porCorr?.values() || []) if (r.fare && r.price) {
    const f = frec.get(r.fare) || new Map();
    frec.set(r.fare, f.set(r.price, (f.get(r.price) || 0) + 1));
  }
  for (const [fare, f] of frec) p[fare] = [...f].sort((a, b) => b[1] - a[1])[0][0] / 100;
  const acc = new Map(); // fare -> {cash, count}
  for (const L of liqs)
    for (const e of L.resume) {
      if (p[e.fare] != null) continue;
      const n = tickets.filter((k) => k.fare === e.fare && k.num >= e.start && k.num <= e.end).length;
      if (!n) continue;
      const a = acc.get(e.fare) || { cash: 0, count: 0 };
      a.cash += e.cash; a.count += n;
      acc.set(e.fare, a);
    }
  for (const [fare, a] of acc) p[fare] = Math.round(a.cash / a.count / 5) * 5 / 100; // céntimos → soles, redondeo 0.05
  return p;
}

const LADO = (dir) => (String(dir).toLowerCase() === "true" ? "B" : "A");

// Petición de login que envía el equipo al tipear DNI+clave (para medir cuánto demoró en abrir la sesión).
const RE_LOGIN_REQ = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*?\[ENVIADO\].*?\[KEY\]:\s*driver_login\s*\[DATA\]:\s*\{([^}]*)\}/;
function parseLoginRequests(text) {
  const out = [];
  for (const linea of text.split(/\r?\n/)) {
    const m = RE_LOGIN_REQ.exec(linea);
    if (!m) continue;
    const d = m[2], g = (re) => { const x = re.exec(d); return x ? x[1] : null; };
    out.push({ t: parseTs(m[1]), dni: g(/dni=(\w+)/), direction: g(/direction=(true|false)/) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// --- Sesiones del conductor (driver_login) : ciclo de vida y autoretorno ---
function parseLogins(text) {
  const out = [];
  for (const linea of text.split(/\r?\n/)) {
    if (!/\[SocketMessageDispatcher\] Mensaje: Header: driver_login/.test(linea)) continue;
    if (!/sessions=\[/.test(linea)) continue;
    const g = (re) => { const x = re.exec(linea); return x ? x[1] : null; };
    const msg = (g(/message=([^}]+)\}/) || "").trim();
    let tipo = "nueva";
    if (/autom[aá]tica/i.test(msg)) tipo = "automatica";
    else if (/reingres/i.test(msg)) tipo = "reingreso";
    out.push({
      t: parseTs(g(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)),
      id: +(g(/(?:^|[,{\s])id=(\d+)/) || 0),
      driverCode: g(/driver_code=(\w+)/),
      direction: g(/direction=(true|false)/),
      startTime: g(/start_time=([\dT:.\-]+)/),
      title: (g(/title=([^,]+)/) || "").trim(),
      msg, tipo,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function ticketsPorHora(tk) {
  const d = new Array(24).fill(0);
  for (const k of tk) d[k.t.getHours()]++;
  return d;
}

function renderTickets(tk, env, imp) {
  if (!tk.length) return "";
  const conEnv = env.intentos.length > 0;
  const hhmmss = (d) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  const prod = tk.reduce((s, k) => s + precio(k.fare), 0);
  const t0 = tk[0].t, t1 = tk[tk.length - 1].t;

  const fares = [...new Set(tk.map((k) => k.fare))].sort((a, b) => a - b);
  const porFare = new Map(fares.map((f) => [f, tk.filter((k) => k.fare === f).length]));

  const hd = ticketsPorHora(tk);
  const hdEtiq = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));

  let filas = "";
  tk.forEach((k, i) => {
    const r = conEnv ? env.porCorr.get(env.corrDe(k)) : null;
    filas += `<tr class="${imp?.porTicket.get(k)?.intentos > 1 ? "hit" : ""}"><td>${i + 1}</td><td>${hhmmss(k.t)}</td><td>${k.num}</td>
      <td>${k.fare}</td><td>S/ ${precio(k.fare).toFixed(2)}</td>${imp ? `<td>${celdaIntentos(imp.porTicket.get(k))}</td>` : ""}${conEnv
        ? `<td>${r ? `#${r.corr}` : "—"}</td><td>${celdaReenvios(r)}</td><td>${celdaServidor(r, true)}</td>` : ""}</tr>`;
  });

  const fila = (f) => f.toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  let chips = "";
  for (const f of fares)
    chips += `<div class="card"><div class="lbl">Tarifa ${f} · S/ ${precio(f).toFixed(2)}</div>
      <div class="big">${porFare.get(f)}</div><div class="sub">boletos</div></div>`;

  return `
    <div class="panel"><h2>🎟️ Boletos vendidos</h2>
      <div class="grid">
        <div class="card"><div class="lbl">Total boletos</div><div class="big">${tk.length}</div>
          <div class="sub">${fila(t0)} → ${fila(t1)}</div></div>
        <div class="card"><div class="lbl">Producción estimada</div><div class="big">S/ ${prod.toFixed(2)}</div>
          <div class="sub">precio de cada tarifa según el log</div></div>
        ${chips}
      </div>
      ${barras(hd, hdEtiq, "var(--accent3)", CUENTA)}
      <div class="scroll"><table class="${conEnv || imp ? "nowrap" : ""}">
        <tr><th>#</th><th>hora</th><th>n° boleto</th><th>tarifa</th><th>precio</th>${imp ? "<th>intentos</th>" : ""}${conEnv
          ? "<th>corr.</th><th>reenv.</th><th>ACK</th>" : ""}</tr>
        ${filas}</table></div>
      <p class="note">Cada fila es un boleto confirmado en BD (<code>[TicketCounterManager]</code>), la fuente real de venta.
        La tarifa es el <b>tipo</b> de boleto; el precio se toma del mapa <code>PRECIO_FARE</code> en el código.${conEnv
          ? ` <b>corr.</b> = correlativo local del boleto; <b>reenv.</b> = veces que ese correlativo volvió a salir por el socket
          (<b>+N✗</b> = intentos que ni salieron); <b>ACK</b> = si el servidor respondió (✗ = sin respuesta, ×2 = respondió dos veces).
          El detalle y el motivo están en <i>Envío de boletos al servidor</i>.` : ""}${imp
          ? ` <b>intentos</b> = veces que se intentó imprimir ese n° hasta que salió en papel (1 = a la primera; pasa el mouse
          para ver a qué hora falló y por qué; <b>?</b> = boleto sin su línea <code>[VENTA] IMPRESA</code>).` : ""}</p>
    </div>`;
}

// Objeto(s) JSON de sesión de la plataforma → filas de comparación + objeto crudo para render estructurado.
const tsSesion = (v) => (v != null ? parseTs(String(v).replace("T", " ").slice(0, 19)) : null);

function filaDeSesion(o) {
  if (!o || typeof o !== "object" || (o.inicio == null && o.fin == null)) return null;
  return {
    lado: o.lado != null ? LADO(o.lado) : null,
    ini: tsSesion(o.inicio),
    fin: tsSesion(o.fin),
    prod: o.produccion != null ? +o.produccion : null,
    id: o.id ?? null,
    raw: o,
  };
}

// Acepta: un objeto, un arreglo [ ... ], o varios objetos pegados uno tras otro. null = JSON inválido.
function parseVariosJson(text) {
  const t = (text || "").trim();
  if (!t) return [];
  let data;
  try { data = JSON.parse(t); }
  catch {
    try { data = JSON.parse("[" + t.replace(/}\s*,?\s*\{/g, "},{") + "]"); }
    catch { return null; }
  }
  return Array.isArray(data) ? data : [data];
}

function parseSesionesJson(text) {
  const arr = parseVariosJson(text);
  if (!arr) return null;
  const filas = arr.map(filaDeSesion).filter(Boolean);
  filas.sort((a, b) => a.ini - b.ini);
  return filas.length ? filas : null;
}

function parseSesiones(text) {
  const t = (text || "").trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = parseSesionesJson(t);
    if (j) return j;
  }
  const RE_DT = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/g;
  const out = [];
  for (const linea of text.split(/\r?\n/)) {
    const l = linea.trim();
    if (!l) continue;
    const dts = [...l.matchAll(RE_DT)];
    if (dts.length < 2) continue;
    const ini = parseTs(`${dts[0][1]} ${dts[0][2]}`);
    const fin = parseTs(`${dts[1][1]} ${dts[1][2]}`);
    let lado = null;
    const mv = l.match(/lado[=:\s]+(true|false)/i);
    if (mv) lado = /true/i.test(mv[1]) ? "B" : "A";
    else { const ml = l.match(/(?:^|\s)([AB])(?:\s|$)/); if (ml) lado = ml[1]; }
    const mp = l.replace(RE_DT, " ").match(/(\d+\.\d{1,2})/);
    out.push({ lado, ini, fin, prod: mp ? +mp[1] : null });
  }
  out.sort((a, b) => a.ini - b.ini);
  return out;
}

function duplicados(tk) {
  const g = new Map();
  for (const k of tk) {
    const key = `${k.fare}-${k.num}`;
    if (!g.has(key)) g.set(key, []);
    g.get(key).push(k);
  }
  return [...g.entries()].filter(([, a]) => a.length > 1);
}

function clasificaError(msg) {
  const m = msg.toLowerCase();
  // Hasta la 1.0.65 la cola fallaba con el mensaje viejo del estado ("Impresora lista") cuando no había impresora
  // seleccionada porque se estaba reconectando; desde la 1.0.66 espera y, si no vuelve en 30 s, es "Timeout".
  if (/^impresora lista/.test(m)) return "Sin impresora (reconectando)";
  if (/sin impresora|no hay impresora/.test(m)) return "Sin impresora";
  if (/sin papel/.test(m)) return "Sin papel";
  if (/no responde/.test(m)) return "No responde";
  if (/ocupada/.test(m)) return "Ocupada";
  if (/timeout/.test(m)) return "Timeout";
  if (/fall[oó]|error/.test(m)) return "Error impresión";
  return null;
}

// Una falla = un trabajo de impresión que falló: "[ERROR-PrintQueue] Error: X" (boleto) o "Error raw job <tipo>: X"
// (liquidación, prueba…). No se cuentan sus ecos: "Procesamiento detenido" (hasta la 1.0.65 repite cada falla),
// "Ping falló", "No se encontró impresora" y demás pasos de la recuperación. Sin PrintQueue en el log (antes de la
// 1.0.13) vale cualquier línea de error de impresión.
// Varios archivos del mismo equipo pueden solaparse: una línea idéntica cuenta las veces que aparece en el archivo que
// más la repite (dos fallas en el mismo segundo son dos líneas iguales y las dos cuentan).
function parseErrores(textos) {
  const lista = Array.isArray(textos) ? textos : [textos];
  const conCola = lista.some((t) => t.includes("[PrintQueue]"));
  const RE = conCola
    ? /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[ERROR-PrintQueue\] Error(?: raw job (\S+))?: (.*)$/
    : /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(?:ERROR-)?(?:PrintExecutor(?:V2)?|PrinterService|PrintManager)\] ()(.*)$/;
  const veces = new Map();
  for (const t of lista) {
    const n = new Map();
    for (const linea of t.split(/\r?\n/)) if (RE.test(linea)) n.set(linea, (n.get(linea) || 0) + 1);
    for (const [l, k] of n) veces.set(l, Math.max(veces.get(l) || 0, k));
  }
  const out = [];
  for (const [linea, k] of veces) {
    const m = RE.exec(linea), tipo = clasificaError(m[3]) ?? (conCola ? "Error impresión" : null);
    if (!tipo) continue;
    for (let j = 0; j < k; j++) out.push({ t: parseTs(m[1]), tipo, msg: m[3], trabajo: m[2] || "boleto" });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function hhmmss(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// --- Envío de boletos al servidor: intentos, reenvíos y ACK por correlativo ---
// El APK manda cada boleto al imprimir (PrintQueue "✓ Job completado …, ticket C") y, en cada login
// con el servidor, reenvía en lotes de 20 los que siguen sin ACK (SocketMessageDispatcher "📡 Lote").
// El servidor confirma con [RECIBIDO] tickets {id, correlative}; ese ACK es lo que marca upload=1.
const RE_LINEA = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*)$/;
const ENVIO_VENTANA_MS = [-2000, 10000]; // intención → línea del socket (el send es asíncrono)
const CRUCE_MS = 5000;                   // reenvío tan pegado al envío que el ACK no pudo llegar
const ORIGEN = { venta: "al imprimir", pendientes: "lote al reconectar", forzado: "lote forzado", "?": "envío" };

// El export del APK viene del más nuevo al más viejo: se invierte por registro (línea con fecha + continuaciones).
function cronologico(text) {
  const regs = [];
  for (const l of text.split(/\r?\n/)) {
    if (RE_LINEA.test(l) || !regs.length) regs.push([l]); else regs[regs.length - 1].push(l);
  }
  const ts = regs.filter((r) => RE_LINEA.test(r[0])).map((r) => r[0].slice(0, 19));
  if (ts.length < 2 || ts[0] <= ts[ts.length - 1]) return text;
  return regs.reverse().map((r) => r.join("\n")).join("\n");
}

function motivoError(msg) {
  if (/Socket NULL|No conectado/i.test(msg)) return "socket desconectado";
  if (/Send falló/i.test(msg)) return "socket se cerró al enviar";
  if (/Encode falló/i.test(msg)) return "error al codificar";
  return "excepción al enviar";
}

const CONEXION = [
  [/\[NetworkConnectivityRepository\] ✅ Red disponible/, "netup", () => "red disponible"],
  [/\[NetworkConnectivityRepository\] ❌ Red perdida/, "netdown", () => "sin internet (red perdida)"],
  [/\[SocketService\] ✅ CONECTADO/, "up", () => "socket conectado"],
  [/\[onFailure\] \[ID: \d+\]:\s*(.*)/, "down", (m) => `socket cayó: ${m[1].slice(0, 140).replace(/</g, "&lt;")}`],
  [/\[onClos(?:ing|ed)\] \[ID: \d+\] - (\d+)/, "down", (m) => `servidor cerró el socket (${m[1]})`],
  [/TIMEOUT conexión/, "down", () => "timeout al conectar"],
  [/⏰ Watchdog/, "down", () => "socket mudo 2 min (watchdog)"],
  [/Sin login ACK tras/, "down", () => "servidor no confirmó el login"],
  [/DESCONECTANDO manualmente/, "down", () => "desconexión manual"],
];

const campo = (o, k) => { const m = new RegExp(`(?:^|[{,\\s])${k}=([^,}\\s]+)`).exec(o); return m ? m[1] : null; };
const objetosDe = (s) => s.match(/\{[^{}]*\}/g) || [];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function parseEnvios(text) {
  const ev = [];
  let origenLote = "pendientes";
  text.split(/\r?\n/).forEach((linea, i) => {
    const m = RE_LINEA.exec(linea);
    if (!m) return;
    const t = parseTs(m[1]), s = m[2];
    let x;
    if ((x = /\[ENVIADO\].*?\((\d+)B\).*?\[KEY\]:\s*tickets\s*\[DATA\]:\s*(.*)/.exec(s))) {
      const tks = objetosDe(x[2]).map((o) => ({
        corr: +campo(o, "correlative"), fare: +campo(o, "fare"), num: +campo(o, "number"),
        day: campo(o, "day"), time: campo(o, "time"), price: +campo(o, "price"), session: +campo(o, "session"),
      })).filter((k) => k.corr);
      if (tks.length) ev.push({ t, i, tipo: "send", bytes: +x[1], tks });
    } else if ((x = /\[ENVIADO\].*?\[ERROR🔴\]\s*:?\s*(.*)/.exec(s))) {
      const fmt = /formato:\s*(\w+)/.exec(x[1]);
      if (!fmt || fmt[1] === "tickets") ev.push({ t, i, tipo: "err", motivo: motivoError(x[1]), post: /Send falló/.test(x[1]) });
    } else if ((x = /\[RECIBIDO\].*?\|\s*tickets\s*\[DATA\]:\s*(.*)/.exec(s) ||
                    /\[SocketMessageDispatcher\] Mensaje: Header: tickets, Data:\s*(.*)/.exec(s))) {
      const tks = objetosDe(x[1]).map((o) => ({ corr: +campo(o, "correlative"), id: campo(o, "id") })).filter((k) => k.corr);
      ev.push({ t, i, tipo: "ack", rx: s.includes("[RECIBIDO]"), tks });
    } else if ((x = /\[PrintQueue\] ✓ Job completado: \S+, ticket (\d+)/.exec(s))) {
      ev.push({ t, i, tipo: "intento", origen: "venta", corrs: [+x[1]] });
    } else if ((x = /\[SocketMessageDispatcher\] 📡 Lote (\d+\/\d+) \(\d+ tickets\): #\[([\d,\s]*)\]/.exec(s))) {
      ev.push({ t, i, tipo: "intento", origen: origenLote, lote: x[1], corrs: x[2].split(",").map(Number).filter(Boolean) });
    } else if (/\[SocketMessageDispatcher\] 🔄 FORZANDO ENVÍO/.test(s)) origenLote = "forzado";
    else if (/\[SocketMessageDispatcher\] 📤 Obteniendo tickets PENDIENTES/.test(s)) origenLote = "pendientes";
    else if ((x = /\[TicketCounterManager\] Número confirmado en BD: fare=(\d+), num=(\d+)/.exec(s)))
      ev.push({ t, i, tipo: "venta", fare: +x[1], num: +x[2] });
    else for (const [re, kind, txt] of CONEXION) {
      const c = re.exec(s);
      if (c) { ev.push({ t, i, tipo: "conn", kind, txt: txt(c) }); break; }
    }
  });
  return ev.sort((a, b) => a.t - b.t || a.i - b.i);
}

// Por qué salió de nuevo un correlativo, mirando el intento anterior y lo que pasó entre ambos.
function motivoReintento(prev, a, caidaEntre) {
  if (a.origen === "forzado") return { cat: "forzado por el servidor", txt: "operación 'tickets' del servidor: reenvía aunque ya tenga ACK" };
  const p = prev.a;
  if (p.estado !== "ok") return { cat: "reintento tras fallo", txt: `el intento anterior no salió (${p.motivo})` };
  if (prev.ack && prev.ack.t <= a.t) return { cat: "duplicado con ACK", txt: `ya tenía ACK desde ${hhmmss(prev.ack.t)} y se reenvió igual` };
  const c = caidaEntre(p.tSend, a.t);
  if (c) return {
    cat: c.kind === "netdown" ? "sin ACK · sin internet" : "sin ACK · se cayó la conexión",
    txt: `sin ACK del envío anterior: ${c.txt} a las ${hhmmss(c.t)}`,
  };
  if (a.t - p.tSend <= CRUCE_MS) return { cat: "cruce con el lote", txt: `el lote lo tomó ${Math.round((a.t - p.tSend) / 1000)} s después del envío, sin dar tiempo al ACK` };
  return { cat: "sin ACK · servidor no respondió", txt: "el envío anterior salió con el socket arriba y el servidor no respondió" };
}

function analizarEnvios(text) {
  const ev = parseEnvios(text);
  const de = (tipo) => ev.filter((e) => e.tipo === tipo);
  const errs = de("err"), conn = de("conn"), ventas = de("venta"), sends = de("send");
  let acks = de("ack");
  if (acks.some((a) => a.rx)) acks = acks.filter((a) => a.rx); // el dispatcher repite el mismo mensaje
  const cerca = (a, t) => t - a.t >= ENVIO_VENTANA_MS[0] && t - a.t <= ENVIO_VENTANA_MS[1];
  const dist = (a, t) => Math.abs(a.t - t);

  // 1) cada [ENVIADO] tickets se asocia a la intención que lo originó (venta o lote)
  const intentos = de("intento").map((e) => ({ ...e, estado: null }));
  for (const s of sends) {
    const set = s.tks.map((k) => k.corr);
    let a = intentos
      .filter((a) => !a.estado && cerca(a, s.t) && set.every((c) => a.corrs.includes(c)))
      .sort((x, y) => Math.abs(x.corrs.length - set.length) - Math.abs(y.corrs.length - set.length) || dist(x, s.t) - dist(y, s.t))[0];
    if (!a) intentos.push((a = { t: s.t, i: s.i, origen: "?", corrs: set }));
    Object.assign(a, { estado: "ok", tSend: s.t, bytes: s.bytes });
  }
  intentos.sort((a, b) => a.t - b.t || a.i - b.i);

  // 2) "Send falló (formato: tickets)" se loguea DESPUÉS de [NUEVO]: ese envío no salió
  for (const e of errs.filter((e) => e.post)) {
    const a = intentos.filter((a) => a.estado === "ok" && e.t >= a.tSend && e.t - a.tSend <= 3000).pop();
    if (a) Object.assign(a, { estado: "fallo", motivo: e.motivo });
  }

  // 3) intentos sin [NUEVO]: el error genérico más cercano (no trae key) o, si no hay, nunca llegó al socket
  const sinRed = (t) => {
    let caida = false;
    for (const c of conn) { if (c.t > t) break; if (c.kind === "netdown") caida = true; else if (c.kind === "netup") caida = false; }
    return caida;
  };
  for (const a of intentos) {
    if (a.estado === "ok") continue;
    if (!a.estado) {
      const e = errs.filter((e) => !e.post && cerca(a, e.t)).sort((x, y) => dist(a, x.t) - dist(a, y.t))[0];
      a.estado = e ? "fallo" : "descartado";
      a.motivo = e ? e.motivo : "no llegó al socket (equipo sin login al servidor)";
    }
    if (sinRed(a.t)) a.motivo += " · sin internet";
  }

  // 4) por correlativo: historial, ACK de cada envío y motivo de cada reintento
  const caidaEntre = (t0, t1) => {
    const en = conn.filter((c) => c.t >= t0 && c.t <= t1);
    return en.find((c) => c.kind === "netdown") || en.find((c) => c.kind === "down");
  };
  const info = new Map();
  for (const s of sends) for (const k of s.tks) if (!info.has(k.corr)) info.set(k.corr, k);
  const porCorr = new Map();
  for (const a of intentos) for (const c of a.corrs) {
    if (!porCorr.has(c)) porCorr.set(c, { ...(info.get(c) || {}), corr: c, intentos: [], acks: [] });
    porCorr.get(c).intentos.push(a);
  }
  for (const k of acks) for (const x of k.tks) porCorr.get(x.corr)?.acks.push({ t: k.t, id: x.id });

  for (const r of porCorr.values()) {
    const oks = r.intentos.filter((a) => a.estado === "ok");
    let prev = null;
    r.pasos = r.intentos.map((a) => {
      const sig = a.estado === "ok" ? oks[oks.indexOf(a) + 1] : null;
      const ack = a.estado === "ok" ? r.acks.find((k) => k.t >= a.tSend - 1000 && (!sig || k.t < sig.tSend)) || null : null;
      const p = { a, ack, motivo: prev ? motivoReintento(prev, a, caidaEntre) : null };
      prev = p;
      return p;
    });
    r.envios = oks.length;
    r.reenvios = Math.max(0, oks.length - 1);
    r.fallidos = r.intentos.length - oks.length;
    r.ids = [...new Set(r.acks.map((k) => k.id).filter(Boolean))];
    r.estado = r.acks.length ? "ack" : oks.length ? "sinack" : "nunca";
  }

  // 5) boleto vendido (TicketCounterManager) → correlativo: la línea "✓ Job completado" que le sigue
  const corrDeVenta = new Map();
  const usadas = new Set();
  for (const a of intentos.filter((a) => a.origen === "venta")) {
    const v = ventas.filter((v) => !usadas.has(v) && a.t >= v.t && a.t - v.t <= 3000).pop();
    if (!v) continue;
    usadas.add(v);
    corrDeVenta.set(`${+v.t}|${v.fare}|${v.num}`, a.corrs[0]);
    const r = porCorr.get(a.corrs[0]);
    if (r) { r.fare ||= v.fare; r.num ||= v.num; r.tVenta = v.t; }
  }
  for (const [c, k] of info) {
    const key = `${k.day}|${k.fare}|${k.num}`;
    if (k.day && !corrDeVenta.has(key)) corrDeVenta.set(key, c);
  }
  const corrDe = (k) => corrDeVenta.get(`${+k.t}|${k.fare}|${k.num}`) ?? corrDeVenta.get(`${ymd(k.t)}|${k.fare}|${k.num}`);

  const lista = [...porCorr.values()].sort((a, b) => a.corr - b.corr);
  for (const r of lista) r.tVenta ??= r.time ? tsSesion(r.time) : r.intentos[0].t;
  return { intentos, lista, porCorr, corrDe, conn };
}

const ENVIOS_VACIO = { intentos: [], lista: [], porCorr: new Map(), corrDe: () => undefined, conn: [] };
const fmtSeg = (ms) => (ms < 1000 ? "<1 s" : `${Math.round(ms / 1000)} s`);

function celdaServidor(r, corto) {
  if (!r) return "—";
  if (r.estado === "nunca") return '<span class="tag err" title="ningún intento salió por el socket">no salió</span>';
  if (r.estado === "sinack") return `<span class="tag warn" title="salió y el servidor no respondió">${corto ? "✗" : "✗ sin ACK"}</span>`;
  const n = r.acks.length > 1 ? ` ×${r.acks.length}` : "";
  return `<span class="tag ok" title="${r.acks.length} ACK del servidor">${corto ? "✓" : "✓ ACK"}${n}</span>`;
}

function celdaIntentos(e) {
  if (!e) return '<span class="muted" title="sin línea [VENTA] IMPRESA para este boleto">?</span>';
  if (e.intentos <= 1) return '<span class="muted">1</span>';
  const tip = e.previas.map((f) => `${hhmmss(f.t)} ${f.ev}: ${f.motivo ?? ""}`).join("\n");
  return `<span class="tag warn" title="${esc(tip)}">${e.intentos}</span>`;
}

function celdaReenvios(r) {
  if (!r) return "—";
  const tip = `${r.envios} envío(s) al socket${r.fallidos ? ` · ${r.fallidos} intento(s) que no salieron` : ""}`;
  if (!r.reenvios && !r.fallidos) return `<span class="muted" title="${tip}">0</span>`;
  return `<span class="tag ${r.reenvios ? "err" : "warn"}" title="${tip}">${r.reenvios}${r.fallidos ? ` +${r.fallidos}✗` : ""}</span>`;
}

function renderEnvios(env) {
  if (!env.intentos.length) return "";
  const L = env.lista;
  const reenv = L.filter((r) => r.reenvios);
  const sinAck = L.filter((r) => r.estado === "sinack"), nunca = L.filter((r) => r.estado === "nunca");
  const multiAck = L.filter((r) => r.acks.length > 1), dupBD = L.filter((r) => r.ids.length > 1);
  const totReenv = L.reduce((s, r) => s + r.reenvios, 0);
  const lat = L.flatMap((r) => r.pasos.filter((p) => p.ack).map((p) => Math.max(0, p.ack.t - p.a.tSend))).sort((a, b) => a - b);
  const pct = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];
  const cuenta = (arr) => [...arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
  const lista = (pares) => pares.map(([k, n]) => `${k}: <b>${n}</b>`).join(" &nbsp;·&nbsp; ");
  const motivos = cuenta(L.flatMap((r) => r.pasos.filter((p) => p.motivo).map((p) => p.motivo.cat)));
  const fallos = cuenta(env.intentos.filter((a) => a.estado !== "ok").map((a) => a.motivo));
  const nLotes = env.intentos.filter((a) => a.lote).length;

  const paso = (p) => {
    const a = p.a;
    const res = a.estado === "ok"
      ? (p.ack ? `<span class="tag ok">✓ ACK ${fmtSeg(p.ack.t - a.tSend)}</span>` : '<span class="tag warn">salió · sin ACK</span>')
      : `<span class="tag err">no salió</span> <span class="muted">${a.motivo}</span>`;
    return `<div>${hhmmss(a.t)} · ${ORIGEN[a.origen]}${a.lote ? ` ${a.lote}` : ""} → ${res}${
      p.motivo ? `<div class="muted">↳ ${p.motivo.txt}</div>` : ""}</div>`;
  };
  const prob = L.filter((r) => r.reenvios || r.fallidos || r.estado !== "ack" || r.acks.length > 1);
  let tr = "";
  for (const r of prob)
    tr += `<tr class="${r.reenvios ? "hit" : ""}"><td>#${r.corr}</td><td>${r.fare ? `${r.fare}-${r.num}` : "—"}</td>
      <td>${hhmmss(r.tVenta)}</td><td>${r.envios}${r.fallidos ? ` <span class="muted">+${r.fallidos}✗</span>` : ""}</td>
      <td>${celdaServidor(r)}</td><td>${r.ids.length > 1 ? `<span class="tag err">${r.ids.join(", ")}</span>` : r.ids[0] ?? "—"}</td>
      <td class="hist">${r.pasos.map(paso).join("")}</td></tr>`;

  // Intentos que merecen revisión: todos los lotes y cualquier envío que no quedó 100% confirmado.
  const ackEn = (a) => a.corrs.filter((c) => env.porCorr.get(c)?.pasos.find((p) => p.a === a)?.ack).length;
  let trI = "";
  for (const a of env.intentos) {
    const n = a.estado === "ok" ? ackEn(a) : 0;
    if (!a.lote && a.estado === "ok" && n === a.corrs.length) continue;
    const cs = a.corrs.slice().sort((x, y) => x - y);
    const res = a.estado === "ok"
      ? `<span class="tag ok">salió</span> <span class="muted">${humano(a.bytes)}</span>`
      : `<span class="tag err">${a.estado === "fallo" ? "falló" : "descartado"}</span> <span class="muted">${a.motivo}</span>`;
    const ack = a.estado !== "ok" ? "—"
      : `<span class="tag ${n === cs.length ? "ok" : "warn"}">${n}/${cs.length}</span>`;
    trI += `<tr><td>${hhmmss(a.t)}</td><td>${ORIGEN[a.origen]}${a.lote ? ` ${a.lote}` : ""}</td>
      <td>${cs.length} · #${cs[0]}${cs.length > 1 ? `–#${cs[cs.length - 1]}` : ""}</td>
      <td style="text-align:left">${res}</td><td>${ack}</td></tr>`;
  }

  const veredicto = !prob.length
    ? `<p class="muted"><span class="tag ok">✓ Sin reenvíos</span> — los ${L.length} boletos salieron una vez y el servidor confirmó cada uno.</p>`
    : `<p class="muted">${motivos.length ? `Motivo principal de reintento: <b>${motivos[0][0]}</b> (${motivos[0][1]} de ${motivos.reduce((s, m) => s + m[1], 0)}).` : ""}
        ${multiAck.length ? ` &nbsp;<span class="tag ${dupBD.length ? "err" : "warn"}">${multiAck.length} con ACK múltiple</span> el servidor recibió el mismo correlativo más de una vez${
          dupBD.length ? ` y en <b>${dupBD.length}</b> devolvió ids distintos (duplicado en BD).` : ", pero devolvió el mismo id (no lo duplicó)."}` : ""}</p>`;

  return `<div class="panel wide"><h2>📡 Envío de boletos al servidor</h2>
    <div class="grid">
      <div class="card"><div class="lbl">Boletos enviados</div><div class="big">${L.length}</div>
        <div class="sub">${env.intentos.length} intentos · ${nLotes} lotes</div></div>
      <div class="card"><div class="lbl">Reenviados</div><div class="big">${reenv.length}</div>
        <div class="sub">${totReenv} reenvío(s) en total</div></div>
      <div class="card"><div class="lbl">Sin ACK</div><div class="big">${sinAck.length}</div>
        <div class="sub">salieron y el servidor no respondió</div></div>
      <div class="card"><div class="lbl">No salieron</div><div class="big">${nunca.length}</div>
        <div class="sub">todos sus intentos fallaron</div></div>
      ${lat.length ? `<div class="card"><div class="lbl">Respuesta del servidor</div><div class="big">${fmtSeg(pct(0.5))}</div>
        <div class="sub">mediana · p90 ${fmtSeg(pct(0.9))}</div></div>` : ""}
    </div>
    ${veredicto}
    ${motivos.length ? `<p class="muted">Motivos de reintento (por boleto): ${lista(motivos)}</p>` : ""}
    ${fallos.length ? `<p class="muted">Intentos que no salieron: ${lista(fallos)}</p>` : ""}
    ${prob.length ? `<h2 style="margin-top:14px">Boletos reenviados o sin confirmar (${prob.length})</h2>
    <div class="scroll"><table>
      <tr><th>correlativo</th><th>tarifa-n°</th><th>venta</th><th>envíos</th><th>servidor</th><th>id servidor</th><th class="hist">historial</th></tr>
      ${tr}</table></div>` : ""}
    ${trI ? `<h2 style="margin-top:14px">Lotes e intentos sin confirmar</h2>
    <div class="scroll"><table>
      <tr><th>hora</th><th>origen</th><th>boletos</th><th>resultado</th><th>ACK</th></tr>
      ${trI}</table></div>` : ""}
    <p class="note">Cada boleto se envía <b>al imprimir</b> y, en cada login con el servidor, el APK reenvía en lotes de 20 los que aún no tienen ACK
      (<code>📡 Lote</code>). <b>Reenvío</b> = el mismo correlativo salió 2+ veces por el socket (<code>[ENVIADO] tickets</code>);
      <b>ACK</b> = el servidor respondió <code>[RECIBIDO] tickets</code> con ese correlativo (el <b>id servidor</b> sale de ahí; dos ids distintos = duplicado en BD).
      <b>No salió</b> = socket caído (<code>No conectado</code> / <code>Socket NULL</code>) o el mensaje nunca llegó al socket (equipo aún sin login al servidor).
      El motivo de cada reintento se deduce de lo que pasó entre un intento y el siguiente: red perdida, caída del socket, o silencio del servidor.</p>
  </div>`;
}

function renderComparacion(tk, ses) {
  if (!ses.length) return "";
  const fmt = (d) => (d ? d.toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "en curso");
  const filas = ses.map((s) => {
    const items = tk.filter((k) => (s.ini == null || k.t >= s.ini) && (s.fin == null || k.t <= s.fin));
    return { ...s, n: items.length, prodLog: items.reduce((a, k) => a + precio(k.fare), 0) };
  });
  const maxN = Math.max(0, ...filas.map((f) => f.n));
  const asignados = filas.reduce((a, f) => a + f.n, 0);
  const fuera = tk.length - asignados;
  const ganadora = filas.find((f) => f.n === maxN);

  let tr = "";
  for (const f of filas) {
    const dif = f.prod != null ? (f.prodLog - f.prod) : null;
    tr += `<tr class="${f.n === maxN ? "hit" : ""}">
      <td>${f.lado ?? "—"}</td><td>${fmt(f.ini)} → ${fmt(f.fin)}</td>
      <td>${f.n}${f.n === maxN ? " ★" : ""}</td>
      <td>S/ ${f.prodLog.toFixed(2)}</td>
      <td>${f.prod != null ? "S/ " + f.prod.toFixed(2) : "—"}</td>
      <td>${dif != null ? (Math.abs(dif) < 1e-9 ? "✓ cuadra" : "S/ " + dif.toFixed(2)) : "—"}</td></tr>`;
  }
  return `
    <div class="panel"><h2>📊 Boletos por sesión</h2>
      <p class="muted">Sesión con más ventas: <b>Lado ${ganadora?.lado ?? "?"}</b>
        con <b>${maxN}</b> boletos.${fuera ? ` &nbsp;·&nbsp; ${fuera} boleto(s) fuera de toda sesión.` : ""}</p>
      <table>
        <tr><th>lado</th><th>ventana</th><th>boletos</th><th>producción (log)</th><th>plataforma</th><th>diferencia</th></tr>
        ${tr}</table></div>`;
}

function renderDuplicados(tk) {
  const dup = duplicados(tk);
  if (!dup.length)
    return `<div class="panel"><h2>Duplicados</h2><p class="muted"><span class="tag ok">✓ Sin duplicados</span> — cada boleto (tarifa+n°) es único.</p></div>`;
  let tr = "";
  for (const [key, arr] of dup)
    tr += `<tr><td>${key}</td><td>${arr.length}</td><td>${arr.map((k) => hhmmss(k.t)).join(", ")}</td></tr>`;
  return `<div class="panel"><h2>⚠️ Boletos duplicados (${dup.length})</h2>
    <table><tr><th>tarifa-n°</th><th>veces</th><th>horas</th></tr>${tr}</table></div>`;
}

function renderErrores(textos) {
  const errs = parseErrores(textos);
  if (!errs.length)
    return `<div class="panel"><h2>Errores de impresión</h2><p class="muted"><span class="tag ok">✓ Sin errores</span> — no se registró ninguna falla de impresión en el log.</p></div>`;
  const porTipo = new Map();
  for (const e of errs) porTipo.set(e.tipo, (porTipo.get(e.tipo) || 0) + 1);
  const resumen = [...porTipo.entries()].map(([t, n]) => `${t}: <b>${n}</b>`).join(" &nbsp;·&nbsp; ");
  const nBol = errs.filter((e) => e.trabajo === "boleto").length;
  let tr = "";
  for (const e of errs)
    tr += `<tr><td>${hhmmss(e.t)}</td><td><span class="tag err">${e.tipo}</span></td><td>${esc(e.trabajo)}</td><td>${esc(e.msg)}</td></tr>`;
  return `<div class="panel"><h2>🖨️ Errores de impresión (${errs.length})</h2>
    <p class="muted">${resumen}${nBol < errs.length ? ` &nbsp;·&nbsp; ${nBol} de boletos, ${errs.length - nBol} de liquidación u otros` : ""}</p>
    <p class="muted">Una fila por trabajo de impresión que falló (<code>[ERROR-PrintQueue] Error…</code>); no se cuentan sus ecos
      (<code>Procesamiento detenido</code>, <code>Ping falló</code>). <b>Sin impresora (reconectando)</b> = hasta la 1.0.65 la cola
      fallaba con el texto "Impresora lista" mientras la impresora se reconectaba.</p>
    <table><tr><th>hora</th><th>tipo</th><th>trabajo</th><th>mensaje</th></tr>${tr}</table></div>`;
}

// --- Versión del APK e impresión por toque (1.0.72+) ---
// Desde la 1.0.72 el APK deja una línea "[VENTA] EVENTO clave=valor" por cada paso de una venta:
// TOQUE (el chofer tocó una tarjeta) → ENCOLADA → IMPRIMIENDO → IMPRESA (suma) | NO_IMPRESA (no suma, la fila se borra),
// y RECHAZADA / CANCELADA cuando no llegó a imprimirse. Además ya no existe el modo digital: siempre imprime.
const V72 = [1, 0, 72];
const cmpV = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const NO_IMPRIMIO = new Set(["NO_IMPRESA", "CANCELADA", "RECHAZADA"]);
const REINTENTO_MS = 3 * 60 * 1000; // falla → mismo tarifa-n° impreso: más separado ya es otra venta
const CUENTA = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function detectarVersiones(text) {
  const vs = new Map();
  for (const m of text.matchAll(/(?:proceso iniciado v|version=|ahora v)(\d+)\.(\d+)\.(\d+)/g))
    vs.set(`${m[1]}.${m[2]}.${m[3]}`, [+m[1], +m[2], +m[3]]);
  return [...vs.values()].sort(cmpV);
}

// Versión del APK en cada momento: la última línea con versión antes de t (device_status cada 5 min, arranque,
// "[TCONTUR_UPDATE] … ahora vX" al actualizarse); sin ninguna antes, la primera de después. `.cambios` = actualizaciones.
function lineaDeVersiones(text) {
  const pts = [];
  for (const m of text.matchAll(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) .*?(?:proceso iniciado v|version=|ahora v)(\d+\.\d+\.\d+)/gm))
    pts.push({ t: parseTs(m[1]), v: m[2] });
  pts.sort((a, b) => a.t - b.t);
  const en = (t) => {
    if (!pts.length) return null;
    let v = pts[0].v;
    for (const p of pts) { if (p.t > t) break; v = p.v; }
    return v;
  };
  en.cambios = pts.flatMap((p, i) => (i && p.v !== pts[i - 1].v ? [{ t: p.t, de: pts[i - 1].v, a: p.v }] : []));
  return en;
}

const RE_VENTA = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[VENTA\] (\w+)\s*(.*)$/;
const RE_KV = /(\w+)=(?:"([^"]*)"|(\S+))/g;
const NUMERICOS = ["boleto", "num", "correlativo", "ms", "min", "espera_ms", "tarifa"];

function parseVentaLog(text) {
  const out = [];
  text.split(/\r?\n/).forEach((linea, i) => {
    const m = RE_VENTA.exec(linea);
    if (!m) return;
    const e = { t: parseTs(m[1]), i, ev: m[2] };
    for (const k of m[3].matchAll(RE_KV)) e[k[1]] = k[2] ?? k[3];
    for (const k of NUMERICOS) if (e[k] != null && !isNaN(+e[k])) e[k] = +e[k];
    out.push(e);
  });
  return out.sort((a, b) => a.t - b.t || a.i - b.i);
}

// Logs anteriores a la 1.0.72 (desde la 1.0.50): los mismos eventos se reconstruyen con las líneas de siempre.
// Número reservado (UI) = intento de venta → Job encolado le da su job → la cola es FIFO, así que "IMPRESIÓN INICIADA"
// y "[ERROR-PrintQueue] Error" son del job más antiguo sin terminar. No hay toques: un toque corto no deja rastro.
function reconstruirVentaLegacy(text) {
  const out = [], cola = [], porJob = new Map(), sinJob = [];
  let actual = null;
  const quitar = (a) => { const k = cola.indexOf(a); if (k >= 0) cola.splice(k, 1); if (actual === a) actual = null; };
  const evento = (a, ev, t, i, extra = {}) => {
    const tarifa = precio(a.fare);
    const e = { t, i, ev, job: a.job?.slice(0, 8), boleto: a.fare, num: a.num, ...(tarifa ? { tarifa } : {}), ...extra };
    out.push(e);
    return e;
  };
  text.split(/\r?\n/).forEach((linea, i) => {
    const m = RE_LINEA.exec(linea);
    if (!m) return;
    const t = parseTs(m[1]), s = m[2];
    let x;
    if ((x = /\[TicketCounterManager\] Número reservado: fare=(\d+), num=(\d+)/.exec(s))) {
      sinJob.push({ t, fare: +x[1], num: +x[2] });
    } else if ((x = /\[PrintQueue\] Job encolado: (\S+)/.exec(s))) {
      const a = sinJob.length && t - sinJob[sinJob.length - 1].t <= 2000 ? sinJob.pop() : { t, prueba: true };
      a.job = x[1];
      cola.push(a);
      porJob.set(a.job, a);
      if (!a.prueba) evento(a, "ENCOLADA", t, i);
    } else if (/\[PrintQueue\] Cola llena/.test(s)) {
      // venderBoleto reserva, la cola la rechaza y se loguea después: es la última reserva sin job.
      const a = sinJob.length && t - sinJob[sinJob.length - 1].t <= 2000 ? sinJob.pop() : null;
      if (a) evento(a, "RECHAZADA", t, i, { suma: "NO", motivo: "cola llena" });
    }
    else if (/\[PrintExecutor(?:V2)?\] === IMPRESIÓN (?:V2 )?INICIADA ===/.test(s)) {
      actual = cola[0] || null;
      if (actual && !actual.prueba) { actual.inicio = t; evento(actual, "IMPRIMIENDO", t, i); }
    } else if (/Modo digital - Sin impresión física/.test(s)) { if (actual) actual.digital = true; }
    else if ((x = /\[TicketCounterManager\] Número confirmado en BD: fare=(\d+), num=(\d+)/.exec(s))) {
      const a = cola.find((c) => c.fare === +x[1] && c.num === +x[2]) || actual;
      if (!a || a.prueba) return;
      a.impresa = evento(a, a.digital ? "DIGITAL" : "IMPRESA", t, i, {
        suma: "SI", ...(a.inicio ? { ms: t - a.inicio } : {}), ...(a.digital ? { motivo: "modo digital: sumó sin papel" } : {}),
      });
      quitar(a);
    } else if ((x = /\[PrintQueue\] ✓ Job completado: (\S+), ticket (\d+)/.exec(s))) {
      const a = porJob.get(x[1]);
      if (a?.impresa) a.impresa.correlativo = +x[2];
      if (a) quitar(a);
    } else if ((x = /\[ERROR-PrintQueue\] Error: (.*)/.exec(s))) {
      const a = actual || cola[0];
      if (!a) return;
      // Antes de la 1.0.72 la fila ya estaba guardada si falló después de IMPRESIÓN INICIADA: sumó sin papel.
      // Hasta la 1.0.65 "Impresora lista" como error = no había impresora seleccionada (se estaba reconectando).
      const motivo = /^Impresora lista/.test(x[1]) ? `${x[1]} (sin impresora: se estaba reconectando)` : x[1];
      if (!a.prueba) evento(a, "NO_IMPRESA", t, i, { suma: a.inicio ? "SI" : "NO", motivo: motivo + (a.inicio ? " · la fila quedó guardada (sumó)" : "") });
      quitar(a);
    } else if ((x = /\[PrintQueue\] Job cancelado con rollback: (\S+)/.exec(s))) {
      const a = porJob.get(x[1]);
      if (a && !a.prueba && cola.includes(a)) evento(a, "CANCELADA", t, i, { suma: "NO", motivo: "cola limpiada tras una falla o al reconectar" });
      if (a) quitar(a);
    }
  });
  return out.sort((a, b) => a.t - b.t || a.i - b.i);
}

function analizarImpresion(venta, tickets) {
  if (!venta.length) return null;
  const de = (ev) => venta.filter((e) => e.ev === ev);
  const toques = de("TOQUE");
  const porResultado = new Map();
  for (const e of toques) porResultado.set(e.resultado, (porResultado.get(e.resultado) || 0) + 1);

  // Un ERROR_TRAS_IMPRIMIR sin IMPRESA del mismo job también salió en papel.
  const conImpresa = new Set(de("IMPRESA").map((e) => e.job));
  const impresas = venta.filter((e) => e.ev === "IMPRESA" || e.ev === "DIGITAL" || (e.ev === "ERROR_TRAS_IMPRIMIR" && !conImpresa.has(e.job)));
  const fallas = venta.filter((e) => NO_IMPRIMIO.has(e.ev));

  // Toque OK → la ENCOLADA del mismo boleto que le sigue (≤ 3 s) es la venta que disparó.
  const toqueDe = new Map();
  const libres = toques.filter((e) => e.resultado === "OK");
  for (const e of de("ENCOLADA")) {
    const k = libres.findIndex((x) => x.boleto === e.boleto && e.t - x.t >= 0 && e.t - x.t <= 3000);
    if (k >= 0) toqueDe.set(e.job, libres.splice(k, 1)[0]);
  }

  // Intentos por n° de boleto: al fallar se devuelve el número y la siguiente venta de esa tarifa lo reusa.
  // Solo son intentos previos de un boleto impreso las fallas de su mismo tarifa-n° encadenadas a ≤ 3 min una de otra
  // hasta la impresión: si pasó más tiempo, ese n° lo tomó otra venta (la falla no "salió al reintentar").
  const pendientes = new Map(), esImpresa = new Set(impresas);
  for (const e of venta) {
    if (e.boleto == null || e.num == null) continue;
    const key = `${e.boleto}-${e.num}`;
    if (NO_IMPRIMIO.has(e.ev)) { if (!pendientes.has(key)) pendientes.set(key, []); pendientes.get(key).push(e); }
    else if (esImpresa.has(e)) {
      const fallas = pendientes.get(key) || [], previas = [];
      let t = e.t;
      for (let k = fallas.length - 1; k >= 0 && t - fallas[k].t <= REINTENTO_MS; k--) { previas.unshift(fallas[k]); t = fallas[k].t; }
      e.previas = previas;
      e.intentos = previas.length + 1;
      for (const f of previas) f.luego = e;
      pendientes.delete(key);
    }
  }

  // Cada boleto confirmado en BD ([TicketCounterManager]) se empareja con su IMPRESA (misma tarifa y n°, ±5 s).
  const usadas = new Set();
  const impresaDe = (k) => {
    const e = impresas.find((x) => !usadas.has(x) && x.boleto === k.fare && x.num === k.num && Math.abs(x.t - k.t) <= 5000);
    if (e) usadas.add(e);
    return e || null;
  };
  const porTicket = new Map(tickets.map((k) => [k, impresaDe(k)]));

  const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  return {
    venta, toques, porResultado, impresas, fallas, toqueDe, porTicket,
    sinVenta: toques.filter((e) => ["CORTO", "CANCELADO", "DESHABILITADO"].includes(e.resultado)),
    reintentados: impresas.filter((e) => e.intentos > 1),
    nuncaImpresos: fallas.filter((f) => !f.luego && f.num != null),
    msImpresion: med(impresas.map((e) => e.ms).filter((x) => x != null)),
    msCorto: med(toques.filter((e) => e.resultado === "CORTO").map((e) => e.ms)),
    minToque: med(toques.map((e) => e.min).filter((x) => x != null)),
  };
}

const TAG_EVENTO = {
  TOQUE: "", ENCOLADA: "", IMPRIMIENDO: "", IMPRESA: "ok", ERROR_TRAS_IMPRIMIR: "warn", DIGITAL: "warn",
  NO_IMPRESA: "err", CANCELADA: "err", RECHAZADA: "err",
};
const TAG_TOQUE = { OK: "ok", CORTO: "warn", CANCELADO: "warn", DESHABILITADO: "err", YAPE: "" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function boletoTxt(e) {
  if (e.boleto == null) return e.lote ? `lote ${esc(e.lote)}` : "—";
  const soles = e.tarifa != null ? `S/ ${(+e.tarifa).toFixed(2)}` : "";
  return e.nombre
    ? `${esc(e.nombre)} <span class="muted">t${e.boleto}${soles ? ` · ${soles}` : ""}</span>`
    : `Tarifa ${e.boleto}${soles ? ` <span class="muted">${soles}</span>` : ""}`;
}

function detalleEvento(e) {
  if (e.ev === "TOQUE") {
    const dur = e.ms != null ? ` <span class="muted">${e.ms} ms${e.min != null ? ` / mín ${e.min}` : ""}</span>` : "";
    return `<span class="tag ${TAG_TOQUE[e.resultado] ?? ""}">${esc(e.resultado)}</span>${dur}`;
  }
  const partes = [];
  if (e.correlativo != null && e.correlativo !== "-") partes.push(`corr. #${e.correlativo}`);
  if (e.ms != null) partes.push(`${e.ms} ms`);
  if (e.cola) partes.push(`cola ${esc(e.cola)}`);
  if (e.motivo) partes.push(esc(e.motivo));
  return `<span class="muted">${partes.join(" · ")}</span>`;
}

function filaEvento(e, conFecha) {
  const cuando = conFecha ? `${ymd(e.t)} ${hhmmss(e.t)}` : hhmmss(e.t);
  return `<tr><td>${cuando}</td><td><span class="tag ${TAG_EVENTO[e.ev] ?? ""}">${e.ev}</span></td>
    <td style="text-align:left">${boletoTxt(e)}</td><td>${e.num ?? "—"}</td><td>${esc(e.pago ?? "")}</td>
    <td style="text-align:left">${detalleEvento(e)}</td></tr>`;
}

function renderVersion(versiones, imp) {
  const txt = versiones.length ? versiones.map((v) => v.join(".")).join(" → ") : "no detectada";
  const nueva = (imp && !imp.inferido) || (versiones.length && cmpV(versiones[versiones.length - 1], V72) >= 0);
  return `<div class="panel"><h2>📱 Versión del APK</h2>
    <div class="grid"><div class="card"><div class="lbl">Versión en el log</div><div class="big">${txt}</div>
      <div class="sub">${nueva ? "diagnóstico de impresión por toque (1.0.72+)"
        : imp ? "intentos reconstruidos desde la cola (sin toques)" : "diagnóstico inferido (versión anterior a 1.0.72)"}</div></div></div>
    <p class="note">${nueva
      ? "Con la 1.0.72+ cada toque y cada intento de impresión queda en el log (<code>[VENTA]</code>): el reporte ya no adivina, lee lo que pasó."
      : "Las versiones 1.0.50–1.0.71 no registran los toques: los intentos de impresión se reconstruyen con las líneas de la cola "
        + "(<code>Número reservado</code>, <code>IMPRESIÓN INICIADA</code>, <code>Error</code>, <code>Número confirmado</code>) y "
        + "<i>Vendidos sin imprimir</i> deduce lo que sumó por correlativos."}
      La versión sale de <code>[Arranque] 1) MyApp.onCreate — proceso iniciado vX</code> o del <code>version=</code> que envía el equipo.</p>
  </div>`;
}

function renderImpresion(x, versiones) {
  if (!x) {
    const vieja = versiones.length && cmpV(versiones[versiones.length - 1], V72) < 0;
    return vieja ? `<div class="panel"><h2>👆 Impresión por toque</h2>
      <p class="muted">Este log es de la v${versiones[versiones.length - 1].join(".")}: no registra toques ni intentos de impresión.
        Actualiza el equipo a la <b>1.0.72</b> para ver aquí si el chofer presionó y por qué no imprimió.</p></div>` : "";
  }
  const r = (k) => x.porResultado.get(k) || 0;
  const nOk = r("OK"), nCorto = r("CORTO"), nCanc = r("CANCELADO"), nBloq = r("DESHABILITADO"), nYape = r("YAPE");
  const cuentaMotivos = [...x.fallas.reduce((m, f) => m.set(f.motivo || f.ev, (m.get(f.motivo || f.ev) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]);

  const porHora = new Array(24).fill(0);
  for (const f of x.fallas) porHora[f.t.getHours()]++;
  const cortosHora = new Array(24).fill(0);
  for (const e of x.sinVenta) cortosHora[e.t.getHours()]++;
  const hdEtiq = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));

  const nDig = x.impresas.filter((e) => e.ev === "DIGITAL").length;
  const sumaronFalla = x.fallas.filter((f) => f.suma === "SI").length;
  const veredicto = [];
  if (x.inferido) veredicto.push(`<span class="tag warn">Sin toques</span> esta versión no registra los toques: si el chofer dice que presionó
    y a esa hora no hay intento de venta, pudo ser un toque corto o que no tocó (no se puede distinguir).`);
  if (nDig) veredicto.push(`<span class="tag warn">${nDig} en modo digital</span> sumaron <b>sin papel</b> (<code>gps_imprimir</code> apagado).`);
  if (nCorto) veredicto.push(`<span class="tag warn">${nCorto} toque(s) cortos</span> tocó y soltó antes del mínimo
    (mediana <b>${x.msCorto} ms</b>${x.minToque != null ? ` de <b>${x.minToque} ms</b> requeridos` : ""}): <b>no se intentó vender</b>.`);
  if (nCanc) veredicto.push(`<span class="tag warn">${nCanc} cancelado(s)</span> deslizó el dedo o el gesto se interrumpió: no vendió.`);
  if (nBloq) veredicto.push(`<span class="tag err">${nBloq} en tarjeta bloqueada</span> tocó un boleto deshabilitado.`);
  if (x.fallas.length) veredicto.push(`<span class="tag err">${x.fallas.length} falla(s) de impresión</span> la venta se intentó y
    <b>no salió papel</b>${sumaronFalla ? `; <b>${sumaronFalla}</b> igual sumó (la fila ya estaba guardada)` : " (no sumó)"}:
    ${cuentaMotivos.slice(0, 3).map(([m, n]) => `${esc(m)} <b>×${n}</b>`).join(" · ")}.`);
  if (!x.fallas.length && !nDig && !nCorto && !nCanc && !nBloq)
    veredicto.push(`<span class="tag ok">✓ Sin fallas</span> ${x.inferido ? "cada venta intentada" : "cada toque válido"} terminó impreso.`);

  const tablaFallas = x.fallas.map((f) => {
    const toque = x.toqueDe.get(f.job);
    const luego = f.luego ? `<span class="tag ok">impreso ${hhmmss(f.luego.t)}</span> <span class="muted">intento ${f.luego.intentos}</span>`
      : f.num != null ? '<span class="tag err">no salió al reintentar</span>' : "—";
    return `<tr class="hit"><td>${hhmmss(f.t)}</td><td><span class="tag err">${f.ev}</span></td>
      <td style="text-align:left">${boletoTxt(f)}</td><td>${f.num ?? "—"}</td><td>${esc(f.pago ?? "")}</td>
      <td style="text-align:left">${esc(f.motivo ?? "")}${toque ? `<div class="muted">toque ${toque.ms} ms a las ${hhmmss(toque.t)}</div>` : ""}</td>
      <td style="text-align:left">${luego}</td></tr>`;
  }).join("");

  const intentadas = x.venta.filter((e) => e.ev === "ENCOLADA" || e.ev === "RECHAZADA").length;
  const fallasSub = x.inferido && sumaronFalla ? `${sumaronFalla} sumaron igual (fila guardada)` : "no sumaron";
  return `<div class="panel wide"><h2>${x.inferido ? "🖨️ Intentos de impresión (reconstruido" : "👆 Impresión por toque ("}${
      x.fallas.length} falla${x.fallas.length === 1 ? "" : "s"})</h2>
    <div class="grid">
      ${x.inferido
        ? `<div class="card"><div class="lbl">Ventas intentadas</div><div class="big">${intentadas}</div>
        <div class="sub">esta versión no registra toques</div></div>`
        : `<div class="card"><div class="lbl">Toques</div><div class="big">${x.toques.length}</div>
        <div class="sub">OK ${nOk} · cortos ${nCorto} · cancelados ${nCanc}${nBloq ? ` · bloqueada ${nBloq}` : ""}${nYape ? ` · Yape ${nYape}` : ""}</div></div>`}
      <div class="card"><div class="lbl">Impresos (suman)</div><div class="big">${x.impresas.length}</div>
        <div class="sub">${nDig ? `${nDig} en modo digital (sin papel) · ` : ""}${x.msImpresion != null ? `mediana ${fmtSeg(x.msImpresion)} por boleto` : ""}</div></div>
      <div class="card"><div class="lbl">Fallas de impresión</div><div class="big">${x.fallas.length}</div>
        <div class="sub">${fallasSub} · ${x.nuncaImpresos.length} sin reintento que imprimiera (≤ 3 min)</div></div>
      <div class="card"><div class="lbl">Con reintento</div><div class="big">${x.reintentados.length}</div>
        <div class="sub">boletos que salieron al 2° intento o más</div></div>
      ${x.inferido ? "" : `<div class="card"><div class="lbl">Toques sin venta</div><div class="big">${x.sinVenta.length}</div>
        <div class="sub">cortos, cancelados o bloqueados</div></div>`}
    </div>
    ${veredicto.map((v) => `<p class="muted" style="margin:4px 0">${v}</p>`).join("")}
    <div class="buscar"><label>¿Qué pasó a las <input type="time" step="1" id="qHora"></label>
      <span class="muted">muestra todo lo de ±2 min: si el chofer dice que presionó y no imprimió, aquí se ve.</span></div>
    <div id="qRes"></div>
    ${x.fallas.length ? `<h2 style="margin-top:14px">Fallas de impresión por hora</h2>${barras(porHora, hdEtiq, "#ff6b6b", CUENTA)}
    <h2 style="margin-top:14px">Boletos que no se imprimieron (${x.fallas.length})</h2>
    <div class="scroll"><table class="nowrap">
      <tr><th>hora</th><th>evento</th><th>boleto</th><th>n°</th><th>pago</th><th>motivo</th><th>después</th></tr>
      ${tablaFallas}</table></div>` : ""}
    ${x.sinVenta.length ? `<h2 style="margin-top:14px">Toques sin venta por hora</h2>${barras(cortosHora, hdEtiq, "var(--accent2)", CUENTA)}
    <h2 style="margin-top:14px">Toques sin venta (${x.sinVenta.length})</h2>
    <div class="scroll"><table class="nowrap">
      <tr><th>hora</th><th>evento</th><th>boleto</th><th>n°</th><th>pago</th><th>detalle</th></tr>
      ${x.sinVenta.map((e) => filaEvento(e)).join("")}</table></div>` : ""}
    ${x.inferido ? `<p class="note"><b>Reconstruido</b> desde las líneas de la cola de una versión anterior a la 1.0.72:
      <code>Número reservado</code> = venta intentada (ENCOLADA), <code>IMPRESIÓN INICIADA</code> = IMPRIMIENDO,
      <code>Número confirmado</code> = IMPRESA, <code>[ERROR-PrintQueue] Error</code> = NO_IMPRESA, <code>Job cancelado con rollback</code> = CANCELADA,
      <code>Modo digital</code> = DIGITAL (sumó sin papel). En estas versiones una falla <b>después</b> de <code>IMPRESIÓN INICIADA</code>
      dejaba la fila guardada y <b>sumaba</b> igual; el n° se devolvía y la siguiente venta de esa tarifa lo reusaba
      (<i>después</i> dice si ese mismo n° salió impreso en los 3 min siguientes; si tardó más, lo tomó otra venta). No hay toques ni nombre del boleto, solo su tarifa.</p>`
    : `<p class="note"><b>TOQUE</b> = el chofer tocó una tarjeta: <b>OK</b> la mantuvo el tiempo mínimo y vendió; <b>CORTO</b> soltó antes
      (no vende); <b>CANCELADO</b> deslizó o se interrumpió; <b>DESHABILITADO</b> tarjeta bloqueada. <b>IMPRESA</b> = salió en papel y
      es lo único que suma. <b>NO_IMPRESA</b> = falló la impresora: la fila se borra y el n° se devuelve, por eso la siguiente venta
      de esa tarifa reusa el mismo n° (<i>después</i> dice si ese mismo n° salió impreso en los 3 min siguientes; si tardó más, lo tomó otra venta). <b>CANCELADA</b> = estaba en cola cuando falló la
      anterior o se reconectó la impresora. <b>RECHAZADA</b> = sin sesión/login, cola llena o impresora no lista (lote Yape/externo).
      Si no hay ningún <b>TOQUE</b> a la hora que dice el chofer, no tocó la pantalla.</p>`}
  </div>`;
}

// Buscador "¿qué pasó a las HH:MM?": toda la actividad [VENTA] a ±2 min de esa hora (todos los días del log).
function mostrarHora(valor) {
  const res = $("qRes");
  if (!res) return;
  if (!valor || !_impresion) { res.innerHTML = ""; return; }
  const [h, m, s = 0] = valor.split(":").map(Number);
  const seg = h * 3600 + m * 60 + s;
  const cerca = _impresion.venta.filter((e) => {
    const x = e.t.getHours() * 3600 + e.t.getMinutes() * 60 + e.t.getSeconds();
    return Math.abs(x - seg) <= 120;
  });
  const dias = new Set(cerca.map((e) => ymd(e.t))).size;
  res.innerHTML = cerca.length
    ? `<div class="scroll" style="margin-top:8px"><table class="nowrap">
        <tr><th>hora</th><th>evento</th><th>boleto</th><th>n°</th><th>pago</th><th>detalle</th></tr>
        ${cerca.map((e) => filaEvento(e, dias > 1)).join("")}</table></div>`
    : _impresion.inferido
      ? `<p class="muted"><span class="tag warn">Nada</span> ningún intento de venta entre ${valor.slice(0, 5)} ±2 min
          (esta versión no registra toques: pudo ser un toque corto o que no tocó).</p>`
      : `<p class="muted"><span class="tag warn">Nada</span> ningún toque ni venta entre ${valor.slice(0, 5)} ±2 min: el equipo no registró que tocaran la pantalla.</p>`;
}

// --- Vendidos sin imprimir ---
// PrintQueue inserta el boleto en BD ANTES de imprimir. Si la impresión falla solo revierte el contador (Rollback UI):
// la fila queda con upload=0, el siguiente login la manda en el lote de pendientes, entra a la liquidación y su n°
// se vuelve a emitir en la próxima venta de esa tarifa. También es venta sin papel el "Modo digital" (gps_imprimir
// apagado): el job termina OK sin tocar la impresora. El flag `ticket` del login solo decide si se inicia la impresora.
// La liquidación (driver_logout) suma TODA la tabla tickets de la sesión y el APK nunca borra filas: cada correlativo
// entre primero y ultimo sumó, y si no tiene "✓ Job completado" sumó sin imprimirse.
const NOIMP_VENTANA_MS = 15000; // venta → error de impresión que la tumbó
const RE_IMP_INICIO = /\[PrintExecutor(?:V2)?\] === IMPRESIÓN (?:V2 )?INICIADA ===/;

function analizarNoImpresos(text, env, liqs, logins, venta = []) {
  // 1.0.72+: la fila de una impresión fallida se BORRA (no suma); su correlativo queda como hueco en la liquidación.
  const borrados = new Set(venta.filter((e) => e.ev === "NO_IMPRESA" && typeof e.correlativo === "number").map((e) => e.correlativo));
  const impresos = new Map(), fallas = [], errores = [], actividad = [], flagRx = [], flagMsg = [], filasBD = new Map();
  const confirmado = new Map(); // fare -> último n° confirmado en BD
  let digital = false, guardado = false, cancelados = 0, logIni = null, ultimaFalla = null;
  for (const linea of text.split(/\r?\n/)) {
    const m = RE_LINEA.exec(linea);
    if (!m) continue;
    const t = parseTs(m[1]), s = m[2];
    if (!logIni || t < logIni) logIni = t;
    let x;
    if (/\[(?:ERROR-)?Print(?:Queue|Executor(?:V2)?)\]/.test(s)) actividad.push(+t);
    // Tras "IMPRESIÓN INICIADA" el insert ya se hizo: un error desde ahí deja la fila guardada (sumó).
    if (RE_IMP_INICIO.test(s)) { digital = false; guardado = true; }
    else if (/Modo digital - Sin impresión física/.test(s)) digital = true;
    else if ((x = /\[PrintQueue\] ✓ Job completado: \S+, (?:ticket (\d+)|PRUEBA)/.exec(s))) {
      if (x[1]) impresos.set(+x[1], { t, digital });
      guardado = false;
    } else if ((x = /\[TicketCounterManager\] Número confirmado en BD: fare=(\d+), num=(\d+)/.exec(s))) confirmado.set(+x[1], +x[2]);
    else if ((x = /\[ERROR-PrintQueue\] Error: (.*)/.exec(s))) { fallas.push((ultimaFalla = { t, msg: x[1], guardado })); guardado = false; }
    // El primer Rollback tras el error es el del job que falló; la fila guardada lleva el n° confirmado + 1 de su tarifa.
    else if ((x = /\[TicketCounterManager\] Rollback UI: fare=(\d+)/.exec(s))) {
      if (ultimaFalla && !ultimaFalla.fare && t - ultimaFalla.t <= 2000) {
        ultimaFalla.fare = +x[1];
        if (confirmado.has(+x[1])) ultimaFalla.num = confirmado.get(+x[1]) + 1;
      }
    } else if ((x = /\[ERROR-Print(?:Queue|Executor(?:V2)?)\] (.*)/.exec(s))) errores.push({ t, msg: x[1] });
    else if (/\[PrintQueue\] Job cancelado con rollback/.test(s)) cancelados++;
    else if ((x = /🎟️ Ticket #(\d+) - ID: (\S+) - Uploaded/.exec(s))) filasBD.set(+x[1], tsSesion(x[2]));
    else if ((x = /\[RECIBIDO\].*?\|\s*login\s*\[DATA\]:.*?[{,\s]ticket=(true|false)/.exec(s))) flagRx.push({ t, ticket: x[1] === "true" });
    else if ((x = /\[SocketMessageDispatcher\] Mensaje: Header: login, Data:.*?[{,\s]ticket=(true|false)/.exec(s))) flagMsg.push({ t, ticket: x[1] === "true" });
  }
  const flags = (flagRx.length ? flagRx : flagMsg).sort((a, b) => a.t - b.t);
  const flagEn = (t) => { let f = null; for (const x of flags) { if (x.t > t) break; f = x.ticket; } return f; };
  // Solo se acusa a un correlativo si el log cubre su venta: hubo actividad de impresión a ±10 s y aun así no hay "Job completado".
  const cubierto = (t) => actividad.some((a) => Math.abs(a - t) <= 10000);
  const ordenados = [...impresos.keys()].sort((a, b) => a - b);
  const vecinos = (c) => {
    let prev = null, next = null;
    for (const k of ordenados) { if (k < c) prev = k; else if (k > c) { next = k; break; } }
    return { tPrev: prev != null ? impresos.get(prev).t : null, tNext: next != null ? impresos.get(next).t : null };
  };
  // Precio (céntimos): el del payload; si no salió al servidor, el más frecuente de su tarifa entre los enviados.
  const frec = new Map();
  for (const r of env.porCorr.values()) if (r.fare && r.price) {
    const f = frec.get(r.fare) || new Map();
    frec.set(r.fare, f.set(r.price, (f.get(r.price) || 0) + 1));
  }
  const precioFare = (fare) => {
    const f = frec.get(fare);
    return f ? [...f].sort((a, b) => b[1] - a[1])[0][0] : precio(fare) ? Math.round(precio(fare) * 100) : null;
  };
  const precioDe = (r) => (r?.price ? r.price : r?.fare ? precioFare(r.fare) : null);
  const reemitidos = (r) => env.lista.filter((o) => o.corr !== r.corr && o.fare === r.fare && o.num === r.num && impresos.has(o.corr));

  // Los reintentos del driver_logout repiten el mismo payload: vale el último de cada sesión.
  const ultima = new Map();
  for (const L of liqs) if (L.first && L.last >= L.first) ultima.set(L.session, L);
  const liqsSes = [...ultima.values()];
  const liqDe = (c, ses) => liqsSes.find((L) => c >= L.first && c <= L.last && (!ses || L.session === ses)) || null;
  const inicioSesion = (id) => { const l = logins.find((l) => l.id === id && l.startTime); return l ? tsSesion(l.startTime) : null; };

  const usadas = new Set();
  const causaDe = (tv, v) => {
    const dentro = (f) => (tv ? f.t - tv >= -2000 && f.t - tv <= NOIMP_VENTANA_MS
      : (v.tPrev == null || f.t >= v.tPrev) && (v.tNext == null || f.t <= v.tNext));
    const f = fallas.find((f) => f.guardado && !usadas.has(f) && dentro(f));
    if (f) { usadas.add(f); return { tipo: "falla", txt: f.msg, t: f.t, fare: f.fare, num: f.num }; }
    const e = tv && errores.find(dentro);
    return e ? { tipo: "falla", txt: e.msg, t: e.t } : { tipo: "falla", txt: "sin error registrado (¿app cerrada mientras imprimía?)" };
  };

  // Filas que existen en BD: las que salieron al servidor y todo el rango de correlativos de cada liquidación.
  const revisar = new Set(env.lista.map((r) => r.corr));
  for (const L of liqsSes) for (let c = L.first; c <= L.last; c++) revisar.add(c);

  const out = [], noVerif = new Map();
  for (const c of [...revisar].sort((a, b) => a - b)) {
    if (borrados.has(c)) continue;
    const imp = impresos.get(c);
    if (imp && !imp.digital) continue;
    const r = env.porCorr.get(c) || { corr: c };
    const L = liqDe(c, r.session);
    const v = vecinos(c);
    let tv = r.time ? tsSesion(r.time) : filasBD.get(c) ?? null;
    const ini = inicioSesion(r.session || L?.session);
    const cub = imp || (tv ? cubierto(+tv) : v.tPrev != null || (ini && ini >= logIni));
    if (!cub) { if (L) noVerif.set(L.session, (noVerif.get(L.session) || 0) + 1); continue; }
    const causa = imp ? { tipo: "digital", txt: "modo digital (gps_imprimir apagado)" } : causaDe(tv, v);
    if (!tv && causa.t) tv = causa.t;
    const fare = r.fare || causa.fare, num = r.num || causa.num, p = precioDe({ ...r, fare });
    out.push({
      ...r, corr: c, fare, num, tv, entre: v, monto: p != null ? p / 100 : null, causa, flag: tv ? flagEn(tv) : null,
      liq: L, enLog: env.porCorr.has(c), reemitidos: fare && num ? reemitidos({ corr: c, fare, num }) : [],
    });
  }

  // Conciliación: lo que sumó la liquidación vs lo que tiene "✓ Job completado" en esa sesión.
  const conc = liqsSes.map((L) => {
    const corrs = [];
    let nb = 0;
    for (let c = L.first; c <= L.last; c++) {
      if (borrados.has(c)) { nb++; continue; }
      const s = env.porCorr.get(c)?.session;
      if (!s || s === L.session) corrs.push(c);
    }
    const papel = corrs.filter((c) => impresos.has(c) && !impresos.get(c).digital);
    const dig = corrs.filter((c) => impresos.get(c)?.digital);
    const suma = (cs, fare) => cs.reduce((a, c) => {
      const r = env.porCorr.get(c);
      return fare != null && r?.fare !== fare ? a : a + (precioDe(r) ?? 0);
    }, 0);
    const sinPrecio = papel.filter((c) => precioDe(env.porCorr.get(c)) == null).length;
    const liquidado = L.cash + L.digital, impreso = suma(papel);
    const tarifas = L.resume.map((e) => ({ fare: e.fare, liq: e.cash + e.digital, imp: suma(papel, e.fare) }))
      .filter((e) => e.liq !== e.imp);
    // Cuántos boletos contó la liquidación por tarifa (filas en BD) frente a cuántos salieron en papel.
    const conPapel = new Set(papel), fareSin = new Map(out.filter((o) => o.liq === L).map((o) => [o.corr, o.fare]));
    const nTar = new Map();
    for (const c of corrs) {
      const f = env.porCorr.get(c)?.fare ?? fareSin.get(c);
      if (f == null) continue;
      const e = nTar.get(f) || { fare: f, contados: 0, impresos: 0 };
      e.contados++;
      if (conPapel.has(c)) e.impresos++;
      nTar.set(f, e);
    }
    return {
      L, filas: corrs.length, papel: papel.length, dig: dig.length, nb,
      porTarifa: [...nTar.values()].sort((a, b) => a.fare - b.fare),
      sin: out.filter((o) => o.liq === L && o.causa.tipo === "falla").length, nv: noVerif.get(L.session) || 0,
      liquidado, impreso, dif: liquidado - impreso, sinPrecio, tarifas,
    };
  });

  const v72 = venta.length > 0;
  return {
    lista: out, conc, flags, impresos: impresos.size, v72, borrados: borrados.size,
    noSumaron: v72 ? venta.filter((e) => NO_IMPRIMIO.has(e.ev)).length : fallas.filter((f) => !f.guardado).length + cancelados,
  };
}

function renderNoImpresos(x) {
  if (!x || (!x.lista.length && !x.impresos && !x.conc.length)) return "";
  const L = x.lista, soles = (c) => `S/ ${(c / 100).toFixed(2)}`;
  const total = L.reduce((s, r) => s + (r.monto ?? 0), 0), sinMonto = L.some((r) => r.monto == null);
  const falla = L.filter((r) => r.causa.tipo === "falla"), dig = L.filter((r) => r.causa.tipo === "digital");
  const enLiq = L.filter((r) => r.liq), reem = L.filter((r) => r.reemitidos.length);
  const nFalse = x.flags.filter((f) => !f.ticket).length;
  const flagTxt = !x.flags.length ? "—" : nFalse ? `false ×${nFalse}` : "true";
  const flagSub = !x.flags.length ? "no hay login en el log" : `${x.flags.length} login(s) · ${nFalse ? `${x.flags.length - nFalse} en true` : "nunca en false"}`;

  let tr = "";
  for (const r of L) {
    const srv = r.acks?.length
      ? `<span class="tag ok" title="${r.envios} envío(s)">✓ ACK</span> <span class="muted">${r.ids.join(", ")}</span>`
      : r.envios ? '<span class="tag warn">salió · sin ACK</span>'
      : r.enLog ? '<span class="tag err">no salió</span>' : '<span class="muted">no se envió en este log</span>';
    const envio = r.pasos?.find((p) => p.a.estado === "ok");
    const { tPrev, tNext } = r.entre;
    const venta = r.tv ? hhmmss(r.tv)
      : tPrev || tNext ? `<span class="muted">entre ${tPrev ? hhmmss(tPrev) : "?"} y ${tNext ? hhmmss(tNext) : "?"}</span>` : "—";
    tr += `<tr class="hit"><td>#${r.corr}</td><td>${r.fare ? `${r.fare}-${r.num}` : "?"}</td><td>${venta}</td>
      <td>${r.monto != null ? `S/ ${r.monto.toFixed(2)}` : "?"}</td>
      <td>${r.session || r.liq ? `#${r.session || r.liq.session}` : "—"}</td>
      <td style="text-align:left"><span class="tag ${r.causa.tipo === "digital" ? "warn" : "err"}">${r.causa.tipo === "digital" ? "modo digital" : "falló impresión"}</span>
        <span class="muted">${r.causa.txt}</span></td>
      <td>${r.flag == null ? "—" : r.flag ? "true" : '<span class="tag warn">false</span>'}</td>
      <td style="text-align:left">${srv}${envio ? `<div class="muted">${ORIGEN[envio.a.origen]} ${hhmmss(envio.a.tSend)}</div>` : ""}</td>
      <td>${r.liq ? `<span class="tag err">sumó</span> <span class="muted">liq. #${r.liq.session}</span>` : "—"}</td>
      <td>${r.reemitidos.length ? r.reemitidos.map((o) => `#${o.corr} <span class="muted">${hhmmss(o.tVenta)}</span>`).join("<br>") : "—"}</td></tr>`;
  }

  let trC = "";
  for (const c of x.conc) {
    const res = !c.dif && !c.sin && !c.dig ? '<span class="tag ok">✓ cuadra</span>'
      : c.sin || c.dig ? `<span class="tag err">${soles(c.dif)} sin papel</span>`
      : c.nv ? `<span class="muted">${soles(c.dif)} de ${c.nv} fila(s) anteriores al log</span>`
      : `<span class="tag warn" title="${c.sinPrecio} impreso(s) sin precio en el log">${soles(c.dif)} sin explicar</span>`;
    const nTar = new Map(c.porTarifa.map((e) => [e.fare, e]));
    const det = c.tarifas.length && (c.sin || c.dig || c.dif)
      ? `<div class="muted">${c.tarifas.map((e) => `tarifa ${e.fare}: liquidó ${soles(e.liq)} · impreso ${soles(e.imp)}${
        nTar.has(e.fare) ? ` (contó ${nTar.get(e.fare).contados}, impresos ${nTar.get(e.fare).impresos})` : ""}`).join(" · ")}</div>` : "";
    trC += `<tr class="${c.sin || c.dig ? "hit" : ""}"><td>#${c.L.session}</td><td>${c.L.first}→${c.L.last}</td><td>${c.filas}</td>
      <td>${c.papel}</td><td>${c.dig || "—"}</td><td>${c.sin || "—"}${c.nv ? ` <span class="muted">+${c.nv} no verif.</span>` : ""}</td>
      <td>${soles(c.liquidado)}</td><td>${soles(c.impreso)}</td><td style="text-align:left">${res}${det}${
        c.nb ? `<div class="muted">${c.nb} correlativo(s) borrados por falla: no sumaron</div>` : ""}</td></tr>`;
  }
  const nv = x.conc.reduce((s, c) => s + c.nv, 0);

  const veredicto = !L.length
    ? `<p class="muted"><span class="tag ok">✓ Todo lo que sumó se imprimió</span> — ${!x.conc.length
        ? `los ${x.impresos} boletos con correlativo tienen su <code>✓ Job completado</code>.`
        : nv ? `las ${x.conc.reduce((s, c) => s + c.filas - c.nv, 0)} filas de liquidación que cubre el log tienen su <code>✓ Job completado</code>.`
        : `las ${x.conc.length} liquidaciones cuadran: sus ${x.conc.reduce((s, c) => s + c.filas, 0)} filas tienen su <code>✓ Job completado</code>.`}</p>`
    : `<p class="muted"><b>${L.length}</b> boleto(s) por <b>S/ ${total.toFixed(2)}${sinMonto ? "+" : ""}</b> sumaron sin papel.
        ${enLiq.length ? ` <span class="tag err">${enLiq.length} dentro de una liquidación</span>` : ""}
        ${reem.length ? ` <span class="tag warn">${reem.length} n° reemitido(s)</span> el mismo tarifa-n° salió impreso en otro correlativo.` : ""}</p>`;

  return `<div class="panel wide"><h2>🧾 Vendidos sin imprimir (${L.length})</h2>
    <div class="grid">
      <div class="card"><div class="lbl">Sumaron sin imprimir</div><div class="big">${L.length}</div>
        <div class="sub">de ${x.impresos + falla.length} guardados en BD</div></div>
      <div class="card"><div class="lbl">Monto</div><div class="big">S/ ${total.toFixed(2)}${sinMonto ? "+" : ""}</div>
        <div class="sub">${sinMonto ? "hay boletos sin precio en el log" : "precio enviado al servidor"}</div></div>
      <div class="card"><div class="lbl">Falló la impresión</div><div class="big">${falla.length}</div>
        <div class="sub">guardados antes de imprimir</div></div>
      ${x.v72 ? `<div class="card"><div class="lbl">Borrados por falla</div><div class="big">${x.borrados}</div>
        <div class="sub">1.0.72+: la fila se borra, no sumó</div></div>`
      : `<div class="card"><div class="lbl">Modo digital</div><div class="big">${dig.length}</div>
        <div class="sub">gps_imprimir apagado</div></div>`}
      <div class="card"><div class="lbl">Fallas que no sumaron</div><div class="big">${x.noSumaron}</div>
        <div class="sub">${x.v72 ? "NO_IMPRESA · CANCELADA · RECHAZADA" : "fallaron antes de guardarse"}</div></div>
      <div class="card"><div class="lbl">Flag ticket (login)</div><div class="big">${flagTxt}</div>
        <div class="sub">${flagSub}</div></div>
    </div>
    ${veredicto}
    ${nv ? `<p class="muted">${nv} correlativo(s) de las liquidaciones son anteriores al inicio del log: no se pueden verificar.</p>` : ""}
    ${trC ? `<h2 style="margin-top:14px">Liquidación vs impreso</h2>
    <div class="scroll"><table class="nowrap">
      <tr><th>sesión</th><th>correlativos</th><th title="filas que sumó la liquidación">contó</th><th>impresos</th><th>modo digital</th><th>sin imprimir</th>
        <th>liquidado</th><th>impreso</th><th>resultado</th></tr>
      ${trC}</table></div>` : ""}
    ${L.length ? `<h2 style="margin-top:14px">Boletos que sumaron sin imprimir</h2>
    <div class="scroll"><table class="nowrap">
      <tr><th>correlativo</th><th>tarifa-n°</th><th>venta</th><th>precio</th><th>sesión</th><th>causa</th><th>flag ticket</th>
        <th>servidor</th><th>liquidación</th><th>n° reemitido en</th></tr>
      ${tr}</table></div>` : ""}
    <p class="note">${x.v72 ? `<b>Log 1.0.72+:</b> si la impresión falla el APK <b>borra la fila</b> (<code>[VENTA] NO_IMPRESA</code>) y ya no
      existe el modo digital, así que un boleto sin papel ya no suma; esos correlativos quedan como huecos y aquí no se acusan.
      Lo que aparezca abajo es de antes de actualizar o de una app cerrada a mitad de impresión.<br>` : ""}
      El APK <b>inserta el boleto en BD antes de imprimir</b> (<code>PrintQueue.processJob</code>) y la liquidación
      (<code>driver_logout</code>) suma <b>toda</b> la tabla de la sesión (<code>cash</code>, <code>digital</code>, <code>primero</code>→<code>ultimo</code>).
      Las filas nunca se borran: cada correlativo del rango sumó, y si no tiene <code>✓ Job completado</code> sumó sin imprimirse.
      Pasa cuando la impresión falla después de <code>IMPRESIÓN INICIADA</code> (solo queda <code>Rollback UI</code> y el mismo n° se reemite
      en la siguiente venta), cuando la app se cierra imprimiendo, o en <b>modo digital</b>. Si falla antes (impresora no lista, timeout)
      el boleto no se guarda y <b>no suma</b>. <b>Impreso</b> = suma del <code>price</code> de los boletos con papel.
      El <b>flag ticket</b> del login solo decide si el equipo inicia la impresora. Un boleto que la impresora dio por impreso
      sin sacar papel (atasco) no se puede detectar en el log.</p>
  </div>`;
}

function renderTrafico(traf) {
  if (!traf.length) return "";
  const sum = (k) => traf.reduce((s, x) => s + x[k], 0);
  const movil = sum("movilTx") + sum("movilRx"), wifi = sum("wifiTx") + sum("wifiRx");
  const total = traf.reduce((s, x) => s + x.total, 0) || (movil + wifi);
  const cero = movil + wifi === 0;
  const t0 = traf[0].t, t1 = traf[traf.length - 1].t;
  const f = (d) => d.toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const datos = traf.map((x) => x.total);
  const etiq = traf.map((x) => `${String(x.t.getDate()).padStart(2, "0")}/${String(x.t.getMonth() + 1).padStart(2, "0")} ${String(x.t.getHours()).padStart(2, "0")}:${String(x.t.getMinutes()).padStart(2, "0")}`);
  return `<div class="panel"><h2>📶 Consumo real del sistema (TrafficMonitor)</h2>
    <div class="grid">
      <div class="card"><div class="lbl">Total real</div><div class="big">${humano(total)}</div>
        <div class="sub">${traf.length} ventanas · ${f(t0)} → ${f(t1)}</div></div>
      <div class="card"><div class="lbl">Móvil (SIM)</div><div class="big">${humano(movil)}</div>
        <div class="sub">↑ ${humano(sum("movilTx"))} &nbsp; ↓ ${humano(sum("movilRx"))}</div></div>
      <div class="card"><div class="lbl">WiFi</div><div class="big">${humano(wifi)}</div>
        <div class="sub">↑ ${humano(sum("wifiTx"))} &nbsp; ↓ ${humano(sum("wifiRx"))}</div></div>
    </div>
    ${cero ? "" : barras(datos, etiq, "var(--accent2)")}
    <p class="note">${cero
      ? "⚠️ El detector reportó <b>0 B</b> en todas las ventanas: falta el permiso <b>Usage Access</b> (PACKAGE_USAGE_STATS) o el equipo lanza SecurityException. Este es el consumo <b>real</b> de SIM/WiFi que mide el APK — distinto del estimado de payload del socket."
      : "Consumo <b>real</b> de SIM/WiFi medido por el APK (<code>NetworkStatsManager</code>): incluye TODO el tráfico (mapas, APK, TLS), no solo el payload del socket."}</p>
  </div>`;
}

function ventana(ev, desde) {
  let env = 0, rec = 0;
  for (const e of ev) if (e.t >= desde) { env += e.env; rec += e.rec; }
  return { env, rec };
}

function porKey(ev) {
  const d = new Map();
  for (const e of ev) {
    if (!d.has(e.key)) d.set(e.key, { eb: 0, en: 0, rb: 0, rn: 0 });
    const r = d.get(e.key);
    if (e.env) { r.eb += e.env; r.en++; }
    if (e.rec) { r.rb += e.rec; r.rn++; }
  }
  return d;
}

function timelineHora(ev) {
  const d = new Map();
  for (const e of ev) {
    const k = new Date(e.t); k.setMinutes(0, 0, 0);
    d.set(+k, (d.get(+k) || 0) + e.env + e.rec);
  }
  return d;
}

function horaDelDia(ev) {
  const d = new Array(24).fill(0);
  for (const e of ev) d[e.t.getHours()] += e.env + e.rec;
  return d;
}

function barras(datos, etiquetas, color, fmt = humano) {
  const w = 960, h = 300, padL = 62, padB = 48, padT = 16;
  const maxv = Math.max(1, ...datos);
  const n = datos.length;
  const bw = (w - padL - 20) / Math.max(n, 1);
  let s = "";
  for (let f = 0; f <= 1.0001; f += 0.25) {
    const yy = h - padB - (h - padB - padT) * f;
    s += `<line x1="${padL}" y1="${yy}" x2="${w - 10}" y2="${yy}" stroke="var(--line)"/>`;
    s += `<text x="${padL - 8}" y="${yy + 4}" font-size="10" text-anchor="end">${fmt(maxv * f)}</text>`;
  }
  const step = n <= 26 ? 1 : Math.ceil(n / 26);
  for (let i = 0; i < n; i++) {
    const bh = (h - padB - padT) * (datos[i] / maxv);
    const x = padL + i * bw, y = h - padB - bh;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(bw - 3, 1).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}"><title>${etiquetas[i]}: ${fmt(datos[i])}</title></rect>`;
    if (i % step === 0)
      s += `<text x="${(x + bw / 2).toFixed(1)}" y="${h - padB + 16}" font-size="10" text-anchor="middle">${etiquetas[i]}</text>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px">${s}</svg>`;
}

function fmtHora(s) {
  return s ? String(s).replace("T", " ").slice(0, 19) : "—";
}

// --- Detección de bucles logout→auto-login (aperturas de sesión en cascada) ---
// Síntoma independiente de versión: muchas aperturas (driver_login) muy seguidas,
// cada una con vida de pocos segundos, sin que el conductor haga nada.
const BUCLE_GAP_S = 90;  // separación máx. (s) entre aperturas para encadenarlas
const BUCLE_MIN = 3;     // nº de aperturas seguidas para marcarlo como bucle

function detectarBucles(logins, liqs) {
  const opens = logins.slice().sort((a, b) => a.t - b.t);
  const logoutT = new Map();
  for (const L of liqs) if (!logoutT.has(L.session)) logoutT.set(L.session, L.t);
  // vida de una apertura = hasta su logout, o hasta la siguiente apertura si no hay logout.
  const vida = (o, next) => {
    const fin = logoutT.get(o.id) || (next ? next.t : null);
    return fin ? Math.round((fin - o.t) / 1000) : null;
  };
  const cadenas = [];
  let cur = null;
  for (const o of opens) {
    if (!cur) { cur = [o]; continue; }
    const prev = cur[cur.length - 1];
    if ((o.t - prev.t) / 1000 <= BUCLE_GAP_S) cur.push(o);
    else { cadenas.push(cur); cur = [o]; }
  }
  if (cur) cadenas.push(cur);
  return cadenas.filter((c) => c.length >= BUCLE_MIN).map((items) => {
    const ini = items[0].t, fin = items[items.length - 1].t;
    const vidas = items.map((o, i) => vida(o, items[i + 1])).filter((v) => v != null);
    return {
      ini, fin, n: items.length, durMin: (fin - ini) / 60000,
      ids: items.map((o) => o.id), lado: LADO(items[0].direction), vidas,
    };
  });
}

function renderBucles(logins, liqs, text) {
  if (!logins.length) return "";
  const bucles = detectarBucles(logins, liqs);
  const autoCount = (text.match(/\[DRIVERAUTO\] Ejecutando auto-login/g) || []).length;
  if (!bucles.length)
    return `<div class="panel"><h2>🔁 Bucles de re-login</h2>
      <p class="muted"><span class="tag ok">✓ Sin bucles</span> — no se detectaron cascadas de aperturas automáticas.</p></div>`;

  const totSes = bucles.reduce((a, b) => a + b.n, 0);
  const fantasma = bucles.reduce((a, b) => a + (b.n - 1), 0); // basta 1 apertura real por bucle
  const totMin = bucles.reduce((a, b) => a + b.durMin, 0);
  const vidas = bucles.flatMap((b) => b.vidas).sort((a, b) => a - b);
  const medVida = vidas.length ? vidas[Math.floor(vidas.length / 2)] : 0;

  let tr = "";
  bucles.forEach((b, i) => {
    const vmin = b.vidas.length ? Math.min(...b.vidas) : "—";
    tr += `<tr class="hit"><td>${i + 1}</td><td>Lado ${b.lado}</td>
      <td>${hhmmss(b.ini)} → ${hhmmss(b.fin)}</td><td><b>${b.n}</b></td>
      <td>${b.durMin.toFixed(1)} min</td><td>${vmin}s</td>
      <td>#${b.ids[0]}→#${b.ids[b.ids.length - 1]}</td></tr>`;
  });

  return `<div class="panel" style="border:2px solid var(--accent2)"><h2>⚠️🔁 Bucles de re-login detectados (${bucles.length})</h2>
    <div class="grid">
      <div class="card"><div class="lbl">Sesiones en bucle</div><div class="big">${totSes}</div>
        <div class="sub">de ${logins.length} aperturas totales</div></div>
      <div class="card"><div class="lbl">Sesiones fantasma</div><div class="big">${fantasma}</div>
        <div class="sub">sobraban (basta 1 por bucle)</div></div>
      <div class="card"><div class="lbl">Tiempo en bucle</div><div class="big">${totMin.toFixed(1)} min</div>
        <div class="sub">vida mediana ${medVida}s / sesión</div></div>
      ${autoCount ? `<div class="card"><div class="lbl">Auto-logins del APK</div><div class="big">${autoCount}</div>
        <div class="sub"><code>[DRIVERAUTO] Ejecutando auto-login</code></div></div>` : ""}
    </div>
    <div class="scroll"><table>
      <tr><th>#</th><th>lado</th><th>ventana</th><th>aperturas</th><th>duración</th><th>vida mín.</th><th>sesiones</th></tr>
      ${tr}</table></div>
    <p class="note">Un <b>bucle</b> es una cascada de ${BUCLE_MIN}+ aperturas (<code>driver_login</code>) separadas por
      ≤ ${BUCLE_GAP_S}s: el equipo <b>cierra y reabre la sesión solo</b>, sin que el conductor teclee nada.
      Cada sesión fantasma se cierra con <b>cash=0</b> y ensucia la liquidación. Es el auto-login del APK
      (típico de la versión antigua) reciclando la sesión; actualizar el equipo lo corrige.</p>
  </div>`;
}

// --- Solicitó vs Recibió: ¿el servidor respetó el lado que pidió el equipo? ---
// Empareja cada petición (driver_login ENVIADO) con la sesión creada (driver_login RECIBIDO)
// y marca cuándo el lado devuelto no coincide con el pedido → desajuste de contrato.
function emparejarPeticiones(logins, text) {
  const reqs = parseLoginRequests(text || "");            // {t, dni, direction} (lo que se pide)
  const opens = logins.slice().sort((a, b) => a.t - b.t); // {t, id, direction} (lo que responde el server)
  const usados = new Set();
  const pares = [];
  for (const r of reqs) {
    let elegido = -1;
    for (let i = 0; i < opens.length; i++) {
      if (usados.has(i)) continue;
      const dt = opens[i].t - r.t;
      if (dt >= 0 && dt <= 60000) { elegido = i; break; }
    }
    if (elegido >= 0) {
      usados.add(elegido);
      const o = opens[elegido];
      pares.push({ t: r.t, pide: LADO(r.direction), recibe: LADO(o.direction), id: o.id, ms: o.t - r.t });
    } else {
      pares.push({ t: r.t, pide: LADO(r.direction), recibe: null, id: null, ms: null }); // sin respuesta
    }
  }
  pares.sort((a, b) => a.t - b.t);
  return pares;
}

function renderSolicitudVsRespuesta(logins, text) {
  const pares = emparejarPeticiones(logins, text);
  if (!pares.length) return "";
  const conResp = pares.filter((p) => p.recibe != null);
  const desajustes = conResp.filter((p) => p.pide !== p.recibe);
  const nDes = desajustes.length, nTot = conResp.length;

  let tr = "";
  for (const p of pares) {
    if (p.recibe == null) {
      tr += `<tr><td>${hhmmss(p.t)}</td><td>Lado ${p.pide}</td><td>—</td>
        <td><span class="tag err">sin respuesta</span></td><td>—</td></tr>`;
      continue;
    }
    const ok = p.pide === p.recibe;
    tr += `<tr class="${ok ? "" : "hit"}"><td>${hhmmss(p.t)}</td>
      <td>Lado ${p.pide}</td><td>Lado ${p.recibe}</td>
      <td>${ok ? '<span class="tag ok">✓ coincide</span>' : '<span class="tag err">✗ cambió de lado</span>'}</td>
      <td>#${p.id}</td></tr>`;
  }

  const veredicto = nDes === 0
    ? `<p class="muted"><span class="tag ok">✓ Sin desajustes</span> — el servidor respetó el lado pedido en las ${nTot} sesiones.
        Si hubo bucle, el origen está en el <b>equipo</b>, no en el lado.</p>`
    : `<p class="muted"><span class="tag err">⚠️ ${nDes} de ${nTot} sesiones cambiaron de lado</span> —
        el equipo pidió un lado y el <b>servidor devolvió otro</b>, sin marcar error.
        Ese desajuste de contrato es lo que alimentaba el bucle: el equipo no logra abrir el lado que quiere.</p>`;

  return `<div class="panel"><h2>🔀 Solicitó vs Recibió (lado de sesión)</h2>
    ${veredicto}
    <div class="scroll"><table>
      <tr><th>hora (petición)</th><th>lado solicitado</th><th>lado recibido</th><th>resultado</th><th>sesión</th></tr>
      ${tr}</table></div>
    <p class="note">Cada fila empareja una petición (<code>[ENVIADO] driver_login</code>) con la sesión que creó el servidor
      (<code>[RECIBIDO] driver_login</code>). El lado sale de <code>direction</code>: <b>false = Lado A</b>, <b>true = Lado B</b>.
      Si el lado pedido ≠ el recibido, el servidor <b>no respetó</b> lo solicitado — útil para separar si el problema es del servidor o del equipo.</p>
  </div>`;
}

function renderCierre(liqs, logins, text) {
  if (!liqs.length && !logins.length) return "";
  const conVentas = liqs.filter((l) => l.cash > 0);
  const cierre = conVentas.length
    ? conVentas.reduce((a, b) => (b.cash > a.cash ? b : a))
    : (liqs.length ? liqs[liqs.length - 1] : null);
  const autos = logins.filter((l) => l.tipo === "automatica");
  const cfg = /Retorno auto:\s*(true|false)/i.exec(text || "");
  const habilitado = cfg ? /true/i.test(cfg[1]) : null;

  const cardLado = (L) => {
    const del = autos.filter((a) => LADO(a.direction) === L);
    const on = del.length > 0;
    return `<div class="card"><div class="lbl">Autoretorno Lado ${L}</div>
      <div class="big">${on ? "Sí" : "No"}</div>
      <div class="sub">${on ? del.map((a) => `#${a.id} ${hhmmss(a.t)}`).join(", ") : "sin sesión automática"}</div></div>`;
  };

  const cards = `
    <div class="card"><div class="lbl">Cierre de jornada</div>
      <div class="big">${cierre ? fmtHora(cierre.endTime).slice(11) : "—"}</div>
      <div class="sub">${cierre ? `sesión #${cierre.session} · ${fmtHora(cierre.endTime).slice(0, 10)}` : "sin driver_logout"}</div></div>
    <div class="card"><div class="lbl">Recaudado (liquidación)</div>
      <div class="big">S/ ${cierre ? (cierre.cash / 100).toFixed(2) : "0.00"}</div>
      <div class="sub">${cierre ? `efectivo · digital ${cierre.digital}` : ""}</div></div>
    <div class="card"><div class="lbl">Retorno auto (config)</div>
      <div class="big">${habilitado == null ? "—" : habilitado ? "ON" : "OFF"}</div>
      <div class="sub">Retorno auto = ${habilitado == null ? "no encontrado" : habilitado}</div></div>
    ${cardLado("A")}${cardLado("B")}`;

  // Cuánto demoró el servidor en abrir cada sesión: petición enviada (DNI+clave) → respuesta de sesión.
  const reqs = parseLoginRequests(text || "");
  const opens = logins.slice().sort((a, b) => a.t - b.t);
  const usados = new Set();
  for (const r of reqs) {
    for (let i = 0; i < opens.length; i++) {
      if (usados.has(i)) continue;
      const dt = opens[i].t - r.t;
      if (dt >= 0 && dt <= 60000) { usados.add(i); opens[i].abrioMs = dt; break; }
    }
  }
  const fmtDur = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

  // Flujo temporal único: aperturas (driver_login) y cierres (driver_logout) intercalados por hora.
  const eventos = [];
  for (const l of logins)
    eventos.push({ t: l.t, kind: "open", id: l.id, lado: LADO(l.direction), tipo: l.tipo, abrioMs: l.abrioMs });
  for (const L of liqs) {
    const login = logins.find((x) => x.id === L.session);
    const auto = logins.some((x) => x.id === L.session && x.tipo === "automatica");
    eventos.push({ t: L.t, kind: "close", id: L.session, lado: login ? LADO(login.direction) : "—", cash: L.cash, first: L.first, last: L.last, auto });
  }
  eventos.sort((a, b) => a.t - b.t || (a.kind === "open" ? -1 : 1));

  let tr = "";
  for (const e of eventos) {
    if (e.kind === "open") {
      const ev = '<span class="tag ok">▶ abrió</span>';
      const base = e.tipo === "automatica" ? '<span class="tag ok">sesión automática (autoretorno)</span>'
        : e.tipo === "reingreso" ? '<span class="tag">reingreso a su sesión</span>' : "nueva sesión";
      const dur = e.abrioMs != null
        ? ` · ${e.abrioMs > 5000 ? `<span class="tag err">⏱ tardó ${fmtDur(e.abrioMs)}</span>` : `<span style="color:var(--muted)">⏱ abrió en ${fmtDur(e.abrioMs)}</span>`}`
        : "";
      tr += `<tr><td>${hhmmss(e.t)}</td><td>${ev}</td><td>#${e.id}</td><td>Lado ${e.lado}</td><td style="text-align:left">${base}${dur}</td></tr>`;
    } else {
      const ev = '<span class="tag err">■ cerró</span>';
      const auto = e.auto ? ' · <span class="tag ok">era automática</span>' : "";
      const det = e.cash > 0
        ? `S/ ${(e.cash / 100).toFixed(2)} · correlativo ${e.first}→${e.last}${auto}`
        : `sin ventas${auto}`;
      tr += `<tr class="${e.cash > 0 ? "hit" : ""}"><td>${hhmmss(e.t)}</td><td>${ev}</td><td>#${e.id}</td><td>Lado ${e.lado}</td><td style="text-align:left">${det}</td></tr>`;
    }
  }

  return `
    <div class="panel"><h2>🔒 Cierre y autoretorno</h2>
      <div class="grid">${cards}</div>
      ${eventos.length ? `<h2 style="margin-top:14px">Flujo de sesiones (apertura → cierre)</h2>
      <div class="scroll"><table><tr><th>hora</th><th>evento</th><th>sesión</th><th>lado</th><th>detalle</th></tr>${tr}</table></div>` : ""}
      <p class="note">Una sola línea de tiempo: cada fila es una <b>apertura</b> (▶) o un <b>cierre</b> (■) en orden cronológico.
        En las aperturas, ⏱ es lo que <b>demoró el servidor</b> en responder desde que se envió el login (DNI+clave) hasta confirmar la sesión.
        El <b>cierre</b> de jornada es el <code>driver_logout</code> con recaudo; el <b>autoretorno</b> es una apertura con "sesión automática"
        (<code>direction</code> false = Lado A, true = Lado B).</p>
    </div>`;
}

// Contó = filas que sumó la liquidación (correlativo primero→último, por tarifa desde "Vendidos sin imprimir");
// impresos = las que tienen "✓ Job completado". Precio unitario = el `price` de los boletos enviados (detectarTarifas).
function renderLiquidacion(liqs, tickets, logins) {
  // Los reintentos del driver_logout repiten el mismo payload: vale el último de cada sesión.
  const conV = [...new Map(liqs.filter((l) => l.resume.length).map((l) => [l.session, l])).values()];
  if (!conV.length) return "";
  const nEnRango = (e) => tickets.filter((k) => k.fare === e.fare && k.num >= e.start && k.num <= e.end).length;
  let out = "";
  for (const L of conV) {
    const lado = logins.find((x) => x.id === L.session);
    const ladoTxt = lado ? ` — Lado ${LADO(lado.direction)}` : "";
    const c = _noImpresos?.conc?.find((x) => x.L.session === L.session);
    const porTarifa = new Map((c?.porTarifa || []).map((e) => [e.fare, e]));
    const filas = L.resume.slice().sort((a, b) => b.cash - a.cash).map((e) => {
      const pu = precio(e.fare), t = porTarifa.get(e.fare);
      const conto = t?.contados ?? (pu ? Math.round((e.cash + e.digital) / 100 / pu) : null);
      const imp = t?.impresos ?? nEnRango(e);
      return `<tr class="${conto != null && imp < conto ? "hit" : ""}"><td>Tarifa ${e.fare}</td><td>${e.start}→${e.end}</td><td>${conto ?? "?"}</td>
        <td>${imp}${conto != null && imp < conto ? ` <span class="tag err">${conto - imp} sin papel</span>` : ""}</td>
        <td>${pu ? `S/ ${pu.toFixed(2)}` : "?"}</td><td>S/ ${((e.cash + e.digital) / 100).toFixed(2)}</td></tr>`;
    }).join("");
    const nFilas = c ? c.filas : L.last >= L.first && L.first ? L.last - L.first + 1 : null;
    const nImp = c ? c.papel : L.resume.reduce((s, e) => s + nEnRango(e), 0);
    out += `<div class="panel"><h2>💵 Liquidación sesión #${L.session}${ladoTxt}</h2>
      <div class="grid">
        <div class="card"><div class="lbl">Recaudado</div><div class="big">S/ ${(L.cash / 100).toFixed(2)}</div>
          <div class="sub">digital ${L.digital}</div></div>
        <div class="card"><div class="lbl">Boletos que contó</div><div class="big">${nFilas ?? "?"}</div>
          <div class="sub">${nImp} impresos · correlativo ${L.first}→${L.last}</div></div>
        <div class="card"><div class="lbl">Cierre</div><div class="big">${fmtHora(L.endTime).slice(11)}</div>
          <div class="sub">${fmtHora(L.endTime).slice(0, 10)}</div></div>
      </div>
      <table><tr><th>tarifa</th><th>rango n°</th><th>contó</th><th>impresos</th><th>precio unit.</th><th>importe</th></tr>${filas}</table>
      <p class="note">Importes exactos enviados al cerrar (<code>driver_logout</code>). <b>Contó</b> = boletos guardados en la sesión, que es lo
        que suma la liquidación; <b>impresos</b> = los que tienen <code>✓ Job completado</code>. El precio unitario es el que viaja en cada
        boleto enviado al servidor (si la tarifa no se envió en el log: importe ÷ impresos, que sobrestima si hubo cobrados sin papel).</p>
    </div>`;
  }
  return out;
}

function renderSesionObjeto(ses) {
  const objs = ses.filter((s) => s.raw);
  if (!objs.length) return "";
  const row = (k, v) => (v == null || v === "" ? "" : `<tr><td>${k}</td><td style="text-align:left">${v}</td></tr>`);
  let out = "";
  for (const s of objs) {
    const o = s.raw, c = o.conductor || {}, sal = o.salida || {};
    let ctrl = "";
    if (Array.isArray(sal.controles) && sal.controles.length) {
      const cf = sal.controles.map((x) => {
        const rv = x.roundVolada ?? 0, a = Math.abs(rv);
        const cls = a <= 3 ? "ok" : a <= 10 ? "" : "err";
        const txt = (rv > 0 ? "+" : rv < 0 ? "−" : "±") + a + " min";
        return `<tr><td>${x.orden}</td><td>${x.hora ? String(x.hora).slice(11, 19) : "—"}</td>
          <td>${x.real ? String(x.real).slice(11, 19) : "—"}</td>
          <td>${x.real ? `<span class="tag ${cls}">${txt}</span>` : "prog"}</td><td>${x.estado || ""}</td></tr>`;
      }).join("");
      ctrl = `<h2 style="margin-top:12px">Controles de la salida #${sal.id || ""} (${sal.controles.length})</h2>
        <div class="scroll"><table><tr><th>#</th><th>prog</th><th>real</th><th>volada</th><th>estado</th></tr>${cf}</table></div>`;
    }
    out += `<div class="panel"><h2>🧾 Sesión #${o.id || ""} — Lado ${o.lado != null ? LADO(o.lado) : "?"} (objeto)</h2>
      <table>
        ${row("conductor", [c.nombre, c.codigo, c.dni && `DNI ${c.dni}`].filter(Boolean).join(" · "))}
        ${row("inicio", o.inicio)}
        ${row("fin", o.fin)}
        ${row("producción", o.produccion)}
        ${row("ruta", o.ruta ? `id ${o.ruta.id} · código ${o.ruta.codigo}` : "")}
        ${row("salida", sal.id ? `#${sal.id} · día ${sal.dia || ""} · vuelta ${sal.vuelta ?? ""} · frecuencia ${sal.frecuencia ?? ""} min · record ${sal.record ?? ""}` : "")}
        ${row("unidad", o.unidad ? `id ${o.unidad.id} · ${o.unidad.placa || ""} · estado ${o.unidad.estado || ""}` : "")}
      </table>
      ${ctrl}
      <p class="note">Objeto de sesión de la plataforma. La <i>volada</i> de cada control es adelanto/atraso en minutos:
        negativo = adelantado, positivo = atrasado.</p>
    </div>`;
  }
  return out;
}

// --- Informe para imprimir o abrir en otra pestaña (lectura no técnica) ---
// Reúne lo que ya calculan los paneles: cobrados sin papel (Vendidos sin imprimir), boletos impresos por sesión
// ([TicketCounterManager] Número confirmado en BD) frente a lo que contó la liquidación, los intentos que fallaron
// agrupados en momentos sin impresión, las fallas de la impresora y hasta cuándo el servidor confirmó los boletos.
const CORTE_MIN_MS = 60000; // cortes de conexión más cortos no se listan

// Sesión de cada boleto: la del payload enviado; si no, la liquidación cuyo rango cubre su correlativo;
// si no, el último driver_login antes de la venta mientras esa sesión no se haya cerrado.
function sesionesInforme() {
  const ses = new Map();
  const get = (id) => {
    if (!ses.has(id)) ses.set(id, { id, lado: null, conductor: null, ini: null, fin: null, liq: null });
    return ses.get(id);
  };
  const logins = _logins.filter((l) => l.id).sort((a, b) => a.t - b.t);
  for (const l of logins) {
    const s = get(l.id), ini = tsSesion(l.startTime) || l.t;
    s.lado ??= LADO(l.direction);
    s.conductor ??= l.driverCode;
    if (!s.ini || ini < s.ini) s.ini = ini;
  }
  for (const L of _liqs) {
    if (!L.session) continue;
    const s = get(L.session);
    s.fin ??= tsSesion(L.endTime) || L.t;
    if (L.first && L.last >= L.first) s.liq = L;
  }
  const porCorr = (c) => (c == null ? null : [...ses.values()].find((s) => s.liq && c >= s.liq.first && c <= s.liq.last)?.id ?? null);
  const porTiempo = (t) => {
    if (!t) return null;
    let id = null;
    for (const l of logins) { if (l.t > t) break; id = l.id; }
    const s = id != null ? ses.get(id) : null;
    return s && !(s.fin && s.fin < t) ? id : null;
  };
  return { ses, get, de: (t, corr, hint) => hint || porCorr(corr) || porTiempo(t) || null };
}

function cortesConexion(conn) {
  const out = [];
  let cur = null;
  for (const c of conn) {
    if (c.kind === "up") { if (cur) { cur.hasta = c.t; out.push(cur); cur = null; } }
    else if ((c.kind === "down" || c.kind === "netdown") && !cur) cur = { desde: c.t, hasta: null, kind: c.kind, txt: c.txt };
  }
  if (cur) out.push(cur);
  return out;
}

const RAFAGA_GAP_MS = 10 * 60 * 1000; // dentro de un momento sin impresión, 10 min sin intentos separan una ráfaga de otra

// Motivo corto de un intento que no salió impreso y lo que significa para quien lee el informe.
const MOTIVO_FALLA = {
  "Sin impresora (reconectando)": "la impresora se estaba reconectando; hasta la 1.0.65 el equipo lo anota como «Impresora lista»",
  Timeout: "esperó 30 s y la impresora no quedó lista",
  "No responde": "la impresora no respondió justo antes de imprimir",
  "Sin impresora": "no había impresora conectada",
  "Sin papel": "la impresora no tenía papel",
  Ocupada: "la impresora estaba ocupada",
  "Error impresión": "error de la impresora",
  "App cerrada al imprimir": "no quedó ningún error: la app se cerró o se reinició mientras imprimía",
  "Cola llena": "ya había 10 boletos esperando imprimirse y el equipo rechazó el toque",
  "Cancelada en cola": "esperaba en la cola y se canceló porque falló el boleto anterior o se reconectó la impresora",
  Rechazada: "el equipo no aceptó la venta",
};

function motivoFalla(ev, motivo) {
  if (ev === "CANCELADA") return "Cancelada en cola";
  if (ev === "RECHAZADA") return /cola llena/i.test(motivo || "") ? "Cola llena" : "Rechazada";
  const m = String(motivo || "").replace(/ · la fila quedó guardada.*$/, "");
  if (/sin error registrado/i.test(m)) return "App cerrada al imprimir";
  return clasificaError(m) ?? "Error impresión";
}

function datosInforme() {
  const env = _envios, imp = _impresion, noi = _noImpresos;
  const S = sesionesInforme();
  const soles = (r, fare, e) => (r?.price ? r.price / 100 : e?.tarifa != null ? +e.tarifa : precio(fare) || null);

  // 1) Cobrados sin papel: la fila quedó en BD (entra a la liquidación) y no hay "✓ Job completado".
  // En 1.0.72+ la línea [VENTA] IMPRIMIENDO trae el correlativo: de ahí salen hora, tarifa y n° si no se envió.
  const imprimiendo = new Map();
  for (const e of imp?.venta || []) if (e.ev === "IMPRIMIENDO" && typeof e.correlativo === "number") imprimiendo.set(e.correlativo, e);
  const cobrados = [], corrNoImp = new Set(), tCausa = new Set();
  for (const r of noi?.lista || []) {
    corrNoImp.add(r.corr);
    if (r.causa.t) tCausa.add(+r.causa.t);
    const e = imprimiendo.get(r.corr);
    const t = r.tv || e?.t || null, fare = r.fare ?? e?.boleto;
    cobrados.push({
      t, entre: r.entre, fare, num: r.num ?? e?.num, corr: r.corr, nombre: e?.nombre, pago: e?.pago,
      monto: r.monto ?? (e?.tarifa != null ? +e.tarifa : precio(fare) || null),
      ses: S.de(t, r.corr, r.session || r.liq?.session), srv: env.porCorr.get(r.corr),
      motivo: r.causa.tipo === "digital" ? "Modo digital" : motivoFalla("NO_IMPRESA", r.causa.txt),
      que: r.causa.tipo === "digital" ? "Modo digital: se registró sin sacar papel (impresión desactivada)"
        : `La impresora falló después de registrar la venta: ${r.causa.txt}`,
      cobro: r.liq ? `liquidación #${r.liq.session}` : "quedó guardado en el equipo",
      reem: r.reemitidos.map((o) => ({ t: o.tVenta, corr: o.corr })),
    });
  }

  // 2) Intentos que no salieron impresos (NO_IMPRESA, CANCELADA, RECHAZADA). Si la fila quedó guardada ya está en (1);
  // el resto no suma. `luego` = ese mismo tarifa-n° salió impreso al reintentar (≤ 3 min).
  const fallidos = [];
  for (const f of imp?.fallas || []) {
    if (f.suma === "SI" && tCausa.has(+f.t)) continue; // es la misma fila de (1)
    const x = {
      t: f.t, fare: f.boleto, num: f.num, nombre: f.nombre, pago: f.pago, lote: f.lote, ses: S.de(f.t), ev: f.ev,
      corr: typeof f.correlativo === "number" ? f.correlativo : null,
      monto: f.tarifa != null ? +f.tarifa : precio(f.boleto) || null,
      motivo: motivoFalla(f.ev, f.motivo), detalle: f.motivo, luego: f.luego || null,
    };
    if (f.suma === "SI") cobrados.push({ ...x, que: `La impresora falló después de registrar la venta: ${f.motivo}`, cobro: "quedó guardado en el equipo", reem: [] });
    else fallidos.push(x);
  }

  // 3) Impresos: cada boleto confirmado en BD que no cayó en (1).
  const impresos = [];
  for (const k of _tickets) {
    const corr = env.corrDe(k) ?? null;
    if (corr != null && corrNoImp.has(corr)) continue;
    const e = imp?.porTicket?.get(k) || null, r = corr != null ? env.porCorr.get(corr) : null;
    const x = { t: k.t, fare: k.fare, num: k.num, corr, nombre: e?.nombre, pago: e?.pago, monto: soles(r, k.fare, e), srv: r, ses: S.de(k.t, corr, r?.session) };
    if (e?.ev === "DIGITAL") cobrados.push({ ...x, motivo: "Modo digital", que: "Modo digital: se registró sin sacar papel (impresión desactivada)", cobro: "quedó guardado en el equipo", reem: [] });
    else impresos.push({ ...x, intentos: e?.intentos ?? 1, previas: e?.previas || [], tras: e?.ev === "ERROR_TRAS_IMPRIMIR" ? e.motivo : null });
  }
  const orden = (x) => +(x.t || x.entre?.tPrev || x.entre?.tNext || 0);
  cobrados.sort((a, b) => orden(a) - orden(b));
  impresos.sort((a, b) => a.t - b.t);

  // 4) Momentos en que no se pudo imprimir: intentos fallidos seguidos (incluidos los cobrados sin papel por falla de
  // la impresora) hasta que vuelve a salir un boleto o cambia la sesión. Mientras la impresora no responde el conductor
  // vuelve a tocar: los intentos de un momento no son pasajeros distintos. `rafagas` = tandas separadas por 10 min.
  const tImp = impresos.map((x) => +x.t);
  const hayImpreso = (a, b) => tImp.some((t) => t > a && t < b);
  const puntos = [...fallidos, ...cobrados.filter((x) => x.t && x.motivo !== "Modo digital")].sort((a, b) => a.t - b.t);
  const episodios = [];
  let ep = null;
  for (const x of puntos) {
    if (!ep || x.ses !== ep.ses || hayImpreso(+ep.hasta, +x.t)) {
      ep = { desde: x.t, hasta: x.t, ses: x.ses, intentos: 0, rafagas: 1, cobrados: [], resueltos: 0, tarifas: new Map(), motivos: new Map() };
      episodios.push(ep);
    } else if (x.t - ep.hasta > RAFAGA_GAP_MS) ep.rafagas++;
    ep.hasta = x.t;
    ep.intentos++;
    if (x.cobro) ep.cobrados.push(x);
    if (x.luego) ep.resueltos++;
    ep.motivos.set(x.motivo, (ep.motivos.get(x.motivo) || 0) + 1);
    if (x.fare != null) ep.tarifas.set(x.fare, (ep.tarifas.get(x.fare) || 0) + 1);
  }
  // Después del último intento: el siguiente boleto impreso de la misma sesión o, si no hubo, el cierre de la sesión.
  for (const e of episodios) {
    const sig = impresos.find((x) => x.t > e.hasta) || null;
    e.volvio = sig && sig.ses === e.ses ? sig : null;
    e.cierre = e.volvio ? null : S.ses.get(e.ses)?.fin || null;
  }

  // Servidor: hasta cuándo confirmó y qué quedó sin confirmar.
  let ultAck = null, ultEnvio = null;
  for (const r of env.lista) {
    for (const a of r.acks) if (!ultAck || a.t > ultAck) ultAck = a.t;
    for (const p of r.pasos) if (p.a.estado === "ok" && (!ultEnvio || p.a.tSend > ultEnvio)) ultEnvio = p.a.tSend;
  }
  const sinConf = env.lista.filter((r) => r.estado !== "ack");
  const cortes = cortesConexion(env.conn).filter((c) => !c.hasta || c.hasta - c.desde >= CORTE_MIN_MS);

  let logIni = null, logFin = null;
  for (const m of _texto.matchAll(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/gm)) {
    if (!logIni || m[0] < logIni) logIni = m[0];
    if (!logFin || m[0] > logFin) logFin = m[0];
  }
  return {
    S, impresos, cobrados, fallidos, episodios, errores: parseErrores(_textos), sinConf, cortes, ultAck, ultEnvio, env,
    toques: imp && !imp.inferido ? imp.sinVenta : [], conc: noi?.conc || [],
    logIni: logIni && parseTs(logIni), logFin: logFin && parseTs(logFin),
  };
}

const CSS_INFORME = `
:root{--tx:#1a1d24;--mu:#5d6675;--ln:#d9dde4;--soft:#f4f6f9;--r:#b42318;--rb:#fdeceb;--a:#8a5100;--ab:#fff3dc;--g:#146c43;--gb:#e3f4ea}
*{box-sizing:border-box}
body{margin:0 auto;max-width:1150px;padding:22px 26px 40px;background:#fff;color:var(--tx);font:12.5px/1.45 system-ui,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:15px;margin:26px 0 8px;padding-bottom:4px;border-bottom:2px solid var(--tx);break-after:avoid}
h3{font-size:13px;margin:16px 0 6px;break-after:avoid}
.m{color:var(--mu)}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.acc{display:flex;gap:8px}
.acc button,.acc a{font:inherit;font-weight:600;border:1px solid var(--tx);background:var(--tx);color:#fff;border-radius:8px;padding:7px 14px;cursor:pointer;text-decoration:none}
.acc a{background:#fff;color:var(--tx)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:14px 0}
.card{border:1px solid var(--ln);border-radius:8px;padding:8px 11px;break-inside:avoid}
.card .l{color:var(--mu);font-size:10.5px;text-transform:uppercase;letter-spacing:.4px}
.card .b{font-size:19px;font-weight:700;margin:2px 0}
.card.r{border-color:var(--r);background:var(--rb)} .card.a{border-color:#e0b25c;background:var(--ab)}
ul.ver{margin:6px 0 0;padding-left:18px} ul.ver li{margin:3px 0}
table{width:100%;border-collapse:collapse;font-size:11.5px;margin:4px 0 6px}
th,td{border-bottom:1px solid var(--ln);padding:4px 6px;text-align:left;vertical-align:top}
th{background:var(--soft);font-weight:600;white-space:nowrap}
thead{display:table-header-group}
tr{break-inside:avoid}
td.n,th.n{text-align:right;white-space:nowrap}
td.h{white-space:nowrap}
tr.tot td{font-weight:700;background:var(--soft)}
.t{display:inline-block;font-weight:600;padding:0 7px;border-radius:10px;white-space:nowrap}
.t.r{background:var(--rb);color:var(--r)} .t.a{background:var(--ab);color:var(--a)} .t.g{background:var(--gb);color:var(--g)}
.vacio{padding:8px 10px;background:var(--gb);color:var(--g);border-radius:8px;font-weight:600}
.nota{color:var(--mu);font-size:11.5px;margin:6px 0}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:6px 0} dt{font-weight:600}
@media print{.acc{display:none}body{padding:0;max-width:none}@page{margin:11mm}}
`;

function informeHtml() {
  const d = datosInforme();
  const todos = [...d.impresos, ...d.cobrados, ...d.fallidos].map((x) => x.t).filter(Boolean);
  const variosDias = new Set(todos.map(ymd)).size > 1;
  const dm = (t) => `${String(t.getDate()).padStart(2, "0")}/${String(t.getMonth() + 1).padStart(2, "0")}`;
  const fh = (t) => (t ? `${variosDias ? `${dm(t)} ` : ""}${hhmmss(t)}` : "—");
  const fl = (t) => (t ? `${dm(t)}/${t.getFullYear()} ${hhmmss(t).slice(0, 5)}` : "—");
  const sol = (v) => (v == null ? "?" : `S/ ${v.toFixed(2)}`);
  const suma = (arr) => arr.reduce((s, x) => s + (x.monto ?? 0), 0);
  const dur = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min`
    : `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} min`);
  const tag = (cls, txt) => `<span class="t ${cls}">${txt}</span>`;
  const pl = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  const boleto = (x) => (x.nombre ? `${esc(x.nombre)} <span class="m">t${x.fare}</span>`
    : x.fare != null ? `Tarifa ${x.fare}` : x.lote ? `lote ${esc(x.lote)}` : "—");
  const sesTxt = (id) => {
    if (!id) return '<span class="m">sin identificar</span>';
    const s = d.S.ses.get(id);
    return `#${id}${s?.lado ? ` · Lado ${s.lado}` : ""}`;
  };
  const motivoRed = (m) => String(m || "")
    .replace("socket desconectado", "sin conexión con el servidor")
    .replace("socket se cerró al enviar", "se cortó la conexión al enviar")
    .replace("no llegó al socket (equipo sin login al servidor)", "el equipo aún no había iniciado sesión con el servidor")
    .replace("error al codificar", "error interno al armar el mensaje")
    .replace("excepción al enviar", "error al enviar");
  const srv = (r) => {
    if (!r) return '<span class="m">sin registro de envío</span>';
    const n = r.intentos.length, veces = n > 1 ? ` <span class="m">(${n} intentos)</span>` : "";
    if (r.estado === "ack") return `${tag("g", "✓ recibido")} ${fh(r.acks[0].t)}${veces}`;
    if (r.estado === "sinack") {
      const ok = r.pasos.filter((p) => p.a.estado === "ok").pop();
      return `${tag("a", "⚠ sin respuesta")} enviado ${fh(ok.a.tSend)}${veces}`;
    }
    const u = r.intentos[r.intentos.length - 1];
    return `${tag("r", "✗ no se pudo enviar")} <span class="m">${esc(motivoRed(u.motivo))} · último intento ${fh(u.t)}</span>${veces}`;
  };
  const conPago = [...d.impresos, ...d.cobrados].some((x) => x.pago);
  const cambios = _versionEn.cambios || [];
  const versionTxt = !_versiones.length ? "no detectada" : _versiones.map((v) => `v${v.join(".")}`).join(" → ");

  // --- 1. Cobrados sin papel ---
  const cobrados = d.cobrados;
  const trNo = cobrados.map((x, i) => {
    const cuando = x.t ? fh(x.t) : x.entre && (x.entre.tPrev || x.entre.tNext)
      ? `<span class="m">entre ${fh(x.entre.tPrev)} y ${fh(x.entre.tNext)}</span>` : "—";
    const reem = (x.reem || []).map((o) => `<div class="m">El mismo n° salió impreso después, a las ${fh(o.t)} (corr. #${o.corr}), en otra venta.</div>`).join("");
    return `<tr><td class="n">${i + 1}</td><td class="h">${cuando}</td><td class="h">${sesTxt(x.ses)}</td><td>${boleto(x)}</td>
      <td class="n">${x.num ?? "—"}</td><td class="n">${sol(x.monto)}</td>${conPago ? `<td>${esc(x.pago ?? "")}</td>` : ""}
      <td>${esc(x.que)}${reem}</td><td>${tag("r", "Sí")} <span class="m">${esc(x.cobro)}</span></td>
      <td>${x.corr != null ? `#${x.corr}` : "—"}</td><td>${srv(x.srv)}</td></tr>`;
  }).join("");
  const secNo = `<h2>1. Boletos cobrados sin imprimir (${cobrados.length})</h2>
    ${cobrados.length ? `<table><thead><tr><th class="n">#</th><th>Fecha y hora</th><th>Sesión</th><th>Boleto</th><th class="n">N°</th>
      <th class="n">Precio</th>${conPago ? "<th>Pago</th>" : ""}<th>Qué pasó</th><th>¿Suma?</th><th>Corr.</th><th>Envío al servidor</th></tr></thead>
      <tbody>${trNo}</tbody><tbody><tr class="tot"><td></td><td colspan="4">Total cobrado sin papel</td><td class="n">${sol(suma(cobrados))}</td>
        <td colspan="${conPago ? 5 : 4}">${cobrados.length} boleto(s)</td></tr></tbody></table>
      <p class="nota">Hasta la 1.0.71 el equipo <b>guarda la venta antes de imprimir</b>; si la impresora falla después, solo devuelve el
        número en pantalla y la venta queda guardada: sale al servidor con los pendientes y suma en la liquidación aunque el pasajero
        no recibió boleto. Desde la 1.0.72 esa venta se borra y no suma.</p>`
    : '<p class="vacio">✓ Ningún boleto se cobró sin salir impreso.</p>'}`;

  // --- 2. Impresos por sesión ---
  const agrupar = (arr) => arr.reduce((m, x) => m.set(x.ses, [...(m.get(x.ses) || []), x]), new Map());
  const grupos = agrupar(d.impresos), cobPorSes = agrupar(cobrados), falPorSes = agrupar(d.fallidos);
  const primera = (id) => +(grupos.get(id)?.[0]?.t || cobPorSes.get(id)?.[0]?.t || falPorSes.get(id)?.[0]?.t || 0);
  const ids = [...new Set([...grupos.keys(), ...cobPorSes.keys(), ...falPorSes.keys()])]
    .sort((a, b) => (a == null) - (b == null) || primera(a) - primera(b));
  const sinVentas = [...d.S.ses.keys()].filter((id) => !ids.includes(id)).length;
  const conVersion = _versiones.length > 1;

  const concDe = (id) => d.conc.find((c) => c.L.session === id);
  // Boletos que contó la liquidación vs impresos: "contó 3, se imprimió 1".
  const contoTxt = (c) => {
    if (!c) return ['<span class="m">sin liquidación</span>', "—"];
    const sin = c.sin + c.dig;
    return [`${c.filas}`, `${sin ? tag("r", sin) : c.nv ? "" : tag("g", "0")}${c.nv ? ` <span class="m">+${c.nv} sin verificar</span>` : ""}`];
  };
  const tarifasTxt = (c) => (c?.porTarifa || []).filter((e) => e.contados !== e.impresos)
    .map((e) => `tarifa ${e.fare}: contó ${e.contados}, impresos ${e.impresos}`).join(" · ");
  const liqTxt = (id) => {
    const c = concDe(id);
    if (!c) return ["—", ""];
    const liq = sol(c.liquidado / 100);
    if (!c.dif && !c.sin && !c.dig) return [liq, tag("g", "✓ cuadra")];
    const dif = sol(c.dif / 100);
    if (c.sin || c.dig) return [liq, `${tag("r", dif)} <span class="m">cobrado sin papel</span>`];
    if (c.nv) return [liq, `<span class="m">${dif} de ${c.nv} boleto(s) anteriores al log</span>`];
    return [liq, `${tag("a", dif)} <span class="m">sin explicar</span>`];
  };
  const trRes = ids.map((id) => {
    const s = id ? d.S.ses.get(id) : null, imp = grupos.get(id) || [], fal = (falPorSes.get(id) || []).length;
    const [liq, dif] = id ? liqTxt(id) : ["—", ""];
    const [conto, sinPapel] = contoTxt(id && concDe(id));
    const tar = tarifasTxt(id && concDe(id));
    const ini = s?.ini || imp[0]?.t, fin = s?.fin;
    return `<tr><td class="h">${id ? `#${id}` : '<span class="m">sin identificar</span>'}</td><td>${s?.lado ?? "—"}</td><td>${esc(s?.conductor ?? "—")}</td>
      ${conVersion ? `<td class="h">${ini ? `v${_versionEn(ini) ?? "?"}` : "—"}</td>` : ""}
      <td class="h">${fh(ini)}</td><td class="h">${fin ? fh(fin) : '<span class="m">sin cierre en el log</span>'}</td>
      <td class="n">${imp.length}</td><td class="n">${conto}</td><td class="n">${sinPapel}</td><td class="n">${sol(suma(imp))}</td>
      <td class="n">${liq}</td><td>${dif}${tar ? `<div class="m">${tar}</div>` : ""}</td><td class="n">${fal || "—"}</td></tr>`;
  }).join("");

  const detalle = ids.filter((id) => grupos.has(id)).map((id) => {
    const s = id ? d.S.ses.get(id) : null, arr = grupos.get(id);
    const noC = (cobPorSes.get(id) || []).length, noA = (falPorSes.get(id) || []).length;
    const tr = arr.map((x, i) => {
      const impTxt = x.tras ? `${tag("g", "✓ impreso")} <span class="m">error después de imprimir: ${esc(x.tras)}</span>`
        : x.intentos > 1 ? `${tag("a", `✓ al ${x.intentos}° intento`)}${x.previas.map((f) => `<div class="m">falló ${fh(f.t)}: ${esc(f.motivo || f.ev)}</div>`).join("")}`
        : tag("g", "✓ a la primera");
      return `<tr><td class="n">${i + 1}</td><td class="h">${fh(x.t)}</td><td>${boleto(x)}</td><td class="n">${x.num}</td>
        <td class="n">${sol(x.monto)}</td>${conPago ? `<td>${esc(x.pago ?? "")}</td>` : ""}<td>${impTxt}</td>
        <td>${x.corr != null ? `#${x.corr}` : "—"}</td><td>${srv(x.srv)}</td></tr>`;
    }).join("");
    const cab = id ? `Sesión #${id}${s?.lado ? ` · Lado ${s.lado}` : ""}${s?.conductor ? ` · conductor ${esc(s.conductor)}` : ""}${
      conVersion && s?.ini ? ` · v${_versionEn(s.ini) ?? "?"}` : ""}` : "Sin sesión identificada";
    const c = id && concDe(id);
    const conto = c && c.filas !== arr.length ? ` ${tag(c.sin || c.dig ? "r" : "a", `la liquidación contó ${c.filas}`)}` : "";
    return `<h3>${cab} — ${arr.length} impreso(s) · ${sol(suma(arr))}${conto}${noC ? ` ${tag("r", `${noC} cobrado(s) sin papel: sección 1`)}` : ""}${
      noA ? ` ${tag("a", `${noA} intento(s) fallido(s): sección 3`)}` : ""}</h3>
      <table><thead><tr><th class="n">#</th><th>Hora</th><th>Boleto</th><th class="n">N°</th><th class="n">Precio</th>${conPago ? "<th>Pago</th>" : ""}
        <th>Impresión</th><th>Corr.</th><th>Envío al servidor</th></tr></thead>
      <tbody>${tr}<tr class="tot"><td></td><td colspan="3">Total sesión</td><td class="n">${sol(suma(arr))}</td>${conPago ? "<td></td>" : ""}
        <td colspan="3">${arr.length} boleto(s)</td></tr></tbody></table>`;
  }).join("");
  const secImp = `<h2>2. Boletos impresos por sesión (${d.impresos.length})</h2>
    ${ids.length ? `<table><thead><tr><th>Sesión</th><th>Lado</th><th>Conductor</th>${conVersion ? "<th>APK</th>" : ""}<th>Inicio</th><th>Fin</th>
      <th class="n">Impresos</th><th class="n">Contó la liquidación</th><th class="n">Cobrados sin papel</th><th class="n">Importe impreso</th>
      <th class="n">Liquidación</th><th>Diferencia</th><th class="n">Intentos fallidos</th></tr></thead>
      <tbody>${trRes}</tbody></table>
      ${sinVentas ? `<p class="nota">${sinVentas} sesión(es) más en el log sin ninguna venta.</p>` : ""}
      ${detalle}` : '<p class="m">No hay boletos impresos en el log.</p>'}`;

  // --- 3. Momentos en que no se pudo imprimir ---
  const ep = d.episodios, nFal = d.fallidos.length, intentosVenta = d.impresos.length + cobrados.length + nFal;
  const cuenta = (m) => [...m].sort((a, b) => b[1] - a[1]);
  const motivosVistos = new Set(ep.flatMap((e) => [...e.motivos.keys()]));
  const trEp = ep.map((e, i) => {
    const volvio = e.volvio ? `${fh(e.volvio.t)}<div class="m">${dur(e.volvio.t - e.hasta)} después del último intento</div>`
      : e.cierre ? `${tag("r", "no")} <span class="m">la sesión cerró a las ${fh(e.cierre)} sin volver a imprimir</span>`
      : `${tag("r", "no")} <span class="m">hasta el final del log</span>`;
    return `<tr><td class="n">${i + 1}</td><td class="h">${fh(e.desde)}</td><td class="h">${fh(e.hasta)}</td>
      <td class="h">${sesTxt(e.ses)}</td>
      <td class="n">${e.intentos}${e.rafagas > 1 ? `<div class="m">en ${e.rafagas} tandas</div>` : ""}${
        e.resueltos ? `<div class="m">${pl(e.resueltos, "salió", "salieron")} al reintentar</div>` : ""}</td>
      <td>${cuenta(e.tarifas).map(([f, n]) => `t${f}${n > 1 ? ` ×${n}` : ""}`).join(" · ") || "—"}</td>
      <td>${cuenta(e.motivos).map(([m, n]) => `${esc(m)}${n > 1 ? ` ×${n}` : ""}`).join(" · ")}</td>
      <td>${e.cobrados.length ? tag("r", `${e.cobrados.length} · ${sol(suma(e.cobrados))}`) : "—"}</td>
      <td class="h">${volvio}</td></tr>`;
  }).join("");
  const largo = ep.slice().sort((a, b) => b.hasta - b.desde - (a.hasta - a.desde) || b.intentos - a.intentos)[0];
  const secFal = `<h2>3. Momentos en que no se pudo imprimir (${ep.length})</h2>
    ${ep.length ? `<p class="nota">Cada fila junta los intentos de venta que fallaron seguidos, sin ningún boleto impreso entre uno y otro
      (una <i>tanda</i> nueva empieza tras 10 min sin intentos). <b>Intentos no son pasajeros</b>: mientras la impresora no
      responde el conductor vuelve a tocar el boleto, el equipo devuelve el número y el intento no suma. Solo suman los
      <b>cobrados sin papel</b> (sección 1).</p>
    <table><thead><tr><th class="n">#</th><th>Primer intento</th><th>Último intento</th><th>Sesión</th><th class="n">Intentos</th><th>Tarifas</th>
      <th>Qué pasó</th><th>Cobrados sin papel</th><th>¿Volvió a imprimir?</th></tr></thead>
    <tbody>${trEp}</tbody></table>
    <dl>${[...motivosVistos].filter((m) => MOTIVO_FALLA[m]).map((m) => `<dt>${esc(m)}</dt><dd>${MOTIVO_FALLA[m]}</dd>`).join("")}</dl>`
    : intentosVenta ? '<p class="vacio">✓ Todos los intentos de venta salieron impresos.</p>' : '<p class="m">No hay intentos de venta en el log.</p>'}`;

  // --- 4. Fallas de impresora ---
  // Por tipo de falla: cuántas y entre qué horas, separando boletos de liquidaciones y otros trabajos.
  const tipos = new Map();
  for (const e of d.errores) {
    const x = tipos.get(e.tipo) || { tipo: e.tipo, trabajos: new Map() };
    const w = x.trabajos.get(e.trabajo) || { n: 0, ini: e.t, fin: e.t };
    w.n++;
    if (e.t < w.ini) w.ini = e.t;
    if (e.t > w.fin) w.fin = e.t;
    x.trabajos.set(e.trabajo, w);
    tipos.set(e.tipo, x);
  }
  const nDe = (x, trabajo) => x.trabajos.get(trabajo)?.n || 0;
  const porTipo = [...tipos.values()].sort((a, b) => nDe(b, "boleto") - nDe(a, "boleto") || a.tipo.localeCompare(b.tipo));
  const rango = (w) => `${w.n} <span class="m">${fh(w.ini)}${+w.fin !== +w.ini ? `–${fh(w.fin)}` : ""}</span>`;
  const nErrBol = d.errores.filter((e) => e.trabajo === "boleto").length, nErrOtros = d.errores.length - nErrBol;
  const secErr = `<h2>4. Fallas de la impresora (${d.errores.length})</h2>
    ${d.errores.length ? `<table><thead><tr><th>Tipo</th><th>Qué significa</th><th class="n">Al imprimir boletos</th><th>Liquidación y otros</th></tr></thead>
    <tbody>${porTipo.map((x) => `<tr><td>${tag("r", esc(x.tipo))}</td><td>${MOTIVO_FALLA[x.tipo] ?? ""}</td>
      <td class="n">${x.trabajos.has("boleto") ? rango(x.trabajos.get("boleto")) : "—"}</td>
      <td>${[...x.trabajos].filter(([k]) => k !== "boleto").map(([k, w]) => `${esc(k)}: ${rango(w)}`).join("<br>") || "—"}</td></tr>`).join("")}
    <tr class="tot"><td colspan="2">Total</td><td class="n">${nErrBol}</td><td>${nErrOtros || "—"}</td></tr></tbody></table>
    <p class="nota">Una falla por cada impresión que el equipo dio por fallida; no se cuentan los reintentos internos ni los mensajes de la
      reconexión. Muchas fallas de <i>liquidacion</i> en pocos minutos son el conductor pidiendo reimprimir la liquidación con la impresora caída.
      Los intentos de la sección 3 <i>cancelados en cola</i> o rechazados por <i>cola llena</i> no son fallas de la impresora: son la
      consecuencia de una de estas.</p>`
    : '<p class="vacio">✓ No se registró ninguna falla de la impresora.</p>'}`;

  // --- 5. Envío al servidor ---
  const L = d.env.lista, nAck = L.filter((r) => r.estado === "ack").length;
  const despues = d.ultAck ? d.impresos.filter((x) => x.t > d.ultAck).length : 0;
  const tVenta = (r) => r.tVenta || r.intentos[0]?.t;
  const trSin = d.sinConf.map((r) => `<tr><td>#${r.corr}</td><td class="h">${fh(tVenta(r))}</td>
      <td class="h">${sesTxt(d.S.de(tVenta(r), r.corr, r.session))}</td><td>${r.fare ? `${boleto(r)} n° ${r.num}` : "—"}</td><td>${srv(r)}</td></tr>`).join("");
  const trCortes = d.cortes.map((c) => {
    const min = c.hasta ? Math.round((c.hasta - c.desde) / 60000) : null;
    const n = d.impresos.filter((x) => x.t >= c.desde && (!c.hasta || x.t <= c.hasta)).length;
    return `<tr><td class="h">${fh(c.desde)}</td><td class="h">${c.hasta ? fh(c.hasta) : '<span class="m">hasta el final del log</span>'}</td>
      <td class="n">${min != null ? `${min} min` : "—"}</td>
      <td>${c.kind === "netdown" ? "El equipo perdió internet" : "Se cortó la conexión con el servidor"} <span class="m">${c.txt}</span></td>
      <td class="n">${n}</td></tr>`;
  }).join("");
  const secSrv = `<h2>5. Envío de boletos al servidor</h2>
    ${L.length ? `<div class="cards">
      <div class="card"><div class="l">Confirmados por el servidor</div><div class="b">${nAck} de ${L.length}</div></div>
      <div class="card"><div class="l">Último boleto confirmado</div><div class="b">${fl(d.ultAck)}</div></div>
      <div class="card ${d.sinConf.length ? "a" : ""}"><div class="l">Sin confirmar</div><div class="b">${d.sinConf.length}</div></div>
      <div class="card"><div class="l">Último envío</div><div class="b">${fl(d.ultEnvio)}</div></div>
    </div>
    ${cobrados.some((x) => x.srv) ? `<p>${tag("r", "⚠")} ${cobrados.filter((x) => x.srv).length} de esos boletos se cobraron sin papel (sección 1):
      el servidor los recibió igual que los impresos.</p>` : ""}
    ${despues ? `<p>${tag("a", "⚠")} ${despues} boleto(s) impresos después de las ${fh(d.ultAck)} (último confirmado) no tienen confirmación del servidor en este log.</p>` : ""}
    ${trSin ? `<h3>Boletos sin confirmación del servidor (${d.sinConf.length})</h3>
    <table><thead><tr><th>Corr.</th><th>Venta</th><th>Sesión</th><th>Boleto</th><th>Qué pasó con el envío</th></tr></thead><tbody>${trSin}</tbody></table>`
    : '<p class="vacio">✓ El servidor confirmó todos los boletos enviados.</p>'}`
    : '<p class="m">El log no tiene envíos de boletos al servidor.</p>'}
    ${trCortes ? `<h3>Cortes de conexión de más de 1 minuto (${d.cortes.length})</h3>
    <table><thead><tr><th>Desde</th><th>Hasta</th><th class="n">Duración</th><th>Qué pasó</th><th class="n">Boletos vendidos en el corte</th></tr></thead>
    <tbody>${trCortes}</tbody></table>` : ""}`;

  // --- 6. Toques sin venta (1.0.72+) ---
  const TOQUE = { CORTO: "Toque muy corto: soltó antes de tiempo", CANCELADO: "Deslizó el dedo o se interrumpió", DESHABILITADO: "Tarjeta bloqueada" };
  const secToq = d.toques.length ? `<h2>6. Toques en pantalla que no llegaron a venta (${d.toques.length})</h2>
    <p class="nota">El conductor tocó un boleto pero el equipo no intentó venderlo, así que no hay nada que imprimir ni cobrar.</p>
    <table><thead><tr><th>Fecha y hora</th><th>Sesión</th><th>Boleto</th><th>Qué pasó</th><th class="n">Duración del toque</th></tr></thead>
    <tbody>${d.toques.map((e) => `<tr><td class="h">${fh(e.t)}</td><td class="h">${sesTxt(d.S.de(e.t))}</td><td>${boleto({ ...e, fare: e.boleto })}</td>
      <td>${TOQUE[e.resultado] ?? esc(e.resultado)}</td><td class="n">${e.ms != null ? `${e.ms} ms${e.min != null ? ` <span class="m">/ mín ${e.min}</span>` : ""}` : "—"}</td></tr>`).join("")}
    </tbody></table>` : "";

  // --- Resumen ---
  const ver = [];
  if (!intentosVenta) ver.push("No hay ventas de boletos en el log.");
  else ver.push(`${intentosVenta > d.impresos.length ? `El conductor intentó vender <b>${pl(intentosVenta, "vez", "veces")}</b>: ` : ""}<b>${
    pl(d.impresos.length, "boleto salió impreso", "boletos salieron impresos")}</b> por <b>${sol(suma(d.impresos))}</b>${
    ids.filter(Boolean).length ? ` en <b>${pl(ids.filter(Boolean).length, "sesión", "sesiones")}</b>` : ""}${
    cobrados.length ? `, ${tag("r", `${pl(cobrados.length, "se cobró", "se cobraron")} sin papel`)} por <b>${sol(suma(cobrados))}</b>` : ""}${
    nFal ? ` y <b>${pl(nFal, "intento falló", "intentos fallaron")}</b> sin sumar` : ""}.`);
  const contoDeMas = d.conc.filter((c) => c.sin || c.dig);
  if (contoDeMas.length) ver.push(`La liquidación contó más boletos de los que salieron en papel: ${contoDeMas.map((c) =>
    `sesión <b>#${c.L.session}</b> contó <b>${c.filas}</b> y se imprimieron <b>${c.papel}</b>`).join("; ")}.`);
  if (ep.length) ver.push(`No se pudo imprimir en <b>${pl(ep.length, "momento", "momentos")}</b>${ep.length > 1 ? "; el más largo" : ""}: ${
    +largo.hasta !== +largo.desde ? `de ${fh(largo.desde)} a ${fh(largo.hasta)} (${dur(largo.hasta - largo.desde)})` : `a las ${fh(largo.desde)}`}${
    largo.ses ? `, sesión #${largo.ses}` : ""}, el conductor intentó <b>${pl(largo.intentos, "vez", "veces")}</b>${
    largo.volvio ? ` y volvió a imprimir a las ${fh(largo.volvio.t)}` : largo.cierre ? ` y la sesión cerró a las ${fh(largo.cierre)} sin volver a imprimir` : " sin volver a imprimir"}.${
    d.fallidos.length > ep.length ? " Los intentos repetidos son el conductor volviendo a tocar, no pasajeros distintos." : ""}`);
  if (d.errores.length) ver.push(`${nErrBol ? `La impresora falló <b>${pl(nErrBol, "vez", "veces")}</b> al imprimir boletos (${porTipo.filter((x) => nDe(x, "boleto")).slice(0, 3)
    .map((x) => `${esc(x.tipo)} ×${nDe(x, "boleto")}`).join(", ")})` : "La impresora no falló al imprimir boletos"}${
    nErrOtros ? `${nErrBol ? " y" : "; falló"} <b>${pl(nErrOtros, "vez", "veces")}</b> al imprimir liquidaciones u otros` : ""}.`);
  for (const c of cambios) ver.push(`El equipo se actualizó de <b>v${c.de}</b> a <b>v${c.a}</b> el ${fl(c.t)}.`);
  if (L.length) ver.push(`El servidor confirmó <b>${nAck} de ${L.length}</b> boletos enviados${d.ultAck ? `; el último, el ${fl(d.ultAck)}` : ""}.${d.sinConf.length ? ` ${tag("a", `${d.sinConf.length} sin confirmar`)}` : ""}`);
  if (d.cortes.length) ver.push(`Hubo <b>${d.cortes.length}</b> corte(s) de conexión de más de 1 minuto.`);

  // Solo se explican las columnas que este informe realmente muestra.
  const conTablas = d.impresos.length || cobrados.length;
  const glosario = [
    [d.impresos.length, "Impreso", "El equipo registró que la impresora terminó el boleto (quedó confirmado en su base de datos)."],
    [cobrados.length, "Cobrado sin papel", "La venta quedó guardada en el equipo y suma en la liquidación, pero el boleto no salió impreso (sección 1)."],
    [nFal, "Intento fallido", "Toque de venta que no salió impreso y el equipo anuló: no suma ni se envía al servidor (sección 3)."],
    [conTablas || d.sinConf.length, "Corr.", "Correlativo: número interno y único de cada venta en el equipo; sirve para ubicarla en la liquidación y en el servidor."],
    [conTablas, "Envío al servidor", `<b>✓ recibido</b>: el servidor confirmó el boleto a esa hora. <b>⚠ sin respuesta</b>: salió del equipo pero el servidor no confirmó.
      <b>✗ no se pudo enviar</b>: no había conexión; el equipo lo reintenta al reconectar.`],
    [ids.length, "Contó la liquidación", `Resumen de la sección 2: cuántos boletos reportó el equipo al cerrar la sesión (del correlativo <i>primero</i> al <i>último</i>).
      Incluye los <b>cobrados sin papel</b>; no incluye los intentos fallidos.`],
    [ids.length, "Liquidación", "Columna del resumen de la sección 2: lo que el equipo reportó al cerrar la sesión. <b>Diferencia</b> = liquidación menos lo impreso."],
  ].filter(([ok]) => ok).map(([, dt, dd]) => [dt, dd]);

  const ahora = new Date();
  const nombre = (_files || "log").replace(/\.txt\b/gi, "").replace(/[^\w.-]+/g, "_").slice(0, 60);
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Informe de boletos — ${esc(_files)}</title><style>${CSS_INFORME}</style></head><body>
<div class="top"><div><h1>Informe de boletos</h1>
  <div class="m">Archivo: <b>${esc(_files)}</b> · APK ${versionTxt}${cambios.length ? ` <span class="m">(actualizado el ${cambios.map((c) => fl(c.t)).join(", ")})</span>` : ""}
    · Log del ${fl(d.logIni)} al ${fl(d.logFin)} · Generado el ${fl(ahora)}</div></div>
  <div class="acc"><button onclick="print()">🖨️ Imprimir / PDF</button><a id="dl" download="informe-boletos-${nombre}.html">⬇ Descargar</a></div></div>
<div class="cards">
  <div class="card"><div class="l">Boletos impresos</div><div class="b">${d.impresos.length}</div><div class="m">${sol(suma(d.impresos))}</div></div>
  <div class="card ${cobrados.length ? "r" : ""}"><div class="l">Cobrados sin papel</div><div class="b">${cobrados.length}</div>
    <div class="m">${cobrados.length ? `${sol(suma(cobrados))} · suman en la liquidación` : "ninguno"}</div></div>
  <div class="card ${nFal ? "a" : ""}"><div class="l">Intentos fallidos (no suman)</div><div class="b">${nFal}</div>
    <div class="m">${ep.length ? `en ${pl(ep.length, "momento", "momentos")} sin impresión` : "—"}</div></div>
  <div class="card ${d.errores.length ? "a" : ""}"><div class="l">Fallas de la impresora</div><div class="b">${nErrBol}</div>
    <div class="m">${nErrOtros ? `boletos · +${nErrOtros} liquidación y otros` : "al imprimir boletos"}</div></div>
  <div class="card ${d.sinConf.length ? "a" : ""}"><div class="l">Confirmados por el servidor</div><div class="b">${nAck}/${L.length}</div>
    <div class="m">último ${d.ultAck ? fh(d.ultAck) : "—"}</div></div>
</div>
<ul class="ver">${ver.map((v) => `<li>${v}</li>`).join("")}</ul>
${secNo}${secImp}${secFal}${secErr}${secSrv}${secToq}
<h2>Cómo leer este informe</h2>
<dl>${glosario.map(([dt, dd]) => `<dt>${dt}</dt><dd>${dd}</dd>`).join("")}</dl>
<p class="nota">Todo sale del log del equipo. Si la impresora dio un boleto por impreso sin sacar el papel (por ejemplo, un atasco), eso no queda en el log.
  Las horas son las del equipo.</p>
<script>document.getElementById("dl").href = location.href;</script>
</body></html>`;
}

// Abre el informe en otra pestaña (blob) o lo manda a imprimir desde un iframe oculto.
function abrirInforme(imprimir) {
  const html = informeHtml();
  if (!imprimir) {
    window.open(URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" })), "_blank");
    return;
  }
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  f.onload = () => {
    f.contentWindow.addEventListener("afterprint", () => f.remove());
    f.contentWindow.focus();
    f.contentWindow.print();
  };
  f.srcdoc = html;
  document.body.appendChild(f);
}

// Barra fija: un salto por panel, así no hay que volver arriba para navegar.
function construirNav() {
  const nav = $("jump");
  const panels = [...document.querySelectorAll("#report .panel")];
  if (!panels.length) { nav.hidden = true; nav.innerHTML = ""; return; }
  const archivo = _files.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const version = _versiones.length ? ` · v${_versiones[_versiones.length - 1].join(".")}` : "";
  nav.innerHTML = (archivo ? `<span class="jump-file" title="${archivo}">📄 ${archivo}${version}</span>` : "") +
    panels.map((p, i) => {
      p.id = "p" + i;
      const h = p.querySelector("h2");
      const txt = (h ? h.textContent : `Panel ${i + 1}`).replace(/\s*\(\d+\).*/, "").trim();
      return `<a href="#p${i}">${txt}</a>`;
    }).join("") +
    (_tickets.length || _impresion || _noImpresos?.lista.length
      ? `<span class="jump-acc"><button class="jump-btn" data-informe="ver" title="Informe claro para una persona: no impresos, impresos por sesión, errores y envío al servidor">📄 Informe</button>
         <button class="jump-btn" data-informe="imprimir" title="Imprimir o guardar el informe como PDF">🖨️ Imprimir</button></span>`
      : "");
  nav.hidden = false;
}

function render(ev, tickets, files) {
  const rep = $("report");
  if (!ev.length && !tickets.length && !_liqs.length && !_logins.length && !_sesionesJson.length && !_traf.length && !_impresion) {
    rep.hidden = true;
    $("jump").hidden = true;
    $("status").textContent = "No se encontraron líneas de socket ni boletos en el archivo.";
    return;
  }
  if (tickets.length || _liqs.length || _logins.length) $("cmp").hidden = false;
  const ses = [...parseSesiones($("sesiones").value || ""), ..._sesionesJson.map(filaDeSesion).filter(Boolean)]
    .sort((a, b) => a.ini - b.ini);
  const ticketsHtml =
    (_versiones.length || _impresion ? renderVersion(_versiones, _impresion) : "") +
    renderBucles(_logins, _liqs, _texto) +
    renderSolicitudVsRespuesta(_logins, _texto) +
    renderCierre(_liqs, _logins, _texto) + renderLiquidacion(_liqs, tickets, _logins) +
    renderTickets(tickets, _envios, _impresion) + renderImpresion(_impresion, _versiones) +
    renderNoImpresos(_noImpresos) + renderEnvios(_envios) +
    renderComparacion(tickets, ses) + renderSesionObjeto(ses) +
    renderDuplicados(tickets) + renderErrores(_textos) + renderTrafico(_traf);
  if (!ev.length) {
    rep.innerHTML = ticketsHtml;
    rep.hidden = false;
    construirNav();
    $("status").textContent = "";
    return;
  }
  const t0 = ev[0].t, t1 = ev[ev.length - 1].t;
  const horas = Math.max((t1 - t0) / 3.6e6, 1 / 3600);
  let totEnv = 0, totRec = 0;
  for (const e of ev) { totEnv += e.env; totRec += e.rec; }
  const tot = totEnv + totRec, ph = tot / horas;

  // tarjetas de ventana
  const vents = [["Últimas 6h", 6], ["Últimas 12h", 12], ["Últimas 24h", 24], ["Total", null]];
  let cards = "";
  for (const [lbl, dh] of vents) {
    const desde = dh === null ? t0 : new Date(+t1 - dh * 3.6e6);
    const { env, rec } = ventana(ev, desde);
    cards += `<div class="card"><div class="lbl">${lbl}</div>
      <div class="big">${humano(env + rec)}</div>
      <div class="sub">↑ ${humano(env)} &nbsp; ↓ ${humano(rec)}</div></div>`;
  }

  // timeline
  const tl = timelineHora(ev);
  const horasArr = [];
  const cur = new Date(t0); cur.setMinutes(0, 0, 0);
  const fin = new Date(t1); fin.setMinutes(0, 0, 0);
  while (cur <= fin) { horasArr.push(new Date(cur)); cur.setHours(cur.getHours() + 1); }
  const tlDatos = horasArr.map((h) => tl.get(+h) || 0);
  const tlEtiq = horasArr.map((h) =>
    `${String(h.getDate()).padStart(2, "0")}/${String(h.getMonth() + 1).padStart(2, "0")} ${String(h.getHours()).padStart(2, "0")}h`);

  // hora del día
  const hd = horaDelDia(ev);
  let pico = 0; for (let i = 1; i < 24; i++) if (hd[i] > hd[pico]) pico = i;
  const hdEtiq = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));

  // por key
  const dk = porKey(ev);
  const keys = [...dk.keys()].sort((a, b) => (dk.get(b).eb + dk.get(b).rb) - (dk.get(a).eb + dk.get(a).rb));
  const keyDatos = keys.map((k) => dk.get(k).eb + dk.get(k).rb);
  let filas = "";
  for (const k of keys) {
    const r = dk.get(k);
    filas += `<tr><td>${k}</td><td>${humano(r.eb)}</td><td>${r.en}</td>
      <td>${humano(r.rb)}</td><td>${r.rn}</td><td><b>${humano(r.eb + r.rb)}</b></td></tr>`;
  }

  const f = (d) => d.toLocaleString("es", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  rep.innerHTML = ticketsHtml + `
    <div class="panel"><h2>📡 Consumo de datos — resumen</h2>
      <p class="muted" style="margin:0 0 10px">${files} &nbsp;|&nbsp; ${f(t0)} → ${f(t1)} &nbsp;|&nbsp;
        ${horas.toFixed(1)} h (${(horas / 24).toFixed(1)} días) &nbsp;|&nbsp;
        proyección: <b>${humano(ph * 24)}/día</b> · ${humano(ph * 24 * 30)}/mes</p>
      <div class="grid" style="margin-bottom:0">${cards}</div></div>
    <div class="panel"><h2>Consumo por hora (línea de tiempo)</h2>${barras(tlDatos, tlEtiq, "var(--accent)")}</div>
    <div class="panel"><h2>Consumo por hora del día — pico ${String(pico).padStart(2, "0")}:00</h2>${barras(hd, hdEtiq, "var(--accent2)")}</div>
    <div class="panel"><h2>Consumo por tipo de mensaje</h2>${barras(keyDatos, keys, "var(--accent3)")}</div>
    <div class="panel"><table>
      <tr><th>tipo</th><th>enviado</th><th>n°</th><th>recibido</th><th>n°</th><th>total</th></tr>
      ${filas}</table></div>
    <p class="note">Son los bytes de payload del socket que el propio log declara (protocolo protobin).
      El consumo real de la SIM es algo mayor por overhead TCP/TLS y no incluye mapas, llamadas ni actualizaciones de APK.</p>`;
  rep.hidden = false;
  construirNav();
  $("status").textContent = "";
}

let _ev = [], _tickets = [], _liqs = [], _logins = [], _traf = [], _texto = "", _textos = [], _files = "", _envios = ENVIOS_VACIO;
let _versionEn = () => null;
let _noImpresos = null, _impresion = null, _versiones = [];
let _sesionesJson = [], _jsonStage = [];

function pintar() { render(_ev, _tickets, _files); }

// --- Modal: agregar sesiones en JSON, apilando varias antes de procesar ---
function resumenJson() {
  const n = _sesionesJson.length;
  $("jsonResumen").textContent = n ? `${n} sesión(es) JSON cargada(s)` : "";
}
function refrescarChipsJson() {
  $("jsonChips").innerHTML = _jsonStage.map((o, i) =>
    `<span class="chip">#${o.id ?? "?"} · Lado ${o.lado != null ? LADO(o.lado) : "?"}<button class="chip-x" data-i="${i}" title="Quitar">×</button></span>`
  ).join("");
  $("jsonCount").textContent = _jsonStage.length ? `${_jsonStage.length} sesión(es) en la lista` : "lista vacía";
}
function abrirModalJson() {
  _jsonStage = _sesionesJson.slice();
  $("jsonInput").value = "";
  $("jsonMsg").textContent = "";
  refrescarChipsJson();
  $("jsonModal").hidden = false;
  $("jsonInput").focus();
}
function cerrarModalJson() { $("jsonModal").hidden = true; }

// Parsea el textarea y apila las sesiones válidas. Devuelve false si el texto es inválido.
function apilarDesdeInput() {
  const txt = $("jsonInput").value;
  if (!txt.trim()) return true;
  const arr = parseVariosJson(txt);
  if (arr == null) { $("jsonMsg").innerHTML = '<span class="tag err">JSON inválido</span> revisa el texto pegado.'; return false; }
  let n = 0;
  for (const o of arr) {
    if (!filaDeSesion(o)) continue;
    const idx = o.id != null ? _jsonStage.findIndex((x) => x.id === o.id) : -1;
    if (idx >= 0) _jsonStage[idx] = o; else _jsonStage.push(o);
    n++;
  }
  if (!n) { $("jsonMsg").innerHTML = '<span class="tag err">Sin sesiones válidas</span> cada objeto necesita <code>inicio</code> y <code>fin</code>.'; return false; }
  $("jsonMsg").innerHTML = `<span class="tag ok">✓ ${n} añadida(s)</span>`;
  $("jsonInput").value = "";
  refrescarChipsJson();
  return true;
}

// Líneas anteriores a `t` (con sus continuaciones): lo que el APK logueó antes de actualizarse a la 1.0.72.
function antesDe(crono, t) {
  const out = [];
  for (const l of crono.split(/\r?\n/)) {
    const m = RE_LINEA.exec(l);
    if (m && parseTs(m[1]) >= t) break;
    out.push(l);
  }
  return out.join("\n");
}

function analizarTextos(textos) {
  _textos = textos;
  _texto = textos.join("\n");
  _ev = parse(_texto);
  _tickets = parseTickets(_texto);
  _liqs = parseLiquidaciones(_texto);
  _logins = parseLogins(_texto);
  _traf = parseTrafico(_texto);
  const crono = textos.map(cronologico).join("\n");
  _envios = analizarEnvios(crono);
  _precioDetectado = detectarTarifas(_liqs, _tickets, _envios);
  _versiones = detectarVersiones(_texto);
  _versionEn = lineaDeVersiones(_texto);
  // Un log que se actualizó a la 1.0.72 a mitad del día trae las dos formas: lo anterior a la primera línea [VENTA]
  // se reconstruye con las líneas de siempre y lo posterior sale de [VENTA].
  const venta = parseVentaLog(crono);
  const legacy = reconstruirVentaLegacy(venta.length ? antesDe(crono, venta[0].t) : crono);
  _impresion = analizarImpresion([...legacy, ...venta].sort((a, b) => a.t - b.t || a.i - b.i), _tickets);
  if (_impresion) _impresion.inferido = !venta.length;
  _noImpresos = analizarNoImpresos(crono, _envios, _liqs, _logins, venta);
}

async function cargar(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  $("status").textContent = "Procesando…";
  analizarTextos(await Promise.all(files.map((f) => f.text())));
  _files = files.map((f) => f.name).join(", ");
  document.title = `${_files} — Consumo Tcontur`;
  pintar();
}

const drop = $("drop"), input = $("file");
input.addEventListener("change", () => cargar(input.files));
$("comparar").addEventListener("click", pintar);
$("jump").addEventListener("click", (e) => {
  const b = e.target.closest("[data-informe]");
  if (b) abrirInforme(b.dataset.informe === "imprimir");
});
$("sesiones").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) pintar(); });
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => cargar(e.dataTransfer.files));

// Modal JSON
$("btnJson").addEventListener("click", abrirModalJson);
$("jsonClose").addEventListener("click", cerrarModalJson);
$("jsonCancel").addEventListener("click", cerrarModalJson);
$("jsonAdd").addEventListener("click", apilarDesdeInput);
$("jsonChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip-x");
  if (!b) return;
  _jsonStage.splice(+b.dataset.i, 1);
  refrescarChipsJson();
});
$("jsonConfirm").addEventListener("click", () => {
  if (!apilarDesdeInput()) return;
  _sesionesJson = _jsonStage.slice();
  cerrarModalJson();
  resumenJson();
  pintar();
});
$("jsonModal").addEventListener("click", (e) => { if (e.target.id === "jsonModal") cerrarModalJson(); });
document.addEventListener("input", (e) => { if (e.target.id === "qHora") mostrarHora(e.target.value); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("jsonModal").hidden) cerrarModalJson(); });
