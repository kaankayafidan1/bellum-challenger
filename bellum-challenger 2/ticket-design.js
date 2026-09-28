// ============================================================================
//  Gestaltung der BFC-6-Eintrittskarte.
//
//  Portiert aus ticket.css des Designpakets in die Zeichen-API von PDFKit -
//  gleiche Arbeitsflaeche (1776 x 888), gleiche Koordinaten, gleiche Assets.
//  Hier steht NUR die Gestaltung. Die Ticketdaten und die Codegrafiken
//  kommen von aussen herein und werden nirgends erzeugt oder veraendert.
// ============================================================================
import { SAAL_JPG, LOGO_WEISS_PNG, LOGO_SCHWARZ_PNG,
         SANS_BOLD, SANS_REGULAR, SANS_BOLD_KURSIV,
         MONO_BOLD, MONO_REGULAR } from "./ticket-assets.js";
import { code128b } from "./code128.js";

// Arbeitsflaeche des Entwurfs
export const FLAECHE_B = 1776, FLAECHE_H = 888;
// Ausgabeformat 250 x 125 mm quer (so steht es in der @page-Regel des Pakets)
export const SEITE_B = 250 / 25.4 * 72, SEITE_H = 125 / 25.4 * 72;
const S = SEITE_B / FLAECHE_B;

const GRUEN = "#A3FF00", WEISS = "#FFFFFF", DUNKEL = "#0B0D0C";
const PAPIER = "#FAFAF8", GRUEN_DUNKEL = "#497A00", AUSSEN = "#101211";
// Innenkante der Karte: .bfc-shell liegt 10/6 vom Rand, dazu 2 px Kontur
const OX = 12, OY = 8;                 // Nullpunkt der Inhalte
const HAUPT_B = 1240;                  // Breite der Hauptkarte
const LOGO_V = 460 / 1484;             // Hoehe/Breite des Originallogos

/** Bilder einmal einbetten und auf allen Seiten wiederverwenden.
 *  Vorher steckte das Saalfoto in jeder Seite erneut: 10 Tickets ergaben
 *  3,3 MB PDF und eine 4,5 MB grosse Mail. Optisch aendert sich nichts. */
function bild(doc, daten, schluessel){
  doc.__bfcBilder = doc.__bfcBilder || {};
  if(!doc.__bfcBilder[schluessel]) doc.__bfcBilder[schluessel] = doc.openImage(daten);
  return doc.__bfcBilder[schluessel];
}

/* ---------------------------------------------------------------------------
   Die Ziffer neben dem Logo.

   Die mitgelieferte Schrift setzt eine runde, schmale 6, die nicht zum kantigen
   BFC-Logo passt. Die Ziffer wird deshalb als Vektorform gezeichnet. Ihre Umrisse
   sind am freigegebenen Bildentwurf ausgemessen (dort 176 x 126 px) und zu
   geraden Kanten vereinfacht - eckige Aussenkontur, eckiger Innenraum, dieselbe
   Neigung und Strichstaerke wie die Buchstaben.

   Am Logo gemessen:
     Neigung       23,4°  (dx/dy = 0,4334)
     Koerperhoehe  360 von 460 Bildhoehe; darunter nur die F-Spitze,
                   die ausdruecklich NICHT die Grundlinie ist.
--------------------------------------------------------------------------- */
const LOGO_KOERPER = 360 / 460;        // Anteil der Buchstabenhoehe am Logobild
const SECHS_VERH   = 176 / 126;        // Breite zu Hoehe der Ziffer

// Am Bildentwurf zeilenweise ausgemessen und zu geraden Kanten vereinfacht.
// Balken oben, schraeger Steg, Kasten unten - ihre Vereinigung ergibt die 6,
// der Zwischenraum rechts die Einkerbung. Alles auf 0..1 bezogen.
const SECHS_BALKEN = [[0.290,0.045],[0.995,0.045],[0.909,0.336],[0.472,0.336]];
const SECHS_STEG   = [[0.290,0.045],[0.520,0.290],[0.443,0.462],[0.148,0.462]];
const SECHS_KASTEN = [[0.148,0.456],[0.830,0.456],[0.864,0.544],[0.795,0.792],
                      [0.756,0.920],[0.693,1.000],[0.028,1.000],[0.000,0.920],[0.085,0.664]];
const SECHS_INNEN  = [[0.374,0.636],[0.566,0.636],[0.520,0.784],[0.326,0.784]];
// Die Ziffer beginnt in ihrem eigenen Kasten erst bei 0,045 und endet bei
// 1,000. Wird der KASTEN an den Buchstaben ausgerichtet, sitzt die Ziffer oben
// 4,5 % zu tief und bildet neben der flachen Oberkante des C eine Stufe.
// Darum wird der Kasten entsprechend groesser gezeichnet und nach oben
// gesetzt - dann liegen Oberkante UND Grundlinie auf den Buchstaben.
const SECHS_OBEN = 0.045;
// Waagerecht wird an der oberen linken Ecke der Ziffer angeschlagen; die
// liegt bei 0,290 ihrer Breite.
const SECHS_ANSCHLAG = 0.290;

/** Zeichnet die Ziffer 6 so, dass sie GENAU die Buchstabenhoehe h ausfuellt:
 *  x ist der Anschlag fuer ihre obere linke Ecke (rechte Logokante + Abstand),
 *  y die Oberkante der Buchstaben. Der Innenraum wird gegenlaeufig umlaufen
 *  und bleibt dadurch ausgespart. */
function zeichneSechs(doc, x, y, h, farbe){
  const H = h / (1 - SECHS_OBEN);      // Kastenhoehe, damit die Tinte h hoch ist
  const b = H * SECHS_VERH;
  doc.save();
  doc.translate(x - SECHS_ANSCHLAG * b, y - SECHS_OBEN * H);
  for (const teil of [SECHS_BALKEN, SECHS_STEG, SECHS_KASTEN]) {
    teil.forEach(([u,v],i) => i ? doc.lineTo(u*b, v*h) : doc.moveTo(u*b, v*h));
    doc.closePath();
  }
  SECHS_INNEN.slice().reverse()
    .forEach(([u,v],i) => i ? doc.lineTo(u*b, v*h) : doc.moveTo(u*b, v*h));
  doc.closePath();
  doc.fillColor(farbe).fill();
  doc.restore();
}

export function schriftenLaden(doc){
  doc.registerFont("BFC",       SANS_BOLD);
  doc.registerFont("BFC-Normal",SANS_REGULAR);
  doc.registerFont("BFC-Kursiv",SANS_BOLD_KURSIV);
  doc.registerFont("BFC-Mono",  MONO_BOLD);
  doc.registerFont("BFC-Mono-N",MONO_REGULAR);
}

/** Text an CSS-Koordinaten: y ist die Oberkante der Zeilenbox. */
function txt(doc, s, x, yTop, { font="BFC", size=20, color=WEISS, ls=0,
                                lh=null, width=null, align="left", opacity=1 } = {}){
  doc.font(font).fontSize(size).fillColor(color).fillOpacity(opacity);
  const zeile = (lh || 1) * size;
  const halb  = (zeile - size) / 2;                 // halbe Durchschusshoehe wie im CSS
  const oben  = yTop + halb + (size - doc.currentLineHeight(false)) / 2;
  // Selbst ausrichten. PDFKit liefert bei lineBreak:false zusammen mit
  // width/align unbrauchbare Werte und zerlegt damit den Rest der Seite.
  let px = x;
  if (width != null && align !== "left") {
    const w = doc.widthOfString(s, { characterSpacing: ls });
    px = align === "right" ? x + width - w : x + (width - w) / 2;
  }
  doc.text(s, px, oben, { characterSpacing: ls, lineBreak: false, baseline: "top" });
  doc.fillOpacity(1);
}
function breite(doc, s, font, size, ls){
  doc.font(font).fontSize(size);
  return doc.widthOfString(s, { characterSpacing: ls });
}
function linie(doc, x, y, b, h, farbe, deckung=1){
  doc.save().fillOpacity(deckung).rect(x, y, b, h).fill(farbe).restore();
}

/**
 * Zeichnet eine Karte auf die aktuelle Seite.
 * @param d  { edition, area, dateLabel, doorsLabel, categoryLabel,
 *             block, row, seat, room, serial, codeCaption, qrPng }
 */
export function zeichneTicket(doc, d){
  for (const f of ["edition","area","dateLabel","doorsLabel","categoryLabel",
                   "blockLabel","row","seat","room","serial","codeCaption"]) {
    if (typeof d[f] !== "string" || !d[f].trim()) throw new Error("Ticketfeld fehlt: " + f);
  }
  if (!d.qrPng || !d.qrPng.length) throw new Error("QR-Code fehlt - Ticket wird nicht ausgegeben.");

  doc.save();
  doc.scale(S, S, { origin: [0, 0] });          // ab hier in Entwurfs-Koordinaten

  // ---------------------------------------------------------------- Untergrund
  doc.rect(0, 0, FLAECHE_B, FLAECHE_H).fill(AUSSEN);

  // Kartenkoerper mit runden Ecken; alles Weitere liegt darin
  doc.save();
  doc.roundedRect(10, 6, FLAECHE_B - 20, FLAECHE_H - 24, 28).clip();
  doc.rect(0, 0, FLAECHE_B, FLAECHE_H).fill(DUNKEL);

  // ------------------------------------------------------------- Saalfoto
  // object-fit: cover, object-position: 56% center
  const bX = OX, bY = OY + 84, bB = HAUPT_B, bH = 778;
  doc.save();
  doc.rect(bX, bY, bB, bH).clip();
  const iB = 1774, iH = 887;
  const f = bH / iH, sB = iB * f;
  doc.image(bild(doc, SAAL_JPG, "saal"), bX - (sB - bB) * 0.56, bY, { width: sB, height: bH });
  // Abdunkelung wie .bfc-shade
  doc.save();
  doc.rect(bX, bY, bB, bH)
     .fill(doc.linearGradient(bX, 0, bX + bB, 0)
              .stop(0, "#000", 0.46).stop(0.63, "#000", 0.10).stop(1, "#000", 0));
  doc.rect(bX, bY, bB, bH)
     .fill(doc.linearGradient(0, bY + bH, 0, bY)
              .stop(0, "#000", 0.50).stop(0.45, "#000", 0));
  doc.restore();
  doc.restore();

  // ------------------------------------------------------------- Kopfzeile
  doc.rect(OX, OY, HAUPT_B, 88)
     .fill(doc.linearGradient(OX, OY, OX + HAUPT_B, OY + 88).stop(0, "#141715").stop(1, "#090B0A"));
  linie(doc, OX, OY + 84, HAUPT_B, 4, GRUEN);
  txt(doc, "BFC — BELLUM CHALLENGER", OX + 47, OY + 24, { size: 40, ls: -0.5 });
  const etB = breite(doc, "EINTRITTSKARTE", "BFC", 24, 5);
  txt(doc, "EINTRITTSKARTE", OX + HAUPT_B - 42 - etB, OY + 32, { size: 24, ls: 5 });

  // ------------------------------------------------------------- Logo + Nummer
  const logoB = 490, logoH = logoB * LOGO_V;
  // Der Schriftzug sitzt 10 px hoeher als im Entwurf: seine F-Spitze reicht bis
  // 36 px unter die Buchstaben und lief sonst in den Untertitel hinein.
  const LOGO_Y = OY + 127;
  doc.image(bild(doc, LOGO_WEISS_PNG, "logoW"), OX + 48, LOGO_Y, { width: logoB, height: logoH });
  // Groesse und Lage an der freigegebenen Referenz ausgemessen: dort ist die
  // Ziffer 157 px hoch und beginnt bei x 524, ueberlappt das Logo also leicht.
  // Die Referenz nutzt eine unbekannte Anzeigeschrift; mit der mitgelieferten
  // Nimbus Sans faellt die Ziffer schmaler aus - Hoehe und Lage stimmen.
  // Ziffer: Oberkante und Grundlinie wie die Buchstaben, kleiner gleichmaessiger
  // Abstand zum C. Reicht damit nicht bis in den Untertitel hinein.
  const koerperH = logoH * LOGO_KOERPER;
  // Die Ziffer beginnt oben links bei 0,290 ihrer Breite; damit der Abstand zum
  // C gleichmaessig bleibt, wird von dort aus gerechnet.
  // Keine Ziffer neben dem Logo: die 6 gehoert zu BFC 6. Die Bellum Challenger
  // traegt das Logo allein. zeichneSechs bleibt im Modul stehen, wird aber
  // nicht mehr aufgerufen.

  txt(doc, "Bellum Challenger", OX + 48, OY + 285, { size: 38, ls: -0.8, lh: 1.15 });

  // ------------------------------------------------------------- Bereich
  const aX = OX + 1060, aY = OY + 115, aB = 180;
  const aH = Math.max(99, 18 + 24 + 5 + 49 + 18);
  doc.save().fillOpacity(0.909)
     .roundedRect(aX, aY, aB + 20, aH, 13).fill(DUNKEL).restore();
  txt(doc, "BEREICH", aX + 18, aY + 18, { size: 20, color: GRUEN, ls: 4, lh: 1.2 });
  txt(doc, d.area, aX + 18, aY + 18 + 24 + 5, { size: 39, lh: 1.25 });

  // ------------------------------------------------------------- Ortszeile
  // Das Zeichen sitzt mittig zur Textzeile (im CSS: align-items:center).
  // Vorher stand es 10 px zu tief und wirkte abgesackt.
  const pX = OX + 48, pY = OY + 343 - 6;
  doc.save().translate(pX, pY).scale(35 / 32, 46 / 44);
  doc.path("M16 0C7 0 0 7 0 16c0 11 16 28 16 28s16-17 16-28C32 7 25 0 16 0z").fill(GRUEN);
  doc.circle(16, 16, 7).fill(DUNKEL);
  doc.restore();
  txt(doc, "MARITIM HOTEL BONN", pX + 35 + 28, OY + 343 + 2, { size: 39, ls: 9 });

  // ------------------------------------------------------------- Datum / Einlass / Kategorie
  const fY = OY + 416;
  txt(doc, "DATUM", OX + 52, fY, { size: 20, color: GRUEN, ls: 4, lh: 1.2 });
  txt(doc, d.dateLabel, OX + 52, fY + 24 + 8, { size: 38, ls: -0.7, lh: 1.25 });
  txt(doc, "EINLASS", OX + 460, fY, { size: 20, color: GRUEN, ls: 4, lh: 1.2 });
  txt(doc, d.doorsLabel, OX + 460, fY + 24 + 8, { size: 38, ls: -0.7, lh: 1.25 });
  txt(doc, "KATEGORIE", OX + 692, fY, { size: 20, color: GRUEN, ls: 4, lh: 1.2 });
  linie(doc, OX + 425, OY + 419, 2, 71, GRUEN);
  linie(doc, OX + 651, OY + 419, 2, 71, GRUEN);
  // Kategorie als gruene Flaeche
  const katS = 29, katB = Math.max(186, breite(doc, d.categoryLabel, "BFC", katS, 0) + 56);
  const katY = fY + 24 + 9;
  doc.roundedRect(OX + 692, katY, katB, 9 + katS * 1.1 + 8, 10).fill(GRUEN);
  txt(doc, d.categoryLabel, OX + 692, katY + 9, { size: katS, color: "#050805", lh: 1.1,
                                                  width: katB, align: "center" });

  // ------------------------------------------------------------- Sitzplatzband
  const sY = OY + 500;
  doc.rect(OX, sY, HAUPT_B, 102)
     .fill(doc.linearGradient(OX, 0, OX + HAUPT_B, 0)
              .stop(0, "#070A08", 0.75).stop(0.70, "#070A08", 0.5).stop(1, "#070A08", 0));
  linie(doc, OX, sY, HAUPT_B, 1, WEISS, 0.157);
  const sf = [["REIHE", d.row, 52, 112, true], ["PLATZ", d.seat, 199, 122, true],
              ["ORT", d.room, 366, 520, false]];
  for (const [lab, wert, lx, lb, strich] of sf) {
    txt(doc, lab, OX + lx, sY + 17, { size: 20, color: GRUEN, ls: 4, lh: 1.2 });
    txt(doc, wert, OX + lx, sY + 17 + 24 + 8, { size: lab === "ORT" ? 34 : 38, ls: -0.7, lh: 1.25 });
    if (strich) linie(doc, OX + lx + lb, sY + 17, 1, 75, WEISS, 0.314);
  }

  // ------------------------------------------------------------- Strichcode
  const cX = OX + 32, cY = OY + 607, cB = 1018, cH = 142;
  doc.roundedRect(cX, cY, cB, cH, 16).fill("#FFFFFF");
  const bcB = 978, bcH = 92, bcX = cX + 20, bcY = cY + 10;
  const { breiten } = code128b(d.barcodeText || d.serial);
  const module = breiten.reduce((a, b) => a + b, 0);
  const ruhe = 10;                                   // Ruhezone: 10 Module je Seite
  const mB = bcB / (module + 2 * ruhe);
  let px = bcX + ruhe * mB, balken = true;
  doc.fillColor("#000000");
  for (const w of breiten) {
    if (balken) doc.rect(px, bcY, w * mB, bcH).fill("#000000");
    px += w * mB; balken = !balken;
  }
  txt(doc, d.codeCaption, bcX, bcY + bcH + 4,
      { font: "BFC-Mono", size: 24, color: "#000000", ls: 2, lh: 1.25 });

  // ------------------------------------------------------------- Hinweistext
  // Selbst umbrochen: PDFKit rechnet seinen Textfluss ohne den Massstab und
  // haette den Absatz auf eine neue Seite geschoben - mitsamt allem danach.
  const hinweis = "Der QR-Code erlaubt pro Scan nur einen Eintritt. Unautorisierte Vervielfältigung "
    + "oder unbefugter Verkauf dieser Karte kann dazu führen, dass der Einlass verwehrt wird. Bei "
    + "Duplikaten behält sich der Veranstalter vor, allen Inhabern den Zutritt zu verweigern. "
    + "Änderungen von Termin und Beginn vorbehalten.";
  doc.font("BFC-Normal").fontSize(17);
  const zeilen = [];
  let akt = "";
  for (const wort of hinweis.split(" ")) {
    const probe = akt ? akt + " " + wort : wort;
    if (doc.widthOfString(probe) > 995 && akt) { zeilen.push(akt); akt = wort; }
    else akt = probe;
  }
  if (akt) zeilen.push(akt);
  zeilen.forEach((z, i) => txt(doc, z, OX + 45, OY + 771 + i * 17 * 1.4,
                               { font: "BFC-Normal", size: 17, color: "#DDDDDD", lh: 1.4 }));

  // ------------------------------------------------------------- Claim
  linie(doc, OX + 1083, OY + 701, 111, 2, GRUEN);
  ["MORE", "THAN", "A FIGHT"].forEach((z, i) => {
    txt(doc, z, OX + 1083, OY + 701 + 22 + i * 22 * 1.35,
        { font: "BFC-Normal", size: 22, ls: 8, lh: 1.35 });
  });

  // ------------------------------------------------------------- Abriss
  const tX = OX + HAUPT_B, tB = 516, tH = 864;
  doc.rect(tX, OY, tB, tH).fill(PAPIER);
  doc.save();
  doc.rect(tX, OY, tB, tH).clip();
  doc.rect(tX, OY, tB, tH)
     .fill(doc.radialGradient(tX + tB * 0.85, OY + tH / 2, 0,
                              tX + tB * 0.85, OY + tH / 2, tB * 0.72)
              .stop(0, "#E8ECE6", 1).stop(1, "#E8ECE6", 0));
  // angedeutete Architekturstruktur
  doc.save().opacity(0.15).lineWidth(1.5).strokeColor("#B2BCAD");
  for (let i = -tH; i < tB + tH; i += 48) {
    doc.moveTo(tX + i, OY + 115).lineTo(tX + i + tH, OY + tH).stroke();
  }
  doc.strokeColor("#BAC4B5");
  for (let i = -tH; i < tB + tH; i += 96) {
    doc.moveTo(tX + i, OY + tH).lineTo(tX + i + tH, OY + 115).stroke();
  }
  doc.restore();
  doc.restore();
  // Perforation
  doc.save().lineWidth(4).dash(14, { space: 12 }).strokeColor("#151815")
     .moveTo(tX, OY).lineTo(tX, OY + tH).stroke().restore();

  linie(doc, tX + 37, OY + 54, 90, 2, GRUEN);
  linie(doc, tX + 388, OY + 54, 82, 2, GRUEN);
  const slB = 160, slH = slB * LOGO_V;
  doc.image(bild(doc, LOGO_SCHWARZ_PNG, "logoS"), tX + 150, OY + 37, { width: slB, height: slH });
  const slKoerper = slH * LOGO_KOERPER;
  // Auch auf dem Abriss keine Ziffer.

  // QR-Feld: weisse Flaeche, der Code sitzt mit Rand darin
  const qX = tX + 65, qY = OY + 176, qG = 388;
  doc.roundedRect(qX, qY, qG, qG, 13).fill("#FFFFFF");
  // Der weisse Rand steckt bereits im QR-Bild (4 Module, wie vorgeschrieben),
  // deshalb fuellt es die Flaeche ganz aus.
  doc.image(d.qrPng, qX, qY, { width: qG, height: qG });

  linie(doc, tX + 53, OY + 620, 410, 2, GRUEN);
  txt(doc, d.blockLabel, tX + 53, OY + 620 + 12,
      { size: 33, color: DUNKEL, lh: 1.3, width: 410, align: "center" });
  txt(doc, "Reihe " + d.row + " · Platz " + d.seat, tX + 53, OY + 620 + 12 + 33 * 1.3,
      { size: 30, color: DUNKEL, lh: 1.4, width: 410, align: "center" });
  // "Nr." nicht am Stueck setzen: NimbusMonoPS ersetzt die drei Zeichen fest
  // durch das Nummernzeichen №, und ueber features laesst sich das nicht
  // abschalten. In zwei Teilen gezeichnet bleibt es "Nr.".
  {
    const nY = OY + 620 + 12 + 33 * 1.3 + 30 * 1.4 + 7;
    doc.font("BFC-Mono-N").fontSize(27);
    const t1 = "Nr", t2 = ". " + d.serial;
    const w1 = doc.widthOfString(t1), w2 = doc.widthOfString(t2);
    const nX = tX + 53 + (410 - (w1 + w2)) / 2;
    txt(doc, t1, nX,      nY, { font: "BFC-Mono-N", size: 27, color: "#767676", lh: 1.5 });
    txt(doc, t2, nX + w1, nY, { font: "BFC-Mono-N", size: 27, color: "#767676", lh: 1.5 });
  }

  linie(doc, tX + 65, OY + 760, 386, 2, GRUEN);
  txt(doc, "EINLASSKONTROLLE", tX + 65, OY + 760 + 24,
      { size: 23, color: GRUEN_DUNKEL, ls: 4, width: 386, align: "center" });

  doc.restore();   // Ende Kartenkoerper

  // Kontur und Einkerbungen
  doc.lineWidth(2).strokeColor("#E7E8E7")
     .roundedRect(10, 6, FLAECHE_B - 20, FLAECHE_H - 24, 28).stroke();
  for (const cy of [-21 + 24, FLAECHE_H - 5 - 24]) {
    doc.circle(1226 + 24, cy, 24).fill(AUSSEN);
    doc.lineWidth(2).strokeColor("#E7E8E7").circle(1226 + 24, cy, 24).stroke();
  }

  doc.restore();   // Ende Massstab
}
