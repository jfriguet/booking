// Test de la lecture d'un vrai PDF (tableau de devis généré par Chromium).
// Le lecteur pdf.js, normalement chargé depuis cdnjs, est servi localement pour ce test.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { demarrer } from "./serve.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const { server, url } = await demarrer(8898);
const browser = await chromium.launch();

const ligne = (a, b, c, d, e) => `<tr><td>${a}</td><td>${b}</td><td>${c}</td><td>${d}</td><td>${e}</td></tr>`;
const html = `<html><body style="font-family:Arial;font-size:12px"><h2>DEVIS</h2><table cellpadding="4">
<tr><td colspan="5"><b>TUESDAY 17 NOV</b></td></tr>
<tr><td colspan="5"><b>SCENE ABC</b></td></tr>
<tr><td colspan="5">Event 09.30-17.45:</td></tr>
${ligne("Barco E2/S3 Operator", "Day", "660,00 €", "1", "660,00 €")}
${ligne("Sound Engineer", "Day", "600,00 €", "2", "1 200,00 €")}
${ligne("Meal expenses for 1 person", "", "22,00 €", "3", "66,00 €")}
<tr><td colspan="5"><b>- WEDNESDAY 18 NOV</b></td></tr>
<tr><td colspan="5"><b>GENERAL MANAGER</b></td></tr>
${ligne("Technical Manager", "Day", "630,00 €", "1", "630,00 €")}
<tr><td colspan="5"><b>LOFT GH</b></td></tr>
${ligne("Sound Engineer", "Day", "600,00 €", "1", "600,00 €")}
</table></body></html>`;

const gen = await browser.newPage();
await gen.setContent(html);
const pdfPath = "/tmp/planning-intermittents/shots/devis-test.pdf";
writeFileSync(pdfPath, await gen.pdf({ format: "A4" }));

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const erreurs = [];
page.on("pageerror", (e) => erreurs.push(e.message));
await page.route("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/*", (route) => {
  const f = route.request().url().split("/").pop();
  route.fulfill({ contentType: "text/javascript", body: readFileSync("node_modules/pdfjs-dist/build/" + f) });
});
try {
  await page.goto(url);
  await page.fill("#pwd", "secret");
  await page.click("#loginBtn");
  await page.waitForSelector("#tab-cal .grid");
  await page.click('nav [data-tab="new"]');
  await page.setInputFiles("#devisPdf", pdfPath);
  await page.waitForSelector("#draftZone .dform", { timeout: 30000 });

  const texte = await page.inputValue("#devisTxt");
  console.log("--- texte extrait du PDF ---\n" + texte + "\n---");
  const demandes = await page.locator("#draftZone .dform").count();
  const salles = await page.locator('#draftZone [data-bind="salle"]').evaluateAll((els) => els.map((e) => e.value));
  const metiers = await page.locator('#draftZone select[data-bind="metierId"]').evaluateAll((els) => els.map((e) => e.selectedOptions[0].textContent));
  console.log("salles :", salles, "\nmétiers :", metiers);
  // SCENE ABC : barco + 2 ingés son (le 2e est une 2e demande) ; Général : régisseur ; LOFT GH : ingé son
  assert.equal(demandes, 5);
  assert.deepEqual(salles.sort(), ["Général", "LOFT GH", "SCENE ABC", "SCENE ABC", "SCENE ABC"]);
  assert.equal(await page.locator("#draftZone .note").count(), 0, "aucun avertissement attendu : toutes les dates sont lues");
  assert.deepEqual(erreurs, []);
  console.log("PDF OK");
} catch (e) {
  await page.screenshot({ path: "/tmp/planning-intermittents/shots/pdf-echec.png" });
  console.error("PDF ÉCHEC :", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
