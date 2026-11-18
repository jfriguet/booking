// API du planning intermittents.
// Stockage : Netlify Blobs (gratuit, rien à configurer). Variable obligatoire : ADMIN_PASSWORD
// Les écritures sont conditionnelles (ETag) : si deux personnes modifient en même temps,
// la 2e opération est rejouée sur les données à jour au lieu d'écraser la 1re.

import { getStore } from "@netlify/blobs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as L from "../../public/logic.js";

export const config = { path: "/api/*" };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const exiger = (cond, msg, status = 400) => {
  if (!cond) throw new HttpError(status, msg);
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const uid = () => randomUUID().slice(0, 8);
const maintenant = () => new Date().toISOString();
const texte = (s) => String(s ?? "").trim();

/* ---------- base de données ---------- */

function nouvelleBase() {
  return {
    version: 2,
    metiers: L.METIERS_DEFAUT.map((m) => ({ ...m, aliases: [...m.aliases] })),
    salles: [],
    intermittents: [],
    prestations: [],
  };
}

function migrer(db) {
  db.metiers ??= [];
  db.salles ??= [];
  db.intermittents ??= [];
  db.prestations ??= [];
  return db;
}

async function mutate(store, fn) {
  for (let essai = 0; essai < 6; essai++) {
    const cur = await store.getWithMetadata("db", { type: "json" });
    const db = migrer(cur ? cur.data : nouvelleBase());
    const extra = (await fn(db)) || {};
    const res = await store.setJSON("db", db, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return { ok: true, db, ...extra };
  }
  throw new HttpError(503, "Trop de modifications simultanées, réessaie dans un instant.");
}

async function lire(store) {
  const cur = await store.getWithMetadata("db", { type: "json" });
  return migrer(cur ? cur.data : nouvelleBase());
}

/* ---------- authentification ---------- */

const sha = (s) => createHash("sha256").update(String(s)).digest();
function estAdmin(req) {
  const pwd = process.env.ADMIN_PASSWORD;
  if (!pwd) return false;
  return timingSafeEqual(sha(req.headers.get("x-admin-password") ?? ""), sha(pwd));
}

/* ---------- helpers métier ---------- */

function salleNom(db, brut) {
  const nom = texte(brut).replace(/\s+/g, " ");
  exiger(nom, "Salle requise");
  if (L.normaliser(nom) === L.normaliser(L.GENERAL) || L.normaliser(nom) === "general") return L.GENERAL;
  const connue = db.salles.find((s) => L.normaliser(s.nom) === L.normaliser(nom));
  if (connue) return connue.nom;
  db.salles.push({ id: uid(), nom });
  return nom;
}

function creerDemande(db, b) {
  exiger(db.metiers.some((m) => m.id === b.metierId), "Métier à choisir pour chaque demande");
  const dates = L.nettoyerDates(b.dates);
  exiger(dates.length, "Chaque demande doit avoir au moins une date");
  const horaires = {};
  for (const [d, h] of Object.entries(b.horaires || {})) if (dates.includes(d)) horaires[d] = texte(h);
  return {
    id: uid(),
    salle: salleNom(db, b.salle),
    metierId: b.metierId,
    dates,
    horaires,
    tentatives: [],
    historique: [{ at: maintenant(), texte: "Demande créée" }],
  };
}

const listeAliases = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[,\n;]/)).map((s) => texte(s)).filter(Boolean);

function nomInter(db, id) {
  return db.intermittents.find((i) => i.id === id)?.nom ?? "?";
}

/* ---------- routes admin ---------- */

function route(db, parts, m, b) {
  const [res, id, sub, sid] = parts;

  /* salles */
  if (res === "salles") {
    if (m === "POST" && !id) {
      const nom = texte(b.nom);
      exiger(nom, "Nom requis");
      exiger(L.normaliser(nom) !== "general", "« Général » existe déjà");
      if (b.id) {
        const s = db.salles.find((x) => x.id === b.id);
        exiger(s, "Salle introuvable", 404);
        const ancien = s.nom;
        s.nom = nom;
        for (const p of db.prestations) for (const d of p.demandes) if (d.salle === ancien) d.salle = nom;
      } else {
        exiger(!db.salles.some((s) => L.normaliser(s.nom) === L.normaliser(nom)), "Cette salle existe déjà", 409);
        db.salles.push({ id: uid(), nom });
      }
      return;
    }
    if (m === "DELETE" && id) {
      db.salles = db.salles.filter((s) => s.id !== id);
      return;
    }
  }

  /* métiers */
  if (res === "metiers") {
    if (m === "POST" && !id) {
      const nom = texte(b.nom);
      exiger(nom, "Nom requis");
      const aliases = listeAliases(b.aliases);
      if (b.id) {
        const x = db.metiers.find((y) => y.id === b.id);
        exiger(x, "Métier introuvable", 404);
        x.nom = nom;
        x.aliases = aliases;
      } else {
        exiger(!db.metiers.some((y) => L.normaliser(y.nom) === L.normaliser(nom)), "Ce métier existe déjà", 409);
        db.metiers.push({ id: uid(), nom, aliases });
      }
      return;
    }
    if (m === "DELETE" && id) {
      exiger(!db.intermittents.some((i) => (i.metiers || []).includes(id)), "Ce métier est attribué à des intermittents", 409);
      exiger(!db.prestations.some((p) => p.demandes.some((d) => d.metierId === id)), "Ce métier est utilisé dans des prestations", 409);
      db.metiers = db.metiers.filter((x) => x.id !== id);
      return;
    }
  }

  /* intermittents */
  if (res === "intermittents") {
    if (m === "POST" && id === "import") {
      const rapport = { crees: 0, maj: 0, inconnus: [] };
      for (const l of b.lignes || []) {
        const nom = texte(l.nom);
        if (!nom) continue;
        const ids = [];
        for (const mot of String(l.metiers ?? "").split(/[,;|\n]/).map(texte).filter(Boolean)) {
          const mt = L.trouverMetier(mot, db.metiers);
          if (mt) ids.push(mt.id);
          else if (!rapport.inconnus.includes(mot)) rapport.inconnus.push(mot);
        }
        const ex = db.intermittents.find((i) => L.normaliser(i.nom) === L.normaliser(nom));
        if (ex) {
          if (texte(l.tel)) ex.tel = texte(l.tel);
          ex.metiers = [...new Set([...(ex.metiers || []), ...ids])];
          rapport.maj++;
        } else {
          db.intermittents.push({ id: uid(), nom, tel: texte(l.tel), metiers: [...new Set(ids)], indispos: [], archive: false });
          rapport.crees++;
        }
      }
      return { rapport };
    }
    if (m === "POST" && !id) {
      const nom = texte(b.nom);
      exiger(nom, "Nom requis");
      const metiers = [...new Set((b.metiers || []).filter((x) => db.metiers.some((y) => y.id === x)))];
      if (b.id) {
        const i = db.intermittents.find((x) => x.id === b.id);
        exiger(i, "Intermittent introuvable", 404);
        Object.assign(i, { nom, tel: texte(b.tel), metiers });
      } else {
        db.intermittents.push({ id: uid(), nom, tel: texte(b.tel), metiers, indispos: [], archive: false });
      }
      return;
    }
    const i = db.intermittents.find((x) => x.id === id);
    if (id && id !== "import") exiger(i, "Intermittent introuvable", 404);
    if (m === "POST" && sub === "archive") {
      i.archive = !!b.archive;
      return;
    }
    if (m === "POST" && sub === "indispos") {
      exiger(L.dateValide(b.debut), "Date de début invalide");
      const fin = b.fin && L.dateValide(b.fin) ? b.fin : b.debut;
      exiger(fin >= b.debut, "La date de fin précède le début");
      (i.indispos ??= []).push({ id: uid(), debut: b.debut, fin, motif: texte(b.motif) });
      return;
    }
    if (m === "DELETE" && sub === "indispos" && sid) {
      i.indispos = (i.indispos || []).filter((x) => x.id !== sid);
      return;
    }
    if (m === "DELETE" && !sub) {
      const utilise = db.prestations.some((p) => p.demandes.some((d) => d.tentatives.some((t) => t.intermittentId === id)));
      exiger(!utilise, "Cet intermittent apparaît dans des prestations : archive-le plutôt que de le supprimer.", 409);
      db.intermittents = db.intermittents.filter((x) => x.id !== id);
      return;
    }
  }

  /* prestations */
  if (res === "prestations") {
    if (m === "POST" && !id) {
      const demandes = (b.demandes || []).map((d) => creerDemande(db, d));
      exiger(demandes.length, "Ajoute au moins une demande");
      const toutes = L.nettoyerDates(demandes.flatMap((d) => d.dates));
      const p = {
        id: uid(),
        nom: texte(b.nom) || `Prestation ${L.formatDates(toutes)}`,
        client: texte(b.client),
        creeLe: maintenant(),
        demandes,
      };
      db.prestations.push(p);
      return { prestationId: p.id };
    }
    const p = db.prestations.find((x) => x.id === id);
    exiger(p, "Prestation introuvable", 404);
    if (m === "POST" && !sub) {
      if (b.nom !== undefined) p.nom = texte(b.nom) || p.nom;
      if (b.client !== undefined) p.client = texte(b.client);
      return;
    }
    if (m === "POST" && sub === "demandes") {
      p.demandes.push(creerDemande(db, b));
      return;
    }
    if (m === "DELETE" && !sub) {
      db.prestations = db.prestations.filter((x) => x.id !== id);
      return;
    }
  }

  /* demandes */
  if (res === "demandes") {
    const f = L.trouverDemande(db, id);
    exiger(f, "Demande introuvable", 404);
    const { p, d } = f;
    if (m === "POST" && !sub) {
      let impacts = [];
      if (b.metierId !== undefined && b.metierId !== d.metierId) {
        exiger(db.metiers.some((x) => x.id === b.metierId), "Métier inconnu");
        exiger(!d.tentatives.length, "Retire d'abord les intermittents contactés avant de changer le métier.", 409);
        d.metierId = b.metierId;
        d.historique.push({ at: maintenant(), texte: "Métier modifié" });
      }
      if (b.salle !== undefined && texte(b.salle) && texte(b.salle) !== d.salle) {
        const ancienne = d.salle;
        d.salle = salleNom(db, b.salle);
        d.historique.push({ at: maintenant(), texte: `Salle changée : ${ancienne} → ${d.salle}` });
      }
      if (b.dates !== undefined) {
        const nd = L.nettoyerDates(b.dates);
        exiger(nd.length, "Au moins une date est requise");
        impacts = L.appliquerChangementDates(d, nd);
        for (const k of Object.keys(d.horaires || {})) if (!nd.includes(k)) delete d.horaires[k];
      }
      return { impacts };
    }
    if (m === "DELETE" && !sub) {
      p.demandes = p.demandes.filter((x) => x.id !== id);
      if (!p.demandes.length) db.prestations = db.prestations.filter((x) => x.id !== p.id);
      return;
    }
    if (m === "POST" && sub === "tentatives") {
      const inter = db.intermittents.find((x) => x.id === b.intermittentId);
      exiger(inter && !inter.archive, "Intermittent introuvable", 404);
      exiger((inter.metiers || []).includes(d.metierId), "Cet intermittent n'a pas ce métier", 409);
      exiger(L.demandeStatut(d) !== "complete", "Cette demande est déjà pourvue", 409);
      const dispo = L.disponibilite(db, d, inter);
      exiger(dispo.etat === "ok" || dispo.etat === "attente_ailleurs", `${inter.nom} : ${dispo.detail}`, 409);
      exiger(/^[A-Za-z0-9_-]{16,64}$/.test(b.token || ""), "Jeton invalide");
      exiger(!db.prestations.some((q) => q.demandes.some((x) => x.tentatives.some((t) => t.token === b.token))), "Jeton déjà utilisé", 409);
      d.tentatives.push({
        id: uid(),
        intermittentId: inter.id,
        statut: "en_attente",
        token: b.token,
        msgType: "initial",
        aPrevenir: false,
        recontacter: false,
        creeLe: maintenant(),
        envoyeLe: maintenant(),
      });
      d.historique.push({ at: maintenant(), texte: `WhatsApp envoyé à ${inter.nom}` });
      return;
    }
  }

  /* tentatives (un intermittent sur une demande) */
  if (res === "tentatives") {
    const f = L.trouverTentative(db, id);
    exiger(f, "Introuvable", 404);
    const { d, t } = f;
    const nom = nomInter(db, t.intermittentId);
    if (m === "POST" && sub === "envoye") {
      if (t.statut === "a_envoyer") t.statut = "en_attente";
      t.aPrevenir = false;
      t.envoyeLe = maintenant();
      d.historique.push({ at: maintenant(), texte: `WhatsApp envoyé à ${nom}` });
      return;
    }
    if (m === "POST" && sub === "recontacter") {
      t.statut = "en_attente";
      t.msgType = "initial";
      t.recontacter = false;
      t.aPrevenir = false;
      t.envoyeLe = maintenant();
      d.historique.push({ at: maintenant(), texte: `${nom} recontacté(e) (nouvelles dates)` });
      return;
    }
    if (m === "POST" && sub === "statut") {
      exiger(["confirme", "refuse", "en_attente"].includes(b.statut), "Statut invalide");
      t.statut = b.statut;
      t.repondu = maintenant();
      t.aPrevenir = false;
      d.historique.push({ at: maintenant(), texte: `${nom} : ${L.TENT_LABEL[b.statut]} (saisi à la main)` });
      return;
    }
    if (m === "DELETE" && !sub) {
      d.tentatives = d.tentatives.filter((x) => x.id !== id);
      d.historique.push({ at: maintenant(), texte: `${nom} retiré(e) de la demande` });
      return;
    }
  }

  throw new HttpError(404, "Route inconnue");
}

/* ---------- réponse publique de l'intermittent ---------- */

async function reponsePublique(store, req, url) {
  if (req.method === "GET") {
    const db = await lire(store);
    const t = url.searchParams.get("t");
    for (const p of db.prestations)
      for (const d of p.demandes) {
        const x = d.tentatives.find((y) => y.token === t);
        if (x) {
          const inter = db.intermittents.find((i) => i.id === x.intermittentId);
          return json({ prenom: L.prenom(inter?.nom), client: p.client, dates: d.dates, datesTexte: L.formatDates(d.dates), statut: x.statut });
        }
      }
    return json({ error: "Lien invalide" }, 404);
  }
  if (req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    exiger(b.reponse === "oui" || b.reponse === "non", "Réponse invalide");
    const out = await mutate(store, (db) => {
      const f = db.prestations.flatMap((p) => p.demandes.map((d) => ({ d }))).find(({ d }) => d.tentatives.some((t) => t.token === b.t));
      exiger(f, "Lien invalide", 404);
      const t = f.d.tentatives.find((x) => x.token === b.t);
      t.statut = b.reponse === "oui" ? "confirme" : "refuse";
      t.repondu = maintenant();
      t.aPrevenir = false;
      t.recontacter = false;
      f.d.historique.push({ at: maintenant(), texte: `${nomInter(db, t.intermittentId)} a répondu : ${b.reponse === "oui" ? "OUI" : "NON"}` });
      return { statut: t.statut };
    });
    return json({ ok: true, statut: out.statut });
  }
  return json({ error: "Méthode non autorisée" }, 405);
}

/* ---------- point d'entrée ---------- */

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const store = getStore("planning");
  try {
    if (parts[0] === "reponse") return await reponsePublique(store, req, url);

    if (!estAdmin(req)) {
      await new Promise((r) => setTimeout(r, 400)); // freine les essais de mot de passe
      return json({ error: "Non autorisé" }, 401);
    }
    if (parts[0] === "data" && req.method === "GET") return json(await lire(store));

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const out = await mutate(store, (db) => route(db, parts, req.method, body));
    return json(out);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Erreur serveur" }, 500);
  }
};
