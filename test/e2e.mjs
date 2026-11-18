// Test de bout en bout dans un vrai navigateur (Chromium) avec le devis d'exemple.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { demarrer } from "./serve.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const OUT = process.env.SHOTS || "/tmp/planning-intermittents/shots";
mkdirSync(OUT, { recursive: true });

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

const { server, url } = await demarrer(8899);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const erreurs = [];
page.on("pageerror", (e) => erreurs.push("pageerror: " + e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && erreurs.push("console: " + m.text())); // le 401 vient du faux mot de passe volontaire
await page.addInitScript(() => {
  window.__ouvertures = [];
  window.open = (u) => { window.__ouvertures.push(u); return {}; };
  window.confirm = () => true;
});

const api = async (path, method = "GET", body) => {
  const r = await fetch(url + "/api/" + path, { method, headers: { "x-admin-password": "secret", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });

try {
  // 1. connexion (mauvais puis bon mot de passe)
  await page.goto(url);
  await page.fill("#pwd", "faux");
  await page.click("#loginBtn");
  await page.waitForSelector("#loginErr:not(:empty)");
  await page.fill("#pwd", "secret");
  await page.click("#loginBtn");
  await page.waitForSelector("#tab-cal .grid");

  // 2. base : import depuis Excel
  await page.click('nav [data-tab="base"]');
  await page.fill("#importTxt", [
    "Nom\tTéléphone\tMétiers",
    "Jean Dupont\t06 12 34 56 78\tIngénieur du son, Chef d'équipement",
    "Marie Roy\t06 11 22 33 44\tSound Engineer, Opérateur Barco S3/E2",
    "Paul Martin\t06 99 88 77 66\tIngénieur du son",
    "Lea Bernard\t06 55 44 33 22\tPupitreur lumière, Opérateur Barco S3/E2",
    "Tom Petit\t06 77 66 55 44\tRégisseur",
  ].join("\n"));
  await page.click('[data-act="import"]');
  await page.waitForSelector("text=5 créé(s)");
  assert.equal(await page.locator("#tab-base table").first().locator("tr").count(), 6);
  await shot("1-base");

  // 3. nouvelle prestation : collage du devis d'exemple
  await page.click('nav [data-tab="new"]');
  await page.fill("#devisTxt", DEVIS);
  await page.click('[data-act="analyser"]');
  await page.waitForSelector("#draftZone .dform");
  assert.equal(await page.locator("#draftZone .dform").count(), 7);
  assert.ok(await page.locator("#draftZone .note", { hasText: "sans date" }).count());
  await shot("2-brouillon");
  // les 3 demandes sans date : on complète (le 17 nov) — les 3 premiers formulaires
  for (let i = 0; i < 3; i++) {
    await page.fill(`[data-from="d:${i}"]`, "2026-11-17");
    await page.click(`[data-act="adddate"][data-ctx="d:${i}"]`);
  }
  await page.fill('[data-bind="client"][data-ctx="d"]', "ACME");
  await page.click('[data-act="creer"]');
  await page.waitForSelector("#modal.open .dcard");

  // 4. fenêtre de la prestation : onglets par salle
  const onglets = await page.locator("#sheet .stabs button").allTextContents();
  assert.deepEqual(onglets.map((s) => s.trim()), ["SCENE ABC", "Général"]);
  await shot("3-prestation");

  // 5. booking : l'ingé son de la salle ABC du 17 nov
  const carteSon = page.locator(".dcard", { hasText: "Ingénieur du son" }).first();
  assert.ok(await carteSon.locator("select[data-cand] option:not([disabled])").count() >= 3);
  await carteSon.locator("select[data-cand]").selectOption({ label: "Jean Dupont" });
  await carteSon.locator('[data-act="contacter"]').click();
  await page.waitForSelector(".dcard .badge:has-text('En attente')");
  const urls = await page.evaluate(() => window.__ouvertures);
  assert.equal(urls.length, 1);
  const wa = decodeURIComponent(urls[0]);
  assert.match(wa, /wa\.me\/33612345678/);
  assert.match(wa, /Bonjour Jean/);
  assert.match(wa, /le 17 novembre 2026 pour ACME/);
  assert.doesNotMatch(wa, /SCENE|Ingénieur|son\b.*salle/i); // ni la salle ni le poste
  const token = wa.match(/r\.html\?t=([\w-]+)/)[1];

  // 6. l'intermittent répond NON depuis la page publique
  const pub = await ctx.newPage();
  await pub.goto(`${url}/r.html?t=${token}`);
  await pub.waitForSelector("text=Es-tu disponible");
  assert.ok(await pub.locator("text=ACME").count());
  assert.equal(await pub.locator("text=SCENE").count(), 0);
  await pub.click("#non");
  await pub.waitForSelector("text=pas disponible");
  await pub.screenshot({ path: `${OUT}/4-reponse.png` });

  // 7. retour sur le site : actualiser → la demande est « à rebooker » et Jean est grisé
  await page.click('[data-act="close-modal"]');
  await page.click('[data-act="refresh"]');
  await page.click(".chipcal >> nth=0");
  await page.waitForSelector(".dcard");
  const carteSon2 = page.locator(".dcard", { hasText: "Ingénieur du son" }).first();
  assert.ok(await carteSon2.locator(".badge", { hasText: "À rebooker" }).count());
  assert.ok(await carteSon2.locator("option[disabled]", { hasText: "Jean Dupont" }).count());
  await shot("5-rebooker");

  // 8. on propose un autre intermittent, il répond OUI → la demande passe au vert
  await carteSon2.locator("select[data-cand]").selectOption({ label: "Marie Roy" });
  await carteSon2.locator('[data-act="contacter"]').click();
  await page.waitForSelector(".dcard .trow:has-text('Marie Roy')");
  const t2 = decodeURIComponent((await page.evaluate(() => window.__ouvertures)).at(-1)).match(/r\.html\?t=([\w-]+)/)[1];
  await fetch(`${url}/api/reponse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: t2, reponse: "oui" }) });
  await page.click('[data-act="close-modal"]');
  await page.click('[data-act="refresh"]');
  await page.click(".chipcal >> nth=0");
  await page.waitForSelector(".dcard");
  assert.ok(await page.locator(".dcard.st-complete", { hasText: "Ingénieur du son" }).count());

  // 9. changement de dates : on ajoute le 19 nov à la demande confirmée → Marie doit reconfirmer
  await page.locator(".dcard.st-complete", { hasText: "Ingénieur du son" }).locator('[data-act="edit-d"]').click();
  await page.fill('[data-from="e"]', "2026-11-19");
  await page.click('[data-act="adddate"][data-ctx="e"]');
  await page.click('[data-act="save-edit"]');
  await page.waitForSelector("text=Dates modifiées");
  assert.ok(await page.locator('[data-act="env"]', { hasText: "Envoyer la mise à jour" }).count());
  await page.locator('[data-act="env"]', { hasText: "Envoyer la mise à jour" }).click();
  await page.waitForFunction(() => window.__ouvertures.length >= 3);
  const maj = decodeURIComponent((await page.evaluate(() => window.__ouvertures)).at(-1));
  assert.match(maj, /les dates ont changé pour ACME : du 17 au 19 novembre 2026|le 17 novembre et le 19 novembre 2026/);
  await shot("6-maj-dates");

  // 10. calendrier filtré par intermittent
  await page.click('[data-act="close-modal"]');
  await page.selectOption('select[data-filter="inter"]', { label: "Jean Dupont" });
  await page.waitForSelector(".chipcal.c-refuse");
  await shot("7-filtre-jean");
  await page.selectOption('select[data-filter="inter"]', { value: "" });

  // 11. indisponibilité manuelle de Paul + calendrier filtré
  await page.click('nav [data-tab="base"]');
  await page.click('tr:has-text("Paul Martin") [data-act="fi-edit"]');
  await page.fill("#indDebut", "2026-11-23");
  await page.fill("#indFin", "2026-11-25");
  await page.fill("#indMotif", "autre mission");
  await page.click('[data-act="indispo-add"]');
  await page.waitForSelector(".chip:has-text('autre mission')");

  await page.click('nav [data-tab="cal"]');
  const paul = (await api("data")).intermittents.find((i) => i.nom === "Paul Martin");
  await page.selectOption('select[data-filter="inter"]', paul.id);
  await page.waitForSelector(".chipcal.c-indispo");
  assert.equal(await page.locator(".chipcal.c-indispo").count(), 3);
  await shot("8-filtre-paul");

  // 12. page de réponse sur mobile
  const mob = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  const mp = await mob.newPage();
  await mp.goto(`${url}/r.html?t=${token}`);
  await mp.waitForSelector("text=Es-tu disponible");
  await mp.screenshot({ path: `${OUT}/9-mobile-reponse.png` });

  assert.deepEqual(erreurs, [], "erreurs JS dans la page : " + erreurs.join(" | "));
  console.log("E2E OK — captures dans", OUT);
} catch (e) {
  await shot("echec").catch(() => {});
  console.error("E2E ÉCHEC :", e.message, erreurs.length ? "\nErreurs JS : " + erreurs.join(" | ") : "");
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
