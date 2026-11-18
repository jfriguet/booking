import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Copie le projet dans un dossier temporaire en remplaçant @netlify/blobs par un faux stockage
// avec ETag (même comportement que le vrai pour les écritures conditionnelles).
const tmp = mkdtempSync(join(tmpdir(), "api-test-"));
cpSync("public", join(tmp, "public"), { recursive: true });
mkdirSync(join(tmp, "netlify/functions"), { recursive: true });
const src = readFileSync("netlify/functions/api.mjs", "utf8").replace(
  'import { getStore } from "@netlify/blobs";',
  `const mem = (globalThis.__mem ??= new Map());
   globalThis.__conflits = 0;
   const getStore = () => ({
     async getWithMetadata(k) { const v = mem.get(k); return v ? { data: JSON.parse(v.json), etag: String(v.n), metadata: {} } : null; },
     async setJSON(k, data, o = {}) {
       const v = mem.get(k);
       if (o.onlyIfNew && v) return { modified: false };
       if (o.onlyIfMatch && (!v || String(v.n) !== o.onlyIfMatch)) return { modified: false };
       if (globalThis.__injecter) { const f = globalThis.__injecter; globalThis.__injecter = null; await f(); if (o.onlyIfMatch && String(mem.get(k).n) !== o.onlyIfMatch) return { modified: false }; }
       mem.set(k, { json: JSON.stringify(data), n: (v?.n ?? 0) + 1 });
       return { modified: true, etag: String(mem.get(k).n) };
     },
   });`
);
writeFileSync(join(tmp, "netlify/functions/api.mjs"), src);
process.env.ADMIN_PASSWORD = "secret";
const { default: handler } = await import(pathToFileURL(join(tmp, "netlify/functions/api.mjs")).href);

const call = async (path, method = "GET", body, admin = true) => {
  const r = await handler(new Request("http://x/api/" + path, {
    method,
    headers: { ...(admin ? { "x-admin-password": "secret" } : {}), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: r.status, data: await r.json() };
};
const tok = () => "tok" + Math.random().toString(36).slice(2).padEnd(20, "x");

test("scénario complet", async () => {
  assert.equal((await call("data", "GET", null, false)).status, 401);

  // base : intermittents
  const imp = await call("intermittents/import", "POST", {
    lignes: [
      { nom: "Jean Dupont", tel: "06 12 34 56 78", metiers: "Ingénieur du son" },
      { nom: "Marie Roy", tel: "0611223344", metiers: "Sound Engineer, Opérateur Barco S3/E2" },
      { nom: "Paul Martin", tel: "0699887766", metiers: "Ingénieur du son; Chauffeur" },
    ],
  });
  assert.deepEqual(imp.data.rapport, { crees: 3, maj: 0, inconnus: ["Chauffeur"] });
  const db0 = imp.data.db;
  assert.equal(db0.metiers.length, 9);
  const [jean, marie, paul] = db0.intermittents;
  assert.deepEqual(marie.metiers.sort(), ["barco", "son"]);

  // prestation avec 2 demandes (nouvelles salles créées automatiquement)
  const cr = await call("prestations", "POST", {
    nom: "Séminaire X", client: "ACME",
    demandes: [
      { salle: "SCENE ABC", metierId: "son", dates: ["2026-12-08", "2026-12-09", "2026-12-10"] },
      { salle: "loft gh", metierId: "son", dates: ["2026-12-10"] },
      { salle: "general", metierId: "regisseur", dates: ["2026-12-08"] },
    ],
  });
  assert.equal(cr.status, 200);
  let db = cr.data.db;
  const P = db.prestations[0];
  assert.deepEqual(db.salles.map((s) => s.nom).sort(), ["SCENE ABC", "loft gh"]);
  assert.equal(P.demandes[2].salle, "Général");
  const [dABC, dLoft] = P.demandes;

  // contacter Jean sur ABC
  let r = await call(`demandes/${dABC.id}/tentatives`, "POST", { intermittentId: jean.id, token: tok() });
  assert.equal(r.status, 200);
  db = r.data.db;
  const tJean = db.prestations[0].demandes[0].tentatives[0];
  assert.equal(tJean.statut, "en_attente");

  // jeton invalide / déjà contacté
  assert.equal((await call(`demandes/${dABC.id}/tentatives`, "POST", { intermittentId: paul.id, token: "court" })).status, 400);
  assert.equal((await call(`demandes/${dABC.id}/tentatives`, "POST", { intermittentId: jean.id, token: tok() })).status, 409);

  // Jean dit NON (page publique)
  const pub = await call("reponse?t=" + tJean.token, "GET", null, false);
  assert.equal(pub.data.prenom, "Jean");
  assert.equal(pub.data.client, "ACME");
  assert.equal(pub.data.datesTexte, "du 8 au 10 décembre 2026");
  assert.equal(pub.data.salle, undefined); // la salle et le poste ne sont jamais exposés
  r = await call("reponse", "POST", { t: tJean.token, reponse: "non" }, false);
  assert.equal(r.data.statut, "refuse");
  db = (await call("data")).data;
  assert.equal(db.prestations[0].demandes[0].tentatives[0].statut, "refuse");

  // Jean ne peut plus être reproposé sur cette demande ; Marie oui → elle dit OUI
  assert.equal((await call(`demandes/${dABC.id}/tentatives`, "POST", { intermittentId: jean.id, token: tok() })).status, 409);
  const tm = tok();
  await call(`demandes/${dABC.id}/tentatives`, "POST", { intermittentId: marie.id, token: tm });
  await call("reponse", "POST", { t: tm, reponse: "oui" }, false);
  db = (await call("data")).data;
  assert.equal(db.prestations[0].demandes[0].tentatives[1].statut, "confirme");

  // Marie confirmée du 8 au 10 → occupée pour le loft du 10
  assert.equal((await call(`demandes/${dLoft.id}/tentatives`, "POST", { intermittentId: marie.id, token: tok() })).status, 409);
  // Paul peut faire le loft
  r = await call(`demandes/${dLoft.id}/tentatives`, "POST", { intermittentId: paul.id, token: tok() });
  assert.equal(r.status, 200);
  // demande déjà pourvue : on ne peut plus contacter personne
  assert.equal((await call(`demandes/${dABC.id}/tentatives`, "POST", { intermittentId: paul.id, token: tok() })).status, 409);

  // changement de dates : 8-10 → 9-10 ; Marie (confirmée) doit être prévenue, Jean (refus) recontactable
  r = await call(`demandes/${dABC.id}`, "POST", { dates: ["2026-12-09", "2026-12-10"] });
  const act = Object.fromEntries(r.data.impacts.map((i) => [i.intermittentId, i.action]));
  assert.deepEqual(act, { [jean.id]: "recontacter", [marie.id]: "prevenir" });
  db = r.data.db;
  const tMarie = db.prestations[0].demandes[0].tentatives[1];
  assert.equal(tMarie.statut, "confirme");
  assert.equal(tMarie.aPrevenir, true);
  r = await call(`tentatives/${tMarie.id}/envoye`, "POST", {});
  assert.equal(r.data.db.prestations[0].demandes[0].tentatives[1].aPrevenir, false);

  // changer le métier d'une demande contactée est refusé
  assert.equal((await call(`demandes/${dABC.id}`, "POST", { metierId: "barco" })).status, 409);

  // indisponibilité manuelle
  r = await call(`intermittents/${paul.id}/indispos`, "POST", { debut: "2026-12-20", fin: "2026-12-22", motif: "congés" });
  assert.equal(r.data.db.intermittents[2].indispos.length, 1);

  // suppressions protégées
  assert.equal((await call(`intermittents/${marie.id}`, "DELETE")).status, 409);
  assert.equal((await call(`metiers/son`, "DELETE")).status, 409);
  await call(`intermittents/${marie.id}/archive`, "POST", { archive: true });

  // validation à la création
  assert.equal((await call("prestations", "POST", { demandes: [{ salle: "A", metierId: null, dates: ["2026-12-08"] }] })).status, 400);
  assert.equal((await call("prestations", "POST", { demandes: [{ salle: "A", metierId: "son", dates: [] }] })).status, 400);

  // suppression d'une demande puis de la prestation
  r = await call(`demandes/${dLoft.id}`, "DELETE");
  assert.equal(r.data.db.prestations[0].demandes.length, 2);
  r = await call(`prestations/${P.id}`, "DELETE");
  assert.equal(r.data.db.prestations.length, 0);
  assert.equal((await call("reponse?t=nope", "GET", null, false)).status, 404);
});

test("modifications simultanées : aucune n'est perdue", async () => {
  const avant = (await call("data")).data.salles.length;
  // pendant que la 1re requête écrit, une 2e s'intercale et modifie la base
  globalThis.__injecter = async () => {
    await call("salles", "POST", { nom: "Salle B" });
  };
  const r = await call("salles", "POST", { nom: "Salle A" });
  assert.equal(r.status, 200);
  const noms = (await call("data")).data.salles.map((s) => s.nom);
  assert.equal(noms.length, avant + 2);
  assert.ok(noms.includes("Salle A") && noms.includes("Salle B"));
});
