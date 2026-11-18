import * as L from "./logic.js";
import { parserDevis } from "./parser.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let db = null;
let pwd = "";
try { pwd = sessionStorage.getItem("pwd") || ""; } catch { /* stockage indisponible */ }

const auj = new Date();
const ui = {
  tab: "cal",
  mois: { y: auj.getFullYear(), m: auj.getMonth() },
  fInter: "",
  fMetier: "",
  openP: null,
  salleTab: null,
  edit: null, // { id|null, nouveau, salle, metierId, dates }
  editHead: false,
  banner: "",
  draft: null,
  fi: { id: null, nom: "", tel: "", metiers: [] },
  archives: false,
  rapport: "",
};
let dlg = null;

/* ---------- utilitaires ---------- */

const metierNom = (id) => db.metiers.find((m) => m.id === id)?.nom ?? "Métier ?";
const interDe = (id) => db.intermittents.find((i) => i.id === id);
const fmtCourt = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const fmtLong = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const aujourdhuiIso = () => L.isoDe(new Date(Date.UTC(auj.getFullYear(), auj.getMonth(), auj.getDate())));

function genToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = "none"), 4500);
}

async function api(path, method = "GET", body) {
  const r = await fetch("/api/" + path, {
    method,
    headers: { "x-admin-password": pwd, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) {
    deconnecter();
    throw new Error("Mot de passe incorrect");
  }
  if (!r.ok) throw new Error(data.error || "Erreur");
  if (data.db) db = data.db;
  else if (path === "data") db = data;
  return data;
}

/** Appelle l'API, rafraîchit l'affichage, affiche l'erreur éventuelle. */
async function agir(path, method, body) {
  try {
    const d = await api(path, method, body);
    render();
    return d;
  } catch (e) {
    toast(e.message);
    return null;
  }
}

/* ---------- connexion ---------- */

async function connecter() {
  pwd = $("#pwd").value || pwd;
  $("#loginErr").textContent = "";
  try {
    await api("data");
    try { sessionStorage.setItem("pwd", pwd); } catch { /* ignoré */ }
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    render();
  } catch (e) {
    $("#loginErr").textContent = "Mot de passe incorrect (ou ADMIN_PASSWORD non défini sur Netlify).";
  }
}
function deconnecter() {
  try { sessionStorage.removeItem("pwd"); } catch { /* ignoré */ }
  pwd = "";
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#pwd").value = "";
}

/* ---------- affichage général ---------- */

function allerA(tab) {
  ui.tab = tab;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  for (const t of ["cal", "new", "base"]) $("#tab-" + t).classList.toggle("hidden", t !== tab);
  render();
}

function render() {
  if (!db) return;
  $("#dl-salles").innerHTML = [L.GENERAL, ...db.salles.map((s) => s.nom)].map((n) => `<option value="${esc(n)}">`).join("");
  if (ui.tab === "cal") renderCal();
  if (ui.tab === "base") renderBase();
  if (ui.openP) renderModal();
}

/* ---------- calendrier ---------- */

function entrees(key) {
  const out = [];
  const fi = ui.fInter;
  const fm = ui.fMetier;
  if (fi) {
    const inter = interDe(fi);
    for (const p of db.prestations)
      for (const d of p.demandes) {
        if (!d.dates.includes(key) || (fm && d.metierId !== fm)) continue;
        for (const t of d.tentatives)
          if (t.intermittentId === fi)
            out.push({ pid: p.id, cls: "c-" + t.statut, titre: p.nom, sous: `${d.salle} · ${L.TENT_LABEL[t.statut]}` });
      }
    if (!fm && inter)
      for (const ind of inter.indispos || [])
        if (ind.debut <= key && key <= (ind.fin || ind.debut)) out.push({ cls: "c-indispo", titre: "Indisponible", sous: ind.motif || "" });
    return out;
  }
  for (const p of db.prestations) {
    const ds = p.demandes.filter((d) => d.dates.includes(key) && (!fm || d.metierId === fm));
    if (!ds.length) continue;
    if (fm) {
      for (const d of ds) out.push({ pid: p.id, cls: "c-" + L.demandeStatut(d), titre: p.nom, sous: `${d.salle} · ${L.STATUT_LABEL[L.demandeStatut(d)]}` });
    } else {
      const ok = ds.filter((d) => L.demandeStatut(d) === "complete").length;
      out.push({ pid: p.id, cls: "c-" + L.prestationStatut(p), titre: p.nom, sous: `${ok}/${ds.length} pourvu(s)${p.client ? " · " + p.client : ""}` });
    }
  }
  return out;
}

function renderCal() {
  const { y, m } = ui.mois;
  const inters = db.intermittents.filter((i) => !i.archive).sort((a, b) => a.nom.localeCompare(b.nom));
  const premier = new Date(Date.UTC(y, m, 1));
  const decalage = (premier.getUTCDay() + 6) % 7;
  const titre = premier.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  const aujIso = aujourdhuiIso();
  const compte = {};
  let cases = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((d) => `<div class="dow">${d}</div>`).join("");
  for (let n = 0; n < 42; n++) {
    const d = new Date(Date.UTC(y, m, 1 - decalage + n));
    const key = L.isoDe(d);
    const hors = d.getUTCMonth() !== m;
    let cell = `<div class="day${hors ? " out" : ""}${key === aujIso ? " today" : ""}"><div class="num">${d.getUTCDate()}</div>`;
    for (const e of entrees(key)) {
      if (!hors) compte[e.cls] = (compte[e.cls] || 0) + 1;
      cell += e.pid
        ? `<button class="chipcal ${e.cls}" data-act="open" data-p="${e.pid}"><b>${esc(e.titre)}</b><small>${esc(e.sous)}</small></button>`
        : `<div class="chipcal static ${e.cls}"><b>${esc(e.titre)}</b><small>${esc(e.sous)}</small></div>`;
    }
    cases += cell + "</div>";
  }

  let resume = "";
  if (ui.fInter) {
    const i = interDe(ui.fInter);
    const n = (c) => compte[c] || 0;
    resume = `<div class="note ${n("c-confirme") ? "green" : ""}"><b>${esc(i?.nom)}</b> en ${esc(titre)} : ${n("c-confirme")} jour(s) booké(s), ${n("c-en_attente") + n("c-a_envoyer")} en attente de réponse, ${n("c-refuse") + n("c-indispo")} jour(s) indisponible(s).</div>`;
  }
  const aBooker = db.prestations.filter((p) => L.prestationStatut(p) !== "complete").length;

  $("#tab-cal").innerHTML = `
    <div class="card">
      <div class="filters">
        <div><label>Filtrer par intermittent</label>
          <select data-filter="inter"><option value="">Tous</option>${inters.map((i) => `<option value="${i.id}"${ui.fInter === i.id ? " selected" : ""}>${esc(i.nom)}</option>`).join("")}</select></div>
        <div><label>Filtrer par métier</label>
          <select data-filter="metier"><option value="">Tous</option>${db.metiers.map((x) => `<option value="${x.id}"${ui.fMetier === x.id ? " selected" : ""}>${esc(x.nom)}</option>`).join("")}</select></div>
        <button class="btn" data-act="refresh">Actualiser</button>
      </div>
      <div class="cal-head">
        <button class="btn small" data-act="prev">←</button>
        <h2>${esc(titre)}</h2>
        <button class="btn small" data-act="today">Aujourd'hui</button>
        <button class="btn small" data-act="next">→</button>
      </div>
      ${resume}
      <div class="grid">${cases}</div>
      <div class="legend">
        ${ui.fInter
          ? `<span><i class="sw v"></i> Booké</span><span><i class="sw o"></i> En attente de réponse</span><span><i class="sw r"></i> Indisponible</span>`
          : `<span><i class="sw g"></i> À booker</span><span><i class="sw o"></i> Booking en cours</span><span><i class="sw v"></i> Complète</span>`}
        <span style="margin-left:auto">${aBooker} prestation(s) pas encore complète(s)</span>
      </div>
    </div>`;
}

/* ---------- fenêtre d'une prestation ---------- */

function ouvrirPrestation(id, salle) {
  ui.openP = id;
  ui.salleTab = salle || null;
  ui.edit = null;
  ui.editHead = false;
  ui.banner = "";
  $("#modal").classList.add("open");
  renderModal();
}
function fermerModal() {
  ui.openP = null;
  ui.edit = null;
  $("#modal").classList.remove("open");
}

const premiereSalleABooker = (p) => L.salles(p).find((s) => L.groupeStatut(p.demandes.filter((d) => d.salle === s)) !== "complete");

function renderModal() {
  const p = db.prestations.find((x) => x.id === ui.openP);
  if (!p) {
    fermerModal();
    return;
  }
  const salles = L.salles(p);
  if (!salles.includes(ui.salleTab)) ui.salleTab = premiereSalleABooker(p) || salles[0];
  const st = L.prestationStatut(p);
  const dates = L.datesPrestation(p);
  const conf = L.conflits(db);

  const onglets = salles
    .map((s) => {
      const gs = L.groupeStatut(p.demandes.filter((d) => d.salle === s));
      return `<button class="${s === ui.salleTab ? "on" : ""}" data-act="tab-salle" data-salle="${esc(s)}"><i class="dot ${gs}"></i>${esc(s)}</button>`;
    })
    .join("");

  const demandes = p.demandes.filter((d) => d.salle === ui.salleTab);
  let cartes = demandes.map((d) => carteDemande(p, d, conf)).join("");
  if (ui.edit && ui.edit.nouveau) cartes += formDemande(ui.edit, "e", { boutons: boutonsEdition(true) });

  const entete = ui.editHead
    ? `<div class="two"><div><label>Nom de la prestation</label><input id="hNom" value="${esc(p.nom)}"></div><div><label>Client</label><input id="hClient" value="${esc(p.client)}"></div></div>
       <div class="row" style="margin-top:10px"><button class="btn primary small" data-act="save-head">Enregistrer</button><button class="btn small" data-act="cancel-head">Annuler</button></div>`
    : `<div><h2>${esc(p.nom)}</h2><span class="badge b-${st}">${L.STATUT_LABEL[st]}</span>
       <div class="muted" style="margin-top:4px">Client : ${esc(p.client || "—")} · ${esc(L.formatDates(dates))}</div></div>`;

  $("#sheet").innerHTML = `
    <div class="mhead">${entete}
      <div class="row"><button class="btn small" data-act="edit-head">Modifier nom / client</button><button class="btn small" data-act="close-modal">Fermer</button></div>
    </div>
    ${ui.banner ? `<div class="note">${esc(ui.banner)}</div>` : ""}
    <div class="toolbar">
      <button class="btn primary" data-act="faire-booking">Faire le booking</button>
      <button class="btn" data-act="add-demande">+ Ajouter une demande</button>
      <button class="btn danger" data-act="del-p" style="margin-left:auto">Supprimer la prestation</button>
    </div>
    <div class="stabs">${onglets}</div>
    ${cartes || `<p class="muted">Aucune demande dans cette salle.</p>`}`;
}

function carteDemande(p, d, conf) {
  if (ui.edit && !ui.edit.nouveau && ui.edit.id === d.id) return formDemande(ui.edit, "e", { boutons: boutonsEdition(false) });
  const st = L.demandeStatut(d);
  const cands = L.candidats(db, d);
  const prop = cands.filter(L.proposable);
  const aRebooker = st === "a_booker" && d.tentatives.length > 0;
  const horaires = [...new Set(Object.values(d.horaires || {}))].join(" · ");

  let h = `<div class="dcard st-${st}" data-d="${d.id}">
    <div class="dhead"><b>${esc(metierNom(d.metierId))}</b>
      <span class="badge b-${st}">${aRebooker ? "À rebooker" : L.STATUT_LABEL[st]}</span>
      <button class="btn small" data-act="edit-d" data-id="${d.id}">Modifier</button></div>
    <div class="muted">${esc(L.formatDates(d.dates))}${horaires ? " · " + esc(horaires) : ""}</div>`;

  for (const t of d.tentatives) h += ligneTentative(p, d, t, conf);

  if (st !== "complete") {
    if (!cands.length) h += `<div class="note red">Aucun intermittent n'a ce métier dans la base de données.</div>`;
    else if (!prop.length) h += `<div class="note red">Plus personne à proposer pour cette demande : tous ont refusé, sont occupés ou indisponibles.</div>`;
    if (cands.length)
      h += `<div class="book"><select data-cand="${d.id}">${optionsCandidats(cands)}</select>
        <button class="btn primary" data-act="contacter" data-id="${d.id}">Contacter par WhatsApp</button></div>`;
  }
  if (d.historique?.length)
    h += `<details class="hist"><summary>Historique (${d.historique.length})</summary>${d.historique
      .slice()
      .reverse()
      .map((x) => `<div>${new Date(x.at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} — ${esc(x.texte)}</div>`)
      .join("")}</details>`;
  return h + "</div>";
}

function optionsCandidats(cands) {
  let h = `<option value="">Choisir un intermittent…</option>`;
  for (const c of cands) {
    if (L.proposable(c))
      h += `<option value="${c.inter.id}">${esc(c.inter.nom)}${c.etat === "attente_ailleurs" ? " ⚠ " + esc(c.detail) : ""}${L.telephone(c.inter.tel) ? "" : " (pas de numéro)"}</option>`;
    else h += `<option value="" disabled>${esc(c.inter.nom)} — ${esc(c.detail)}</option>`;
  }
  return h;
}

function ligneTentative(p, d, t, conf) {
  const i = interDe(t.intermittentId);
  const notes = [];
  if (t.statut === "a_envoyer") notes.push(t.msgType === "maj" ? "Dates modifiées : message à renvoyer" : "Message à envoyer");
  if (t.aPrevenir) notes.push("Dates raccourcies : à prévenir");
  if (t.recontacter) notes.push("Avait refusé : les dates ont changé, le recontacter ?");
  if (conf.has(t.id)) notes.push("⚠ Confirmé(e) sur deux demandes aux mêmes dates");
  let acts = "";
  if (t.statut === "a_envoyer") acts += `<button class="btn small primary" data-act="env" data-t="${t.id}">${t.msgType === "maj" ? "Envoyer la mise à jour" : "Envoyer WhatsApp"}</button>`;
  if (t.statut === "en_attente")
    acts += `<button class="btn small" data-act="env" data-t="${t.id}">Relancer</button><button class="btn small" data-act="oui" data-t="${t.id}" title="Il a répondu oui autrement que par le lien">A dit oui</button><button class="btn small" data-act="non" data-t="${t.id}" title="Il a répondu non autrement que par le lien">A dit non</button>`;
  if (t.statut === "confirme") {
    if (t.aPrevenir) acts += `<button class="btn small primary" data-act="prevenir" data-t="${t.id}">Prévenir par WhatsApp</button>`;
    acts += `<button class="btn small" data-act="non" data-t="${t.id}">Finalement non</button>`;
  }
  if (t.statut === "refuse" && t.recontacter) acts += `<button class="btn small primary" data-act="recontacter" data-t="${t.id}">Recontacter</button>`;
  acts += `<button class="btn small danger" data-act="retirer" data-t="${t.id}" title="Retirer de la demande">✕</button>`;
  return `<div class="trow"><div class="who"><b>${esc(i?.nom)}</b><small>${esc(i?.tel || "pas de numéro")}</small>${notes.map((n) => `<small style="color:var(--orange-ink)">${esc(n)}</small>`).join("")}</div>
    <span class="badge b-${t.statut}">${L.TENT_LABEL[t.statut]}</span><div class="acts">${acts}</div></div>`;
}

/* ---------- formulaires de demande ---------- */

function editeurDates(dates, ctx) {
  return `<div class="chips">${dates
    .map((d) => `<span class="chip">${esc(fmtCourt(d))}<button type="button" data-act="rmdate" data-ctx="${ctx}" data-date="${d}" aria-label="Retirer">×</button></span>`)
    .join("") || `<span class="muted">Aucune date</span>`}</div>
    <div class="row"><input type="date" data-from="${ctx}"><input type="date" data-to="${ctx}" title="Facultatif : fin de plage"><button type="button" class="btn small" data-act="adddate" data-ctx="${ctx}">Ajouter</button></div>`;
}

function optionsMetiers(sel) {
  return `<option value="">Choisir…</option>` + db.metiers.map((m) => `<option value="${m.id}"${m.id === sel ? " selected" : ""}>${esc(m.nom)}</option>`).join("");
}

function formDemande(x, ctx, o = {}) {
  const manque = !x.salle || !x.metierId || !x.dates.length;
  return `<div class="dform${manque ? " warn" : ""}">
    ${o.libelle ? `<div class="muted">Lu dans le devis : « ${esc(o.libelle)} »</div>` : ""}
    <div class="two">
      <div><label>Salle</label><input list="dl-salles" data-bind="salle" data-ctx="${ctx}" value="${esc(x.salle)}" placeholder="Salle ou Général"></div>
      <div><label>Métier</label><select data-bind="metierId" data-ctx="${ctx}">${optionsMetiers(x.metierId)}</select></div>
    </div>
    <label>Date(s)</label>${editeurDates(x.dates, ctx)}
    <div class="row" style="margin-top:10px">${o.boutons || ""}</div></div>`;
}

const boutonsEdition = (nouveau) =>
  `<button class="btn primary small" data-act="save-edit">Enregistrer</button><button class="btn small" data-act="cancel-edit">Annuler</button>${
    nouveau ? "" : `<button class="btn small danger" data-act="del-d" style="margin-left:auto">Supprimer la demande</button>`
  }`;

function getRef(ctx) {
  if (ctx === "e") return ui.edit;
  if (ctx === "d") return ui.draft;
  if (ctx.startsWith("d:")) return ui.draft?.demandes[+ctx.slice(2)];
  return null;
}
function rerenderCtx(ctx) {
  if (ctx === "e") renderModal();
  else renderDraft();
}

/* ---------- dialogue d'annulation ---------- */

function demanderSuppression({ titre, intro, contacts, okLabel, onOk }) {
  if (!contacts.length) {
    if (confirm(titre + " ?")) onOk();
    return;
  }
  dlg = { contacts, onOk };
  $("#dlgSheet").innerHTML = `<h2>${esc(titre)}</h2><p>${esc(intro)}</p>${contacts
    .map((c, i) => `<div class="trow"><div class="who"><b>${esc(c.nom)}</b><small>${c.tel ? "" : "pas de numéro"}</small></div><div class="acts"><button class="btn small" data-act="dlg-wa" data-i="${i}">Prévenir par WhatsApp</button></div></div>`)
    .join("")}
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn" data-act="dlg-close">Annuler</button><button class="btn danger" data-act="dlg-ok">${esc(okLabel)}</button></div>`;
  $("#dialog").classList.add("open");
}

function contactsAnnulation(p, demandes) {
  const out = [];
  for (const d of demandes)
    for (const t of d.tentatives) {
      if (t.statut !== "en_attente" && t.statut !== "confirme") continue;
      const i = interDe(t.intermittentId);
      out.push({ nom: i?.nom, tel: i?.tel, msg: L.messageWhatsApp({ type: "annulation", nom: i?.nom, client: p.client, dates: d.dates }) });
    }
  return out;
}

/* ---------- WhatsApp ---------- */

function ouvrirWhatsApp(tel, msg) {
  if (!L.telephone(tel)) {
    toast("Pas de numéro de téléphone pour cet intermittent.");
    return false;
  }
  const w = window.open(L.lienWhatsApp(tel, msg), "_blank");
  if (!w) {
    toast("Le navigateur a bloqué l'ouverture de WhatsApp : autorise les fenêtres pop-up pour ce site.");
    return false;
  }
  return true;
}
const lienReponse = (token) => `${location.origin}/r.html?t=${token}`;

function messagePour(p, d, t, type) {
  return L.messageWhatsApp({ type, nom: interDe(t.intermittentId)?.nom, client: p.client, dates: d.dates, lien: lienReponse(t.token) });
}

/* ---------- nouvelle prestation ---------- */

async function chargerPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = res;
    s.onerror = () => rej(new Error("Impossible de charger le lecteur PDF. Colle le texte du devis à la place."));
    document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return window.pdfjsLib;
}

async function extrairePdf(file) {
  const lib = await chargerPdfJs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const contenu = await (await pdf.getPage(n)).getTextContent();
    const items = contenu.items.filter((it) => it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lignes = [];
    for (const it of items) {
      const l = lignes[lignes.length - 1];
      if (l && Math.abs(l.y - it.y) <= 3) l.items.push(it);
      else lignes.push({ y: it.y, items: [it] });
    }
    pages.push(lignes.map((l) => l.items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim()).join("\n"));
  }
  return pages.join("\n");
}

function analyser() {
  const txt = $("#devisTxt").value.trim();
  if (!txt) return toast("Colle d'abord le texte du devis.");
  const r = parserDevis(txt, { metiers: db.metiers, salles: db.salles.map((s) => s.nom) });
  ui.draft = { nom: r.nom, client: r.client, demandes: r.demandes, warnings: r.warnings, err: "" };
  renderDraft();
}

function renderDraft() {
  const z = $("#draftZone");
  const d = ui.draft;
  if (!d) {
    z.innerHTML = "";
    return;
  }
  z.innerHTML = `<div class="card"><h2>Vérifie la prestation</h2>
    ${d.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join("")}
    <div class="two">
      <div><label>Nom de la prestation (facultatif)</label><input data-bind="nom" data-ctx="d" value="${esc(d.nom)}"></div>
      <div><label>Client</label><input data-bind="client" data-ctx="d" value="${esc(d.client)}" placeholder="Nom du client (utilisé dans le WhatsApp)"></div>
    </div>
    <h3>Demandes (une par salle, métier et période)</h3>
    ${d.demandes.map((x, i) => formDemande(x, "d:" + i, { libelle: x.libelle, boutons: `<button class="btn small danger" data-act="draft-del" data-i="${i}">Supprimer cette demande</button>` })).join("")}
    <div class="row"><button class="btn" data-act="draft-add">+ Ajouter une demande</button></div>
    <div class="err">${esc(d.err)}</div>
    <button class="btn primary" data-act="creer">Créer la prestation</button></div>`;
}

async function creerPrestation() {
  const d = ui.draft;
  for (const x of d.demandes) {
    if (!String(x.salle || "").trim() || !x.metierId || !x.dates.length) {
      d.err = "Chaque demande doit avoir une salle, un métier et au moins une date.";
      renderDraft();
      return;
    }
  }
  if (!d.demandes.length) {
    d.err = "Ajoute au moins une demande.";
    renderDraft();
    return;
  }
  const premiere = L.nettoyerDates(d.demandes.flatMap((x) => x.dates))[0];
  const r = await agir("prestations", "POST", {
    nom: d.nom,
    client: d.client,
    demandes: d.demandes.map((x) => ({ salle: x.salle, metierId: x.metierId, dates: x.dates, horaires: x.horaires })),
  });
  if (!r) return;
  ui.draft = null;
  $("#devisTxt").value = "";
  $("#draftZone").innerHTML = "";
  ui.mois = { y: +premiere.slice(0, 4), m: +premiere.slice(5, 7) - 1 };
  allerA("cal");
  ouvrirPrestation(r.prestationId, null);
}

/* ---------- base de données ---------- */

function renderBase() {
  const fi = ui.fi;
  const liste = db.intermittents.filter((i) => ui.archives || !i.archive).sort((a, b) => a.nom.localeCompare(b.nom));
  const editant = fi.id ? interDe(fi.id) : null;

  const lignes = liste
    .map(
      (i) => `<tr class="${i.archive ? "arch" : ""}"><td>${esc(i.nom)}${i.archive ? ' <span class="muted">(archivé)</span>' : ""}</td><td>${esc(i.tel)}</td>
      <td>${(i.metiers || []).map((id) => esc(metierNom(id))).join(", ")}</td><td>${(i.indispos || []).length || ""}</td>
      <td class="r"><button class="btn small" data-act="fi-edit" data-id="${i.id}">Modifier</button>
      <button class="btn small" data-act="fi-archive" data-id="${i.id}" data-val="${i.archive ? "" : "1"}">${i.archive ? "Réactiver" : "Archiver"}</button>
      <button class="btn small danger" data-act="fi-del" data-id="${i.id}">Supprimer</button></td></tr>`
    )
    .join("");

  const indispos = editant
    ? `<h3>Indisponibilités saisies à la main</h3>
       <div class="chips">${(editant.indispos || []).map((x) => `<span class="chip">${esc(fmtLong(x.debut))}${x.fin !== x.debut ? " → " + esc(fmtLong(x.fin)) : ""}${x.motif ? " · " + esc(x.motif) : ""}<button data-act="indispo-del" data-sid="${x.id}" aria-label="Supprimer">×</button></span>`).join("") || '<span class="muted">Aucune</span>'}</div>
       <div class="row"><input type="date" id="indDebut"><input type="date" id="indFin" title="Facultatif : dernier jour"><input id="indMotif" placeholder="Motif (facultatif)"><button class="btn small" data-act="indispo-add">Ajouter</button></div>`
    : "";

  $("#tab-base").innerHTML = `
    <div class="card"><h2>${editant ? "Modifier " + esc(editant.nom) : "Ajouter un intermittent"}</h2>
      <div class="two">
        <div><label>Nom</label><input data-fi="nom" value="${esc(fi.nom)}" placeholder="Prénom Nom"></div>
        <div><label>Téléphone (WhatsApp)</label><input data-fi="tel" value="${esc(fi.tel)}" placeholder="06 12 34 56 78 ou +33612345678" inputmode="tel"></div>
      </div>
      <label>Métiers</label>
      <div class="checks">${db.metiers.map((m) => `<label><input type="checkbox" data-fi-metier="${m.id}"${fi.metiers.includes(m.id) ? " checked" : ""}> ${esc(m.nom)}</label>`).join("")}</div>
      ${indispos}
      <div class="row" style="margin-top:12px"><button class="btn primary" data-act="fi-save">Enregistrer</button>${editant ? '<button class="btn" data-act="fi-cancel">Annuler</button>' : ""}</div>
    </div>

    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Intermittents (${liste.length})</h2>
      <label style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" data-archives${ui.archives ? " checked" : ""}> Voir les archivés</label></div>
      <table style="margin-top:8px"><tr><th>Nom</th><th>Téléphone</th><th>Métiers</th><th>Indispos</th><th></th></tr>${lignes || '<tr><td colspan="5" class="muted">Aucun intermittent pour l\'instant.</td></tr>'}</table>
    </div>

    <div class="card"><h2>Importer depuis Excel</h2>
      <p class="muted" style="margin-top:0">Copie des lignes depuis Excel (colonnes : Nom, Téléphone, Métiers séparés par des virgules) et colle-les ici. Un nom déjà présent est mis à jour.</p>
      <textarea id="importTxt" rows="5" placeholder="Jean Dupont&#9;06 12 34 56 78&#9;Ingénieur du son, Chef d'équipement"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn" data-act="import">Importer</button></div>
      ${ui.rapport ? `<div class="note green">${esc(ui.rapport)}</div>` : ""}
    </div>

    <div class="two">
      <div class="card"><h2>Salles</h2>
        <div class="row"><input id="salleNom" placeholder="Nom du salon"><button class="btn primary" data-act="salle-add">Ajouter</button></div>
        <table style="margin-top:8px">${db.salles.map((s) => `<tr><td>${esc(s.nom)}</td><td class="r"><button class="btn small" data-act="salle-ren" data-id="${s.id}">Renommer</button> <button class="btn small danger" data-act="salle-del" data-id="${s.id}">Supprimer</button></td></tr>`).join("") || '<tr><td class="muted">Aucune salle (elles se créent aussi toutes seules depuis les devis).</td></tr>'}</table>
        <p class="muted">« Général » existe toujours (régisseur, etc.).</p>
      </div>
      <div class="card"><h2>Sauvegarde</h2>
        <p class="muted" style="margin-top:0">Télécharge toutes les données (intermittents, salles, prestations) dans un fichier.</p>
        <button class="btn" data-act="backup">Télécharger une sauvegarde</button>
      </div>
    </div>

    <div class="card"><h2>Métiers et correspondances avec les devis</h2>
      <p class="muted" style="margin-top:0">Les mots-clés servent à reconnaître un poste dans un devis (ex. « Sound Engineer » → Ingénieur du son). Sépare-les par des virgules.</p>
      <table>${db.metiers.map((m) => `<tr data-m="${m.id}"><td><input data-mf="nom" value="${esc(m.nom)}"></td><td><input data-mf="aliases" value="${esc((m.aliases || []).join(", "))}"></td><td class="r"><button class="btn small" data-act="metier-save" data-id="${m.id}">Enregistrer</button> <button class="btn small danger" data-act="metier-del" data-id="${m.id}">Supprimer</button></td></tr>`).join("")}
        <tr><td><input id="mNom" placeholder="Nouveau métier"></td><td><input id="mAl" placeholder="mots-clés"></td><td class="r"><button class="btn small primary" data-act="metier-add">Ajouter</button></td></tr></table>
    </div>`;
}

/* ---------- gestion des clics ---------- */

document.addEventListener("click", async (e) => {
  if (e.target.id === "modal") return fermerModal();
  if (e.target.id === "dialog") return $("#dialog").classList.remove("open");
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const trouveT = () => L.trouverTentative(db, el.dataset.t);
  const modalP = () => db.prestations.find((x) => x.id === ui.openP);

  switch (act) {
    case "logout": return deconnecter();

    /* calendrier */
    case "prev": ui.mois = ui.mois.m === 0 ? { y: ui.mois.y - 1, m: 11 } : { y: ui.mois.y, m: ui.mois.m - 1 }; return renderCal();
    case "next": ui.mois = ui.mois.m === 11 ? { y: ui.mois.y + 1, m: 0 } : { y: ui.mois.y, m: ui.mois.m + 1 }; return renderCal();
    case "today": ui.mois = { y: auj.getFullYear(), m: auj.getMonth() }; return renderCal();
    case "refresh": try { await api("data"); render(); toast("Données à jour."); } catch (err) { toast(err.message); } return;
    case "open": return ouvrirPrestation(el.dataset.p, null);

    /* fenêtre prestation */
    case "close-modal": return fermerModal();
    case "tab-salle": ui.salleTab = el.dataset.salle; ui.edit = null; return renderModal();
    case "faire-booking": {
      const p = modalP();
      ui.salleTab = premiereSalleABooker(p) || ui.salleTab;
      ui.edit = null;
      renderModal();
      $("#sheet").querySelector(".stabs")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    case "edit-head": ui.editHead = true; return renderModal();
    case "cancel-head": ui.editHead = false; return renderModal();
    case "save-head": {
      const r = await agir(`prestations/${ui.openP}`, "POST", { nom: $("#hNom").value, client: $("#hClient").value });
      if (r) ui.editHead = false, renderModal();
      return;
    }
    case "add-demande": ui.edit = { id: null, nouveau: true, salle: ui.salleTab || "", metierId: "", dates: [] }; return renderModal();
    case "edit-d": {
      const f = L.trouverDemande(db, el.dataset.id);
      ui.edit = { id: f.d.id, nouveau: false, salle: f.d.salle, metierId: f.d.metierId, dates: [...f.d.dates] };
      ui.banner = "";
      return renderModal();
    }
    case "cancel-edit": ui.edit = null; return renderModal();
    case "save-edit": {
      const x = ui.edit;
      if (!String(x.salle).trim() || !x.metierId || !x.dates.length) return toast("Il faut une salle, un métier et au moins une date.");
      let r;
      if (x.nouveau) r = await agir(`prestations/${ui.openP}/demandes`, "POST", { salle: x.salle, metierId: x.metierId, dates: x.dates });
      else {
        const avant = L.trouverDemande(db, x.id).d;
        const corps = { salle: x.salle, dates: x.dates };
        if (x.metierId !== avant.metierId) corps.metierId = x.metierId;
        r = await agir(`demandes/${x.id}`, "POST", corps);
        if (r?.impacts?.length) ui.banner = `Dates modifiées : ${r.impacts.length} intermittent(s) concerné(s). Utilise les boutons ci-dessous pour les prévenir ou leur renvoyer le message.`;
      }
      if (r) {
        ui.salleTab = String(x.salle).trim();
        const p = modalP();
        if (p) ui.salleTab = L.salles(p).find((s) => L.normaliser(s) === L.normaliser(ui.salleTab)) || ui.salleTab;
        ui.edit = null;
        renderModal();
      }
      return;
    }
    case "del-d": {
      const p = modalP();
      const d = p.demandes.find((x) => x.id === ui.edit.id);
      return demanderSuppression({
        titre: "Supprimer cette demande",
        intro: "Des intermittents ont déjà été contactés. Tu peux les prévenir de l'annulation avant de supprimer.",
        contacts: contactsAnnulation(p, [d]),
        okLabel: "Supprimer la demande",
        onOk: async () => { ui.edit = null; await agir(`demandes/${d.id}`, "DELETE"); },
      });
    }
    case "del-p": {
      const p = modalP();
      return demanderSuppression({
        titre: "Supprimer la prestation",
        intro: "Des intermittents ont déjà été contactés. Tu peux les prévenir de l'annulation avant de supprimer.",
        contacts: contactsAnnulation(p, p.demandes),
        okLabel: "Supprimer la prestation",
        onOk: async () => { const r = await agir(`prestations/${p.id}`, "DELETE"); if (r) fermerModal(); },
      });
    }

    /* booking : tout ce qui ouvre WhatsApp s'exécute avant le premier await */
    case "contacter": {
      const sel = el.closest("[data-d]").querySelector("select[data-cand]");
      if (!sel.value) return toast("Choisis d'abord un intermittent dans la liste.");
      const f = L.trouverDemande(db, el.dataset.id);
      const inter = interDe(sel.value);
      const token = genToken();
      const msg = L.messageWhatsApp({ type: "initial", nom: inter.nom, client: f.p.client, dates: f.d.dates, lien: lienReponse(token) });
      if (!ouvrirWhatsApp(inter.tel, msg)) return;
      await agir(`demandes/${f.d.id}/tentatives`, "POST", { intermittentId: inter.id, token });
      return;
    }
    case "env": {
      const { p, d, t } = trouveT();
      if (!ouvrirWhatsApp(interDe(t.intermittentId)?.tel, messagePour(p, d, t, t.msgType === "maj" ? "maj" : "initial"))) return;
      await agir(`tentatives/${t.id}/envoye`, "POST", {});
      return;
    }
    case "prevenir": {
      const { p, d, t } = trouveT();
      if (!ouvrirWhatsApp(interDe(t.intermittentId)?.tel, messagePour(p, d, t, "info"))) return;
      await agir(`tentatives/${t.id}/envoye`, "POST", {});
      return;
    }
    case "recontacter": {
      const { p, d, t } = trouveT();
      if (!ouvrirWhatsApp(interDe(t.intermittentId)?.tel, messagePour(p, d, t, "initial"))) return;
      await agir(`tentatives/${t.id}/recontacter`, "POST", {});
      return;
    }
    case "oui": return void (await agir(`tentatives/${el.dataset.t}/statut`, "POST", { statut: "confirme" }));
    case "non": return void (await agir(`tentatives/${el.dataset.t}/statut`, "POST", { statut: "refuse" }));
    case "retirer": {
      const { p, d, t } = trouveT();
      return demanderSuppression({
        titre: `Retirer ${interDe(t.intermittentId)?.nom} de cette demande`,
        intro: "Cet intermittent a déjà été contacté. Tu peux le prévenir avant de le retirer.",
        contacts: t.statut === "en_attente" || t.statut === "confirme" ? contactsAnnulation(p, [{ ...d, tentatives: [t] }]) : [],
        okLabel: "Retirer",
        onOk: () => agir(`tentatives/${t.id}`, "DELETE"),
      });
    }

    /* dialogue */
    case "dlg-wa": { const c = dlg.contacts[+el.dataset.i]; return void ouvrirWhatsApp(c.tel, c.msg); }
    case "dlg-close": return $("#dialog").classList.remove("open");
    case "dlg-ok": { $("#dialog").classList.remove("open"); const f = dlg.onOk; dlg = null; return void (await f()); }

    /* dates (formulaires) */
    case "adddate": {
      const ctx = el.dataset.ctx;
      const a = document.querySelector(`[data-from="${ctx}"]`).value;
      const b = document.querySelector(`[data-to="${ctx}"]`).value || a;
      if (!a) return;
      const ref = getRef(ctx);
      ref.dates = L.nettoyerDates([...ref.dates, ...L.plage(a, b < a ? a : b)]);
      return rerenderCtx(ctx);
    }
    case "rmdate": { const ref = getRef(el.dataset.ctx); ref.dates = ref.dates.filter((x) => x !== el.dataset.date); return rerenderCtx(el.dataset.ctx); }

    /* nouvelle prestation */
    case "analyser": return analyser();
    case "manuel": ui.draft = { nom: "", client: "", demandes: [{ salle: "", metierId: "", libelle: "", dates: [], horaires: {} }], warnings: [], err: "" }; return renderDraft();
    case "draft-add": ui.draft.demandes.push({ salle: "", metierId: "", libelle: "", dates: [], horaires: {} }); return renderDraft();
    case "draft-del": ui.draft.demandes.splice(+el.dataset.i, 1); return renderDraft();
    case "creer": return creerPrestation();

    /* base de données */
    case "fi-edit": { const i = interDe(el.dataset.id); ui.fi = { id: i.id, nom: i.nom, tel: i.tel, metiers: [...(i.metiers || [])] }; renderBase(); return window.scrollTo({ top: 0, behavior: "smooth" }); }
    case "fi-cancel": ui.fi = { id: null, nom: "", tel: "", metiers: [] }; return renderBase();
    case "fi-save": {
      const r = await agir("intermittents", "POST", { id: ui.fi.id || undefined, nom: ui.fi.nom, tel: ui.fi.tel, metiers: ui.fi.metiers });
      if (r) ui.fi = { id: null, nom: "", tel: "", metiers: [] }, renderBase();
      return;
    }
    case "fi-archive": return void (await agir(`intermittents/${el.dataset.id}/archive`, "POST", { archive: !!el.dataset.val }));
    case "fi-del": if (confirm("Supprimer cet intermittent définitivement ?")) await agir(`intermittents/${el.dataset.id}`, "DELETE"); return;
    case "indispo-add": {
      const r = await agir(`intermittents/${ui.fi.id}/indispos`, "POST", { debut: $("#indDebut").value, fin: $("#indFin").value, motif: $("#indMotif").value });
      return r && renderBase();
    }
    case "indispo-del": return void (await agir(`intermittents/${ui.fi.id}/indispos/${el.dataset.sid}`, "DELETE"));
    case "import": {
      const lignes = $("#importTxt").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const c = l.includes("\t") ? l.split("\t") : l.split(";");
        return { nom: c[0], tel: c[1], metiers: c.slice(2).join(",") };
      }).filter((l) => !["nom", "name"].includes(L.normaliser(l.nom)));
      if (!lignes.length) return toast("Colle d'abord des lignes depuis Excel.");
      const r = await agir("intermittents/import", "POST", { lignes });
      if (r) {
        ui.rapport = `${r.rapport.crees} créé(s), ${r.rapport.maj} mis à jour.${r.rapport.inconnus.length ? " Métiers non reconnus (ignorés) : " + r.rapport.inconnus.join(", ") + "." : ""}`;
        renderBase();
      }
      return;
    }
    case "salle-add": { const n = $("#salleNom").value; if (n.trim()) await agir("salles", "POST", { nom: n }); return; }
    case "salle-ren": { const s = db.salles.find((x) => x.id === el.dataset.id); const n = prompt("Nouveau nom de la salle :", s.nom); if (n && n.trim()) await agir("salles", "POST", { id: s.id, nom: n }); return; }
    case "salle-del": if (confirm("Supprimer cette salle de la liste ? Les prestations existantes la gardent.")) await agir(`salles/${el.dataset.id}`, "DELETE"); return;
    case "metier-save": {
      const tr = el.closest("tr");
      return void (await agir("metiers", "POST", { id: el.dataset.id, nom: tr.querySelector('[data-mf="nom"]').value, aliases: tr.querySelector('[data-mf="aliases"]').value }));
    }
    case "metier-add": { const n = $("#mNom").value; if (n.trim()) await agir("metiers", "POST", { nom: n, aliases: $("#mAl").value }); return; }
    case "metier-del": if (confirm("Supprimer ce métier ?")) await agir(`metiers/${el.dataset.id}`, "DELETE"); return;
    case "backup": {
      try {
        const data = await api("data");
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `planning-sauvegarde-${aujourdhuiIso()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) { toast(err.message); }
      return;
    }
  }
});

/* champs de formulaire : on met à jour l'état sans réafficher (pas de perte de saisie) */
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.bind) {
    const ref = getRef(t.dataset.ctx);
    if (ref) ref[t.dataset.bind] = t.value;
  } else if (t.dataset.fi) ui.fi[t.dataset.fi] = t.value;
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.dataset.bind && t.tagName === "SELECT") {
    const ref = getRef(t.dataset.ctx);
    if (ref) ref[t.dataset.bind] = t.value;
  } else if (t.dataset.filter) {
    if (t.dataset.filter === "inter") ui.fInter = t.value;
    else ui.fMetier = t.value;
    renderCal();
  } else if (t.dataset.fiMetier) {
    const id = t.dataset.fiMetier;
    ui.fi.metiers = t.checked ? [...new Set([...ui.fi.metiers, id])] : ui.fi.metiers.filter((x) => x !== id);
  } else if (t.dataset.archives !== undefined) {
    ui.archives = t.checked;
    renderBase();
  } else if (t.id === "devisPdf" && t.files[0]) {
    try {
      toast("Lecture du PDF…");
      const txt = await extrairePdf(t.files[0]);
      if (!txt.trim()) return toast("Ce PDF ne contient pas de texte sélectionnable (scan ?). Colle le texte à la main.");
      $("#devisTxt").value = txt;
      analyser();
      toast("PDF lu : vérifie les demandes ci-dessous.");
    } catch (err) {
      toast(err.message || "Impossible de lire ce PDF.");
    }
  }
});

$("#nav").addEventListener("click", (e) => { if (e.target.dataset.tab) allerA(e.target.dataset.tab); });
$("#loginBtn").onclick = connecter;
$("#pwd").onkeydown = (e) => { if (e.key === "Enter") connecter(); };
if (pwd) connecter();
