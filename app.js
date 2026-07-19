/* PHOTO 2 PDF — © SA IA
   Architecture : splash → accueil (SCAN UNIQUE / SCAN LOT / OUVRIR IMAGE) → édition → enregistrement
   Moteur : détection auto (OpenCV.js), détourage manuel 4 points, rotation,
            filtres (couleur / amélioré / gris / N&B adaptatif), réglages qualité,
            export PDF avec renommage, qualité au choix et partage système.
   Mémoire : pages stockées compressées, canvas et cv.Mat libérés immédiatement.
*/
(() => {
  "use strict";

  const APP_VERSION = "4.0";

  // ---------- State ----------
  let mode = null;             // "single" | "batch" | "open"
  const pages = [];            // lot : { dataUrl, mime, w, h, thumbUrl }
  let current = null;          // { src, corners|null, color, detected }
  let activeFilter = "enhance";
  let quality = "standard";    // compact | standard | high
  let cvReady = window.__cvReady === true;
  const bootT0 = Date.now();

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const screenSplash = $("screenSplash"), screenHome = $("screenHome"), screenEdit = $("screenEdit");
  const btnSingle = $("btnSingle"), btnBatch = $("btnBatch"), btnOpen = $("btnOpen");
  const backBtn = $("backBtn"), modeTitle = $("modeTitle");
  const fileInput = $("fileInput"), galleryInput = $("galleryInput");
  const emptyState = $("emptyState"), previewWrap = $("previewWrap");
  const previewCanvas = $("previewCanvas"), scanline = $("scanline");
  const detectBadge = $("detectBadge");
  const editBar = $("editBar"), rotLeftBtn = $("rotLeftBtn"), rotRightBtn = $("rotRightBtn"), cropBtn = $("cropBtn");
  const filters = $("filters"), tuneToggle = $("tuneToggle"), tunePanel = $("tunePanel");
  const brightness = $("brightness"), contrast = $("contrast"), sharpness = $("sharpness");
  const brightVal = $("brightVal"), contrastVal = $("contrastVal"), sharpVal = $("sharpVal");
  const blockSize = $("blockSize"), cValue = $("cValue"), blockVal = $("blockVal"), cVal = $("cVal");
  const rowBright = $("rowBright"), rowContrast = $("rowContrast"), rowSharp = $("rowSharp");
  const rowBlock = $("rowBlock"), rowC = $("rowC");
  const queue = $("queue"), queueStrip = $("queueStrip"), clearBtn = $("clearBtn");
  const counter = $("counter"), pageCount = $("pageCount"), plural = $("plural");
  const dockBatch = $("dockBatch"), dockSingle = $("dockSingle");
  const addPageBtn = $("addPageBtn"), finishBtn = $("finishBtn");
  const retakeBtn = $("retakeBtn"), saveBtn = $("saveBtn");
  const saveSheet = $("saveSheet"), fileName = $("fileName"), qualityHint = $("qualityHint");
  const downloadBtn = $("downloadBtn"), shareBtn = $("shareBtn"), saveCancel = $("saveCancel");
  const toast = $("toast");
  const cropEditor = $("cropEditor"), cropStage = $("cropStage"), cropCanvas = $("cropCanvas");
  const loupeCanvas = $("loupeCanvas");
  const cropCancel = $("cropCancel"), cropReset = $("cropReset"), cropApply = $("cropApply");

  $("verSplash").textContent = APP_VERSION;
  $("verHome").textContent = APP_VERSION;

  // ---------- Splash → accueil ----------
  function enterHome() {
    const wait = Math.max(0, 2200 - (Date.now() - bootT0));
    setTimeout(() => {
      screenSplash.classList.add("hide");
      setTimeout(() => { screenSplash.hidden = true; }, 500);
      screenHome.hidden = false;
    }, wait);
  }
  function markReady() { cvReady = true; enterHome(); }
  if (cvReady) markReady();
  else {
    window.addEventListener("opencv-ready", markReady, { once: true });
    const poll = setInterval(() => {
      if (window.__cvReady || (window.cv && cv.Mat)) { clearInterval(poll); if (!cvReady) markReady(); }
    }, 300);
    setTimeout(() => {
      if (!cvReady) {
        const sub = document.querySelector(".splash-sub");
        if (sub) sub.textContent = "Le moteur met du temps à charger… vérifie ta connexion pour le premier lancement.";
      }
    }, 9000);
  }

  // ---------- Navigation ----------
  function showScreen(el) {
    [screenSplash, screenHome, screenEdit].forEach(s => { s.hidden = (s !== el); });
  }

  function startMode(m) {
    mode = m;
    freeCurrent();
    pages.length = 0;
    queueStrip.textContent = "";
    modeTitle.textContent = m === "single" ? "SCAN UNIQUE" : m === "batch" ? "SCAN LOT" : "OUVRIR IMAGE";
    counter.hidden = (m !== "batch");
    dockBatch.hidden = (m !== "batch");
    dockSingle.hidden = (m === "batch");
    queue.hidden = true;
    resetPreview();
    updateCounter();
    // Ouvre la source dans le geste utilisateur
    if (m === "open") { galleryInput.value = ""; galleryInput.click(); }
    else { fileInput.value = ""; fileInput.click(); }
  }
  btnSingle.addEventListener("click", () => startMode("single"));
  btnBatch.addEventListener("click", () => startMode("batch"));
  btnOpen.addEventListener("click", () => startMode("open"));

  function goHome() {
    freeCurrent();
    pages.length = 0;
    queueStrip.textContent = "";
    resetPreview();
    showScreen(screenHome);
    mode = null;
  }
  backBtn.addEventListener("click", () => {
    if (mode === "batch" && pages.length > 0) {
      if (!confirm("Abandonner le lot en cours ?")) return;
    }
    goHome();
  });

  // ---------- Helpers ----------
  function showToast(msg, warn) {
    toast.textContent = msg;
    toast.classList.toggle("warn", !!warn);
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 2600);
  }

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
    pageCount.textContent = pages.length;
    plural.textContent = pages.length > 1 ? "s" : "";
    finishBtn.disabled = pages.length === 0 && !current;
    finishBtn.textContent = pages.length > 0 ? `Terminer (${pages.length})` : "Terminer";
    queue.hidden = pages.length === 0;
  }

  async function fileToCanvas(file) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      bmp = await createImageBitmap(file);
    }
    const MAX = 2400;
    let { width: w, height: h } = bmp;
    const scale = Math.min(1, MAX / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    return c;
  }

  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = bySum[0], br = bySum[3];
    const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const tr = byDiff[0], bl = byDiff[3];
    return [tl, tr, br, bl];
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---------- Détection / recadrage ----------
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
    const out = document.createElement("canvas");
    out.width = srcCanvas.width; out.height = srcCanvas.height;
    out.getContext("2d").drawImage(srcCanvas, 0, 0);
    return { canvas: out, corners: null, detected: false };
  }

  // ---------- Moteur d'amélioration ----------
  // Correction « flat-field » : divise par le fond estimé (flou massif sur copie réduite)
  // → supprime ombres et jaunissement, fond uniforme.
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
    return out;
  }

  // « Amélioré » : flat-field par canal + netteté de base + contraste → Mat RGB
  function enhanceMat(srcRGBA) {
    const rgb = new cv.Mat(), merged = new cv.Mat();
    const channels = new cv.MatVector(), flatv = new cv.MatVector();
    const chRefs = [];
    try {
      cv.cvtColor(srcRGBA, rgb, cv.COLOR_RGBA2RGB);
      cv.split(rgb, channels);
      for (let i = 0; i < 3; i++) {
        const ch = channels.get(i);
        chRefs.push(ch);
        flatv.push_back(flattenChannel(ch));
      }
      cv.merge(flatv, merged);
      const blur = new cv.Mat();
      cv.GaussianBlur(merged, blur, new cv.Size(0, 0), 1.4);
      cv.addWeighted(merged, 1.5, blur, -0.5, 0, merged);
      blur.delete();
      merged.convertTo(merged, -1, 1.08, -8);
      const out = merged.clone();
      return out;
    } finally {
      rgb.delete(); merged.delete();
      chRefs.forEach(m => m.delete());
      for (let i = 0; i < flatv.size(); i++) flatv.get(i).delete();
      channels.delete(); flatv.delete();
    }
  }

  function getOpts() {
    return {
      block: +blockSize.value, c: +cValue.value,
      bright: +brightness.value, contrast: +contrast.value, sharp: +sharpness.value
    };
  }

  // Filtre + réglages qualité → canvas
  function applyFilter(colorCanvas, filter, o) {
    o = o || {};
    const noAdj = !o.bright && !o.contrast && !o.sharp;
    if (filter === "color" && noAdj) return colorCanvas;

    const src = cv.imread(colorCanvas);
    const out = document.createElement("canvas");
    out.width = colorCanvas.width; out.height = colorCanvas.height;
    let mat = null;
    try {
      if (filter === "bw") {
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const flat = flattenChannel(gray);
        gray.delete();
        let b = o.block | 0; if (b < 3) b = 3; if (b % 2 === 0) b += 1;
        mat = new cv.Mat();
        cv.adaptiveThreshold(flat, mat, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, b, o.c);
        flat.delete();
      } else if (filter === "gray") {
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        mat = flattenChannel(gray);
        gray.delete();
        mat.convertTo(mat, -1, 1.06, -6);
      } else if (filter === "enhance") {
        mat = enhanceMat(src);
      } else { // color
        mat = new cv.Mat();
        cv.cvtColor(src, mat, cv.COLOR_RGBA2RGB);
      }
      if (filter !== "bw") {
        if (o.sharp > 0) {
          const blur = new cv.Mat();
          cv.GaussianBlur(mat, blur, new cv.Size(0, 0), 1.6);
          const amt = (o.sharp / 100) * 1.1;
          cv.addWeighted(mat, 1 + amt, blur, -amt, 0, mat);
          blur.delete();
        }
        if (o.bright || o.contrast) {
          mat.convertTo(mat, -1, 1 + (o.contrast || 0) / 100, o.bright || 0);
        }
      }
      cv.imshow(out, mat);
    } finally {
      src.delete();
      if (mat) mat.delete();
    }
    return out;
  }

  // ---------- Preview ----------
  function drawPreview(canvas) {
    const ctx = previewCanvas.getContext("2d");
    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
    ctx.drawImage(canvas, 0, 0);
    emptyState.hidden = true;
    previewWrap.hidden = false;
    filters.hidden = false;
    editBar.hidden = false;
  }

  function renderCurrent() {
    if (!current) return;
    const disp = applyFilter(current.color, activeFilter, getOpts());
    drawPreview(disp);
    if (disp !== current.color) freeCanvas(disp);
  }

  function resetPreview() {
    addPageBtn.disabled = true;
    saveBtn.disabled = true;
    previewWrap.hidden = true;
    filters.hidden = true;
    editBar.hidden = true;
    detectBadge.hidden = true;
    emptyState.hidden = false;
    freeCanvas(previewCanvas);
  }

  // ---------- Chargement d'une photo ----------
  async function handleFile(file) {
    if (!file) return;
    showScreen(screenEdit);
    scanline.hidden = false;
    detectBadge.hidden = true;
    try {
      freeCurrent();
      const srcCanvas = await fileToCanvas(file);
      await new Promise(r => setTimeout(r, 60));
      const { canvas: cropped, corners, detected } = cropToDocument(srcCanvas);
      current = { src: srcCanvas, corners, color: cropped, detected };
      renderCurrent();
      detectBadge.hidden = false;
      detectBadge.textContent = detected ? "Document détecté" : "Bords non trouvés — ajuste le cadre";
      detectBadge.className = "badge " + (detected ? "ok" : "warn");
      addPageBtn.disabled = false;
      saveBtn.disabled = false;
      finishBtn.disabled = pages.length === 0 && !current;
      if (!detected) showToast("Bords non détectés : utilise ⛶ Cadre pour ajuster.", true);
    } catch (err) {
      console.error(err);
      showToast("Impossible de traiter cette image.", true);
    } finally {
      scanline.hidden = true;
    }
  }
  fileInput.addEventListener("change", () => handleFile(fileInput.files && fileInput.files[0]));
  galleryInput.addEventListener("change", () => handleFile(galleryInput.files && galleryInput.files[0]));

  retakeBtn.addEventListener("click", () => {
    if (mode === "open") { galleryInput.value = ""; galleryInput.click(); }
    else { fileInput.value = ""; fileInput.click(); }
  });

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

  // ---------- Détourage manuel 4 points ----------
  const cropUI = { corners: [], scale: 1, ox: 0, oy: 0, dragIdx: -1, dpr: 1 };

  function defaultCorners() {
    const w = current.src.width, h = current.src.height;
    const mx = w * 0.06, my = h * 0.06;
    return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
  }

  function openCropEditor() {
    if (!current) return;
    cropEditor.hidden = false;
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
    ctx.drawImage(current.src, cropUI.ox, cropUI.oy, current.src.width * cropUI.scale, current.src.height * cropUI.scale);
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
    ctx.strokeStyle = "#35D0BA";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
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
    ctx.strokeStyle = "#E0685B";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(R / 2 - 12, R / 2); ctx.lineTo(R / 2 + 12, R / 2);
    ctx.moveTo(R / 2, R / 2 - 12); ctx.lineTo(R / 2, R / 2 + 12);
    ctx.stroke();
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
    let best = -1, bestD = 44;
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
    if (!cropEditor.hidden && current) drawCropUI();
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
    if (!current) return;
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

  // ---------- Filtres + réglages ----------
  function updateTuneRows() {
    const bw = (activeFilter === "bw");
    rowBright.hidden = bw;
    rowContrast.hidden = bw;
    rowSharp.hidden = bw;
    rowBlock.hidden = !bw;
    rowC.hidden = !bw;
  }
  document.querySelectorAll(".seg-btn[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn[data-filter]").forEach(b => { b.classList.remove("is-active"); b.removeAttribute("aria-selected"); });
      btn.classList.add("is-active"); btn.setAttribute("aria-selected", "true");
      activeFilter = btn.dataset.filter;
      updateTuneRows();
      renderCurrent();
    });
  });
  tuneToggle.addEventListener("click", () => { tunePanel.hidden = !tunePanel.hidden; updateTuneRows(); });

  let tuneRaf = 0;
  function onTune() {
    brightVal.textContent = brightness.value;
    contrastVal.textContent = contrast.value;
    sharpVal.textContent = sharpness.value;
    blockVal.textContent = blockSize.value;
    cVal.textContent = cValue.value;
    if (current && !tuneRaf) {
      tuneRaf = requestAnimationFrame(() => { tuneRaf = 0; renderCurrent(); });
    }
  }
  [brightness, contrast, sharpness, blockSize, cValue].forEach(el => el.addEventListener("input", onTune));

  // ---------- Lot : pages ----------
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

  function commitCurrentToPages() {
    if (!current) return false;
    const final = applyFilter(current.color, activeFilter, getOpts());
    const mime = activeFilter === "bw" ? "image/png" : "image/jpeg";
    const page = {
      mime,
      w: final.width, h: final.height,
      dataUrl: final.toDataURL(mime, 0.92),
      thumbUrl: makeThumb(final)
    };
    if (final !== current.color) freeCanvas(final);
    freeCurrent();
    pages.push(page);
    addThumb(page);
    updateCounter();
    resetPreview();
    return true;
  }

  addPageBtn.addEventListener("click", () => {
    if (!current) return;
    commitCurrentToPages();
    showToast("Page ajoutée (" + pages.length + ")");
    // Enchaîne sur la photo suivante (dans le geste utilisateur)
    fileInput.value = "";
    fileInput.click();
  });

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
    showToast("Pages effacées");
  });

  // ---------- Boîte d'enregistrement ----------
  const QUALITY = {
    compact:  { scale: 0.75, jpeg: 0.72, hint: "Fichier léger, idéal pour l'envoi par mail" },
    standard: { scale: 1,    jpeg: 0.88, hint: "Bon équilibre poids / netteté" },
    high:     { scale: 1,    jpeg: 0.95, hint: "Netteté maximale, fichier plus lourd" }
  };

  function defaultName() {
    const stamp = new Date().toISOString().slice(0, 10);
    return (mode === "batch" ? "scan-lot-" : "scan-") + stamp;
  }

  function openSaveSheet() {
    fileName.value = defaultName();
    saveSheet.hidden = false;
  }
  saveCancel.addEventListener("click", () => { saveSheet.hidden = true; });

  document.querySelectorAll(".seg-btn[data-q]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn[data-q]").forEach(b => { b.classList.remove("is-active"); b.removeAttribute("aria-selected"); });
      btn.classList.add("is-active"); btn.setAttribute("aria-selected", "true");
      quality = btn.dataset.q;
      qualityHint.textContent = QUALITY[quality].hint;
    });
  });

  saveBtn.addEventListener("click", () => { if (current) openSaveSheet(); });
  finishBtn.addEventListener("click", () => {
    if (current) { commitCurrentToPages(); showToast("Page ajoutée (" + pages.length + ")"); }
    if (!pages.length) return;
    openSaveSheet();
  });

  function sanitizeName(raw) {
    const n = (raw || "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\.pdf$/i, "");
    return n || defaultName();
  }

  function scaleCanvasFrom(imgOrCanvas, w, h, scale) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d").drawImage(imgOrCanvas, 0, 0, c.width, c.height);
    return c;
  }

  // Ré-encode une page stockée selon la qualité (séquentiel, mémoire maîtrisée)
  function transcodePage(page, q) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = scaleCanvasFrom(img, page.w, page.h, q.scale);
        const out = {
          mime: page.mime, w: c.width, h: c.height,
          dataUrl: page.mime === "image/png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", q.jpeg)
        };
        freeCanvas(c);
        resolve(out);
      };
      img.onerror = reject;
      img.src = page.dataUrl;
    });
  }

  async function collectPagesForExport() {
    const q = QUALITY[quality];
    if (mode === "batch") {
      if (q.scale === 1 && quality !== "compact") return pages; // stockées à 0.92, très proche
      const list = [];
      for (const p of pages) list.push(await transcodePage(p, q));
      return list;
    }
    // single / open : rendu direct depuis current à la qualité choisie
    let final = applyFilter(current.color, activeFilter, getOpts());
    let outC = final;
    if (q.scale !== 1) {
      outC = scaleCanvasFrom(final, final.width, final.height, q.scale);
      if (final !== current.color) freeCanvas(final);
    }
    const mime = activeFilter === "bw" ? "image/png" : "image/jpeg";
    const page = {
      mime, w: outC.width, h: outC.height,
      dataUrl: mime === "image/png" ? outC.toDataURL("image/png") : outC.toDataURL("image/jpeg", q.jpeg)
    };
    if (outC !== current.color) freeCanvas(outC);
    return [page];
  }

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

  function finishSession(msg) {
    saveSheet.hidden = true;
    goHome();
    showToast(msg);
  }

  downloadBtn.addEventListener("click", async () => {
    try {
      downloadBtn.disabled = true;
      const name = sanitizeName(fileName.value);
      const { jsPDF } = window.jspdf;
      const list = await collectPagesForExport();
      const doc = buildDoc(jsPDF, list);
      doc.save(name + ".pdf");
      finishSession("PDF enregistré : " + name + ".pdf");
    } catch (err) {
      console.error(err);
      showToast("Échec de la création du PDF.", true);
    } finally {
      downloadBtn.disabled = false;
    }
  });

  shareBtn.addEventListener("click", async () => {
    try {
      shareBtn.disabled = true;
      const name = sanitizeName(fileName.value);
      const { jsPDF } = window.jspdf;
      const list = await collectPagesForExport();
      const doc = buildDoc(jsPDF, list);
      const blob = doc.output("blob");
      const file = new File([blob], name + ".pdf", { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        finishSession("Document transféré");
      } else {
        doc.save(name + ".pdf");
        finishSession("Partage non disponible ici — PDF téléchargé");
      }
    } catch (err) {
      if (err && err.name === "AbortError") { shareBtn.disabled = false; return; } // partage annulé
      console.error(err);
      showToast("Échec du transfert.", true);
    } finally {
      shareBtn.disabled = false;
    }
  });

  // ---------- PWA ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  updateCounter();
})();
