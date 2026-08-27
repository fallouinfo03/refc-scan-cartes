/* =========================================================================
   CONFIGURATION — REFC Cartes de visite
   =========================================================================
   Ce fichier est le SEUL endroit à modifier pour brancher l'app sur le
   Google Sheet du REFC. Tout le reste (app.js) n'a pas besoin d'être touché.

   ÉTAPES POUR ACTIVER L'ENVOI VERS GOOGLE SHEETS :

   1. Ouvrir (ou créer) le Google Sheet du REFC qui servira de fichier
      central des contacts. Première ligne = en-têtes, par exemple :
      Nom | Organisation | Téléphone | Pays | Courriel | Site web |
      Titre / Notes | Contexte | Date d'ajout

   2. Dans ce Sheet : Extensions > Apps Script

   3. Coller le code de "apps-script.gs" (fourni séparément) dans l'éditeur,
      puis Déployer > Nouveau déploiement > Type: Application web
        - Exécuter en tant que : Moi
        - Qui a accès : Tout le monde
      Copier l'URL de déploiement obtenue (se termine par /exec)

   4. Coller cette URL ci-dessous dans WEBHOOK_URL

   Tant que WEBHOOK_URL est vide, l'app fonctionne quand même : elle
   sauvegarde les cartes localement sur le téléphone (mémoire du navigateur)
   et vous pourrez les exporter/copier manuellement en attendant.
   ========================================================================= */

const CONFIG = {
  // Coller ici l'URL de déploiement Apps Script (se termine par /exec)
  WEBHOOK_URL: "https://script.google.com/macros/s/AKfycbxaa9B_7ia-cOh_gwpxKOcCp1LHIx4p9LFROSn88CJhcct6Q381ij4mi3NPHrQDaKAKGg/exec",

  // Nom affiché en haut de l'app
  APP_TITLE: "Cartes de visite",

  // Suggestions rapides de "contexte" (salons/événements courants du REFC)
  // Modifiable librement — sert juste à accélérer la saisie, pas obligatoire.
  CONTEXTES_SUGGERES: [
    "Salon du livre de Montréal",
    "Salon du livre de l'Outaouais",
    "Salon international du livre de Québec",
    "Foire de Francfort",
    "Foire de Bologne",
    "Autre événement"
  ]
};
