// Règles de gestion partagées entre le serveur (api.mjs) et le navigateur (app.js).
// Aucune dépendance : du JavaScript pur, facile à tester.

export const GENERAL = "Général";

export const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export const METIERS_DEFAUT = [
  { id: "chef-equipement", nom: "Chef d'équipement", aliases: ["chef d'equipement", "chef equipement", "head of crew", "crew chief", "team leader", "lead technician"] },
  { id: "barco", nom: "Opérateur Barco S3/E2", aliases: ["barco", "e2", "s3"] },
  { id: "son", nom: "Ingénieur du son", aliases: ["sound engineer", "audio engineer", "sound", "ingenieur du son", "ingenieur son", "sonorisateur", "a1"] },
  { id: "lumiere", nom: "Pupitreur lumière", aliases: ["light operator", "lighting operator", "lighting", "light", "pupitreur lumiere", "pupitreur", "eclairagiste"] },
  { id: "audiovisuel", nom: "Opérateur audiovisuel", aliases: ["av operator", "av technician", "av tech", "audiovisual", "audio visual", "operateur audiovisuel", "operateur av"] },
  { id: "camera", nom: "Opérateur caméra tourelle", aliases: ["ptz", "tourelle", "robotic camera", "remote camera", "camera operator", "camera"] },
  { id: "realisateur", nom: "Réalisateur vision", aliases: ["vision director", "vision mixer", "video director", "realisateur vision", "realisateur", "director", "switcher"] },
  { id: "interphonie", nom: "Technicien interphonie", aliases: ["intercom technician", "intercom", "interphonie", "comms", "clearcom"] },
  { id: "regisseur", nom: "Régisseur", aliases: ["technical manager", "tech manager", "stage manager", "production manager", "regisseur", "regie"] },
];

export const STATUT_LABEL = { a_booker: "À booker", en_cours: "En cours", complete: "Complète" };
export const TENT_LABEL = { a_envoyer: "À envoyer", en_attente: "En attente", confirme: "Confirmé", refuse: "Refusé" };

/* ---------- texte ---------- */

export function normaliser(s) {
  return String(s ?? "")
    .replace(/[’‘`´]/g, "'")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function contientMot(texteNorm, motNorm) {
  return new RegExp("(^|[^a-z0-9])" + esc(motNorm) + "([^a-z0-9]|$)").test(texteNorm);
}

/** Retrouve le métier correspondant à un intitulé (nom exact ou alias le plus long). */
export function trouverMetier(libelle, metiers) {
  const n = normaliser(libelle);
  if (!n) return null;
  let best = null;
  let bestLen = 0;
  for (const m of metiers) {
    for (const a of [m.nom, ...(m.aliases || [])]) {
      const an = normaliser(a);
      if (an && contientMot(n, an) && an.length > bestLen) {
        best = m;
        bestLen = an.length;
      }
    }
  }
  return best;
}

/* ---------- dates ---------- */

const pad = (n) => String(n).padStart(2, "0");
export const isoDe = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dateDe = (iso) => new Date(iso + "T00:00:00Z");

export function plage(debut, fin) {
  const out = [];
  const d = dateDe(debut);
  const f = dateDe(fin || debut);
  for (let i = 0; d <= f && i < 400; i++) {
    out.push(isoDe(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export const dateValide = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(dateDe(s));

export function nettoyerDates(dates) {
  return [...new Set((dates || []).filter(dateValide))].sort();
}

export const chevauche = (a, b) => a.some((x) => b.includes(x));

function groupes(dates) {
  const ds = nettoyerDates(dates);
  const out = [];
  for (const d of ds) {
    const last = out[out.length - 1];
    if (last) {
      const next = dateDe(last[last.length - 1]);
      next.setUTCDate(next.getUTCDate() + 1);
      if (isoDe(next) === d) {
        last.push(d);
        continue;
      }
    }
    out.push([d]);
  }
  return out;
}

/** « le 18 novembre 2026 », « du 8 au 10 décembre 2026 », « le 8 et le 12 décembre 2026 »… */
export function formatDates(dates) {
  const gs = groupes(dates);
  if (!gs.length) return "";
  const annees = new Set(gs.flat().map((d) => d.slice(0, 4)));
  const memeAnnee = annees.size === 1;
  const jour = (d) => (d.getUTCDate() === 1 ? "1er" : d.getUTCDate());
  const parts = gs.map((g) => {
    const a = dateDe(g[0]);
    const b = dateDe(g[g.length - 1]);
    const an = (d) => (memeAnnee ? "" : " " + d.getUTCFullYear());
    if (g.length === 1) return `le ${jour(a)} ${MOIS[a.getUTCMonth()]}${an(a)}`;
    if (a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear())
      return `du ${jour(a)} au ${jour(b)} ${MOIS[b.getUTCMonth()]}${an(b)}`;
    return `du ${jour(a)} ${MOIS[a.getUTCMonth()]}${an(a)} au ${jour(b)} ${MOIS[b.getUTCMonth()]}${an(b)}`;
  });
  let txt = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " et " + parts[parts.length - 1];
  if (memeAnnee) txt += " " + [...annees][0];
  return txt;
}

/* ---------- statuts ---------- */

export function demandeStatut(d) {
  if (d.tentatives.some((t) => t.statut === "confirme")) return "complete";
  if (d.tentatives.some((t) => t.statut !== "refuse")) return "en_cours";
  return "a_booker";
}

export function prestationStatut(p) {
  const s = p.demandes.map(demandeStatut);
  if (!s.length) return "a_booker";
  if (s.every((x) => x === "complete")) return "complete";
  if (s.some((x) => x !== "a_booker")) return "en_cours";
  return "a_booker";
}

/** Statut d'un ensemble de demandes (ex. une salle). */
export function groupeStatut(demandes) {
  return prestationStatut({ demandes });
}

export function salles(p) {
  const vues = [];
  for (const d of p.demandes) if (!vues.includes(d.salle)) vues.push(d.salle);
  return vues.sort((a, b) => (a === GENERAL) - (b === GENERAL));
}

export const datesPrestation = (p) => nettoyerDates(p.demandes.flatMap((d) => d.dates));

/* ---------- disponibilités ---------- */

/**
 * Pour un intermittent et une demande :
 * ok | attente_ailleurs (proposable avec avertissement) | deja | refuse | indispo | occupe (grisés)
 */
export function disponibilite(db, demande, inter) {
  const own = demande.tentatives.find((t) => t.intermittentId === inter.id);
  if (own) {
    return own.statut === "refuse"
      ? { etat: "refuse", detail: "a déjà refusé cette demande" }
      : { etat: "deja", detail: "déjà contacté pour cette demande" };
  }
  for (const ind of inter.indispos || []) {
    if (chevauche(plage(ind.debut, ind.fin || ind.debut), demande.dates))
      return { etat: "indispo", detail: `indisponible${ind.motif ? " (" + ind.motif + ")" : ""}` };
  }
  let attente = null;
  for (const p of db.prestations) {
    for (const d of p.demandes) {
      if (d.id === demande.id || !chevauche(d.dates, demande.dates)) continue;
      for (const t of d.tentatives) {
        if (t.intermittentId !== inter.id) continue;
        if (t.statut === "confirme") return { etat: "occupe", detail: `déjà pris : ${p.nom}` };
        if (t.statut === "en_attente" || t.statut === "a_envoyer") attente = attente || { etat: "attente_ailleurs", detail: `en attente pour ${p.nom}` };
      }
    }
  }
  return attente || { etat: "ok", detail: "" };
}

export function candidats(db, demande) {
  if (!demande.metierId) return [];
  return db.intermittents
    .filter((i) => !i.archive && (i.metiers || []).includes(demande.metierId))
    .map((i) => ({ inter: i, ...disponibilite(db, demande, i) }))
    .sort((a, b) => (a.etat === "ok" ? 0 : a.etat === "attente_ailleurs" ? 1 : 2) - (b.etat === "ok" ? 0 : b.etat === "attente_ailleurs" ? 1 : 2) || a.inter.nom.localeCompare(b.inter.nom));
}

export const proposable = (c) => c.etat === "ok" || c.etat === "attente_ailleurs";

/** Ids des tentatives confirmées en double sur des dates qui se chevauchent. */
export function conflits(db) {
  const out = new Set();
  const conf = [];
  for (const p of db.prestations)
    for (const d of p.demandes)
      for (const t of d.tentatives) if (t.statut === "confirme") conf.push({ t, d });
  for (let i = 0; i < conf.length; i++)
    for (let j = i + 1; j < conf.length; j++)
      if (conf[i].t.intermittentId === conf[j].t.intermittentId && conf[i].d.id !== conf[j].d.id && chevauche(conf[i].d.dates, conf[j].d.dates)) {
        out.add(conf[i].t.id);
        out.add(conf[j].t.id);
      }
  return out;
}

/* ---------- changement de dates ---------- */

/**
 * Applique de nouvelles dates à une demande et met à jour les intermittents déjà contactés.
 * Renvoie la liste des impacts : { tentativeId, intermittentId, action } avec action =
 * renvoyer | reconfirmer | prevenir | recontacter
 */
export function appliquerChangementDates(d, nouvelles, maintenant = new Date().toISOString()) {
  const anciennes = [...d.dates];
  const memes = anciennes.length === nouvelles.length && anciennes.every((x, i) => x === nouvelles[i]);
  if (memes) return [];
  const elargi = nouvelles.some((x) => !anciennes.includes(x));
  d.dates = nouvelles;
  d.historique.push({ at: maintenant, texte: `Dates changées : ${formatDates(anciennes)} → ${formatDates(nouvelles)}` });
  const impacts = [];
  for (const t of d.tentatives) {
    let action = null;
    if (t.statut === "en_attente" || t.statut === "a_envoyer") {
      t.msgType = t.envoyeLe ? "maj" : "initial";
      t.statut = "a_envoyer";
      action = "renvoyer";
    } else if (t.statut === "confirme") {
      if (elargi) {
        t.statut = "a_envoyer";
        t.msgType = "maj";
        action = "reconfirmer";
      } else {
        t.aPrevenir = true;
        action = "prevenir";
      }
    } else if (t.statut === "refuse") {
      t.recontacter = true;
      action = "recontacter";
    }
    if (action) impacts.push({ tentativeId: t.id, intermittentId: t.intermittentId, action });
  }
  return impacts;
}

/* ---------- WhatsApp ---------- */

/** Numéro au format international sans « + » (France par défaut). */
export function telephone(raw) {
  let p = String(raw || "").replace(/\(0\)/g, "").replace(/[^\d+]/g, "");
  if (!p) return "";
  if (p.startsWith("+")) return p.slice(1);
  if (p.startsWith("00")) return p.slice(2);
  if (p.startsWith("0")) return "33" + p.slice(1);
  return p;
}

export const prenom = (nom) => String(nom || "").trim().split(/\s+/)[0] || "";

/**
 * Message à l'intermittent : uniquement le client et les dates (jamais la salle ni le poste).
 * type : initial | maj | info | annulation
 */
export function messageWhatsApp({ type = "initial", nom, client, dates, lien }) {
  const pour = client ? ` pour ${client}` : "";
  const quand = formatDates(dates);
  const salut = `Bonjour ${prenom(nom)},`;
  if (type === "maj")
    return `${salut} les dates ont changé${pour} : ${quand}. Peux-tu me confirmer ta disponibilité ?\nRéponds en un clic : ${lien}`;
  if (type === "info") return `${salut} petite mise à jour${pour} : tu es désormais attendu(e) ${quand}. Merci !`;
  if (type === "annulation") return `${salut} la prestation${pour} (${quand}) est annulée, ne tiens pas compte de ma demande précédente. Merci !`;
  return `${salut} es-tu disponible ${quand}${pour} ?\nRéponds en un clic : ${lien}`;
}

export const lienWhatsApp = (tel, texte) => `https://wa.me/${telephone(tel)}?text=${encodeURIComponent(texte)}`;

export function trouverTentative(db, id) {
  for (const p of db.prestations)
    for (const d of p.demandes) {
      const t = d.tentatives.find((x) => x.id === id);
      if (t) return { p, d, t };
    }
  return null;
}

export function trouverDemande(db, id) {
  for (const p of db.prestations) {
    const d = p.demandes.find((x) => x.id === id);
    if (d) return { p, d };
  }
  return null;
}
