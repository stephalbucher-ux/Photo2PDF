/* Scanorama — photo → PDF scanner PWA
   Pipeline: capture → auto document detection (OpenCV.js) → perspective crop
             → filter (color / gray / adaptive-threshold B&W) → PDF (single or batch)
*/
(() => {
  "use strict";

  // ---------- State ----------
  const pages = [];          // { color: <canvas cropped color>, filter, block, c, thumb }
  let current = null;        // page being previewed but not yet added
  let cvReady = window.__cvReady === true;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const boot = $("boot"), bootText = $("bootText");
  const fileInput = $("fileInput");
  const captureBtn = $("captureBtn"), addBtn = $("addBtn"), exportBtn = $("exportBtn");
  const emptyState = $("emptyState"), previewWrap = $("previewWrap");
  const previewCanvas = $("previewCanvas"), scanline = $("scanline");
  const detectBadge = $("detectBadge");
  const filters = $("filters"), tuneToggle = $("tuneToggle"), tunePanel = $("tunePanel");
  const blockSize = $("blockSize"), cValue = $("cValue"), blockVal = $("blockVal"), cVal = $("cVal");
  const queue = $("queue"), queueStrip = $("queueStrip");
  const counter = { count: $("pageCount"), plural: $("plural") };
  const splitToggle = $("splitToggle"), toast = $("toast");

  let activeFilter = "bw";

  // ---------- OpenCV readiness ----------
  function markReady() {
    cvReady = true;
    boot.classList.add("hide");
    setTimeout(() => boot.remove(), 450);
  }
  if (cvReady) markReady();
  else {
    window.addEventListener("opencv-ready", markReady, { once: true });
    // Fallback: poll in case the event fired before this script ran
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

  function updateCounter() {
    counter.count.textContent = pages.length;
    counter.plural.textContent = pages.length > 1 ? "s" : "";
    exportBtn.disabled = pages.length === 0;
    queue.hidden = pages.length === 0;
  }

  // Load a File into a correctly-oriented canvas (handles phone EXIF rotation)
  async function fileToCanvas(file) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      bmp = await createImageBitmap(file); // older browsers
    }
    // Cap very large images to keep memory sane on mobile (long edge 2400px)
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

  // Order 4 points as [tl, tr, br, bl]
  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = bySum[0], br = bySum[3];
    const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
    const tr = byDiff[0], bl = byDiff[3];
    return [tl, tr, br, bl];
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Detect the document quad on a scaled-down copy; returns corners in FULL-res coords, or null
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

  // Warp the full-res color image to a flat rectangle. Returns a canvas + whether detection succeeded.
  function cropToDocument(srcCanvas) {
    const src = cv.imread(srcCanvas);
    let outCanvas = document.createElement("canvas");
    let detected = false;
    try {
      const corners = detectDocument(src);
      if (corners) {
        detected = true;
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
        outCanvas.width = maxW; outCanvas.height = maxH;
        cv.imshow(outCanvas, dst);
        srcTri.delete(); dstTri.delete(); M.delete(); dst.delete();
      } else {
        // No quad found → keep the whole frame (still usable)
        outCanvas.width = srcCanvas.width; outCanvas.height = srcCanvas.height;
        outCanvas.getContext("2d").drawImage(srcCanvas, 0, 0);
      }
    } finally {
      src.delete();
    }
    return { canvas: outCanvas, detected };
  }

  // Apply the chosen filter to a cropped COLOR canvas → returns a display canvas
  function applyFilter(colorCanvas, filter, block, c) {
    if (filter === "color") return colorCanvas;
    const src = cv.imread(colorCanvas);
    const gray = new cv.Mat();
    const out = document.createElement("canvas");
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      if (filter === "gray") {
        out.width = colorCanvas.width; out.height = colorCanvas.height;
        cv.imshow(out, gray);
      } else { // bw — adaptive threshold
        let b = block | 0; if (b < 3) b = 3; if (b % 2 === 0) b += 1;
        const dst = new cv.Mat();
        cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, b, c);
        out.width = colorCanvas.width; out.height = colorCanvas.height;
        cv.imshow(out, dst);
        dst.delete();
      }
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
    tuneToggle.hidden = (activeFilter !== "bw");
  }

  function renderCurrent() {
    if (!current) return;
    const disp = applyFilter(current.color, current.filter, current.block, current.c);
    drawPreview(disp);
  }

  // ---------- Capture flow ----------
  captureBtn.addEventListener("click", () => {
    if (!cvReady) { showToast("Le moteur de scan finit de charger…", true); return; }
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    scanline.hidden = false;
    detectBadge.hidden = true;
    try {
      const srcCanvas = await fileToCanvas(file);
      // let the scan-line animate a beat before heavy work
      await new Promise(r => setTimeout(r, 60));
      const { canvas: cropped, detected } = cropToDocument(srcCanvas);
      current = { color: cropped, filter: activeFilter, block: +blockSize.value, c: +cValue.value };
      renderCurrent();
      detectBadge.hidden = false;
      detectBadge.textContent = detected ? "Document détecté" : "Bords non trouvés — image entière";
      detectBadge.className = "badge " + (detected ? "ok" : "warn");
      addBtn.disabled = false;
      if (!detected) showToast("Cadres non détectés : photographie sur un fond contrasté.", true);
    } catch (err) {
      console.error(err);
      showToast("Impossible de traiter cette image.", true);
    } finally {
      scanline.hidden = true;
    }
  });

  // ---------- Filter controls ----------
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

  function onTune() {
    blockVal.textContent = blockSize.value;
    cVal.textContent = cValue.value;
    if (current && current.filter === "bw") {
      current.block = +blockSize.value;
      current.c = +cValue.value;
      renderCurrent();
    }
  }
  blockSize.addEventListener("input", onTune);
  cValue.addEventListener("input", onTune);

  // ---------- Queue ----------
  addBtn.addEventListener("click", () => {
    if (!current) return;
    const final = applyFilter(current.color, current.filter, current.block, current.c);
    const page = {
      color: current.color, filter: current.filter, block: current.block, c: current.c,
      dataUrl: final.toDataURL("image/jpeg", 0.85)
    };
    pages.push(page);
    addThumb(page);
    updateCounter();
    showToast("Page ajoutée (" + pages.length + ")");
    // reset preview to empty, ready for next capture
    current = null;
    addBtn.disabled = true;
    previewWrap.hidden = true;
    filters.hidden = true;
    detectBadge.hidden = true;
    emptyState.hidden = false;
  });

  function addThumb(page) {
    const el = document.createElement("div");
    el.className = "thumb";
    const img = document.createElement("img");
    img.src = page.dataUrl;
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

  // ---------- PDF export ----------
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

  // Build a jsPDF doc; each page sized to its image aspect (no letterboxing)
  function buildDoc(jsPDF, pageList) {
    let doc = null;
    pageList.forEach((p, i) => {
      const img = applyFilter(p.color, p.filter, p.block, p.c);
      const mime = p.filter === "bw" ? "image/png" : "image/jpeg";
      const data = img.toDataURL(mime, 0.92);
      const w = img.width, h = img.height;
      const orient = w > h ? "l" : "p";
      if (i === 0) {
        doc = new jsPDF({ orientation: orient, unit: "px", format: [w, h], compress: true });
      } else {
        doc.addPage([w, h], orient);
      }
      doc.addImage(data, mime === "image/png" ? "PNG" : "JPEG", 0, 0, w, h);
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
