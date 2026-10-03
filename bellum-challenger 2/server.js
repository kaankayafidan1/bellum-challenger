// ============================================================================
//  Fight Night — Ticket-Verkaufsserver  (FESTE PLATZWAHL / Einzelplätze)
//  Stripe Checkout + serverseitige, fälschungssichere Ticket-Signierung
//  Plätze werden einzeln reserviert (mit Ablaufzeit) und nach Zahlung verkauft.
// ============================================================================

import express from "express";
import Stripe from "stripe";
import crypto from "crypto";
import admin from "firebase-admin";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { allBlocks, seatsOf, seatId, seatPrice, blockPriceRange, isBlocked, isRowBlocked, isSeatBlocked, BLOCKED_SEATS} from "./seats-maritim.js";
// Gestaltung der Eintrittskarte: Bilder, Schriften und Layout des Designpakets.
// Fehlt eine dieser Dateien, startet der Server gar nicht erst - besser als
// stillschweigend unfertige Tickets auszugeben.
import { zeichneTicket, schriftenLaden, SEITE_B, SEITE_H } from "./ticket-design.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, TICKET_SECRET,
  FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL,
  EVENT_ID = "bellum-challenger", PUBLIC_URL = "http://localhost:4242", PORT = 4242,
  // E-Mail-Versand (IONOS SMTP)
  SMTP_HOST = "smtp.ionos.de", SMTP_PORT = 465,
  SMTP_USER, SMTP_PASS, MAIL_FROM = "BFC Tickets <info@bellumfc.com>",
  // Schluessel fuer die Verkaufsuebersicht des Veranstalters. Ist er nicht
  // gesetzt, gibt es die Uebersicht gar nicht - kein Zugang ohne Absicht.
  ADMIN_KEY
} = process.env;

function requireEnv(name, val){ if(!val){ console.error(`FEHLT: Umgebungsvariable ${name} ist nicht gesetzt.`); process.exit(1); } }
requireEnv("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY);
requireEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
requireEnv("TICKET_SECRET", TICKET_SECRET);
requireEnv("FIREBASE_SERVICE_ACCOUNT", FIREBASE_SERVICE_ACCOUNT);
requireEnv("FIREBASE_DATABASE_URL", FIREBASE_DATABASE_URL);

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ---------------------------------------------------------------------------
//  Termin des Events - EINE Quelle fuer Ticket UND Mail.
//
//  Vorher standen Datum und Wochentag an drei Stellen als Text im Server. Im
//  HTML-Teil der Bestaetigungsmail war der Samstagstermin von BFC 6 stehen
//  geblieben: jeder Challenger-Kaeufer las dort "17. OKTOBER 2026 - SAMSTAG",
//  waehrend Ticket und Textteil richtig den 18. Oktober nannten. Damit das
//  nicht wieder auseinanderlaufen kann, kommt alles von hier.
// ---------------------------------------------------------------------------
const TERMIN = {
  datum:   "18. Oktober 2026",
  tag:     "Sonntag",
  ort:     "Saal Maritim",
  einlass: "12:15 Uhr",
  kurz:    "So, 18. Oktober 2026"      // so steht es auf dem Ticket
};


admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: FIREBASE_DATABASE_URL
});
const db = admin.database();

// Reservierung läuft nach dieser Zeit ab, wenn nicht bezahlt wird (Millisekunden)
// 5 Min: genug Luft für 3-D-Secure (SMS-TAN/Banking-App), räumt aber schnell wieder frei.
//
// BEWUSST NICHT VERLÄNGERT. Stripe lässt eine Bezahlseite frühestens nach 30 Minuten
// verfallen, die Reservierung müsste also 35 Minuten gelten, um den Wettlauf ganz zu
// schliessen. Durchgerechnet für diesen Saal wären das bei 200 gleichzeitigen
// Kaufversuchen und 60 % Abbrechern rund 71 % des Saals, die nur SCHEINBAR belegt
// sind — der Shop meldete "ausverkauft", obwohl kaum etwas verkauft ist.
// Stattdessen greift die Prüfung in fulfillOrder: zwei Leute können denselben Platz
// zwar noch bezahlen, aber nur einer bekommt ein Ticket, der andere einen sichtbaren
// Konflikteintrag zur Erstattung. Siehe LIESMICH-SERVER.md, Abschnitt "Was offen bleibt".
const RESERVATION_MS = 5 * 60 * 1000; // 5 Minuten
const CHECKOUT_MS    = 30 * 60 * 1000; // Laufzeit der Stripe-Bezahlseite

// ---- Hilfsfunktionen ----
function b64url(buf){ return buf.toString("base64").replace(/[+/=]/g,c=>({"+":"-","/":"_","=":""}[c])); }

// Firebase-tauglicher Schlüssel aus der Sitz-ID (keine . # $ / [ ] Leerzeichen)
function fbKey(seatIdStr){ return seatIdStr.replace(/[.#$/\[\]\s|]/g, "_"); }

/* Die Reihe wird ueberall als ZAHL angezeigt. In den Daten, im QR-Code und in
   der Signatur bleibt der BUCHSTABE stehen - wuerde man den aendern, waere
   jedes bereits verkaufte Ticket ungueltig und jeder Platz in Firebase ein
   anderer. Die Buchstaben laufen durch den ganzen Saal: A = Reihe 1 ...
   V = Reihe 22; die hinteren Bloecke P9-P14 fangen deshalb bei G = Reihe 7 an.
   Emporenreihen sind schon Ziffern und bleiben unveraendert. */
function reiheAnzeige(row, zone){
  // Nur der Saal Maritim wird umgerechnet. Die alten ring°arena-Zonen "Rang"
  // und "Parkett" bleiben, wie sie sind - dort hiess Reihe K wirklich K, und
  // ein Nachdruck eines alten Tickets darf daraus nicht "Reihe 11" machen.
  if(zone !== "Innenraum" && zone !== "Empore") return String(row == null ? "" : row);
  const s = String(row == null ? "" : row).trim().toUpperCase();
  if(/^[A-Z]$/.test(s)) return String(s.charCodeAt(0) - 64);
  return String(row == null ? "" : row);
}

// Status eines Platzes: liest reservations + sold
// Rückgabe: "frei" | "reserviert" | "verkauft"
function seatStatusFrom(reservation, sold, now){
  if (sold) return "verkauft";
  if (reservation && reservation.until > now) return "reserviert";
  return "frei";
}

// ============================================================================
//  EXPRESS
// ============================================================================
const app = express();

// Webhook braucht rohen Body VOR express.json()
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook-Signatur ungültig:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ------------------------------------------------------------------
  // Gehoert diese Zahlung zu einem ANDEREN Event? Dann nicht anfassen.
  //
  // Stripe liefert jedes Ereignis an JEDEN eingerichteten Endpunkt - also
  // auch an den des anderen Events. Der Endpunkt hier bekommt dadurch auch
  // die Kaeufe der anderen Verkaufsseite, korrekt signiert, und stellte sie
  // bisher mit aus. Folge: der Kunde bekam eine zweite Mail mit einem Ticket
  // fuer den falschen Tag, und derselbe Platz wurde hier als verkauft
  // markiert, ohne dass ihn jemand gekauft hat.
  //
  // Die Kennung setzen wir selbst, wenn wir die Bezahlseite anlegen
  // (metadata.eventId = EVENT_ID). Stimmt sie nicht, ist es nicht unser Kauf.
  // ------------------------------------------------------------------
  const kaufEvent = event.data?.object?.metadata?.eventId;
  if (kaufEvent && kaufEvent !== EVENT_ID) {
    console.log(`Webhook ignoriert: Zahlung gehoert zu Event "${kaufEvent}", dieser Server ist "${EVENT_ID}".`);
    return res.json({ received: true, ignoriert: kaufEvent });
  }
  // Bezahlseite verfallen: die Plätze sofort wieder freigeben.
  if (event.type === "checkout.session.expired") {
    try {
      const s = event.data.object;
      const token = s.metadata?.resToken;
      let ids = [];
      try { ids = JSON.parse(s.metadata?.seatIds || "[]"); } catch {}
      for (const id of ids) {
        await db.ref(`events/${EVENT_ID}/seats_res/${fbKey(id)}`).transaction(cur => {
          if (cur && cur.token === token) return null;   // nur die EIGENE Reservierung lösen
          return cur === undefined ? null : cur;
        }).catch(()=>{});
      }
      console.log(`Bezahlseite verfallen (${s.id}), Plätze frei: ${ids.join(", ")}`);
    } catch (e) { console.error("Fehler beim Freigeben:", e); }
  }

  // Bezahlt: Tickets ausstellen.
  // ACHTUNG bei Zahlarten mit Verzögerung (SEPA-Lastschrift, Klarna, Sofort,
  // Überweisung): Stripe meldet "completed" schon beim Absenden, payment_status ist
  // dann noch "unpaid". Ohne diese Prüfung ginge ein gültiges, scanbares Ticket raus,
  // bevor Geld geflossen ist — und bliebe gültig, wenn die Lastschrift platzt.
  if (event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object;
    const bezahlt = s.payment_status === "paid" || s.payment_status === "no_payment_required";
    try {
      if (bezahlt) await fulfillOrder(s);
      else         await platzVormerken(s);   // Platz sperren, Ticket erst nach Zahlung
    }
    catch (e) { console.error("Fehler bei Ticket-Ausstellung:", e); return res.status(500).send("fulfill error"); }
  }

  // Verzögerte Zahlung endgültig gescheitert: Platz wieder freigeben.
  if (event.type === "checkout.session.async_payment_failed") {
    try { await zahlungGescheitert(event.data.object); }
    catch (e) { console.error("Fehler beim Freigeben nach geplatzter Zahlung:", e); }
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Alle Blöcke mit Preis, Kapazität, freien Plätzen & Ausverkauft-Status ----
app.get("/api/blocks", async (req, res) => {
  try {
    const now = Date.now();
    const soldSnap = await db.ref(`events/${EVENT_ID}/seats_sold`).get();
    const resSnap  = await db.ref(`events/${EVENT_ID}/seats_res`).get();
    const sold = soldSnap.val() || {};
    const reservations = resSnap.val() || {};

    // WICHTIG: Hier wird NICHT mehr geliefert, wie viele Plaetze frei sind.
    // Der Kaeufer soll die Auslastung nicht sehen koennen - ein halbleerer
    // Saal verkauft schlechter. Nach aussen geht nur: wie gross ist der Block,
    // was kostet er, und ist er voll. "kapazitaet" ist die feste Stuhlzahl des
    // Blocks ohne dauerhaft gesperrte Reihen und Plaetze, kein Verkaufsstand.
    const blocks = allBlocks().map(b => {
      // Preisspanne NUR ueber die Plaetze, die ueberhaupt verkauft werden.
      // Sonst wirbt ein Block mit einem Preis aus einer gesperrten Reihe:
      // E12 und E14 stuenden mit "ab 49 EUR" da, obwohl ihre 49-EUR-Reihe
      // gesperrt ist und dort nur 69-EUR-Plaetze zu haben sind.
      let voll = true;
      const stufen = new Map();          // Preis -> Anzahl Stuehle dieser Stufe
      const reihen = new Set();          // Reihen, die ueberhaupt verkauft werden
      for (const s of seatsOf(b.zone, b.name)) {
        if (isRowBlocked(b.zone, b.name, s.row)) continue;
        if (isSeatBlocked(b.zone, b.name, s.row, s.seat)) continue;
        reihen.add(s.row);
        const p = seatPrice(b.zone, b.name, s.row);
        stufen.set(p, (stufen.get(p) || 0) + 1);
        if (voll) {
          const k = fbKey(seatId(b.zone, b.name, s.row, s.seat));
          if (seatStatusFrom(reservations[k], sold[k], now) === "frei") voll = false;
        }
      }
      // "anzahl" ist die feste Stuhlzahl der Preisstufe, KEIN Verkaufsstand.
      const preise = [...stufen.entries()].sort((x, y) => y[0] - x[0])
                       .map(([preis, anzahl]) => ({ preis, anzahl }));
      // "reihen" sagt der Seite, welche Reihen im Verkauf sind. Sie graut alle
      // anderen aus - sonst leuchten die vorerst gesperrten Emporenreihen
      // mit, als waere dort alles zu haben. Das ist eine feste Angabe und
      // verraet nichts darueber, was verkauft ist.
      return { zone: b.zone, name: b.name, kapazitaet: b.capacity, preise,
               reihen: [...reihen],
               preisMin: preise.length ? preise[preise.length-1].preis : 0,
               preisMax: preise.length ? preise[0].preis : 0,
               gesperrt: b.blocked, voll: b.blocked ? true : voll };
    });

    // Kategorien: je Preisstufe nur, OB dort noch etwas frei ist. Keine Zahl -
    // wie viel noch zu haben ist, geht den Kaeufer nichts an.
    const kategorien = [];
    for (const preis of [...new Set(blocks.flatMap(b => b.preise.map(x => x.preis)))].sort((a,b)=>b-a)) {
      let frei = false;
      for (const b of allBlocks()) {
        if (frei) break;
        if (isBlocked(b.zone, b.name)) continue;
        for (const st of seatsOf(b.zone, b.name)) {
          if (seatPrice(b.zone, b.name, st.row) !== preis) continue;
          if (isRowBlocked(b.zone, b.name, st.row)) continue;
          if (isSeatBlocked(b.zone, b.name, st.row, st.seat)) continue;
          const k = fbKey(seatId(b.zone, b.name, st.row, st.seat));
          if (seatStatusFrom(reservations[k], sold[k], now) === "frei") { frei = true; break; }
        }
      }
      kategorien.push({ preis, ausverkauft: !frei });
    }

    // Die Liste der einzeln zurueckgehaltenen Plaetze geht NICHT mehr an den
    // Browser. Die Seite hatte sie ausgegraut - als graue Luecken mitten in
    // einer Reihe sahen sie aus wie eben verkaufte Plaetze.
    res.set("Cache-Control", "no-store");
    res.json({ eventId: EVENT_ID, blocks, kategorien });
  } catch (e) {
    console.error("Fehler bei /api/blocks:", e);
    res.status(500).json({ error: "Konnte Blöcke nicht laden" });
  }
});

// ---- Sitzstatus eines Blocks (frei/reserviert/verkauft je Platz) ----
/* /api/block-seats ist entfallen. Er lieferte den Status jedes einzelnen
   Platzes und haette die Auslastung des Saals preisgegeben. Plaetze werden
   seit dem Umbau ohnehin vom Server vergeben, nicht vom Browser gewaehlt. */

// ---- Belegung des GANZEN Saals in einem Aufruf ----
// Der Saalplan zeigt alle 2.038 Plätze gleichzeitig; 45 Einzelabfragen wären zu viel.
// Geliefert werden nur die Plätze, die NICHT frei sind - das hält die Antwort klein.
/* /api/belegung ist entfallen. Er lieferte die Belegung aller 2115 Plaetze
   auf einen Schlag - damit konnte jeder auslesen, wie leer der Saal ist. */

// ---- Checkout: mehrere Plätze reservieren + Stripe-Session ----
/**
 * Sucht `anzahl` freie Plaetze NEBENEINANDER in einem Block.
 * Der Kaeufer waehlt nur noch Block und Anzahl - welche Stuehle es werden,
 * entscheidet allein der Server. Damit erfaehrt der Browser nie, wie voll
 * der Saal ist, und eine Bestellung sitzt immer zusammen.
 *
 * Gefuellt wird von vorne: die erste Reihe, in der genug zusammenhaengende
 * Plaetze frei sind, und dort der fruehstmoegliche Lauf. So bleibt der Block
 * kompakt belegt statt ueber alle Reihen verstreut.
 */
// Ein Reihenschritt zaehlt bei der Verteilung wie zwei Plaetze: im Saal liegen
// die Reihen weiter auseinander als zwei Stuehle nebeneinander.
const REIHENSCHRITT = 2;

// Bis zu welchem Fuellgrad eines Bereichs wird VERTEILT statt aufgefuellt?
//
// Gemessen am ganzen Saal: Verteilen kostet keine Plaetze - der Saal wird am
// Ende genauso voll. Was leidet, ist etwas anderes: je mehr verteilt wurde,
// desto schwerer findet spaeter eine grosse Gruppe noch Plaetze am Stueck.
// Bei durchgehendem Verteilen faellt die Chance einer Sechsergruppe (Saal zu
// 70 % verkauft) von 31 % auf 10 %. Bei dieser Schwelle bleibt sie bei 24 %,
// und der leere Saal sieht trotzdem gleichmaessig besetzt aus - genau in dem
// Bereich, in dem es auffaellt. Eine Zahl, eine Wirkung: hoeher = mehr
// verteilt, niedriger = frueher aufgefuellt.
const VERTEILEN_BIS = 0.40;

async function waehleNebeneinander(zone, block, anzahl, buyerKey, preis){
  // Doppelt gesichert: ein Abendkassen-Block wird schon im Kaufweg abgewiesen,
  // hier aber noch einmal - damit die Funktion nirgends versehentlich Plaetze
  // aus einem gesperrten Block herausgibt.
  if (isBlocked(zone, block)) return null;
  const now = Date.now();
  const [soldSnap, resSnap] = await Promise.all([
    db.ref(`events/${EVENT_ID}/seats_sold`).get(),
    db.ref(`events/${EVENT_ID}/seats_res`).get(),
  ]);
  const sold = soldSnap.val() || {};
  const reservations = resSnap.val() || {};

  const rang = r => /^\d+$/.test(r) ? Number(r) : "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(r) + 1;

  // Sitzt dort schon jemand? Einzeln gesperrte Plaetze zaehlen mit: das sind
  // die umgebuchten Gaeste aus der ring°arena, die dort wirklich sitzen. Eine
  // komplett gesperrte Reihe ist dagegen eine leere Stuhlreihe - sie kommt
  // weiter unten gar nicht erst in die Betrachtung.
  const vergeben = (row, seat) => {
    if (isSeatBlocked(zone, block, row, seat)) return true;
    const k = fbKey(seatId(zone, block, row, seat));
    if (sold[k]) return true;
    const r = reservations[k];
    // Die eigene, noch laufende Reservierung darf ueberschrieben werden.
    return !!(r && r.until > now && r.buyerKey !== buyerKey);
  };

  // Nur die Reihen, die fuer diese Bestellung ueberhaupt in Frage kommen.
  // Ist eine Preisstufe gewaehlt, zaehlen nur Reihen dieser Stufe - sonst
  // bekaeme jemand, der "89 EUR" gewaehlt hat, einen Platz aus Reihe A zu
  // 149 EUR und saehe erst bei Stripe den richtigen Betrag.
  const reihen = [];
  for (const s of seatsOf(zone, block)) {
    if (isRowBlocked(zone, block, s.row)) continue;
    if (preis && seatPrice(zone, block, s.row) !== preis) continue;
    let r = reihen.find(x => x.row === s.row);
    if (!r) { r = { row: s.row, sitze: [] }; reihen.push(r); }
    r.sitze.push(s.seat);
  }
  reihen.sort((a, b) => rang(a.row) - rang(b.row));
  if (!reihen.length) return null;

  // Wie voll ist dieser Bereich, und wo sitzen die Leute?
  let plaetze = 0, besetzteAnzahl = 0;
  const besetzt = [];
  for (const r of reihen) for (const n of r.sitze) {
    plaetze++;
    if (vergeben(r.row, n)) { besetzteAnzahl++; besetzt.push({ rr: rang(r.row), n: Number(n) }); }
  }
  const verteilen = plaetze > 0 && (besetzteAnzahl / plaetze) < VERTEILEN_BIS;

  // ---- Alle Plaetze sammeln, die fuer diese Bestellung in Frage kommen ----
  // Eine Bestellung bleibt IMMER zusammen: fortlaufende Nummern in einer Reihe.
  // Wer vier Tickets kauft, sitzt zu viert nebeneinander. Verteilt wird
  // zwischen den Bestellungen, nie innerhalb einer.
  const kandidaten = [];
  for (const r of reihen) {
    const nummern = r.sitze.slice().sort((a, b) => a - b);
    const freiSet = new Set(nummern.filter(n => !vergeben(r.row, n)));
    // Wie viele freie Plaetze liegen ab "von" am Stueck in Richtung "schritt"?
    const kette = (von, schritt) => { let c = 0, n = von; while (freiSet.has(n)) { c++; n += schritt; } return c; };
    for (let i = 0; i + anzahl <= nummern.length; i++) {
      const lauf = nummern.slice(i, i + anzahl);
      // Nur echte Nachbarn: fortlaufende Nummern, keine Luecke im Hallenplan.
      let zusammen = true;
      for (let j = 1; j < lauf.length; j++) if (lauf[j] !== lauf[j-1] + 1) { zusammen = false; break; }
      if (!zusammen) continue;
      if (!lauf.every(n => freiSet.has(n))) continue;
      const linksRest  = kette(lauf[0] - 1, -1);
      const rechtsRest = kette(lauf[lauf.length - 1] + 1, +1);
      kandidaten.push({
        row: r.row, rr: rang(r.row), lauf, linksRest, rechtsRest,
        rest: linksRest + rechtsRest,
        buendig: (linksRest === 0 || rechtsRest === 0),
        mitte: (lauf[0] + lauf[lauf.length - 1]) / 2,
        reiheMitte: (nummern[0] + nummern[nummern.length - 1]) / 2
      });
    }
  }
  if (!kandidaten.length) return null;

  let beste = null;

  if (verteilen) {
    // ---- Noch viel frei: VERTEILEN ------------------------------------
    // Frueher nahm diese Funktion einfach den ersten freien Platz von vorne
    // links; dadurch klumpte sich der ganze Verkauf in einer Ecke zusammen,
    // waehrend der Rest leer blieb. Jetzt wird der Platz gewaehlt, der von
    // allen schon besetzten am weitesten weg liegt.
    // Einen einzelnen freien Platz daneben lassen wir dabei nicht stehen -
    // den bestellt praktisch niemand mehr.
    const ohneEinzelluecke = kandidaten.filter(k => k.linksRest !== 1 && k.rechtsRest !== 1);
    const menge = ohneEinzelluecke.length ? ohneEinzelluecke : kandidaten;
    const abstand = k => {
      let min = Infinity;
      for (const b of besetzt) {
        let d = Infinity;
        for (const n of k.lauf) {
          const dd = Math.abs(b.rr - k.rr) * REIHENSCHRITT + Math.abs(b.n - n);
          if (dd < d) d = dd;
        }
        if (d < min) min = d;
      }
      return min;
    };
    // Ist der Bereich noch ganz leer, ist jeder Abstand unendlich - dann
    // entscheiden die Nebenkriterien, und der erste Kaeufer bekommt den Platz
    // vorne in der Mitte.
    let besterAbstand = -1;
    for (const k of menge) {
      const a = abstand(k);
      if (beste === null || a > besterAbstand) { beste = k; besterAbstand = a; continue; }
      if (a < besterAbstand) continue;
      if (k.rr !== beste.rr) { if (k.rr < beste.rr) beste = k; continue; }
      if (Math.abs(k.mitte - k.reiheMitte) < Math.abs(beste.mitte - beste.reiheMitte)) beste = k;
    }
  } else {
    // ---- Es wird eng: AUFFUELLEN --------------------------------------
    // Ab hier zaehlt nicht mehr das Bild, sondern dass noch moeglichst viele
    // Gruppen zusammen sitzen koennen. Deshalb in die Luecke, die am besten
    // passt, und dort buendig an den Rand - so bleibt der Rest am Stueck.
    const buendige = kandidaten.filter(k => k.buendig);
    const menge = buendige.length ? buendige : kandidaten;
    for (const k of menge) {
      if (beste === null) { beste = k; continue; }
      if (k.rest !== beste.rest) { if (k.rest < beste.rest) beste = k; continue; }
      if (k.rr !== beste.rr) { if (k.rr < beste.rr) beste = k; continue; }
      if (k.lauf[0] < beste.lauf[0]) beste = k;
    }
  }

  return beste.lauf.map(n => ({
    id: seatId(zone, block, beste.row, n),
    zone, block, row: beste.row,
    seat: String(n).padStart(2, "0"),
    price: seatPrice(zone, block, beste.row)
  }));
}

/* ---- Verkaufsuebersicht, NUR fuer den Veranstalter ----------------------
   Liefert den Stand jedes einzelnen Platzes. Das ist genau die Auskunft, die
   die Kaufseite absichtlich nicht mehr bekommt - deshalb haengt sie an einem
   Schluessel, der nur in den Servereinstellungen steht. Ohne ADMIN_KEY
   existiert die Route nicht. */
function schluesselStimmt(gegeben){
  if (!ADMIN_KEY || typeof gegeben !== "string") return false;
  const a = Buffer.from(gegeben), b = Buffer.from(ADMIN_KEY);
  // Gleiche Laenge erzwingen, sonst wirft timingSafeEqual - und die Laenge
  // allein soll auch nichts verraten.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.get("/api/admin/belegung", async (req, res) => {
  if (!ADMIN_KEY) return res.status(404).json({ error: "Übersicht ist nicht eingerichtet" });
  if (!schluesselStimmt(req.query.key)) return res.status(403).json({ error: "Falscher Schlüssel" });
  try {
    const now = Date.now();
    const [soldSnap, resSnap] = await Promise.all([
      db.ref(`events/${EVENT_ID}/seats_sold`).get(),
      db.ref(`events/${EVENT_ID}/seats_res`).get(),
    ]);
    const sold = soldSnap.val() || {};
    const reservations = resSnap.val() || {};

    const belegung = {};
    const bloecke = [];
    let verkauft = 0, reserviert = 0, gesperrt = 0, frei = 0, umsatz = 0, offenerWert = 0;

    for (const b of allBlocks()) {
      let bVerkauft = 0, bRes = 0, bGesperrt = 0, bFrei = 0;
      const blockZu = isBlocked(b.zone, b.name);
      for (const s of seatsOf(b.zone, b.name)) {
        const id = seatId(b.zone, b.name, s.row, s.seat);
        const preis = seatPrice(b.zone, b.name, s.row);
        if (blockZu || isRowBlocked(b.zone, b.name, s.row)
            || isSeatBlocked(b.zone, b.name, s.row, s.seat)) {
          belegung[id] = "gesperrt"; gesperrt++; bGesperrt++; continue;
        }
        const k = fbKey(id);
        const st = seatStatusFrom(reservations[k], sold[k], now);
        if (st === "verkauft"){ belegung[id] = "verkauft"; verkauft++; bVerkauft++; umsatz += preis; }
        else if (st === "reserviert"){ belegung[id] = "reserviert"; reserviert++; bRes++; }
        else { frei++; bFrei++; offenerWert += preis; }
      }
      bloecke.push({ zone: b.zone, name: b.name, verkauft: bVerkauft,
                     reserviert: bRes, gesperrt: bGesperrt, frei: bFrei });
    }
    res.set("Cache-Control", "no-store");
    res.json({ belegung, bloecke, stand: now,
               summe: { verkauft, reserviert, gesperrt, frei, umsatz, offenerWert } });
  } catch (e) {
    console.error("Fehler bei /api/admin/belegung:", e);
    res.status(500).json({ error: "Konnte die Übersicht nicht laden" });
  }
});

// ---- Checkout: Block + Anzahl waehlen, der Server sucht die Plaetze ----
app.post("/api/checkout", async (req, res) => {
  try {
    const { zone, block, email } = req.body || {};
    const anzahl = Number(req.body?.anzahl);
    const preis  = Number(req.body?.preis);
    if (!Number.isInteger(anzahl) || anzahl < 1) return res.status(400).json({ error: "Keine Anzahl angegeben" });
    if (anzahl > 10) return res.status(400).json({ error: "Maximal 10 Plätze pro Bestellung" });
    if (!zone || !block) return res.status(400).json({ error: "Kein Block gewählt" });
    if (!seatsOf(zone, block).length) return res.status(400).json({ error: "Unbekannter Block" });
    if (isBlocked(zone, block)) return res.status(403).json({ error: "Dieser Block ist nicht online buchbar" });

    // Gewaehlt werden Block UND Kategorie. Welche Stuehle es genau werden,
    // entscheidet weiterhin der Server. Die Kategorie muss es in diesem Block
    // geben, sonst koennte ein praeparierter Aufruf einen 149-EUR-Platz zu
    // 49 EUR bestellen.
    const stufen = new Set();
    for (const s of seatsOf(zone, block)) {
      if (isRowBlocked(zone, block, s.row)) continue;
      if (isSeatBlocked(zone, block, s.row, s.seat)) continue;
      stufen.add(seatPrice(zone, block, s.row));
    }
    if (!stufen.size) return res.status(409).json({ error: "Dieser Block ist gerade nicht buchbar.", grund: "kein_platz" });
    if (!stufen.has(preis)) return res.status(400).json({ error: "Diese Kategorie gibt es in diesem Block nicht" });

    const buyerKey = (typeof req.body?.buyerKey === "string" && /^[a-f0-9]{8,64}$/.test(req.body.buyerKey))
      ? req.body.buyerKey
      : crypto.randomBytes(16).toString("hex");
    const resToken = crypto.randomBytes(8).toString("hex");

    // ANTI-SABOTAGE: vorher ALLE frueheren Reservierungen dieses Browsers loesen.
    try {
      const allResSnap = await db.ref(`events/${EVENT_ID}/seats_res`).get();
      const allRes = allResSnap.val() || {};
      const freigeben = {};
      for (const [k, r] of Object.entries(allRes)) if (r && r.buyerKey === buyerKey) freigeben[k] = null;
      if (Object.keys(freigeben).length) await db.ref(`events/${EVENT_ID}/seats_res`).update(freigeben);
    } catch (e) { /* die Ablaufzeit raeumt ohnehin auf */ }

    // Suchen und reservieren. Schnappt jemand dazwischen einen Platz weg,
    // wird einfach neu gesucht - der Kaeufer merkt davon nichts.
    let seatInfos = null, reserved = [];
    for (let versuch = 1; versuch <= 3 && !seatInfos; versuch++) {
      const wahl = await waehleNebeneinander(zone, block, anzahl, buyerKey, preis);
      if (!wahl) {
        return res.status(409).json({
          error: anzahl === 1
            ? "In dieser Kategorie ist gerade kein Platz mehr frei."
            : `In dieser Kategorie sind gerade keine ${anzahl} Plätze nebeneinander frei.`,
          grund: "kein_platz"
        });
      }
      const now = Date.now();
      reserved = [];
      let ok = true;
      for (const info of wahl) {
        const k = fbKey(info.id);
        const soldSnap = await db.ref(`events/${EVENT_ID}/seats_sold/${k}`).get();
        if (soldSnap.exists()) { ok = false; break; }
        const tx = await db.ref(`events/${EVENT_ID}/seats_res/${k}`).transaction(cur => {
          if (cur && cur.until > now && cur.buyerKey !== buyerKey) return;
          return { token: resToken, buyerKey, until: now + RESERVATION_MS };
        });
        if (!tx.committed) { ok = false; break; }
        reserved.push(k);
      }
      if (ok) seatInfos = wahl;
      else await rollbackReservations(reserved);
    }
    if (!seatInfos) {
      return res.status(409).json({
        error: "Die Plätze waren gerade schneller weg. Bitte noch einmal versuchen.",
        grund: "vergeben"
      });
    }

    const seatIds = seatInfos.map(s => s.id);
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: seatInfos.map(s => ({
          price_data: {
            currency: "eur",
            product_data: { name: `${s.zone} ${s.block} · Reihe ${reiheAnzeige(s.row, s.zone)} · Platz ${parseInt(s.seat,10)}` },
            unit_amount: s.price
          },
          quantity: 1
        })),
        customer_email: email || undefined,
        allow_promotion_codes: true,
        metadata: { eventId: EVENT_ID, resToken, seatIds: JSON.stringify(seatIds) },
        success_url: `${PUBLIC_URL}/success.html?sid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${PUBLIC_URL}/?abgebrochen=1`,
        expires_at: Math.floor((Date.now() + CHECKOUT_MS)/1000)
      });
    } catch (e) {
      await rollbackReservations(reserved);
      throw e;
    }
    res.json({ url: session.url, plaetze: seatInfos.map(s => ({ row: s.row, seat: parseInt(s.seat,10) })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Checkout fehlgeschlagen" });
  }
});

/**
 * Zahlung ist unterwegs, aber noch nicht da (Lastschrift, Klarna, Überweisung).
 * Der Platz wird gesperrt, damit ihn niemand anders kauft — ein Ticket gibt es erst,
 * wenn Stripe die Zahlung bestätigt (checkout.session.async_payment_succeeded).
 */
async function platzVormerken(session){
  let seatIds = [];
  try { seatIds = JSON.parse(session.metadata?.seatIds || "[]"); } catch {}
  for (const id of seatIds) {
    const tx = await db.ref(`events/${EVENT_ID}/seats_sold/${fbKey(id)}`).transaction(cur => {
      if (cur === true) return;
      if (cur && cur.session && cur.session !== session.id) return;
      return { session: session.id, at: Date.now(), zahlungOffen: true };
    });
    if (!tx.committed) console.error(`Platz ${id} konnte nicht vorgemerkt werden (gehört jemand anderem).`);
  }
  console.log(`Zahlung unterwegs (${session.id}) — vorgemerkt, noch kein Ticket: ${seatIds.join(", ")}`);
}

/** Verzögerte Zahlung geplatzt: Sperre aufheben, aber nur die eigene. */
async function zahlungGescheitert(session){
  let seatIds = [];
  try { seatIds = JSON.parse(session.metadata?.seatIds || "[]"); } catch {}
  for (const id of seatIds) {
    const k = fbKey(id);
    await db.ref(`events/${EVENT_ID}/seats_sold/${k}`).transaction(cur => {
      if (cur && cur.session === session.id) return null;
      return cur === undefined ? null : cur;
    }).catch(()=>{});
    await db.ref(`events/${EVENT_ID}/seats_res/${k}`).remove().catch(()=>{});
  }
  console.error(`ZAHLUNG GEPLATZT (${session.id}) — Plätze wieder frei: ${seatIds.join(", ")}`);
}

async function rollbackReservations(keys){
  for (const k of keys) {
    await db.ref(`events/${EVENT_ID}/seats_res/${k}`).remove().catch(()=>{});
  }
}

// ---- Ticket als PDF erzeugen ----
// Ticket-Foto direkt eingebettet (keine externe Datei nötig)

const GRUEN = "#5ECB24";
const DUNKEL = "#0d100e";

/* Auf dem TICKET steht beides: die Zahl und der Buchstabe, z.B. "4 / D".
   Damit findet der Gast seine Reihe, egal ob im Saal Zahlen oder Buchstaben
   ausgeschildert sind. Wo Zahl und Rohwert gleich sind - Empore, alte Zonen -
   steht nur ein Wert. */
function reiheAufTicket(row, zone){
  // Auf dem Ticket steht nur noch die ZAHL. Die Doppelangabe "4 / D" hat
  // Gaeste verwirrt; im Saal wird durchgezaehlt. In den Daten, im QR-Code
  // und in der Signatur bleibt der Buchstabe unveraendert stehen.
  return reiheAnzeige(row, zone);
}

function platzText(t){
  if (t.zone === "Rollstuhl") return `${t.block} · Platz ${parseInt(t.seat,10)}`;
  return `Reihe ${reiheAnzeige(t.row, t.zone)} · Platz ${parseInt(t.seat,10)}`;
}
function blockText(t){
  if (t.zone === "Rollstuhl") return "Rollstuhlplatz";
  // Saal Maritim
  if (t.zone === "Innenraum") return `Block ${t.block}`;
  if (t.zone === "Empore")    return t.block === "VR" ? "Empore vorne" : `Empore ${t.block}`;
  // ring°arena - fuer die bereits verkauften Tickets, die in Firebase liegen
  return `${t.zone === "Rang" ? "Block" : "Parkett"} ${t.block}`;
}

// Erzeugt ein PDF mit allen Tickets (ein Ticket pro Seite) und liefert es als Buffer
async function buildTicketsPdf(tickets){
  // Legt je Ticket eine Seite an. Die Gestaltung steckt vollstaendig in
  // ticket-design.js; hier werden nur die echten Ticketdaten und der frisch
  // erzeugte QR-Code uebergeben. Codeinhalt und Signatur bleiben unangetastet.
  const doc = new PDFDocument({ size: [SEITE_B, SEITE_H], margin: 0, autoFirstPage: false });
  const chunks = [];
  doc.on("data", c => chunks.push(c));
  const fertig = new Promise((ok, fehler) => {
    doc.on("end", () => ok(Buffer.concat(chunks)));
    doc.on("error", fehler);
  });
  schriftenLaden(doc);

  for (const t of tickets) {
    const qrPng = await QRCode.toBuffer(t.qrData, {
      margin: 4,                    // vorgeschriebene Ruhezone: 4 Module
      width: 900,
      errorCorrectionLevel: "M"
    });
    doc.addPage({ size: [SEITE_B, SEITE_H], margin: 0 });
    zeichneTicket(doc, {
      edition:       "",          // Logo ohne Ziffer
      area:          t.zone === "Innenraum" ? "Unten" : t.zone === "Empore" ? "Oben" : t.zone,
      dateLabel:     TERMIN.kurz,
      doorsLabel:    TERMIN.einlass,
      categoryLabel: blockText(t).toUpperCase(),
      blockLabel:    blockText(t),
      row:           t.zone === "Rollstuhl" ? "—" : reiheAufTicket(t.row, t.zone),
      seat:          String(t.seat),          // fuehrende Null bleibt erhalten
      room:          "Saal Maritim",
      serial:        t.id,
      barcodeText:   t.id,                    // im Strichcode steht die Ticketnummer
      codeCaption:   t.qrData,                // lesbare Referenzzeile wie in der Vorlage
      qrPng
    });
  }
  doc.end();
  return fertig;
}

// ---- E-Mail-Versand (IONOS SMTP) ----
// Wird nur aktiv, wenn SMTP_USER und SMTP_PASS gesetzt sind.
let mailer = null;
if (SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,   // 465 = SSL, 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log(`E-Mail-Versand aktiv über ${SMTP_HOST}:${SMTP_PORT} als ${SMTP_USER}`);
} else {
  console.warn("E-Mail-Versand INAKTIV: SMTP_USER / SMTP_PASS nicht gesetzt.");
}

function ticketRowsHtml(tickets){
  return tickets.map(t => {
    const platz = t.zone === "Rollstuhl"
      ? `${t.block} · Platz ${parseInt(t.seat,10)}`
      : `${t.zone} ${t.block} · Reihe ${reiheAnzeige(t.row, t.zone)} · Platz ${parseInt(t.seat,10)}`;
    const zusatz = t.label ? ` (${t.label})` : "";
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #23292a;color:#dfe6df">${platz}${zusatz}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #23292a;color:#8fa08c;font-family:monospace;font-size:12px">${t.id}</td>
    </tr>`;
  }).join("");
}

async function sendTicketMail(email, tickets, sessionId){
  if (!mailer) { console.warn("Keine Mail verschickt (Versand inaktiv)."); return; }
  if (!email)  { console.warn("Keine Mail verschickt (keine E-Mail-Adresse)."); return; }

  const link = `${PUBLIC_URL}/success.html?session_id=${encodeURIComponent(sessionId)}`;
  const anzahl = tickets.length;
  const betreff = `Dein${anzahl>1?"e":""} Ticket${anzahl>1?"s":""} für Bellum Challenger`;

  // PDF mit allen Tickets erzeugen
  let pdfBuffer = null;
  try {
    pdfBuffer = await buildTicketsPdf(tickets);
    console.log(`Ticket-PDF erzeugt (${Math.round(pdfBuffer.length/1024)} KB, ${anzahl} Seite${anzahl>1?"n":""})`);
  } catch (err) {
    console.error("Ticket-PDF konnte nicht erzeugt werden:", err.message);
  }

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#060706;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:28px 20px">
    <h1 style="color:#fff;font-size:26px;margin:0 0 6px">Bellum Challenger</h1>
    <p style="color:#5ECB24;font-weight:bold;letter-spacing:.06em;margin:0 0 22px">
      ${TERMIN.datum.toUpperCase()} · ${TERMIN.tag.toUpperCase()} · ${TERMIN.ort.toUpperCase()} · EINLASS ${TERMIN.einlass.toUpperCase()}
    </p>

    <p style="color:#dfe6df;font-size:15px;line-height:1.6;margin:0 0 18px">
      vielen Dank für deinen Kauf! Dein${anzahl>1?"e":""} Ticket${anzahl>1?"s":""} ${anzahl>1?"sind":"ist"} bereit.
    </p>

    <table style="width:100%;border-collapse:collapse;background:#0e100f;border:1px solid #23292a;border-radius:10px;overflow:hidden;margin:0 0 22px">
      <tr>
        <th style="text-align:left;padding:10px 14px;background:#141816;color:#8fa08c;font-size:12px;letter-spacing:.08em">PLATZ</th>
        <th style="text-align:left;padding:10px 14px;background:#141816;color:#8fa08c;font-size:12px;letter-spacing:.08em">TICKET-NR.</th>
      </tr>
      ${ticketRowsHtml(tickets)}
    </table>

    <p style="color:#dfe6df;font-size:15px;line-height:1.6;margin:0 0 8px">
      <b style="color:#5ECB24">Dein${anzahl>1?"e":""} Ticket${anzahl>1?"s":""} ${anzahl>1?"sind":"ist"} als PDF im Anhang dieser E-Mail.</b>
    </p>
    <p style="color:#dfe6df;font-size:14px;line-height:1.6;margin:0 0 8px">
      Öffne das PDF und zeige den QR-Code am Einlass — auf dem Handy oder ausgedruckt.
    </p>
    <p style="color:#8fa08c;font-size:13px;line-height:1.6;margin:0 0 22px">
      Bewahre diese E-Mail auf. Jeder QR-Code erlaubt genau einen Eintritt.
    </p>

    <p style="color:#5a635b;font-size:12px;line-height:1.6;border-top:1px solid #23292a;padding-top:16px;margin:0">
      Bellum Fighting Championship · info@bellumfc.com
    </p>
  </div></body></html>`;

  const text = [
    `Bellum Challenger`,
    `${TERMIN.datum} · ${TERMIN.tag} · ${TERMIN.ort} · Einlass ${TERMIN.einlass}`,
    ``,
    `vielen Dank für deinen Kauf! Dein${anzahl>1?"e":""} Ticket${anzahl>1?"s":""}:`,
    ...tickets.map(t => {
      const platz = t.zone === "Rollstuhl"
        ? `${t.block} · Platz ${parseInt(t.seat,10)}`
        : `${t.zone} ${t.block} · Reihe ${reiheAnzeige(t.row, t.zone)} · Platz ${parseInt(t.seat,10)}`;
      return `  - ${platz}${t.label?` (${t.label})`:""} — Nr. ${t.id}`;
    }),
    ``,
    `Dein${anzahl>1?"e":""} Ticket${anzahl>1?"s":""} ${anzahl>1?"sind":"ist"} als PDF im Anhang dieser E-Mail.`,
    `Zeige den QR-Code am Einlass — auf dem Handy oder ausgedruckt.`,
    ``,
    `Bewahre diese E-Mail auf. Jeder QR-Code erlaubt genau einen Eintritt.`,
    ``,
    `Bellum Fighting Championship · info@bellumfc.com`
  ].join("\n");

  const mailOptions = { from: MAIL_FROM, to: email, subject: betreff, text, html };
  if (pdfBuffer) {
    mailOptions.attachments = [{
      filename: anzahl > 1 ? `Bellum-Challenger-Tickets.pdf` : `Bellum-Challenger-Ticket-${tickets[0].id}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf"
    }];
  }

  try {
    await mailer.sendMail(mailOptions);
    console.log(`Ticket-Mail verschickt an ${email} (${anzahl} Ticket${anzahl>1?"s":""}${pdfBuffer?" + PDF":" OHNE PDF"})`);
  } catch (err) {
    // Mail-Fehler darf die Ticket-Ausstellung NICHT scheitern lassen
    console.error("Ticket-Mail konnte nicht verschickt werden:", err.message);
  }
}

// ---- Ticket-Ausstellung nach bestätigter Zahlung ----
async function fulfillOrder(session){
  const resToken = session.metadata?.resToken;
  let seatIds = [];
  try { seatIds = JSON.parse(session.metadata?.seatIds || "[]"); } catch {}
  if (!seatIds.length) { console.error("Keine Sitz-IDs in Metadaten"); return; }

  // Idempotenz: pro Stripe-Session nur einmal ausstellen
  const issuedRef = db.ref(`events/${EVENT_ID}/issued/${session.id}`);
  if ((await issuedRef.get()).exists()) return;

  const email = session.customer_details?.email || session.customer_email || "";
  const createdTickets = [];
  const fehlendePlaetze = [];   // bezahlt, aber kein Ticket -> Erstattung nötig

  // Hilfsfunktion: ein einzelnes Ticket erzeugen und speichern
  async function makeTicket(zone, block, row, seat, label){
    // Kürzel am Anfang der Ticketnummer. Saal Maritim kennt zwei Zonen;
    // die alten Kürzel (R/P/RS) bleiben stehen, damit Tickets aus der
    // ring°arena weiterhin lesbar sind.
    const zabbr = zone === "Innenraum" ? "I"
                : zone === "Empore"    ? "E"
                : zone === "Rang"      ? "R"
                : zone === "Parkett"   ? "P" : "RS";
    const nabbr = String(block).replace(/[^A-Za-z0-9]/g,"").toUpperCase().slice(0,3);
    // seatField kodiert Reihe+Sitz. Bei Begleitperson ein "B" anhängen,
    // damit das Ticket eine EIGENE Signatur hat und separat gescannt werden kann.
    const seatField = label === "Begleitperson" ? `${row}#${seat}B` : `${row}#${seat}`;
    // Ticketnummer wird aus Bestellung + Platz ABGELEITET, nicht gewürfelt: Stripe
    // stellt einen Webhook erneut zu, wenn die Antwort ausbleibt. Mit einer Zufallszahl
    // legte jeder Durchlauf ein NEUES Ticket für denselben Stuhl an — ein Kunde hätte
    // zwei gültige QR-Codes. Abgeleitet überschreibt der zweite Lauf denselben Eintrag.
    // Die Fälschungssicherheit hängt an der Signatur, nicht an der Zufälligkeit.
    // 12 statt 6 Stellen: die alte Zufallszahl kollidierte bei 2.000 Tickets mit rund 12 %.
    const ticketNum = crypto.createHmac("sha256", TICKET_SECRET)
      .update(`TICKETID|${session.id}|${zone}|${block}|${seatField}`)
      .digest("hex").slice(0,12).toUpperCase();
    const ticketId = `${zabbr}${nabbr}-${ticketNum}`;
    const core = `${ticketId}|${zone}|${block}|${seatField}`;
    const sig = b64url(crypto.createHmac("sha256", TICKET_SECRET).update(core).digest()).slice(0,12);
    const qrData = `${core}|${sig}`;

    const ticket = {
      id: ticketId, zone, block, row, seat, seatField, qrData,
      label: label || "",
      email, stripeSession: session.id, createdAt: Date.now(), status: "gültig"
    };
    await db.ref(`events/${EVENT_ID}/tickets/${ticketId}`).set(ticket);
    createdTickets.push(ticket);
    console.log(`Ticket ausgestellt: ${ticketId} (${zone} ${block} Platz ${seat}${label?" — "+label:""})`);
  }

  for (const id of seatIds) {
    const [zone, block, row, seat] = id.split("|");
    const k = fbKey(id);

    // Verkauf nur eintragen, wenn der Platz nicht bereits einer ANDEREN Bestellung
    // gehört. Letzte Sicherung gegen zwei gültige Tickets für denselben Stuhl.
    // Altbestand steht als `true` da; alle lesenden Stellen prüfen nur "vorhanden".
    const soldTx = await db.ref(`events/${EVENT_ID}/seats_sold/${k}`).transaction(cur => {
      if (cur === true) return;                                      // Altbestand, Besitzer unbekannt
      if (cur && cur.session && cur.session !== session.id) return;  // gehört einer anderen Bestellung
      return { session: session.id, at: Date.now() };
    });
    if (!soldTx.committed) {
      // Gehört der Platz vielleicht DIESER Bestellung und der Webhook kommt nur erneut?
      // Sonst bekäme ausgerechnet der rechtmäßige Käufer kein Ticket.
      let gehoertUns = false;
      try {
        const eigene = await db.ref(`events/${EVENT_ID}/tickets`)
          .orderByChild("stripeSession").equalTo(session.id).get();
        eigene.forEach(snap => {
          const tk = snap.val();
          if (tk && tk.zone === zone && tk.block === block &&
              tk.row === row && String(tk.seat) === String(seat)) gehoertUns = true;
        });
      } catch (e) { console.error("Konnte eigene Tickets nicht prüfen:", e); }
      if (gehoertUns) { console.log(`Erneute Zustellung für ${id} — Ticket besteht bereits.`); continue; }
      const owner = (await db.ref(`events/${EVENT_ID}/seats_sold/${k}`).get()).val();
      console.error(`KONFLIKT: ${id} ist bereits verkauft` +
        (owner && owner.session ? ` (Bestellung ${owner.session})` : "") +
        `. Bestellung ${session.id} hat bezahlt und bekommt für diesen Platz KEIN Ticket — bitte erstatten.`);
      await db.ref(`events/${EVENT_ID}/konflikte/${session.id}_${k}`).set({
        seatId: id, zahlendeBestellung: session.id,
        gehoertZu: (owner && owner.session) || "unbekannt",
        email, at: Date.now(), erledigt: false
      });
      fehlendePlaetze.push(id);
      continue;
    }
    await db.ref(`events/${EVENT_ID}/seats_res/${k}`).remove().catch(()=>{});

    if (zone === "Rollstuhl") {
      // Rollstuhlplatz: ZWEI Tickets — Rollstuhlfahrer + Begleitperson
      await makeTicket(zone, block, row, seat, "Rollstuhlplatz");
      await makeTicket(zone, block, row, seat, "Begleitperson");
    } else {
      await makeTicket(zone, block, row, seat, "");
    }
  }

  // Fehlende Plätze mitschreiben, damit Erfolgsseite und Abrechnung nicht so tun,
  // als wäre alles erledigt.
  await issuedRef.set({ tickets: createdTickets.map(t=>t.id), at: Date.now(),
                        fehlend: fehlendePlaetze.length ? fehlendePlaetze : null });

  if (fehlendePlaetze.length) {
    console.error(`ACHTUNG Bestellung ${session.id} (${email}): ${fehlendePlaetze.length} ` +
      `bezahlte(r) Platz/Plätze ohne Ticket — ${fehlendePlaetze.join(", ")}. Bitte erstatten.`);
  }
  // Ticket-Mail nur, wenn es überhaupt etwas zu schicken gibt. Eine Mail mit null
  // Tickets sähe für den Käufer wie eine normale Bestätigung aus.
  if (createdTickets.length) await sendTicketMail(email, createdTickets, session.id);
  else if (fehlendePlaetze.length)
    console.error(`KEINE Mail: Bestellung ${session.id} hat bezahlt und KEIN Ticket bekommen — bitte erstatten.`);
  else
    console.log(`Nichts zu tun für ${session.id} — die Tickets bestehen bereits (erneute Zustellung).`);
}

// ---- Ticket-Abruf für Erfolgsseite ----
app.get("/api/tickets-by-session", async (req, res) => {
  const sid = req.query.sid;
  if (!sid) return res.status(400).json({ error: "sid fehlt" });
  // Diese Kennung wandert ungefiltert in einen Datenbankpfad. Firebase verbietet
  // dort ".", "#", "$", "[" und "]" und wirft bei einem solchen Zeichen einen
  // Fehler - aus einem async-Handler heraus beendete das den ganzen Server.
  // Eine einzige Adresszeile im Browser legte damit den Verkauf lahm.
  // Eine echte Stripe-Sitzungskennung besteht nur aus Buchstaben, Zahlen und "_".
  if (typeof sid !== "string" || !/^[A-Za-z0-9_]{1,250}$/.test(sid)) {
    return res.status(400).json({ error: "sid ungültig" });
  }
  for (let i = 0; i < 12; i++) {
    const marker = await db.ref(`events/${EVENT_ID}/issued/${sid}`).get();
    if (marker.exists()) {
      const ids = marker.val().tickets || [];
      const tickets = [];
      for (const id of ids) {
        const t = await db.ref(`events/${EVENT_ID}/tickets/${id}`).get();
        if (t.exists()) tickets.push(t.val());
      }
      return res.json({ ready: true, tickets });
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  res.json({ ready: false });
});

// ---------------------------------------------------------------------------
//  Letztes Sicherheitsnetz.
//
//  Express faengt Fehler aus async-Handlern nicht ab. Node beendet den Prozess
//  bei einer unbehandelten Zurueckweisung - eine einzelne fehlerhafte Anfrage
//  hat so den gesamten Verkaufsserver gestoppt. Hier wird sie protokolliert,
//  der Verkauf laeuft weiter. Die betroffene Anfrage bleibt ohne Antwort; der
//  Kunde kann sie einfach wiederholen.
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (err) => {
  console.error("Unbehandelter Fehler (Server laeuft weiter):", err && err.stack || err);
});

app.listen(PORT, () => {
  console.log(`Ticket-Verkaufsserver (feste Platzwahl) läuft auf Port ${PORT}`);
  console.log(`Öffentliche URL: ${PUBLIC_URL}`);
});
