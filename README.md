# Planning intermittents

Site pour booker des intermittents à partir d'un devis : calendrier de prestations, envoi des demandes par WhatsApp (un clic), réponse de l'intermittent sur une petite page, suivi automatique.

## Le parcours

1. **Nouvelle prestation** : tu colles le texte du devis (ou tu déposes le PDF). Le site en extrait les salles, les dates et les postes (en anglais ou en français), tu vérifies et tu corriges, puis tu crées.
2. **Calendrier** : la prestation apparaît avec une couleur de statut : gris = à booker, orange = booking en cours, vert = complète.
3. **Faire le booking** : dans la fenêtre de la prestation, un onglet par salle. Pour chaque demande (un métier, une salle, une période), tu choisis un intermittent dans la liste (seuls ceux qui font ce métier sont proposés ; les occupés, indisponibles ou ayant déjà refusé sont grisés) et tu cliques sur « Contacter par WhatsApp ». Ton WhatsApp s'ouvre avec le message prêt (client + dates seulement) : tu appuies sur Envoyer.
4. **Réponse** : l'intermittent clique sur le lien et répond Oui ou Pas dispo. Oui : la demande passe au vert. Non : elle repasse « À rebooker » et tu choisis quelqu'un d'autre.
5. **Prestation complète** quand toutes ses demandes sont pourvues.

Autres fonctions :
- **Modifier** une demande (salle, métier, dates). Si les dates changent, le site gère les intermittents déjà contactés : message de mise à jour à renvoyer, intermittent confirmé à prévenir (dates raccourcies) ou à reconfirmer (dates rallongées), intermittent qui avait refusé à recontacter. Tout est consigné dans l'historique de la demande.
- **Supprimer** une demande ou une prestation : le site propose d'envoyer un WhatsApp d'annulation aux intermittents déjà contactés.
- **Filtres** du calendrier par intermittent (booké / en attente / indisponible) et par métier.
- **Indisponibilités** saisies à la main sur la fiche d'un intermittent.
- Un intermittent ne peut pas être sur deux demandes aux mêmes dates (quel que soit le métier).
- Pas de rafraîchissement automatique : bouton « Actualiser » sur le calendrier.

## Mise en ligne (gratuit)

1. Crée un dépôt GitHub et envoie-y le contenu de ce dossier.
2. Sur [netlify.com](https://netlify.com) : **Add new site → Import an existing project**, choisis le dépôt (les réglages viennent de `netlify.toml`).
3. **Site configuration → Environment variables** : ajoute `ADMIN_PASSWORD` (le mot de passe commun à l'équipe, long de préférence).
4. **Deploys → Trigger deploy** pour que la variable soit prise en compte.

Le glisser-déposer de dossier sur Netlify ne gère pas les fonctions serveur : passe par GitHub (ou par `netlify deploy` avec la CLI).

## Première utilisation

1. Onglet **Base de données** : importe tes intermittents depuis Excel (colonnes Nom, Téléphone, Métiers séparés par des virgules) ou ajoute-les un par un. Les 9 métiers sont déjà créés.
2. Les salles se créent toutes seules à partir des devis ; tu peux aussi les gérer à la main (et les renommer).
3. Si un poste de devis n'est pas reconnu, ajoute un mot-clé au métier concerné (tableau « Métiers et correspondances »).

## Données et limites

- Stockage : Netlify Blobs (inclus gratuitement, rien à configurer). Les modifications simultanées de plusieurs personnes sont fusionnées sans perte.
- Bouton **Télécharger une sauvegarde** dans la base de données.
- Le lecteur de PDF (pdf.js) est chargé depuis cdnjs au moment où tu dépose un PDF. Un PDF scanné (image) ne peut pas être lu : colle alors le texte.
- Le WhatsApp s'ouvre prêt à envoyer, mais c'est toi qui appuies sur Envoyer (l'envoi 100 % automatique exige l'API WhatsApp payante). Le navigateur doit autoriser les pop-up pour le site.
- Plan gratuit Netlify : 300 crédits par mois, limite stricte et jamais de facture ; cet usage en consomme très peu.
- Un seul mot de passe pour toute l'équipe.

## Tests (facultatif)

```bash
npm install
npm test                  # règles de gestion, lecture du devis, API
npm run test:navigateur   # parcours complet dans Chromium (nécessite Playwright)
npm run demo              # lance le site en local sur http://localhost:8899 (mot de passe : secret)
```
