import assert from "node:assert/strict";
import test from "node:test";
import * as L from "../public/logic.js";
import { parserDevis } from "../public/parser.js";

const AUJ = new Date("2026-11-18T00:00:00Z");

test("formatDates", () => {
  assert.equal(L.formatDates(["2026-11-18"]), "le 18 novembre 2026");
  assert.equal(L.formatDates(["2026-12-08", "2026-12-09", "2026-12-10"]), "du 8 au 10 décembre 2026");
  assert.equal(L.formatDates(["2026-12-08", "2026-12-12"]), "le 8 décembre et le 12 décembre 2026");
  assert.equal(L.formatDates(["2026-11-30", "2026-12-01"]), "du 30 novembre au 1er décembre 2026");
  assert.equal(L.formatDates(["2026-12-30", "2027-01-02"]), "le 30 décembre 2026 et le 2 janvier 2027");
});

test("telephone", () => {
  assert.equal(L.telephone("06 12 34 56 78"), "33612345678");
  assert.equal(L.telephone("+33 (0)6 12 34 56 78"), "33612345678");
  assert.equal(L.telephone("0033612345678"), "33612345678");
});

test("trouverMetier", () => {
  const m = L.METIERS_DEFAUT;
  const id = (s) => L.trouverMetier(s, m)?.id;
  assert.equal(id("Barco E2/S3 Operator"), "barco");
  assert.equal(id("Sound Engineer"), "son");
  assert.equal(id("Light Operator"), "lumiere");
  assert.equal(id("Technical Manager"), "regisseur");
  assert.equal(id("Ingénieur du son"), "son");
  assert.equal(id("Opérateur caméra tourelle"), "camera");
  assert.equal(id("Chauffeur"), undefined);
});

const DEVIS = `SCENE ABC
Event 09.30-17.45:
Barco E2/S3 Operator Day 660,00 € 1 1,00 660,00 € 660,00 €
Sound Engineer Day 600,00 € 1 1,00 600,00 € 600,00 €
Light Operator Day 610,00 € 1 1,00 610,00 € 610,00 €
Meal expenses for 1 person 22,00 € 3 1,00 66,00 € 66,00 €
- WEDNESDAY 18 NOV
GENERAL MANAGER
Technical Manager Day 630,00 € 1 1,00 630,00 € 630,00 €
Meal expenses for 1 person 22,00 € 1 1,00 22,00 € 22,00 €
SCENE ABC
Event 09.00-12.30, derig after show:
Barco E2/S3 Operator Day 660,00 € 1 1,00 660,00 € 660,00 €
Sound Engineer Day 600,00 € 1 1,00 600,00 € 600,00 €
Light Operator Day 610,00 € 1 1,00 610,00 € 610,00 €
Meal expenses for 1 `;

test("devis d'exemple", () => {
  const r = parserDevis(DEVIS, { aujourdhui: AUJ });
  const resume = r.demandes.map((d) => `${d.salle}|${d.metierId}|${d.dates.join(",") || "-"}`);
  assert.deepEqual(resume, [
    // 1er bloc (09.30-17.45) : l'en-tête de date manque dans le collage tronqué → signalé
    "SCENE ABC|barco|-",
    "SCENE ABC|son|-",
    "SCENE ABC|lumiere|-",
    // 2e bloc, sous « WEDNESDAY 18 NOV »
    "SCENE ABC|barco|2026-11-18",
    "SCENE ABC|son|2026-11-18",
    "SCENE ABC|lumiere|2026-11-18",
    "Général|regisseur|2026-11-18",
  ]);
  assert.ok(r.warnings.some((w) => /sans date/.test(w)));
  // le Technical Manager va dans Général
  assert.equal(r.demandes.at(-1).salle, "Général");
  assert.equal(r.demandes.at(-1).metierId, "regisseur");
  // horaires conservés pour les blocs datés
  assert.equal(r.demandes[3].horaires["2026-11-18"], "09:00–12:30");
});

test("regroupement multi-jours et quantités", () => {
  const txt = `- TUESDAY 8 DEC
SCENE ABC
Sound Engineer Day 600,00 € 2 1,00 1200,00 €
LOFT GH
Sound Engineer Day 600,00 € 1 1,00 600,00 €
- WEDNESDAY 9 DEC
SCENE ABC
Sound Engineer Day 600,00 € 1 1,00 600,00 €
- THURSDAY 10 DEC
SCENE ABC
Sound Engineer Day 600,00 € 1 1,00 600,00 €`;
  const r = parserDevis(txt, { aujourdhui: AUJ });
  const resume = r.demandes.map((d) => `${d.salle}|${d.metierId}|${d.dates.join(",")}`);
  assert.deepEqual(resume, [
    "SCENE ABC|son|2026-12-08,2026-12-09,2026-12-10", // 1er ingé son sur 3 jours
    "SCENE ABC|son|2026-12-08", // 2e ingé son le 8 seulement
    "LOFT GH|son|2026-12-08",
  ]);
  assert.equal(r.warnings.length, 0);
});

test("salles connues et dates françaises", () => {
  const txt = `Client : ACME
du 8 au 10 décembre
Loft GH
Ingénieur du son Jour 500,00 € 1`;
  const r = parserDevis(txt, { aujourdhui: AUJ, salles: ["Loft GH"] });
  assert.equal(r.client, "ACME");
  assert.deepEqual(r.demandes[0].dates, ["2026-12-08", "2026-12-09", "2026-12-10"]);
  assert.equal(r.demandes[0].salle, "Loft GH");
});

/* ---------- règles métier ---------- */

const mk = () => ({
  metiers: L.METIERS_DEFAUT,
  intermittents: [
    { id: "i1", nom: "Jean Dupont", tel: "0612345678", metiers: ["son"], indispos: [] },
    { id: "i2", nom: "Marie Roy", tel: "0611223344", metiers: ["son", "barco"], indispos: [{ id: "x", debut: "2026-12-09", fin: "2026-12-09", motif: "autre mission" }] },
  ],
  prestations: [],
});
const dem = (id, dates, tentatives = []) => ({ id, salle: "A", metierId: "son", dates, tentatives, historique: [] });

test("statuts", () => {
  const d = dem("d1", ["2026-12-08"]);
  assert.equal(L.demandeStatut(d), "a_booker");
  d.tentatives.push({ id: "t", intermittentId: "i1", statut: "en_attente" });
  assert.equal(L.demandeStatut(d), "en_cours");
  d.tentatives[0].statut = "refuse";
  assert.equal(L.demandeStatut(d), "a_booker");
  d.tentatives.push({ id: "t2", intermittentId: "i2", statut: "confirme" });
  assert.equal(L.demandeStatut(d), "complete");
  assert.equal(L.prestationStatut({ demandes: [d, dem("d2", [])] }), "en_cours");
  assert.equal(L.prestationStatut({ demandes: [d] }), "complete");
});

test("disponibilités et candidats", () => {
  const db = mk();
  const d1 = dem("d1", ["2026-12-08", "2026-12-09"]);
  db.prestations.push({ id: "p1", nom: "P1", demandes: [d1] });
  let c = L.candidats(db, d1);
  assert.equal(c.find((x) => x.inter.id === "i1").etat, "ok");
  assert.equal(c.find((x) => x.inter.id === "i2").etat, "indispo"); // indispo le 9
  // i1 confirmé ailleurs le 9 → occupé
  const d2 = dem("d2", ["2026-12-09"], [{ id: "t1", intermittentId: "i1", statut: "confirme" }]);
  db.prestations.push({ id: "p2", nom: "P2", demandes: [d2] });
  assert.equal(L.candidats(db, d1).find((x) => x.inter.id === "i1").etat, "occupe");
  // en attente ailleurs → proposable avec avertissement
  d2.tentatives[0].statut = "en_attente";
  assert.equal(L.candidats(db, d1).find((x) => x.inter.id === "i1").etat, "attente_ailleurs");
  // refus sur cette demande
  d1.tentatives.push({ id: "t9", intermittentId: "i1", statut: "refuse" });
  assert.equal(L.candidats(db, d1).find((x) => x.inter.id === "i1").etat, "refuse");
  // pas de métier barco pour i1
  const d3 = { ...dem("d3", ["2026-12-20"]), metierId: "barco" };
  assert.deepEqual(L.candidats(db, d3).map((x) => x.inter.id), ["i2"]);
});

test("changement de dates", () => {
  const T = (id, statut, extra = {}) => ({ id, intermittentId: id, statut, ...extra });
  const d = dem("d1", ["2026-12-08", "2026-12-09", "2026-12-10"], [
    T("a", "en_attente", { envoyeLe: "x", msgType: "initial" }),
    T("b", "confirme"),
    T("c", "refuse"),
    T("e", "a_envoyer", { msgType: "initial" }),
  ]);
  // raccourci 8-10 → 9-10
  let imp = L.appliquerChangementDates(d, ["2026-12-09", "2026-12-10"]);
  const act = Object.fromEntries(imp.map((i) => [i.tentativeId, i.action]));
  assert.deepEqual(act, { a: "renvoyer", b: "prevenir", c: "recontacter", e: "renvoyer" });
  assert.equal(d.tentatives[0].statut, "a_envoyer");
  assert.equal(d.tentatives[0].msgType, "maj");
  assert.equal(d.tentatives[1].statut, "confirme");
  assert.equal(d.tentatives[1].aPrevenir, true);
  assert.equal(d.tentatives[3].msgType, "initial"); // jamais envoyé
  // rallongé 9-10 → 8-10 : le confirmé repasse à reconfirmer
  d.tentatives[1].aPrevenir = false;
  imp = L.appliquerChangementDates(d, ["2026-12-08", "2026-12-09", "2026-12-10"]);
  assert.equal(imp.find((i) => i.tentativeId === "b").action, "reconfirmer");
  assert.equal(d.tentatives[1].statut, "a_envoyer");
  assert.equal(d.historique.length, 2);
  // pas de changement
  assert.deepEqual(L.appliquerChangementDates(d, ["2026-12-08", "2026-12-09", "2026-12-10"]), []);
});

test("messages WhatsApp : seulement client et dates", () => {
  const msg = L.messageWhatsApp({ nom: "Jean Dupont", client: "ACME", dates: ["2026-12-08", "2026-12-09"], lien: "https://x/r.html?t=abc" });
  assert.match(msg, /Bonjour Jean/);
  assert.match(msg, /du 8 au 9 décembre 2026 pour ACME/);
  assert.match(msg, /https:\/\/x\/r\.html\?t=abc/);
  assert.doesNotMatch(msg, /salle|scène|ingé|son/i);
});

test("conflits", () => {
  const db = mk();
  db.prestations.push({ id: "p", nom: "P", demandes: [
    dem("d1", ["2026-12-08"], [{ id: "t1", intermittentId: "i1", statut: "confirme" }]),
    dem("d2", ["2026-12-08"], [{ id: "t2", intermittentId: "i1", statut: "confirme" }]),
  ] });
  assert.deepEqual([...L.conflits(db)].sort(), ["t1", "t2"]);
});
