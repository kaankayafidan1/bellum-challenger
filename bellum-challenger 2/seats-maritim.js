// ============================================================================
//  Saal Maritim - Sitzplatzstruktur fuer den BELLUM CHALLENGER am Sonntag,
//  18.10.2026. Eigenes System, getrennt von BFC 6 am Samstag.
//
//  NUR DER INNENRAUM: 1590 Plaetze in 14 Bloecken. Die Empore wird an diesem
//  Tag nicht bestuhlt und kommt hier gar nicht vor.
//
//  Die Blockdaten sind Zeichen fuer Zeichen aus dem BFC-6-Modul uebernommen -
//  es ist derselbe Saal, nur ohne Empore und mit eigenen Preisen.
//
//  Sitz-ID: "zone|block|reihe|platz"  -  z.B. "Innenraum|P1|A|01".
//  Gleiche Funktionsnamen wie beim Samstag, damit server.js unveraendert
//  damit arbeiten kann.
// ============================================================================

// z = Zone, r = Reihe -> Anzahl Plaetze
const LAYOUT = {
  "P1":{z:"Innenraum",r:{"A":9,"B":11,"C":13,"D":13,"E":11,"F":9,"G":8,"H":7}},
  "P2":{z:"Innenraum",r:{"A":9,"B":11,"C":13,"D":13,"E":11,"F":9,"G":8,"H":7}},
  "P3":{z:"Innenraum",r:{"A":5,"B":11,"C":13,"D":14,"E":15,"F":14}},
  "P4":{z:"Innenraum",r:{"A":6,"B":10,"C":12,"D":14,"E":15,"F":17}},
  "P5":{z:"Innenraum",r:{"A":9,"B":10,"C":12,"D":14,"E":15,"F":17}},
  "P6":{z:"Innenraum",r:{"A":9,"B":10,"C":12,"D":14,"E":15,"F":17}},
  "P7":{z:"Innenraum",r:{"A":6,"B":10,"C":12,"D":13,"E":15,"F":16}},
  "P8":{z:"Innenraum",r:{"A":5,"B":10,"C":11,"D":14,"E":15,"F":14}},
  "P9":{z:"Innenraum",r:{"G":11,"H":12,"I":11,"J":10,"K":8,"L":7,"M":8,"N":6,"O":5,"P":3}},
  "P10":{z:"Innenraum",r:{"G":20,"H":20,"I":20,"J":20,"K":20,"L":20,"M":20,"N":20,"O":20,"P":20,"Q":20,"R":15,"S":15,"T":15,"U":13,"V":11}},
  "P11":{z:"Innenraum",r:{"G":20,"H":20,"I":17,"J":14,"K":14,"L":15,"M":14,"N":13,"O":3}},
  "P12":{z:"Innenraum",r:{"G":20,"H":20,"I":16,"J":14,"K":14,"L":15,"M":14,"N":13,"O":3}},
  "P13":{z:"Innenraum",r:{"G":20,"H":20,"I":20,"J":20,"K":20,"L":20,"M":20,"N":20,"O":20,"P":20,"Q":20,"R":15,"S":15,"T":15,"U":12}},
  "P14":{z:"Innenraum",r:{"G":11,"H":12,"I":11,"J":10,"K":8,"L":7,"M":8,"N":6,"O":5,"P":3}}
};


// Preise fuer den Bellum Challenger. Die Reihenbuchstaben laufen durch den ganzen
// Saal: A = Reihe 1 ... V = Reihe 22. Die hinteren Bloecke P9-P14 fangen erst
// bei G (= Reihe 7) an - die sind deshalb durchgehend die guenstigste Stufe.
function innenraumRowPrice(row){
  const stufe = "ABCDEFGHIJKLMNOPQRSTUV".indexOf(row) + 1;
  if(stufe < 1)   return 0;
  if(stufe === 1) return 9900;    // Reihe 1
  if(stufe === 2) return 7900;    // Reihe 2
  if(stufe === 3) return 5900;    // Reihe 3
  if(stufe <= 5)  return 4900;    // Reihe 4 und 5
  return 3900;                    // alles dahinter
}

// Preis eines konkreten Platzes, immer serverseitig bestimmen.
function seatPrice(zone, block, row){
  const b = LAYOUT[block];
  if(!b || b.z !== zone) return 0;
  // Die Reihe muss es im Saal geben - und zwar VOR jeder Preisauskunft. Frueher
  // stand diese Zeile weiter unten: Bloecke mit einem einzigen Blockpreis gaben
  // dadurch fuer JEDE Zeichenkette einen Preis zurueck. Damit liess sich eine
  // gesperrte Reihe kaufen, indem man "02" statt "2" schickte.
  if(!(row in b.r)) return 0;
  if(b.pr) return b.pr[row] || 0;           // Empore: Preis je Reihe
  if(b.p)  return b.p;                      // Empore: Preis je Block
  return innenraumRowPrice(row);            // Innenraum: Preis je Reihe
}

function seatsOf(zone, block){
  const b = LAYOUT[block];
  if(!b || b.z !== zone) return [];
  const out = [];
  for(const row of Object.keys(b.r)){
    const v = b.r[row];
    // Zahl = Reihe ist 1..n durchnummeriert; Liste = echte Nummern (mit Luecke)
    if(Array.isArray(v)) for(const s of v) out.push({ row, seat: s });
    else for(let s = 1; s <= v; s++) out.push({ row, seat: s });
  }
  return out;
}

function seatId(zone, block, row, seat){
  return `${zone}|${block}|${row}|${String(seat).padStart(2,"0")}`;
}

function blockPriceRange(zone, block){
  const seats = seatsOf(zone, block);
  if(!seats.length) return { min:0, max:0 };
  let min = Infinity, max = 0;
  for(const s of seats){
    const p = seatPrice(zone, block, s.row);
    if(p < min) min = p;
    if(p > max) max = p;
  }
  return { min: min === Infinity ? 0 : min, max };
}

// ============================================================================
//  SPERREN - hier traegst du ein, was nicht online verkauft werden soll.
//  Alles leer = alles ist buchbar.
// ============================================================================

// Ganze Bloecke sperren, z.B. fuer Abendkasse, Presse, Technik.
//   Beispiel: "Innenraum|P1", "Empore|T7"
const BLOCKED = new Set([
  // leer: am Sonntag sind alle 14 Bloecke im Verkauf
]);

// Einzelne REIHEN sperren.  Format: "Zone|Block|Reihe"
//   Auf der Empore ist vorerst nur Reihe 1 im Verkauf. Alles dahinter ist
//   gesperrt, bis der Innenraum an seine Grenze kommt - dann hier Zeilen
//   entfernen. Erzeugt aus gesperrte_reihen.json - nicht von Hand aendern.
const BLOCKED_ROWS = new Set([
  // leer: keine Reihe gesperrt
]);

// Einzelne PLAETZE sperren.  Format: "Zone|Block|Reihe|Platz" (Platz zweistellig)
//   Diese Plaetze sind fuer die Kunden reserviert, die ihr Ticket noch fuer die
//   ring°arena gekauft haben. Sie bleiben unverkaeuflich, bis die Umbuchung steht.
//   Erzeugt aus gesperrt.json - nicht von Hand aendern.
const BLOCKED_SEATS = new Set([
  // leer: der Saal startet vollstaendig frei
]);

function isBlocked(zone, block){ return BLOCKED.has(zone + "|" + block); }
function isRowBlocked(zone, block, row){ return BLOCKED_ROWS.has(`${zone}|${block}|${row}`); }
// Alle Sitz-IDs, die es im Saal wirklich gibt. Wird einmal beim Start gebaut.
const ALLE_SITZE = new Set();
for(const key of Object.keys(LAYOUT)){
  const b = LAYOUT[key];
  for(const s of seatsOf(b.z, key)) ALLE_SITZE.add(seatId(b.z, key, s.row, s.seat));
}
function seatExists(zone, block, row, seat){
  return ALLE_SITZE.has(seatId(zone, block, row, seat));
}
function isSeatBlocked(zone, block, row, seat){
  // Eine Platznummer, die es im Saal nicht gibt, gilt als gesperrt. Sonst nimmt
  // der Server einen erfundenen Stuhl an und stellt ein gueltiges Ticket dafuer
  // aus - und eine dreistellige Nummer ("001" statt "01") ging an der Sperre
  // eines bereits vergebenen Platzes vorbei.
  if(!seatExists(zone, block, row, seat)) return true;
  return BLOCKED_SEATS.has(`${zone}|${block}|${row}|${String(seat).padStart(2,"0")}`);
}

function allBlocks(){
  return Object.keys(LAYOUT).map(key => {
    const b = LAYOUT[key];
    const r = blockPriceRange(b.z, key);
    return {
      zone: b.z, name: key,
      capacity: seatsOf(b.z, key).filter(s =>
        !isRowBlocked(b.z, key, s.row) && !isSeatBlocked(b.z, key, s.row, s.seat)).length,
      priceMin: r.min, priceMax: r.max,
      blocked: isBlocked(b.z, key)
    };
  });
}

export {
  LAYOUT, innenraumRowPrice, seatPrice, seatsOf, seatId,
  blockPriceRange, allBlocks,
  BLOCKED, BLOCKED_ROWS, BLOCKED_SEATS,
  isBlocked, isRowBlocked, isSeatBlocked, seatExists
};
