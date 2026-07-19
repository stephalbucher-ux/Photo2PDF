/* Scanorama — photo → PDF scanner PWA
   Pipeline : capture/import → détection auto (OpenCV.js) ou détourage manuel 4 points
              → rotation → filtre (couleur / amélioré / gris / N&B adaptatif) → PDF
   Mémoire : les pages ajoutées sont stockées en JPEG/PNG compressé (dataURL),
             jamais en canvas pleine résolution ; tous les canvas et cv.Mat
             intermédiaires sont libérés immédiatement.
*/
(() => {
  "use strict";

  // ---------- State ----------
  // Une page ajoutée = { dataUrl, mime, w, h } (compressé, ~10-20× plus léger qu'un canvas)
  const pages = [];
  // Page en cours d'édition = { src, corners|null, color, filter, block, c, detected }
  let current = null;
  let cvReady = window.__cvReady === true;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const boot = $("boot"), bootText = $("bootText");
  const fileInput = $("fileInput"), galleryInput = $("galleryInput");
  const captureBtn = $("captureBtn"), importBtn = $("importBtn");
  const addBtn = $("addBtn"), exportBtn = $("exportBtn");
  const emptyState = $("emptyState"), previewWrap = $("previewWrap");
  const previewCanvas = $("previewCanvas"), scanline = $("scanline");
  const detectBadge = $("detectBadge");
  const editBar = $("editBar"), rotLeftBtn = $("rotLeftBtn"), rotRightBtn = $("rotRightBtn"), cropBtn = $("cropBtn");
  const filters = $("filters"), tuneToggle = $("tuneToggle"), tunePanel = $("tunePanel");
  const blockSize = $("blockSize"), cValue = $("cValue"), blockVal = $("blockVal"), cVal = $("cVal");
  const queue = $("queue"), queueStrip = $("queueStrip"), clearBtn = $("clearBtn");
  const counter = { count: $("pageCount"), plural: $("plural") };
  const splitToggle = $("splitToggle"), toast = $("toast");
  const cropEditor = $("cropEditor"), cropStage = $("cropStage"), cropCanvas = $("cropCanvas");
  const loupeCanvas = $("loupeCanvas");
  const cropCancel = $("cropCancel"), cropReset = $("cropReset"), cropApply = $("cropApply");

  let activeFilter = "enhance";

  // ---------- OpenCV readiness ----------
  function markReady() {
    cvReady = true;
    boot.classList.add("hide");
    setTimeout(() => boot.remove(), 450);
  }
  if (cvReady) markReady();
  else {
    window.addEventListener("opencv-ready", markReady, { once: true });
    const poll = setInterval(() => {
      if (window.__cvReady || (window.cv && cv.Mat)) { clearInterval(poll); markReady(); }
    }, 300);
    setTimeout(() => {
      if (!cvReady) bootText.textContent = "Le moteur met du temps à charger… vérifie ta connexion pour le premier lancement.";
    }, 8000);
  }

  // ---------- Helpers ----------
  function showToast(msg, warn) {
    toast.textContent = msg;
    toast.classList.toggle("warn", !!warn);
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  // Libère la mémoire bitmap d'un canvas (crucial sur mobile)
  function freeCanvas(c) {
    if (c && c.width) { c.width = 0; c.height = 0; }
  }
  function freeCurrent() {
    if (!current) return;
    if (current.color !== current.src) freeCanvas(current.color);
    freeCanvas(current.src);
    current = null;
  }

  function updateCounter() {
    counter.count.textContent = pages.length;
    counter.plural.textContent = pages.length > 1 ? "s" : "";
    exportBtn.disabled = pages.length === 0;
    queue.hidden = pages.length === 0;
  }

  // Charge un File dans un canvas correctement orienté (EXIF) et plafonné
  async function fileToCanvas(file) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      bmp = await createImageBitmap(file); // navigateurs plus anciens
    }
    const MAX = 2400; // grand côté ; bon compromis netteté texte / mémoire
    let { width: w, height: h } = bmp;
    const scale = Math.min(1, MAX / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    return c;
  }

  // Ordonne 4 points en [tl, tr, br, bl]
  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = bySum[0], br = bySum[3];
    const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const tr = byDiff[0], bl = byDiff[3];
    return [tl, tr, br, bl];
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Détecte le quadrilatère du document (sur copie réduite) → coins en coordonnées pleine résolution, ou null
  function detectDocument(srcColor) {
    const long = Math.max(srcColor.cols, srcColor.rows);
    const procScale = Math.min(1, 800 / long);
    const small = new cv.Mat();
    cv.resize(srcColor, small, new cv.Size(Math.round(srcColor.cols * procScale), Math.round(srcColor.rows * procScale)), 0, 0, cv.INTER_AREA);

    const gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), dil = new cv.Mat();
    const contours = new cv.MatVector(), hierarchy = new cv.Mat();
    let corners = null;
    try {
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 60, 180);
      const k = cv.Mat.ones(5, 5, cv.CV_8U);
      cv.dilate(edges, dil, k, new cv.Point(-1, -1), 1);
      k.delete();
      cv.findContours(dil, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const frameArea = small.cols * small.rows;
      let best = null, bestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);
        if (area > 0.18 * frameArea && area > bestArea) {
          const peri = cv.arcLength(cnt, true);
          const approx = new cv.Mat();
          cv.approxPolyDP(cnt, approx, 0.02 * peri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const p = approx.data32S;
            best = [
              { x: p[0], y: p[1] }, { x: p[2], y: p[3] },
              { x: p[4], y: p[5] }, { x: p[6], y: p[7] }
            ];
            bestArea = area;
          }
          approx.delete();
        }
        cnt.delete();
      }
      if (best) corners = best.map(pt => ({ x: pt.x / procScale, y: pt.y / procScale }));
    } finally {
      small.delete(); gray.delete(); blur.delete(); edges.delete(); dil.delete();
      contours.delete(); hierarchy.delete();
    }
    return corners;
  }

  // Warp perspective du canvas source selon 4 coins → canvas redressé
  function warpWithCorners(srcCanvas, corners) {
    const src = cv.imread(srcCanvas);
    const out = document.createElement("canvas");
    try {
      const [tl, tr, br, bl] = orderCorners(corners);
      const wA = dist(br, bl), wB = dist(tr, tl);
      const hA = dist(tr, br), hB = dist(tl, bl);
      const maxW = Math.max(8, Math.round(Math.max(wA, wB)));
      const maxH = Math.max(8, Math.round(Math.max(hA, hB)));
      const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
      const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, maxW, 0, maxW, maxH, 0, maxH]);
      const M = cv.getPerspectiveTransform(srcTri, dstTri);
      const dst = new cv.Mat();
      cv.warpPerspective(src, dst, M, new cv.Size(maxW, maxH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      out.width = maxW; out.height = maxH;
      cv.imshow(out, dst);
      srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
    } finally {
      src.delete();
    }
    return out;
  }

  // Détection auto + recadrage. Retourne { canvas, corners|null, detected }
  function cropToDocument(srcCanvas) {
    const src = cv.imread(srcCanvas);
    let corners = null;
    try {
      corners = detectDocument(src);
    } finally {
      src.delete();
    }
    if (corners) {
      return { canvas: warpWithCorners(srcCanvas, corners), corners, detected: true };
    }
    // Pas de quadrilatère → image entière (le détourage manuel reste possible)
    const out = document.createElement("canvas");
    out.width = srcCanvas.width; out.height = srcCanvas.height;
    out.getContext("2d").drawImage(srcCanvas, 0, 0);
    return { canvas: out, corners: null, detected: false };
  }

  // ---------- Moteur d'amélioration d'image ----------
  // Estime le fond (éclairage) par flou massif sur copie réduite, puis divise :
  // supprime ombres et jaunissement, fond uniforme. Technique « flat-field ».
  function flattenChannel(ch) {
    const small = new cv.Mat(), blurred = new cv.Mat(), bg = new cv.Mat(), out = new cv.Mat();
    try {
      const s = Math.min(1, 260 / Math.max(ch.cols, ch.rows));
      cv.resize(ch, small, new cv.Size(Math.max(1, Math.round(ch.cols * s)), Math.max(1, Math.round(ch.rows * s))), 0, 0, cv.INTER_AREA);
      cv.GaussianBlur(small, blurred, new cv.Size(21, 21), 0);
      cv.resize(blurred, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
      cv.divide(ch, bg, out, 255);
    } finally {
      small.delete(); blurred.delete(); bg.delete();
    }
    return out; // à libérer par l'appelant
  }

  // « Amélioré » : suppression d'ombres par canal + contraste + netteté (unsharp mask)
  function enhanceColor(colorCanvas) {
    const src = cv.imread(colorCanvas);
    const rgb = new cv.Mat(), merged = new cv.Mat(), sharp = new cv.Mat(), blur2 = new cv.Mat();
    const channels = new cv.MatVector(), flat = new cv.MatVector();
    const out = document.createElement("canvas");
    try {
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
      cv.split(rgb, channels);
      for (let i = 0; i < 3; i++) flat.push_back(flattenChannel(channels.get(i)));
      cv.merge(flat, merged);
      // Netteté : unsharp mask doux (renforce les lettres sans halo)
      cv.GaussianBlur(merged, blur2, new cv.Size(0, 0), 1.4);
      cv.addWeighted(merged, 1.55, blur2, -0.55, 0, sharp);
      // Léger boost de contraste
      sharp.convertTo(sharp, -1, 1.08, -8);
      out.width = colorCanvas.width; out.height = colorCanvas.height;
      cv.imshow(out, sharp);
    } finally {
      src.delete(); rgb.delete(); merged.delete(); sharp.delete(); blur2.delete();
      for (let i = 0; i < channels.size(); i++) channels.get(i).delete();
      for (let i = 0; i < flat.size(); i++) flat.get(i).delete();
      channels.delete(); flat.delete();
    }
    return out;
  }

  // Applique le filtre choisi à un canvas couleur recadré → canvas d'affichage
  function applyFilter(colorCanvas, filter, block, c) {
    if (filter === "color") return colorCanvas;
    if (filter === "enhance") return enhanceColor(colorCanvas);

    const src = cv.imread(colorCanvas);
    const gray = new cv.Mat();
    const out = document.createElement("canvas");
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      // Normalisation d'éclairage avant tout : gris propre, N&B sans pâtés d'ombre
      const flat = flattenChannel(gray);
      if (filter === "gray") {
        flat.convertTo(flat, -1, 1.06, -6);
        out.width = colorCanvas.width; out.height = colorCanvas.height;
        cv.imshow(out, flat);
      } else { // bw — seuillage adaptatif sur image normalisée
        let b = block | 0; if (b < 3) b = 3; if (b % 2 === 0) b += 1;
        const dst = new cv.Mat();
        cv.adaptiveThreshold(flat, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, b, c);
        out.width = colorCanvas.width; out.height = colorCanvas.height;
        cv.imshow(out, dst);
        dst.delete();
      }
      flat.delete();
    } finally {
      src.delete(); gray.delete();
    }
    return out;
  }

  function drawPreview(canvas) {
    const ctx = previewCanvas.getContext("2d");
    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    emptyState.hidden = true;
    previewWrap.hidden = false;
    filters.hidden = false;
    editBar.hidden = false;
    tuneToggle.hidden = (activeFilter !== "bw");
  }

  function renderCurrent() {
    if (!current) return;
    const disp = applyFilter(current.color, current.filter, current.block, current.c);
    drawPreview(disp);
    if (disp !== current.color) freeCanvas(disp); // le bitmap est copié dans previewCanvas
  }

  function resetPreview() {
    addBtn.disabled = true;
    previewWrap.hidden = true;
    filters.hidden = true;
    editBar.hidden = true;
    detectBadge.hidden = true;
    emptyState.hidden = false;
    freeCanvas(previewCanvas);
  }

  // ---------- Capture / import ----------
  captureBtn.addEventListener("click", () => {
    if (!cvReady) { showToast("Le moteur de scan finit de charger…", true); return; }
    fileInput.value = "";
    fileInput.click();
  });
  importBtn.addEventListener("click", () => {
    if (!cvReady) { showToast("Le moteur de scan finit de charger…", true); return; }
    galleryInput.value = "";
    galleryInput.click();
  });

  async function handleFile(file) {
    if (!file) return;
    scanline.hidden = false;
    detectBadge.hidden = true;
    try {
      freeCurrent(); // libère l'éventuelle page précédente non ajoutée
      const srcCanvas = await fileToCanvas(file);
      await new Promise(r => setTimeout(r, 60)); // laisse la scanline s'animer
      const { canvas: cropped, corners, detected } = cropToDocument(srcCanvas);
      current = {
        src: srcCanvas, corners, color: cropped, detected,
        filter: activeFilter, block: +blockSize.value, c: +cValue.value
      };
      renderCurrent();
      detectBadge.hidden = false;
      detectBadge.textContent = detected ? "Document détecté" : "Bords non trouvés — ajuste le cadre";
      detectBadge.className = "badge " + (detected ? "ok" : "warn");
      addBtn.disabled = false;
      if (!detected) showToast("Bords non détectés : utilise ⛶ Cadre pour ajuster manuellement.", true);
    } catch (err) {
      console.error(err);
      showToast("Impossible de traiter cette image.", true);
    } finally {
      scanline.hidden = true;
    }
  }
  fileInput.addEventListener("change", () => handleFile(fileInput.files && fileInput.files[0]));
  galleryInput.addEventListener("change", () => handleFile(galleryInput.files && galleryInput.files[0]));

  // ---------- Rotation 90° ----------
  function rotateCanvas(c, cw) {
    const o = document.createElement("canvas");
    o.width = c.height; o.height = c.width;
    const ctx = o.getContext("2d");
    if (cw) { ctx.translate(o.width, 0); ctx.rotate(Math.PI / 2); }
    else { ctx.translate(0, o.height); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(c, 0, 0);
    return o;
  }
  function rotateCurrent(cw) {
    if (!current) return;
    const h = current.src.height, w = current.src.width;
    const newSrc = rotateCanvas(current.src, cw);
    const newColor = (current.color === current.src) ? newSrc : rotateCanvas(current.color, cw);
    if (current.color !== current.src) freeCanvas(current.color);
    freeCanvas(current.src);
    current.src = newSrc;
    current.color = newColor;
    if (current.corners) {
      current.corners = current.corners.map(p =>
        cw ? { x: h - 1 - p.y, y: p.x } : { x: p.y, y: w - 1 - p.x }
      );
    }
    renderCurrent();
  }
  rotLeftBtn.addEventListener("click", () => rotateCurrent(false));
  rotRightBtn.addEventListener("click", () => rotateCurrent(true));

  // ---------- Éditeur de détourage manuel (4 points) ----------
  const cropUI = { corners: [], scale: 1, ox: 0, oy: 0, dragIdx: -1, dpr: 1 };

  function defaultCorners() {
    const w = current.src.width, h = current.src.height;
    const mx = w * 0.06, my = h * 0.06;
    return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
  }

  function openCropEditor() {
    if (!current) return;
    cropEditor.hidden = false;
    // Attend que l'overlay soit rendu pour mesurer la zone
    requestAnimationFrame(() => {
      const rect = cropStage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      cropUI.dpr = dpr;
      cropCanvas.width = Math.round(rect.width * dpr);
      cropCanvas.height = Math.round(rect.height * dpr);
      const w = current.src.width, h = current.src.height;
      const s = Math.min((rect.width - 24) / w, (rect.height - 24) / h);
      cropUI.scale = s;
      cropUI.ox = (rect.width - w * s) / 2;
      cropUI.oy = (rect.height - h * s) / 2;
      const base = current.corners ? orderCorners(current.corners) : defaultCorners();
      cropUI.corners = base.map(p => ({ x: p.x, y: p.y }));
      drawCropUI();
    });
  }

  function toScreen(p) { return { x: cropUI.ox + p.x * cropUI.scale, y: cropUI.oy + p.y * cropUI.scale }; }
  function toImage(x, y) {
    return {
      x: Math.max(0, Math.min(current.src.width, (x - cropUI.ox) / cropUI.scale)),
      y: Math.max(0, Math.min(current.src.height, (y - cropUI.oy) / cropUI.scale))
    };
  }

  function drawCropUI() {
    const ctx = cropCanvas.getContext("2d");
    const dpr = cropUI.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
    // Image
    ctx.drawImage(current.src, cropUI.ox, cropUI.oy, current.src.width * cropUI.scale, current.src.height * cropUI.scale);
    // Assombrit l'extérieur du quadrilatère
    const pts = cropUI.corners.map(toScreen);
    ctx.save();
    ctx.fillStyle = "rgba(10,14,20,0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, cropCanvas.width / dpr, cropCanvas.height / dpr);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 3; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill("evenodd");
    ctx.restore();
    // Contour
    ctx.strokeStyle = "#35D0BA";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    // Poignées
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === cropUI.dragIdx ? 13 : 10, 0, Math.PI * 2);
      ctx.fillStyle = i === cropUI.dragIdx ? "#35D0BA" : "rgba(53,208,186,0.25)";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#35D0BA";
      ctx.stroke();
    });
  }

  function drawLoupe(idx) {
    const p = cropUI.corners[idx];
    const ctx = loupeCanvas.getContext("2d");
    const Z = 2.6, R = 132;
    ctx.clearRect(0, 0, R, R);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R / 2, R / 2, R / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#F5F3EC";
    ctx.fillRect(0, 0, R, R);
    const half = R / (2 * Z);
    ctx.drawImage(current.src, p.x - half, p.y - half, R / Z, R / Z, 0, 0, R, R);
    ctx.restore();
    // Croix de visée
    ctx.strokeStyle = "#E0685B";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(R / 2 - 12, R / 2); ctx.lineTo(R / 2 + 12, R / 2);
    ctx.moveTo(R / 2, R / 2 - 12); ctx.lineTo(R / 2, R / 2 + 12);
    ctx.stroke();
    // Place la loupe du côté opposé au doigt
    const sp = toScreen(p);
    const rect = cropStage.getBoundingClientRect();
    loupeCanvas.classList.toggle("right", sp.x < rect.width / 2);
    loupeCanvas.hidden = false;
  }

  function stagePos(ev) {
    const rect = cropStage.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  cropStage.addEventListener("pointerdown", (ev) => {
    if (cropEditor.hidden || !current) return;
    const pos = stagePos(ev);
    let best = -1, bestD = 44; // rayon de prise généreux (tactile)
    cropUI.corners.forEach((c, i) => {
      const s = toScreen(c);
      const d = Math.hypot(s.x - pos.x, s.y - pos.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) {
      cropUI.dragIdx = best;
      cropStage.setPointerCapture(ev.pointerId);
      drawCropUI();
      drawLoupe(best);
    }
  });
  cropStage.addEventListener("pointermove", (ev) => {
    if (cropUI.dragIdx < 0) return;
    const pos = stagePos(ev);
    cropUI.corners[cropUI.dragIdx] = toImage(pos.x, pos.y);
    drawCropUI();
    drawLoupe(cropUI.dragIdx);
  });
  function endDrag() {
    cropUI.dragIdx = -1;
    loupeCanvas.hidden = true;
    drawCropUI();
  }
  cropStage.addEventListener("pointerup", endDrag);
  cropStage.addEventListener("pointercancel", endDrag);

  function closeCropEditor() {
    cropEditor.hidden = true;
    freeCanvas(cropCanvas);
    loupeCanvas.hidden = true;
  }

  cropBtn.addEventListener("click", openCropEditor);
  cropCancel.addEventListener("click", closeCropEditor);
  cropReset.addEventListener("click", () => {
    // Relance la détection auto ; sinon rectangle par défaut
    let corners = null;
    const src = cv.imread(current.src);
    try { corners = detectDocument(src); } finally { src.delete(); }
    cropUI.corners = (corners ? orderCorners(corners) : defaultCorners()).map(p => ({ x: p.x, y: p.y }));
    drawCropUI();
  });
  cropApply.addEventListener("click", () => {
    if (!current) { closeCropEditor(); return; }
    const corners = cropUI.corners.map(p => ({ x: p.x, y: p.y }));
    const newColor = warpWithCorners(current.src, corners);
    if (current.color !== current.src) freeCanvas(current.color);
    current.color = newColor;
    current.corners = corners;
    current.detected = true;
    closeCropEditor();
    renderCurrent();
    detectBadge.hidden = false;
    detectBadge.textContent = "Cadre ajusté";
    detectBadge.className = "badge ok";
  });

  // ---------- Contrôles de filtre ----------
  document.querySelectorAll(".seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach(b => { b.classList.remove("is-active"); b.removeAttribute("aria-selected"); });
      btn.classList.add("is-active"); btn.setAttribute("aria-selected", "true");
      activeFilter = btn.dataset.filter;
      tuneToggle.hidden = (activeFilter !== "bw");
      if (activeFilter !== "bw") tunePanel.hidden = true;
      if (current) { current.filter = activeFilter; renderCurrent(); }
    });
  });

  tuneToggle.addEventListener("click", () => { tunePanel.hidden = !tunePanel.hidden; });

  let tuneRaf = 0;
  function onTune() {
    blockVal.textContent = blockSize.value;
    cVal.textContent = cValue.value;
    if (current && current.filter === "bw" && !tuneRaf) {
      tuneRaf = requestAnimationFrame(() => {
        tuneRaf = 0;
        current.block = +blockSize.value;
        current.c = +cValue.value;
        renderCurrent();
      });
    }
  }
  blockSize.addEventListener("input", onTune);
  cValue.addEventListener("input", onTune);

  // ---------- File de pages ----------
  addBtn.addEventListener("click", () => {
    if (!current) return;
    const final = applyFilter(current.color, current.filter, current.block, current.c);
    const mime = current.filter === "bw" ? "image/png" : "image/jpeg";
    const page = {
      mime,
      w: final.width, h: final.height,
      dataUrl: final.toDataURL(mime, 0.9),
      thumbUrl: makeThumb(final)
    };
    if (final !== current.color) freeCanvas(final);
    freeCurrent(); // libère src + color : la page vit en compressé uniquement
    pages.push(page);
    addThumb(page);
    updateCounter();
    showToast("Page ajoutée (" + pages.length + ")");
    resetPreview();
  });

  function makeThumb(canvas) {
    const t = document.createElement("canvas");
    const s = 144 / Math.max(canvas.width, canvas.height);
    t.width = Math.max(1, Math.round(canvas.width * s));
    t.height = Math.max(1, Math.round(canvas.height * s));
    t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
    const url = t.toDataURL("image/jpeg", 0.7);
    freeCanvas(t);
    return url;
  }

  function addThumb(page) {
    const el = document.createElement("div");
    el.className = "thumb";
    const img = document.createElement("img");
    img.src = page.thumbUrl;
    const num = document.createElement("span");
    num.className = "num";
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕"; del.setAttribute("aria-label", "Supprimer la page");
    del.addEventListener("click", () => {
      const idx = pages.indexOf(page);
      if (idx > -1) pages.splice(idx, 1);
      el.remove();
      renumber();
      updateCounter();
    });
    el.append(img, num, del);
    queueStrip.appendChild(el);
    renumber();
  }
  function renumber() {
    [...queueStrip.children].forEach((el, i) => {
      const n = el.querySelector(".num"); if (n) n.textContent = String(i + 1).padStart(2, "0");
    });
  }

  clearBtn.addEventListener("click", () => {
    if (!pages.length) return;
    pages.length = 0;
    queueStrip.textContent = "";
    updateCounter();
    showToast("Pages effacées — mémoire libérée");
  });

  // ---------- Export PDF ----------
  exportBtn.addEventListener("click", () => {
    if (!pages.length) return;
    const { jsPDF } = window.jspdf;
    const stamp = new Date().toISOString().slice(0, 10);

    try {
      if (splitToggle.checked) {
        pages.forEach((p, i) => {
          const doc = buildDoc(jsPDF, [p]);
          doc.save(`scan-${stamp}-${String(i + 1).padStart(2, "0")}.pdf`);
        });
        showToast(pages.length + " fichiers PDF générés");
      } else {
        const doc = buildDoc(jsPDF, pages);
        doc.save(`scan-${stamp}.pdf`);
        showToast("PDF créé (" + pages.length + " page" + (pages.length > 1 ? "s" : "") + ")");
      }
    } catch (err) {
      console.error(err);
      showToast("Échec de la création du PDF.", true);
    }
  });

  // Construit le document jsPDF depuis les images compressées (aucun re-traitement)
  function buildDoc(jsPDF, pageList) {
    let doc = null;
    pageList.forEach((p, i) => {
      const orient = p.w > p.h ? "l" : "p";
      if (i === 0) {
        doc = new jsPDF({ orientation: orient, unit: "px", format: [p.w, p.h], compress: true });
      } else {
        doc.addPage([p.w, p.h], orient);
      }
      doc.addImage(p.dataUrl, p.mime === "image/png" ? "PNG" : "JPEG", 0, 0, p.w, p.h);
    });
    return doc;
  }

  // ---------- PWA service worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  updateCounter();
})();
/* v3 */
