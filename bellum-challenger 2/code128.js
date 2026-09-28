/**
 * Code 128 (Zeichensatz B) - echter, normgerechter Strichcode.
 * Liefert die Modulbreiten als Zahlenfolge: abwechselnd Balken, Luecke, ...
 * Vorher standen hier Zufallsbalken ohne Bedeutung.
 */
const MUSTER = [
 "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
 "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
 "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
 "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
 "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
 "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
 "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
 "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
 "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
 "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
 "114131","311141","411131","211412","211214","211232","2331112"
];
const START_B = 104, STOP = 106;

export function code128b(text){
  for (const z of text) {
    const c = z.charCodeAt(0);
    if (c < 32 || c > 126) throw new Error("Code128-B kann dieses Zeichen nicht: " + JSON.stringify(z));
  }
  const werte = [START_B, ...[...text].map(z => z.charCodeAt(0) - 32)];
  let pruef = START_B;
  for (let i = 1; i < werte.length; i++) pruef += werte[i] * i;
  werte.push(pruef % 103, STOP);
  const breiten = [];
  for (const w of werte) for (const z of MUSTER[w]) breiten.push(+z);
  return { breiten, werte };
}

/** Zurueckgelesen: aus den Modulbreiten wieder Text machen - zur Selbstkontrolle. */
export function decode128(breiten){
  const s = breiten.join("");
  const lies = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.length - i;
    const laenge = rest === 7 ? 7 : 6;
    lies.push(s.slice(i, i + laenge));
    i += laenge;
  }
  const werte = lies.map(m => MUSTER.indexOf(m));
  if (werte.some(v => v < 0)) throw new Error("unbekanntes Muster");
  if (werte[0] !== START_B) throw new Error("kein Start-B");
  if (werte[werte.length-1] !== STOP) throw new Error("kein Stop");
  const nutz = werte.slice(1, -2);
  const pruefSoll = werte[werte.length-2];
  let p = START_B;
  nutz.forEach((v,idx) => { p += v * (idx+1); });
  if (p % 103 !== pruefSoll) throw new Error("Pruefziffer falsch");
  return nutz.map(v => String.fromCharCode(v + 32)).join("");
}
