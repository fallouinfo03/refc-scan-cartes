/* =========================================================================
   REFC — Cartes de visite
   Logique principale : capture photo, OCR (Tesseract.js), extraction des
   champs par heuristiques, relecture/correction, envoi vers Google Sheets
   (ou stockage local si non configuré).
   ========================================================================= */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // État
  // ------------------------------------------------------------------
  const state = {
    rectoFile: null,
    versoFile: null,
    rectoDataUrl: null,
    versoDataUrl: null,
    rectoText: "",
    versoText: "",
    extracted: {},
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
  // Extraction de champs par heuristiques (regex) à partir du texte OCR
  // ------------------------------------------------------------------
  function extractFields(rawText) {
    const lines = rawText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const fullText = lines.join(" \n ");

    // --- Courriel ---
    const emailMatch = fullText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0].replace(/\s+/g, "") : "";

    // --- Site web (contient un domaine mais pas de @, pas déjà capté comme email) ---
    // Le regex de site web peut recapter le domaine d'une adresse courriel
    // (ex: "octopus@octopusbooks.ca" contient "octopusbooks.ca"). On ne garde
    // que les candidats qui n'apparaissent PAS collés à un "@" dans le texte
    // d'origine — s'ils apparaissent aussi comme ligne séparée (cas Kidsbooks,
    // où "kidsbooks.ca" est écrit deux fois : seul et dans le courriel), on
    // les garde quand même.
    let website = "";
    const webCandidates = fullText.match(
      /(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9-]+\.(?:com|ca|org|net|qc\.ca|co|io|fr|be|ch|info)(?:\/[^\s]*)?/gi
    );
    if (webCandidates) {
      const filtered = webCandidates.filter((w) => {
        if (w.includes("@")) return false;
        // Vérifie s'il existe, dans le texte, une occurrence de ce domaine
        // qui N'EST PAS immédiatement précédée d'un "@" (donc une vraie
        // ligne "site web" indépendante du courriel).
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const standaloneRegex = new RegExp("(?<!@)" + escaped, "i");
        return standaloneRegex.test(fullText);
      });
      if (filtered.length) website = filtered[0];
    }

    // --- Téléphone : on garde tel quel, formats internationaux inclus ---
    // Cherche des séquences ressemblant à un numéro : +XX, parenthèses, tirets, points
    const phoneMatches = fullText.match(
      /(\+?\d{1,3}[\s.-]?)?(\(?\d{2,4}\)?[\s.-]?){2,5}\d{2,4}/g
    );
    let phone = "";
    if (phoneMatches) {
      // on privilégie la séquence la plus longue qui a au moins 7 chiffres
      const digitsOnly = (s) => (s.match(/\d/g) || []).length;
      const candidates = phoneMatches
        .map((s) => s.trim())
        .filter((s) => digitsOnly(s) >= 7 && digitsOnly(s) <= 15);
      if (candidates.length) {
        candidates.sort((a, b) => digitsOnly(b) - digitsOnly(a));
        phone = candidates[0];
      }
    }

    // --- Pays : déduction depuis indicatif, mots-clés, ou indicatif régional NA ---
    // Indicatifs régionaux nord-américains courants (non exhaustif) pour repérer
    // un numéro canadien/américain même sans "+1" ni mention explicite du pays.
    const NA_AREA_CODES = /\b(819|514|418|450|438|579|873|613|647|416|905|343|289|604|778|236|250|867|902|506|709)\b/;
    let pays = "";
    if (/\+86|china|beijing|shanghai|中国|北京/i.test(fullText)) pays = "Chine";
    else if (/\+1\b|canada|québec|quebec|ontario|ottawa|montr[eé]al/i.test(fullText)) pays = "Canada";
    else if (/\+33|france|paris/i.test(fullText)) pays = "France";
    else if (/\+44|united kingdom|london/i.test(fullText)) pays = "Royaume-Uni";
    else if (/\+32|belgi(um|que)/i.test(fullText)) pays = "Belgique";
    else if (/\+41|suisse|switzerland/i.test(fullText)) pays = "Suisse";
    else if (phone && NA_AREA_CODES.test(phone)) pays = "Canada"; // meilleure estimation, à confirmer par l'utilisatrice

    // --- Nom / organisation : heuristique simple à partir des lignes ---
    // On retire les lignes qui sont clairement email / web / téléphone / adresse pure
    const noisy = new Set();
    lines.forEach((l) => {
      if (email && l.includes(email)) noisy.add(l);
      if (website && l.toLowerCase().includes(website.toLowerCase().replace(/^https?:\/\//, ""))) noisy.add(l);
      if (phone && l.replace(/\D/g, "").length > 0 && phone.replace(/\D/g, "").includes(l.replace(/\D/g, "").slice(0, 6))) {
        if (/\d{5,}/.test(l)) noisy.add(l);
      }
    });
    const remaining = lines.filter((l) => !noisy.has(l));

    // La ligne la plus longue en MAJUSCULES ou en gros caractères est souvent
    // le nom de l'organisation (logo stylisé) ; sinon on prend la première
    // ligne restante comme nom, la deuxième comme organisation/titre.
    let nom = "";
    let organisation = "";
    let notes = "";

    if (remaining.length > 0) {
      // Ligne tout en majuscules = souvent le nom de la maison / logo
      const upperLine = remaining.find(
        (l) => l === l.toUpperCase() && l.length > 3 && /[A-Z]/.test(l)
      );
      if (upperLine) {
        organisation = upperLine;
        const others = remaining.filter((l) => l !== upperLine);
        if (others.length) nom = others[0];
        if (others.length > 1) notes = others.slice(1).join(" · ");
      } else {
        nom = remaining[0] || "";
        organisation = remaining[1] || "";
        if (remaining.length > 2) notes = remaining.slice(2).join(" · ");
      }
    }

    return {
      nom: nom.trim(),
      organisation: organisation.trim(),
      telephone: phone.trim(),
      pays: pays,
      courriel: email.trim(),
      siteWeb: website.trim(),
      notes: notes.trim()
    };
  }

  function mergeExtracted(rectoFields, versoText) {
    // Le verso peut apporter des infos supplémentaires (souvent des titres/
    // rôles, parfois rien d'exploitable) — on les ajoute aux notes sans
    // écraser les champs déjà trouvés au recto.
    const merged = { ...rectoFields };
    if (versoText && versoText.trim().length > 0) {
      const versoFields = extractFields(versoText);
      // Compléter les champs vides avec ce qu'on trouve au verso
      ["nom", "organisation", "telephone", "pays", "courriel", "siteWeb"].forEach((k) => {
        if (!merged[k] && versoFields[k]) merged[k] = versoFields[k];
      });
      // Le verso sert surtout à enrichir les notes (titres, rôles, réseaux)
      const versoLines = versoText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 2);
      const versoNoteText = versoLines.join(" · ");
      merged.notes = [merged.notes, versoNoteText].filter(Boolean).join(" · ");
    }
    return merged;
  }

  // ------------------------------------------------------------------
  // OCR via Tesseract.js
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Pré-traitement d'image : améliore nettement la fiabilité de l'OCR
  // sur des photos prises à main levée (éclairage variable, légère
  // inclinaison). On limite la taille (Tesseract est plus fiable sur des
  // images ni trop grandes ni trop petites) et on augmente le contraste.
  // ------------------------------------------------------------------
  function preprocessImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const MAX_DIM = 1600;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        // Contraste + niveaux de gris légers : aide Tesseract à mieux
        // séparer le texte du fond, surtout sur fond coloré ou texturé.
        const imgData = ctx.getImageData(0, 0, width, height);
        const d = imgData.data;
        const contrast = 1.15;
        const intercept = 128 * (1 - contrast);
        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const adjusted = gray * contrast + intercept;
          const clamped = Math.max(0, Math.min(255, adjusted));
          d[i] = d[i + 1] = d[i + 2] = clamped;
        }
        ctx.putImageData(imgData, 0, 0);

        resolve(canvas.toDataURL("image/jpeg", 0.92));
      };
      img.onerror = () => resolve(dataUrl); // en cas d'échec, on garde l'original
      img.src = dataUrl;
    });
  }

  async function runOCR(dataUrl, onProgress) {
    const processed = await preprocessImage(dataUrl);
    // On utilise uniquement fra+eng par défaut : Tesseract perd en fiabilité
    // quand plusieurs jeux de caractères très différents (latin + chinois)
    // sont chargés simultanément, même sur une carte 100% en français.
    // Le résultat se dégrade globalement plutôt que de juste "ignorer" le
    // chinois. On garde donc fra+eng comme réglage principal, fiable pour
    // la grande majorité des cartes reçues par le REFC.
    const result = await Tesseract.recognize(processed, "fra+eng", {
      logger: (m) => {
        if (m.status === "recognizing text" && onProgress) {
          onProgress(Math.round(m.progress * 100));
        }
      }
    });
    return result.data.text || "";
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
  // Rendu de l'accueil (stats + historique récent)
  // ------------------------------------------------------------------
  function renderHome() {
    const list = loadLocal();
    const sent = list.filter((e) => e.synced);
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

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  // ------------------------------------------------------------------
  // Flux de capture
  // ------------------------------------------------------------------
  function resetCaptureState() {
    state.rectoFile = null;
    state.versoFile = null;
    state.rectoDataUrl = null;
    state.versoDataUrl = null;
    state.rectoText = "";
    state.versoText = "";
    state.extracted = {};
    state.selectedContexte = "";

    $("boxRecto").classList.remove("filled");
    $("boxRecto").innerHTML = `
      <div class="cap-icon">📷</div>
      <div class="cap-label">Photo du recto</div>
      <div class="cap-sub">Cadrez la carte bien à plat, sans reflet</div>
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
    state.rectoFile = file;
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
    state.versoFile = file;
    state.versoDataUrl = await fileToDataUrl(file);
    $("boxVerso").classList.add("filled");
    $("boxVerso").innerHTML = `<img src="${state.versoDataUrl}" alt="Verso"><div class="retake">Reprendre</div>`;
    await processCard();
  }

  async function skipVerso() {
    await processCard();
  }

  async function processCard() {
    showScreen("screen-processing");
    $("procBar").style.width = "0%";

    try {
      $("procTitle").textContent = "Lecture du recto…";
      const rectoText = await runOCR(state.rectoDataUrl, (p) => {
        $("procBar").style.width = p + "%";
      });
      state.rectoText = rectoText;

      let versoText = "";
      if (state.versoDataUrl) {
        $("procTitle").textContent = "Lecture du verso…";
        $("procBar").style.width = "0%";
        versoText = await runOCR(state.versoDataUrl, (p) => {
          $("procBar").style.width = p + "%";
        });
        state.versoText = versoText;
      }

      const rectoFields = extractFields(rectoText);
      const merged = mergeExtracted(rectoFields, versoText);
      state.extracted = merged;

      populateReviewForm(merged);
      showScreen("screen-review");
    } catch (err) {
      console.error(err);
      showBanner("Erreur de lecture — vous pouvez remplir les champs manuellement.", true);
      state.extracted = {};
      populateReviewForm({});
      showScreen("screen-review");
    }
  }

  function populateReviewForm(fields) {
    $("fNom").value = fields.nom || "";
    $("fOrg").value = fields.organisation || "";
    $("fTel").value = fields.telephone || "";
    $("fPays").value = fields.pays || "";
    $("fCourriel").value = fields.courriel || "";
    $("fSiteWeb").value = fields.siteWeb || "";
    $("fNotes").value = fields.notes || "";
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
      chip.onclick = () => {
        $("fContexte").value = c;
        document.querySelectorAll(".chip").forEach((el) => el.classList.remove("selected"));
        chip.classList.add("selected");
      };
      chipRow.appendChild(chip);
    });
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

    $("btnConfirm").textContent = "Envoi en cours…";
    $("btnConfirm").disabled = true;

    const result = await sendToSheet(entry);
    entry.synced = result.ok === true;
    addLocalEntry(entry);

    $("btnConfirm").textContent = "✓ Confirmer et ajouter";
    $("btnConfirm").disabled = false;

    $("successCard").innerHTML = `
      <div><b>${escapeHtml(entry.nom || "(sans nom)")}</b> — ${escapeHtml(entry.organisation)}</div>
      ${entry.telephone ? `<div>📞 ${escapeHtml(entry.telephone)}</div>` : ""}
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
