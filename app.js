/* =========================================================================
   REFC — Cartes de visite
   Logique principale : capture photo (archive), saisie manuelle des champs,
   détection automatique du pays à partir de l'indicatif téléphonique,
   envoi vers Google Sheets (ou stockage local si non configuré).

   Note : une première version utilisait la reconnaissance de texte (OCR)
   automatique pour pré-remplir les champs. Sur des cartes de visite réelles
   (polices stylisées, mises en page non linéaires, faible contraste),
   la fiabilité s'est avérée trop faible pour être utile — corriger un texte
   mal lu prenait plus de temps que de le taper directement. On garde donc
   la photo comme archive/preuve visuelle, et la saisie se fait à la main,
   avec la seule automatisation fiable à ce stade : déduire le pays depuis
   l'indicatif du numéro de téléphone.
   ========================================================================= */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // État
  // ------------------------------------------------------------------
  const state = {
    rectoDataUrl: null,
    versoDataUrl: null,
    selectedContexte: ""
  };

  const STORAGE_KEY = "refc_cartes_local_v1";

  // ------------------------------------------------------------------
  // Petits utilitaires
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(id).classList.add("active");
    window.scrollTo(0, 0);
  }

  function showBanner(msg, isError) {
    const b = $("banner");
    b.textContent = msg;
    b.classList.remove("error");
    if (isError) b.classList.add("error");
    b.classList.add("show");
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => b.classList.remove("show"), 3200);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  // ------------------------------------------------------------------
  // Stockage local (file d'attente / historique)
  // ------------------------------------------------------------------
  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveLocal(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function addLocalEntry(entry) {
    const list = loadLocal();
    list.unshift(entry);
    saveLocal(list);
  }

  // ------------------------------------------------------------------
  // Détection automatique du pays à partir du numéro de téléphone
  // ------------------------------------------------------------------
  const COUNTRY_CODES = [
    { pattern: /^\+?86/, pays: "Chine" },
    { pattern: /^\+?33/, pays: "France" },
    { pattern: /^\+?32/, pays: "Belgique" },
    { pattern: /^\+?41/, pays: "Suisse" },
    { pattern: /^\+?44/, pays: "Royaume-Uni" },
    { pattern: /^\+?49/, pays: "Allemagne" },
    { pattern: /^\+?39/, pays: "Italie" },
    { pattern: /^\+?34/, pays: "Espagne" },
    { pattern: /^\+?351/, pays: "Portugal" },
    { pattern: /^\+?31/, pays: "Pays-Bas" },
    { pattern: /^\+?1/, pays: "Canada" } // +1 = Canada ou USA, Canada par défaut
  ];

  const NA_AREA_CODES = /\b(819|514|418|450|438|579|873|613|647|416|905|343|289|604|778|236|250|867|902|506|709)\b/;

  function detectCountryFromPhone(raw) {
    const cleaned = raw.trim();
    if (!cleaned) return "";

    const normalized = cleaned.replace(/^00/, "+");
    for (const entry of COUNTRY_CODES) {
      if (entry.pattern.test(normalized)) return entry.pays;
    }

    if (NA_AREA_CODES.test(cleaned)) return "Canada";

    return "";
  }

  // ------------------------------------------------------------------
  // Rendu de l'accueil (stats + historique récent)
  // ------------------------------------------------------------------
  function renderHome() {
    const list = loadLocal();
    const pending = list.filter((e) => !e.synced);

    $("statTotal").textContent = list.length;
    $("statPending").textContent = pending.length;

    $("configWarning").style.display = CONFIG.WEBHOOK_URL ? "none" : "block";

    const recentWrap = $("recentList");
    recentWrap.innerHTML = "";
    if (list.length === 0) {
      recentWrap.innerHTML = '<div class="empty-note">Aucune carte ajoutée pour l\'instant.<br>Appuyez sur « Nouvelle carte » pour commencer.</div>';
      return;
    }
    list.slice(0, 5).forEach((e) => {
      const div = document.createElement("div");
      div.className = "recent-item";
      div.innerHTML = `
        <div>
          <div class="name">${escapeHtml(e.nom || e.organisation || "(sans nom)")}</div>
          <div class="org">${escapeHtml(e.organisation || "")}</div>
        </div>
        <div class="badge">${e.synced ? "✓ Envoyé" : "En attente"}</div>
      `;
      recentWrap.appendChild(div);
    });
  }

  function renderFullHistory() {
    const list = loadLocal();
    const wrap = $("fullHistoryList");
    wrap.innerHTML = "";
    if (list.length === 0) {
      wrap.innerHTML = '<div class="empty-note">Aucune carte enregistrée.</div>';
      return;
    }
    list.forEach((e) => {
      const div = document.createElement("div");
      div.className = "recent-item";
      div.style.marginBottom = "8px";
      div.innerHTML = `
        <div>
          <div class="name">${escapeHtml(e.nom || e.organisation || "(sans nom)")}</div>
          <div class="org">${escapeHtml(e.organisation || "")} · ${escapeHtml(e.dateAjout || "")}</div>
        </div>
        <div class="badge">${e.synced ? "✓ Envoyé" : "En attente"}</div>
      `;
      wrap.appendChild(div);
    });
  }

  // ------------------------------------------------------------------
  // Envoi vers Google Sheets (ou file d'attente locale si non configuré)
  // ------------------------------------------------------------------
  async function sendToSheet(entry) {
    if (!CONFIG.WEBHOOK_URL) {
      return { ok: false, reason: "not_configured" };
    }
    try {
      const resp = await fetch(CONFIG.WEBHOOK_URL, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain" }, // évite le preflight CORS avec Apps Script
        body: JSON.stringify(entry)
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "network", error: e };
    }
  }

  // ------------------------------------------------------------------
  // Flux de capture + saisie
  // ------------------------------------------------------------------
  function resetCaptureState() {
    state.rectoDataUrl = null;
    state.versoDataUrl = null;

    $("boxRecto").classList.remove("filled");
    $("boxRecto").innerHTML = `
      <div class="cap-icon">📷</div>
      <div class="cap-label">Photo du recto</div>
      <div class="cap-sub">Sert d'archive — cadrez la carte bien à plat</div>
    `;
    $("boxVerso").classList.remove("filled");
    $("boxVerso").innerHTML = `
      <div class="cap-icon">📷</div>
      <div class="cap-label">Photo du verso</div>
      <div class="cap-sub">Uniquement si le verso contient de l'information utile</div>
    `;
    $("captureVersoWrap").style.display = "none";
    $("versoActions").style.display = "none";
    $("rectoActions").style.display = "flex";
    $("dot1").classList.add("active");
    $("dot2").classList.remove("active");
    $("inputRecto").value = "";
    $("inputVerso").value = "";
  }

  function startNewCard() {
    resetCaptureState();
    showScreen("screen-capture");
  }

  async function handleRectoSelected(file) {
    state.rectoDataUrl = await fileToDataUrl(file);
    $("boxRecto").classList.add("filled");
    $("boxRecto").innerHTML = `<img src="${state.rectoDataUrl}" alt="Recto"><div class="retake">Reprendre</div>`;
    $("rectoActions").style.display = "none";
    $("captureVersoWrap").style.display = "block";
    $("versoActions").style.display = "block";
    $("dot1").classList.add("active");
    $("dot2").classList.add("active");
  }

  async function handleVersoSelected(file) {
    state.versoDataUrl = await fileToDataUrl(file);
    $("boxVerso").classList.add("filled");
    $("boxVerso").innerHTML = `<img src="${state.versoDataUrl}" alt="Verso"><div class="retake">Reprendre</div>`;
    goToReview();
  }

  function skipVerso() {
    goToReview();
  }

  function goToReview() {
    populateReviewForm();
    showScreen("screen-review");
  }

  function populateReviewForm() {
    // Champs vides — saisie manuelle. Le contexte reprend celui de la
    // dernière carte de la session (pratique quand on scanne plusieurs
    // cartes reçues au même événement d'affilée).
    $("fNom").value = "";
    $("fOrg").value = "";
    $("fTel").value = "";
    $("fPays").value = "";
    $("fCourriel").value = "";
    $("fSiteWeb").value = "";
    $("fNotes").value = "";
    $("fContexte").value = state.selectedContexte || "";

    const thumbsRow = $("thumbsRow");
    thumbsRow.innerHTML = "";
    if (state.rectoDataUrl) {
      thumbsRow.innerHTML += `<div class="thumb"><span class="tag">Recto</span><img src="${state.rectoDataUrl}"></div>`;
    }
    if (state.versoDataUrl) {
      thumbsRow.innerHTML += `<div class="thumb"><span class="tag">Verso</span><img src="${state.versoDataUrl}"></div>`;
    }

    // Chips de contexte
    const chipRow = $("chipRow");
    chipRow.innerHTML = "";
    (CONFIG.CONTEXTES_SUGGERES || []).forEach((c) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = c;
      if (c === state.selectedContexte) chip.classList.add("selected");
      chip.onclick = () => {
        $("fContexte").value = c;
        state.selectedContexte = c;
        document.querySelectorAll(".chip").forEach((el) => el.classList.remove("selected"));
        chip.classList.add("selected");
      };
      chipRow.appendChild(chip);
    });

    // Focus direct sur le premier champ pour une saisie rapide
    setTimeout(() => $("fNom").focus(), 100);
  }

  function handlePhoneInput() {
    const raw = $("fTel").value;
    const detected = detectCountryFromPhone(raw);
    if (detected && !$("fPays").value) {
      $("fPays").value = detected;
    }
  }

  async function confirmEntry() {
    const org = $("fOrg").value.trim();
    if (!org) {
      showBanner("L'organisation est requise avant d'ajouter la carte.", true);
      $("fOrg").focus();
      return;
    }

    const entry = {
      nom: $("fNom").value.trim(),
      organisation: org,
      telephone: $("fTel").value.trim(),
      pays: $("fPays").value.trim(),
      courriel: $("fCourriel").value.trim(),
      siteWeb: $("fSiteWeb").value.trim(),
      notes: $("fNotes").value.trim(),
      contexte: $("fContexte").value.trim(),
      dateAjout: new Date().toLocaleDateString("fr-CA"),
      synced: false
    };

    state.selectedContexte = entry.contexte;

    $("btnConfirm").textContent = "Envoi en cours…";
    $("btnConfirm").disabled = true;

    const result = await sendToSheet(entry);
    entry.synced = result.ok === true;
    addLocalEntry(entry);

    $("btnConfirm").textContent = "✓ Confirmer et ajouter";
    $("btnConfirm").disabled = false;

    $("successCard").innerHTML = `
      <div><b>${escapeHtml(entry.nom || "(sans nom)")}</b> — ${escapeHtml(entry.organisation)}</div>
      ${entry.telephone ? `<div>📞 ${escapeHtml(entry.telephone)}${entry.pays ? " · " + escapeHtml(entry.pays) : ""}</div>` : ""}
      ${entry.courriel ? `<div>✉️ ${escapeHtml(entry.courriel)}</div>` : ""}
      ${entry.siteWeb ? `<div>🌐 ${escapeHtml(entry.siteWeb)}</div>` : ""}
    `;

    if (result.ok) {
      $("successSub").textContent = "Ajouté au fichier central du REFC.";
    } else if (result.reason === "not_configured") {
      $("successSub").textContent = "Sauvegardé sur cet appareil (connexion au fichier central pas encore configurée).";
    } else {
      $("successSub").textContent = "Sauvegardé sur cet appareil — l'envoi au fichier central a échoué, on réessaiera.";
    }

    showScreen("screen-success");
    renderHome();
  }

  // ------------------------------------------------------------------
  // Câblage des événements
  // ------------------------------------------------------------------
  function wireEvents() {
    $("headerTitle").textContent = CONFIG.APP_TITLE || "Cartes de visite";

    $("btnNewCard").onclick = startNewCard;
    $("btnAddAnother").onclick = startNewCard;
    $("btnBackHome").onclick = () => {
      renderHome();
      showScreen("screen-home");
    };
    $("btnCancelCapture").onclick = () => {
      resetCaptureState();
      showScreen("screen-home");
    };
    $("btnDiscard").onclick = () => {
      resetCaptureState();
      showScreen("screen-home");
    };

    $("btnTakeRecto").onclick = () => $("inputRecto").click();
    $("btnTakeVerso").onclick = () => $("inputVerso").click();
    $("boxRecto").onclick = () => $("inputRecto").click();
    $("boxVerso").onclick = () => $("inputVerso").click();

    $("inputRecto").onchange = (e) => {
      if (e.target.files && e.target.files[0]) handleRectoSelected(e.target.files[0]);
    };
    $("inputVerso").onchange = (e) => {
      if (e.target.files && e.target.files[0]) handleVersoSelected(e.target.files[0]);
    };

    $("btnSkipVerso").onclick = skipVerso;
    $("btnConfirm").onclick = confirmEntry;
    $("fTel").addEventListener("input", handlePhoneInput);
    $("fTel").addEventListener("blur", handlePhoneInput);

    $("btnHistory").onclick = () => {
      renderFullHistory();
      showScreen("screen-history");
    };
    $("btnCloseHistory").onclick = () => showScreen("screen-home");
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    wireEvents();
    renderHome();
  });
})();
