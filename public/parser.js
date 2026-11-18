// Lecture d'un devis collé en texte (anglais ou français), sans IA.
import { GENERAL, normaliser, trouverMetier, contientMot, METIERS_DEFAUT, isoDe, plage } from "./logic.js";

const MOIS_MAP = {
  jan: 1, janv: 1, january: 1, janvier: 1,
  feb: 2, fev: 2, fevr: 2, february: 2, fevrier: 2,
  mar: 3, mars: 3, march: 3,
  apr: 4, avr: 4, april: 4, avril: 4,
  may: 5, mai: 5,
  jun: 6, juin: 6, june: 6,
  jul: 7, juil: 7, july: 7, juillet: 7,
  aug: 8, aout: 8, august: 8,
  sep: 9, sept: 9, september: 9, septembre: 9,
  oct: 10, october: 10, octobre: 10,
  nov: 11, november: 11, novembre: 11,
  dec: 12, december: 12, decembre: 12,
};

const DEPENSES = /(meal|repas|expense|frais|transport|hotel|hebergement|per diem|defraiement|taxi|parking|total|tva|vat|subtotal|sous-total|discount|remise)/;
const IGNORER_TITRE = /^(total|subtotal|sous-total|tva|vat|description|designation|quantity|qty|price|prix|devis|quote|invoice|facture|page|event|date|amount|montant)\b/;
const UNITE = "(?:day|days|jour|jours|journ[ée]e?s?|half[ -]day|demi[ -]journ[ée]e|heures?|hours?)";

/** Choisit l'année la plus proche d'aujourd'hui pour un jour/mois sans année. */
function annee(jour, mois, aujourdhui) {
  const ty = aujourdhui.getUTCFullYear();
  let best = ty;
  let bestDiff = Infinity;
  for (const y of [ty - 1, ty, ty + 1]) {
    const diff = Math.abs(Date.UTC(y, mois - 1, jour) - aujourdhui.getTime());
    if (diff < bestDiff) {
      best = y;
      bestDiff = diff;
    }
  }
  return best;
}

function iso(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return isoDe(dt);
}

/** Renvoie la liste de dates ISO trouvées dans une ligne d'en-tête, ou null. */
export function lireDates(ligne, aujourdhui = new Date()) {
  const n = normaliser(ligne);
  if (n.length > 70 || n.includes("€")) return null;
  const ordinal = "(?:st|nd|rd|th|er)?";
  let m;

  // « du 12 au 14 décembre », « 12-14 December », « from 12 to 14 dec 2026 »
  m = n.match(new RegExp(`(\\d{1,2})${ordinal}\\s*(?:-|–|to|au|a)\\s*(\\d{1,2})${ordinal}\\s+([a-z]{3,9})\\.?(?:\\s+(\\d{4}))?`));
  if (m && MOIS_MAP[m[3]]) {
    const mo = MOIS_MAP[m[3]];
    const y = m[4] ? +m[4] : annee(+m[1], mo, aujourdhui);
    const a = iso(y, mo, +m[1]);
    const b = iso(y, mo, +m[2]);
    if (a && b && a <= b) return plage(a, b);
  }
  // « WEDNESDAY 18 NOV », « 18 novembre 2026 »
  m = n.match(new RegExp(`(\\d{1,2})${ordinal}\\s+(?:of\\s+)?([a-z]{3,9})\\.?(?:\\s+(\\d{4}))?`));
  if (m && MOIS_MAP[m[2]]) {
    const mo = MOIS_MAP[m[2]];
    const y = m[3] ? +m[3] : annee(+m[1], mo, aujourdhui);
    const d = iso(y, mo, +m[1]);
    if (d) return [d];
  }
  // « November 18 »
  m = n.match(/([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (m && MOIS_MAP[m[1]]) {
    const mo = MOIS_MAP[m[1]];
    const y = m[3] ? +m[3] : annee(+m[2], mo, aujourdhui);
    const d = iso(y, mo, +m[2]);
    if (d) return [d];
  }
  // « 18/11/2026 », « 18/11 »
  m = n.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const mo = +m[2];
    let y = m[3] ? +m[3] : annee(+m[1], mo, aujourdhui);
    if (y < 100) y += 2000;
    const d = iso(y, mo, +m[1]);
    if (d) return [d];
  }
  return null;
}

function lireHoraire(ligne) {
  const m = ligne.match(/(\d{1,2})\s*[h.:]\s*(\d{2})\s*[-–à]\s*(\d{1,2})\s*[h.:]\s*(\d{2})/i);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}–${m[3].padStart(2, "0")}:${m[4]}` : null;
}

/**
 * @param {string} texte devis collé
 * @param {{metiers?: object[], salles?: string[], aujourdhui?: Date}} opts
 */
export function parserDevis(texte, opts = {}) {
  const metiers = opts.metiers || METIERS_DEFAUT;
  const sallesConnues = (opts.salles || []).map((s) => ({ nom: s, n: normaliser(s) })).filter((s) => s.n);
  const aujourdhui = opts.aujourdhui || new Date();
  const warnings = [];
  const items = [];
  let client = "";
  let nom = "";
  let date = "";
  let salle = "";
  let horaire = "";

  const lignes = String(texte || "").split(/\r?\n/);
  for (const brut of lignes) {
    const ligne = brut.replace(/^[\s\-–•*·]+/, "").trim();
    if (!ligne) continue;
    const n = normaliser(ligne);

    // métadonnées
    let m = ligne.match(/^(client|customer|société|societe|company|pour)\s*[:\-]\s*(.+)$/i);
    if (m) {
      client = m[2].trim();
      continue;
    }
    m = ligne.match(/^(event name|nom de l'événement|nom de l'evenement|projet|project|titre|title)\s*[:\-]\s*(.+)$/i);
    if (m) {
      nom = m[2].trim();
      continue;
    }

    // ligne avec un prix : poste ou dépense
    if (ligne.includes("€") || new RegExp(`\\s${UNITE}\\s+[\\d]`, "i").test(ligne)) {
      if (DEPENSES.test(n)) continue;
      let label = "";
      let qty = 1;
      const mp = ligne.match(new RegExp(`^(.+?)\\s+${UNITE}\\s+([\\d\\s.,]+)\\s*€?\\s*(\\d+)?`, "i"));
      if (mp) {
        label = mp[1].trim();
        qty = Math.max(1, parseInt(mp[3] || "1", 10) || 1);
      } else {
        const ml = ligne.match(/^([^\d€]+?)\s*[\d]/);
        label = ml ? ml[1].trim() : "";
        const mq = ligne.match(/€\s*(\d+)\b/);
        qty = mq ? Math.max(1, +mq[1]) : 1;
        if (!label || !trouverMetier(label, metiers)) continue;
      }
      const metier = trouverMetier(label, metiers);
      items.push({ date, salle, label, metierId: metier ? metier.id : null, qty, horaire });
      continue;
    }

    // horaires
    const h = lireHoraire(ligne);
    if (h) {
      horaire = h;
      continue;
    }

    // date
    const ds = lireDates(ligne, aujourdhui);
    if (ds) {
      date = ds[0]; // une plage dans un en-tête : on garde la liste via items multiples
      if (ds.length > 1) date = ds;
      horaire = "";
      continue;
    }

    // salle / section
    const connue = sallesConnues.find((s) => contientMot(n, s.n));
    if (connue) {
      salle = connue.nom;
      horaire = "";
      continue;
    }
    if (/^(general manager|general|regie generale|direction technique)\b/.test(n)) {
      salle = GENERAL;
      horaire = "";
      continue;
    }
    const lettres = ligne.replace(/[^A-Za-zÀ-ÿ]/g, "");
    if (lettres.length >= 3 && ligne === ligne.toUpperCase() && ligne.length <= 40 && !IGNORER_TITRE.test(n)) {
      salle = ligne.replace(/\s+/g, " ").trim();
      horaire = "";
    }
  }

  // regroupement : une demande par salle + métier + « slot » (n-ième poste), avec l'union des dates
  const groupes = new Map();
  for (const it of items) {
    const dates = Array.isArray(it.date) ? it.date : it.date ? [it.date] : [];
    for (let slot = 1; slot <= it.qty; slot++) {
      const cle = `${it.salle}|${it.metierId || "lib:" + normaliser(it.label)}|${slot}|${dates.length ? "d" : "nd"}`;
      if (!groupes.has(cle)) groupes.set(cle, { salle: it.salle, metierId: it.metierId, libelle: it.label, dates: [], horaires: {} });
      const g = groupes.get(cle);
      for (const d of dates) {
        if (!g.dates.includes(d)) g.dates.push(d);
        if (it.horaire && !g.horaires[d]) g.horaires[d] = it.horaire;
      }
    }
  }

  const demandes = [...groupes.values()].map((g) => ({ ...g, dates: g.dates.sort() }));
  const ordre = [...new Set(demandes.map((d) => d.salle))];
  demandes.sort((a, b) => (a.salle === GENERAL) - (b.salle === GENERAL) || ordre.indexOf(a.salle) - ordre.indexOf(b.salle));

  const sansDate = demandes.filter((d) => !d.dates.length).length;
  const sansSalle = demandes.filter((d) => !d.salle).length;
  const sansMetier = demandes.filter((d) => !d.metierId).length;
  if (!demandes.length) warnings.push("Aucun poste trouvé dans ce texte. Vérifie que les lignes de postes contiennent « Day » ou « Jour » suivi d'un prix, ou ajoute les demandes à la main.");
  if (sansDate) warnings.push(`${sansDate} demande(s) sans date : complète-les ci-dessous.`);
  if (sansSalle) warnings.push(`${sansSalle} demande(s) sans salle : complète-les ci-dessous.`);
  if (sansMetier) warnings.push(`${sansMetier} demande(s) dont le métier n'est pas reconnu : choisis-le dans la liste.`);

  return { nom, client, demandes, warnings };
}
