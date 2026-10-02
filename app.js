// LabelFlow page: storage, image reading, the product table, side panels, and the app that connects them.
// Label/PDF logic lives in labelflow.js; this file only deals with the browser.
(function () {
  "use strict";
  const { CsvParser, CsvImporter, Upc, Product, PrintQueue, SheetLayout, LabelDesign,
    GeneratedBarcode, ImageBarcode, MissingBarcode, PdfSheetRenderer, SvgLabelRenderer } = window.LabelFlow;

  const $ = (id) => document.getElementById(id);
  const nextFrame = () => new Promise((r) => setTimeout(r, 0));

  // ---------- Storage ----------
  // Small JSON values in localStorage. Every access is guarded: private windows can refuse storage.
  class LocalStore {
    constructor(prefix) { this.prefix = prefix; }
    get(key, fallback) {
      try { const v = localStorage.getItem(this.prefix + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    }
    set(key, value) { try { localStorage.setItem(this.prefix + key, JSON.stringify(value)); } catch (e) {} }
    remove(key) { try { localStorage.removeItem(this.prefix + key); } catch (e) {} }
  }

  // Barcode images are too big for localStorage, so they go in IndexedDB.
  class ImageStore {
    constructor(dbName) { this.dbName = dbName; this.db = null; }

    open() {
      return new Promise((resolve) => {
        try {
          const req = indexedDB.open(this.dbName, 1);
          req.onupgradeneeded = () => req.result.createObjectStore("images");
          req.onsuccess = () => { this.db = req.result; resolve(); };
          req.onerror = () => resolve();
        } catch (e) { resolve(); }
      });
    }

    store(mode) { return this.db && this.db.transaction("images", mode).objectStore("images"); }
    put(key, value) { try { this.store("readwrite").put(value, key); } catch (e) {} }
    delete(key) { try { this.store("readwrite").delete(key); } catch (e) {} }

    all() {
      return new Promise((resolve) => {
        const out = new Map();
        try {
          const req = this.store("readonly").openCursor();
          req.onsuccess = () => { const c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } else resolve(out); };
          req.onerror = () => resolve(out);
        } catch (e) { resolve(out); }
      });
    }
  }

  // ---------- Barcodes ----------
  // GS1 images, keyed "upc:<digits>" (matches any row with that UPC) or "row:<id>" (attached to one row).
  class BarcodeLibrary {
    constructor(imageStore) { this.imageStore = imageStore; this.images = new Map(); }

    async load() { this.images = await this.imageStore.all(); }

    static upcKey(upc) { return "upc:" + upc; }
    static rowKey(product) { return "row:" + product.id; }

    add(key, img) {
      const rec = { dataUrl: img.dataUrl, width: img.width, height: img.height, id: key.replace(/\W/g, "_") };
      this.images.set(key, rec);
      this.imageStore.put(key, rec);
    }

    imageFor(product) {
      return this.images.get(product.imageKey) || (product.upc && this.images.get(BarcodeLibrary.upcKey(product.upc))) || null;
    }

    // The barcode a product prints with: its GS1 image if there is one, else one drawn from the UPC.
    barcodeFor(product) {
      const img = this.imageFor(product);
      if (img) return new ImageBarcode(img);
      return product.upc ? new GeneratedBarcode(product.upc) : null;
    }

    has(product) { return !!this.barcodeFor(product); }

    // Duplicated rows can share an attached image; only delete it once no row uses it.
    releaseIfUnused(key, products) {
      if (!key || products.some((p) => p.imageKey === key)) return;
      this.images.delete(key);
      this.imageStore.delete(key);
    }
  }

  // Turns an image file into trimmed PNG data, and reads the barcode number when the browser can.
  class ImageReader {
    static INK = 160;   // pixels darker than this count as part of the barcode

    async read(file) {
      const img = await this.load(file);
      const isSvg = file.type === "image/svg+xml";
      let w = img.naturalWidth || 600, h = img.naturalHeight || 300;
      if (isSvg || w < 600) { const k = 1600 / w; w = Math.round(w * k); h = Math.round(h * k); }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = isSvg;
      ctx.drawImage(img, 0, 0, w, h);
      const detected = await this.detect(canvas);
      const box = this.inkBox(ctx, w, h);
      if (!box) throw new Error(`${file.name} looks blank.`);
      const out = document.createElement("canvas");
      out.width = box.w; out.height = box.h;
      out.getContext("2d").drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      return { dataUrl: out.toDataURL("image/png"), width: box.w, height: box.h, detected };
    }

    load(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Couldn't open ${file.name}. Use PNG, JPG or SVG (export EPS/PDF to PNG).`)); };
        img.src = url;
      });
    }

    // Chrome can read UPC/EAN barcodes; other browsers return "".
    async detect(canvas) {
      if (!("BarcodeDetector" in window)) return "";
      try {
        const codes = await new BarcodeDetector({ formats: ["upc_a", "ean_13"] }).detect(canvas);
        return codes[0] ? Upc.normalize(codes[0].rawValue) || codes[0].rawValue : "";
      } catch (e) { return ""; }
    }

    // Bounding box of the dark pixels plus a small white border, or null for a blank image.
    inkBox(ctx, w, h) {
      const d = ctx.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < ImageReader.INK) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return null;
      const pad = Math.round((y1 - y0) * 0.03) + 2;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
      return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  }

  // ---------- Products ----------
  class ProductList {
    constructor(store) {
      this.store = store;
      this.products = [];
      this.colorOverrides = store.get("colors", {});   // handle -> color typed by the user
    }

    load() {
      const saved = this.store.get("items", null);
      this.products = saved ? saved.map(Product.fromJSON) : [];
      return !!saved;
    }

    save() { this.store.set("items", this.products); }

    find(id) { return this.products.find((p) => p.id === id); }
    get manual() { return this.products.filter((p) => p.source === "manual"); }
    get isEmpty() { return this.products.length === 0; }

    // CSV rows replace the previous CSV rows; rows added by hand stay.
    replaceCsvRows(imported) {
      for (const p of imported) {
        if (p.handle in this.colorOverrides) { p.color = this.colorOverrides[p.handle]; p.colorGuessed = false; }
      }
      this.products = [...imported, ...this.manual];
      this.save();
    }

    add(product) { this.products.push(product); this.save(); return product; }

    insertAfter(existing, product) {
      this.products.splice(this.products.indexOf(existing) + 1, 0, product);
      this.save();
      return product;
    }

    remove(product) { this.products = this.products.filter((p) => p !== product); this.save(); }

    clear() { this.products = []; this.save(); }

    // A color typed on one CSV row applies to every size of that product, and is remembered.
    setColor(product, value) {
      const targets = product.source === "csv"
        ? this.products.filter((p) => p === product || (p.source === "csv" && p.handle === product.handle))
        : [product];
      targets.forEach((p) => p.setColor(value));
      if (product.source === "csv") {
        this.colorOverrides[product.handle] = product.color;
        this.store.set("colors", this.colorOverrides);
      }
      this.save();
    }

    // Ids of rows sharing a UPC or SKU with another row.
    duplicateIds() {
      const seen = new Map(), dup = new Set();
      for (const p of this.products) {
        for (const k of [p.upc && "u" + p.upc, p.sku && "s" + p.sku.toUpperCase()]) {
          if (!k) continue;
          if (seen.has(k)) { dup.add(seen.get(k)); dup.add(p.id); } else seen.set(k, p.id);
        }
      }
      return dup;
    }

    // filter: "all" | "queued" | "attention" | "dupes"
    visible(query, filter, barcodes) {
      const q = query.trim().toLowerCase();
      const dupes = filter === "dupes" ? this.duplicateIds() : null;
      return this.products.filter((p) => {
        if (filter === "queued" && !p.print) return false;
        if (filter === "attention" && !(p.needsCheck || !barcodes.has(p))) return false;
        if (dupes && !dupes.has(p.id)) return false;
        return !q || p.matches(q);
      });
    }
  }

  // ---------- Views ----------
  class StatusBar {
    constructor(el) { this.el = el; this.timer = null; }

    // Warnings stay until replaced; other messages clear after a few seconds.
    show(message, kind) {
      this.el.textContent = message || "";
      this.el.className = kind || "";
      clearTimeout(this.timer);
      if (message && kind !== "warn") this.timer = setTimeout(() => { this.el.textContent = ""; }, 8000);
    }
  }

  const ICON = {
    clip: '<svg class="i" viewBox="0 0 24 24"><path d="M20 11.5l-8.2 8.2a5 5 0 01-7.1-7.1l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8"/></svg>',
    copy: '<svg class="i" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/></svg>',
    x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  // The editable product table. It reports what the user did through `handlers`; it changes no data itself.
  class ProductTable {
    constructor({ body, selectAll, search, filter }, handlers) {
      Object.assign(this, { body, selectAll, search, filter, handlers });
      this.activeId = null;
      body.addEventListener("change", (e) => this.onChange(e));
      body.addEventListener("click", (e) => this.onClick(e));
      body.addEventListener("focusin", (e) => this.onFocus(e));
      body.addEventListener("mousedown", (e) => this.onFocus(e));
      selectAll.addEventListener("change", () => handlers.onTickAll(selectAll.checked));
      search.addEventListener("input", () => handlers.onFilter());
      filter.addEventListener("change", () => handlers.onFilter());
    }

    get query() { return this.search.value; }
    get filterValue() { return this.filter.value; }
    resetFilters() { this.search.value = ""; this.filter.value = "all"; }

    render(products, barcodes, hasAny) {
      const frag = document.createDocumentFragment();
      let lastGroup = null, alt = false;
      for (const p of products) {
        const group = p.handle || p.id;
        if (group !== lastGroup) { alt = !alt; lastGroup = group; }
        frag.appendChild(this.row(p, barcodes.imageFor(p), alt));
      }
      this.body.innerHTML = "";
      this.body.appendChild(frag);
      if (hasAny && !products.length) this.body.innerHTML = '<tr><td colspan="7" class="hint" style="padding:16px">No rows match.</td></tr>';
      this.syncTickAll(products);
    }

    row(p, img, alt) {
      const tr = document.createElement("tr");
      tr.dataset.id = p.id;
      tr.className = (alt ? "alt" : "") + (p.print ? " queued" : "") + (p.id === this.activeId ? " active" : "");
      tr.innerHTML = `
        <td style="text-align:center"><input type="checkbox" class="pr" aria-label="Print one sheet"></td>
        <td><input class="cell" data-f="title" aria-label="Product"></td>
        <td><input class="cell up" data-f="color" aria-label="Color"></td>
        <td><input class="cell up" data-f="size" aria-label="Size"></td>
        <td><input class="cell up mono" data-f="sku" aria-label="SKU"></td>
        <td><div class="bc">
          ${img ? '<img alt="GS1 barcode" title="GS1 image">' : ""}
          <input class="cell mono" data-f="upc" aria-label="UPC" placeholder="UPC">
          <button class="icon" data-act="attach" title="Attach GS1 barcode image">${ICON.clip}</button>
        </div></td>
        <td><div class="acts">
          <button class="icon" data-act="dup" title="Duplicate row">${ICON.copy}</button>
          ${p.source === "manual" ? `<button class="icon" data-act="del" title="Delete row">${ICON.x}</button>` : ""}
        </div></td>`;
      tr.querySelector(".pr").checked = p.print;
      const field = (f) => tr.querySelector(`[data-f=${f}]`);
      field("title").value = p.title;
      field("color").value = p.color;
      field("size").value = p.size;
      field("sku").value = p.sku;
      field("upc").value = p.upc || p.rawUpc || "";
      if (p.needsCheck) field("color").classList.add("warn");
      if (p.colorGuessed) field("color").title = "Guessed from the SKU code. Please check.";
      if (!p.upc && !img) field("upc").classList.add("bad");
      if (img) { tr.querySelector("img").src = img.dataUrl; field("upc").title = "Using the uploaded GS1 image"; }
      return tr;
    }

    syncTickAll(products) {
      const on = products.filter((p) => p.print).length;
      this.selectAll.checked = products.length > 0 && on === products.length;
      this.selectAll.indeterminate = on > 0 && on < products.length;
    }

    rowOf(el) { const tr = el.closest("tr[data-id]"); return tr ? tr.dataset.id : null; }

    onChange(e) {
      const id = this.rowOf(e.target); if (!id) return;
      if (e.target.classList.contains("pr")) {
        e.target.closest("tr").classList.toggle("queued", e.target.checked);
        return this.handlers.onTick(id, e.target.checked);
      }
      const f = e.target.dataset.f;
      if (f) this.handlers.onEdit(id, f, e.target.value.trim().replace(/\s+/g, " "));
    }

    onClick(e) {
      const b = e.target.closest("button[data-act]"); if (!b) return;
      const id = this.rowOf(b);
      const act = { attach: "onAttach", dup: "onDuplicate", del: "onDelete" }[b.dataset.act];
      if (id && act) this.handlers[act](id);
    }

    onFocus(e) { const id = this.rowOf(e.target); if (id) this.setActive(id); }

    setActive(id) {
      if (id === this.activeId) return;
      this.activeId = id;
      this.body.querySelectorAll("tr.active").forEach((r) => r.classList.remove("active"));
      const tr = this.body.querySelector(`tr[data-id="${id}"]`);
      if (tr) tr.classList.add("active");
      this.handlers.onActive(id);
    }

    focus(id, field) {
      const tr = this.body.querySelector(`tr[data-id="${id}"]`);
      if (!tr) return;
      tr.scrollIntoView({ block: "nearest" });
      tr.querySelector(`[data-f=${field}]`).focus();
    }
  }

  // One sticker as a PNG at its real printed size (2" x 1.11"), no cut line.
  // It rasterises the SVG sticker, so the layout still comes from LabelDesign.
  class PngLabelRenderer {
    static DPI = 600;

    constructor(layout) {
      this.layout = layout;
      this.svg = new SvgLabelRenderer(new LabelDesign(layout, { border: false }));
    }

    get pixelSize() {
      const k = PngLabelRenderer.DPI / 72;   // layout is in points
      return { w: Math.round(this.layout.labelW * k), h: Math.round(this.layout.labelH * k) };
    }

    async render(product, barcode) {
      const { w, h } = this.pixelSize;
      const svg = this.svg.render(product, barcode).replace("<svg ", `<svg width="${w}" height="${h}" `);
      const img = await this.loadSvg(svg);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    loadSvg(svg) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't draw the sticker.")); };
        img.src = url;
      });
    }
  }

  class StickerPreview {
    constructor({ card, canvas, caption, save }, renderer, onSave) {
      Object.assign(this, { card, canvas, caption, save, renderer });
      this.product = null;
      save.addEventListener("click", () => this.product && onSave(this.product));
    }

    show(product, barcode) {
      this.product = product;
      this.card.classList.toggle("hidden", !product);
      if (!product) return;
      this.canvas.innerHTML = this.renderer.render(product, barcode || new MissingBarcode());
      this.caption.innerHTML = "<b></b>";
      this.caption.firstChild.textContent = product.displayName || "New label";
      this.save.disabled = !barcode;
      this.save.title = barcode ? "Save this sticker as a PNG" : "Add a UPC or GS1 image first";
    }
  }

  class QueuePanel {
    constructor({ total, sub, summary, modeBox, preview, download }) {
      Object.assign(this, { total, sub, summary, modeBox, preview, download });
    }

    get mode() { return document.querySelector("input[name=mode]:checked").value; }
    get format() { return document.querySelector("input[name=format]:checked").value; }   // "sheet" | "png"

    show(queue) {
      const n = queue.sheetCount;
      if (this.format === "png") return this.showPng(queue, n);
      this.preview.classList.remove("hidden");
      this.total.textContent = `${n} sheet${n === 1 ? "" : "s"}`;
      this.sub.textContent = n ? `${queue.stickerCount} stickers` : "Nothing ticked yet.";
      this.summary.innerHTML = "";
      if (queue.skipped.length) this.line(`Skipping ${queue.skipped.length} without a barcode`, "warnline");
      queue.products.forEach((p) => this.line(p.displayName));
      this.modeBox.classList.toggle("hidden", n < 2);
      this.preview.disabled = this.download.disabled = !n;
      this.download.textContent = n > 1 && this.mode === "zip" ? `Download ${n} PDFs` : "Download";
    }

    // One sticker per ticked product, as PNG images.
    showPng(queue, n) {
      this.total.textContent = `${n} sticker${n === 1 ? "" : "s"}`;
      this.sub.textContent = n ? 'PNG, 2" × 1.11" at 600 dpi' : "Nothing ticked yet.";
      this.summary.innerHTML = "";
      if (queue.skipped.length) this.line(`Skipping ${queue.skipped.length} without a barcode`, "warnline");
      queue.products.forEach((p) => this.line(p.displayName));
      this.modeBox.classList.add("hidden");
      this.preview.classList.add("hidden");
      this.download.disabled = !n;
      this.download.textContent = n > 1 ? `Download ${n} PNGs` : "Download";
    }

    line(text, cls) {
      const d = document.createElement("div");
      if (cls) d.className = cls;
      d.textContent = text;
      this.summary.appendChild(d);
    }
  }

  class SheetViewer {
    constructor({ root, frame, sub, close, download }, onDownload) {
      Object.assign(this, { root, frame, sub, close, download });
      this.url = null;
      close.addEventListener("click", () => this.hide());
      root.addEventListener("click", (e) => { if (e.target === root) this.hide(); });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.isOpen) this.hide(); });
      download.addEventListener("click", () => { this.hide(); onDownload(); });
    }

    get isOpen() { return !this.root.classList.contains("hidden"); }

    show(doc, downloadLabel) {
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(doc.output("blob"));
      const pages = doc.getNumberOfPages();
      this.sub.textContent = `${pages} sheet${pages === 1 ? "" : "s"} · ${pages * PrintQueue.PER_SHEET} stickers`;
      this.download.textContent = downloadLabel;
      this.frame.src = this.url + "#view=FitH";
      this.root.classList.remove("hidden");
      this.close.focus();
    }

    hide() { this.root.classList.add("hidden"); this.frame.src = "about:blank"; }
  }

  class Downloads {
    static save(blob, name) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  }

  // ---------- App ----------
  class LabelFlowApp {
    constructor() {
      const store = new LocalStore("labelflow:");
      this.store = store;
      this.list = new ProductList(store);
      this.barcodes = new BarcodeLibrary(new ImageStore("labelflow"));
      this.reader = new ImageReader();
      this.pdf = new PdfSheetRenderer(window.jspdf.jsPDF, window.LabelFlowFonts);
      this.png = new PngLabelRenderer(SheetLayout.LETTER_4X9);
      this.status = new StatusBar($("status"));
      this.attachTarget = null;

      this.table = new ProductTable(
        { body: $("rows"), selectAll: $("selAll"), search: $("search"), filter: $("filter") },
        {
          onTick: (id, on) => this.tick(id, on),
          onTickAll: (on) => this.tickAllShown(on),
          onEdit: (id, field, value) => this.edit(id, field, value),
          onAttach: (id) => this.pickImageFor(id),
          onDuplicate: (id) => this.duplicate(id),
          onDelete: (id) => this.remove(id),
          onActive: () => this.showSticker(),
          onFilter: () => this.renderTable(),
        });
      this.sticker = new StickerPreview({ card: $("lpCard"), canvas: $("lp"), caption: $("lpName"), save: $("savePng") },
        new SvgLabelRenderer(), (p) => this.saveStickerPng(p));
      this.queuePanel = new QueuePanel({
        total: $("total"), sub: $("totalSub"), summary: $("summary"), modeBox: $("modeBox"), preview: $("preview"), download: $("download"),
      });
      this.viewer = new SheetViewer(
        { root: $("viewer"), frame: $("frame"), sub: $("viewerSub"), close: $("viewerClose"), download: $("viewerDownload") },
        () => this.download());

      this.bindControls();
    }

    async start() {
      await this.barcodes.imageStore.open();
      await this.carryOverFromStickr();
      await this.barcodes.load();
      if (!this.list.load()) this.migrateOldData();
      this.refresh();
    }

    // The app used to be called Stickr. Copy its saved rows, colors and images once, then remove them.
    async carryOverFromStickr() {
      const old = new LocalStore("stickr:");
      const keys = ["items", "colors", "file", "csv", "customs"];
      if (!keys.some((k) => old.get(k, null) !== null)) return;
      for (const k of keys) {
        const v = old.get(k, null);
        if (v !== null && this.store.get(k, null) === null) this.store.set(k, v);
        old.remove(k);
      }
      const oldImages = new ImageStore("stickr");
      await oldImages.open();
      for (const [key, value] of await oldImages.all()) this.barcodes.imageStore.put(key, value);
      try { oldImages.db && oldImages.db.close(); indexedDB.deleteDatabase("stickr"); } catch (e) {}
    }

    // Data saved by the first version (then called Stickr): the last CSV text and hand-made labels.
    migrateOldData() {
      const old = this.store.get("csv", null);
      if (old && old.text) this.loadCsv(old.text, old.name);
      for (const c of this.store.get("customs", [])) {
        const p = new Product({ title: c.title, sku: c.sku, color: c.color, size: c.size, upc: c.upc, print: (c.count || 0) > 0 });
        if (c.barcodeImage) { p.imageKey = BarcodeLibrary.rowKey(p); this.barcodes.add(p.imageKey, c.barcodeImage); }
        this.list.add(p);
      }
      this.store.remove("csv");
      this.store.remove("customs");
      this.list.save();
    }

    bindControls() {
      $("csvFile").addEventListener("change", (e) => { if (e.target.files[0]) this.readCsvFile(e.target.files[0]); e.target.value = ""; });
      $("imgFiles").addEventListener("change", (e) => { this.addImages(e.target.files); e.target.value = ""; });
      $("rowImg").addEventListener("change", (e) => { if (this.attachTarget && e.target.files[0]) this.attachImage(this.attachTarget, e.target.files[0]); });
      $("addRow").addEventListener("click", () => this.addRow());
      document.querySelector("[data-add]").addEventListener("click", () => this.addRow());
      $("tplBtn").addEventListener("click", () => this.downloadTemplate());
      document.querySelector("[data-tpl]").addEventListener("click", () => this.downloadTemplate());
      $("removeAll").addEventListener("click", () => this.clearList());
      $("preview").addEventListener("click", () => this.preview());
      $("download").addEventListener("click", () => this.download());
      document.querySelectorAll("input[name=mode], input[name=format]").forEach((r) => r.addEventListener("change", () => this.refreshQueue()));
      this.bindDragAndDrop();
    }

    bindDragAndDrop() {
      let depth = 0;
      const body = document.body;
      document.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; body.classList.add("dropping"); });
      document.addEventListener("dragover", (e) => e.preventDefault());
      document.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; body.classList.remove("dropping"); } });
      document.addEventListener("drop", (e) => {
        e.preventDefault(); depth = 0; body.classList.remove("dropping");
        if (e.dataTransfer.files.length) this.handleDroppedFiles([...e.dataTransfer.files]);
      });
    }

    // ----- Rendering -----
    refresh() { this.renderTable(); this.refreshQueue(); }

    renderTable() {
      const empty = this.list.isEmpty;
      $("empty").classList.toggle("hidden", !empty);
      $("tableCard").classList.toggle("hidden", empty);
      this.table.render(this.list.visible(this.table.query, this.table.filterValue, this.barcodes), this.barcodes, !empty);
    }

    queue() { return new PrintQueue(this.list.products, (p) => this.barcodes.barcodeFor(p)); }

    refreshQueue() {
      this.queuePanel.show(this.queue());
      this.showSticker();
    }

    // Shows the clicked row, else the first ticked row, else the first row.
    showSticker() {
      const p = this.list.find(this.table.activeId) || this.list.products.find((x) => x.print) || this.list.products[0];
      this.sticker.show(p, p && this.barcodes.barcodeFor(p));
    }

    // ----- Loading files -----
    handleDroppedFiles(files) {
      const csv = files.find((f) => /\.csv$/i.test(f.name) || f.type === "text/csv");
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (csv) this.readCsvFile(csv);
      if (images.length) setTimeout(() => this.addImages(images), csv ? 300 : 0);
      if (!csv && !images.length) this.status.show("LabelFlow takes CSV files and PNG, JPG or SVG images.", "warn");
    }

    readCsvFile(file) {
      const r = new FileReader();
      r.onload = () => this.loadCsv(r.result, file.name);
      r.readAsText(file);
    }

    loadCsv(text, name) {
      const records = CsvParser.parse(text);
      const imported = CsvImporter.for(records).import(records);
      if (!imported.length) return this.status.show(`${name} has no SKU or UPC column.`, "warn");
      this.list.replaceCsvRows(imported);
      this.store.set("file", name);
      const ticked = imported.filter((p) => p.print).length;
      const bad = imported.filter((p) => !this.barcodes.has(p)).length;
      this.status.show(`${imported.length} rows loaded` + (ticked ? `, ${ticked} ticked` : "") + (bad ? `. ${bad} have no valid UPC.` : ""), bad ? "warn" : "ok");
      this.refresh();
    }

    // Bulk images: each is matched by the UPC in its file name, or else the number read from the barcode.
    async addImages(fileList) {
      const files = [...fileList].filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      let matched = 0;
      const unmatched = [], unreadable = [], conflicts = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        this.status.show(`Reading image ${i + 1} of ${files.length}`);
        await nextFrame();
        try {
          const img = await this.reader.read(file);
          const fromName = Upc.findIn(file.name);
          const upc = fromName || Upc.normalize(img.detected);
          if (fromName && img.detected && fromName !== img.detected) conflicts.push(`${file.name} (image reads ${img.detected})`);
          if (!upc) { unreadable.push(file.name); continue; }
          this.barcodes.add(BarcodeLibrary.upcKey(upc), img);
          if (this.list.products.some((p) => p.upc === upc)) matched++; else unmatched.push(file.name);
        } catch (e) { unreadable.push(file.name); }
      }
      let msg = `Matched ${matched} of ${files.length} images.`;
      if (unmatched.length) msg += ` No row has the UPC in ${unmatched.join(", ")}. Saved for later.`;
      if (unreadable.length) msg += ` No UPC found in ${unreadable.join(", ")}. Rename the file to its UPC or attach it to the row.`;
      if (conflicts.length) msg += ` File name and barcode disagree: ${conflicts.join(", ")}.`;
      this.status.show(msg, unmatched.length || unreadable.length || conflicts.length ? "warn" : "ok");
      this.refresh();
    }

    pickImageFor(id) {
      this.attachTarget = this.list.find(id);
      $("rowImg").value = "";
      $("rowImg").click();
    }

    async attachImage(product, file) {
      try {
        this.status.show("Reading image");
        const img = await this.reader.read(file);
        if (!product.upc && Upc.normalize(img.detected)) product.setUpc(img.detected);
        product.imageKey = BarcodeLibrary.rowKey(product);
        this.barcodes.add(product.imageKey, img);
        if (img.detected && product.upc && img.detected !== product.upc) this.status.show(`The image reads ${img.detected}, the row says ${product.upc}.`, "warn");
        else this.status.show(img.detected ? `Attached ${img.detected}.` : "Image attached.", "ok");
        this.list.save();
        this.refresh();
      } catch (e) { this.status.show(e.message, "warn"); }
    }

    // ----- Row actions -----
    tick(id, on) {
      const p = this.list.find(id);
      p.print = on;
      if (on && !this.barcodes.has(p)) this.status.show("This row has no barcode yet. It won't print until it has one.", "warn");
      this.list.save();
      this.table.syncTickAll(this.list.visible(this.table.query, this.table.filterValue, this.barcodes));
      this.refreshQueue();
    }

    // The header box ticks every row shown, so searching first narrows it to one product.
    tickAllShown(on) {
      const shown = this.list.visible(this.table.query, this.table.filterValue, this.barcodes);
      shown.forEach((p) => (p.print = on));
      this.list.save();
      this.status.show(`${on ? "Ticked" : "Unticked"} ${shown.length} rows.`, "ok");
      this.refresh();
    }

    edit(id, field, value) {
      const p = this.list.find(id);
      if (field === "upc") {
        if (!p.setUpc(value)) this.status.show(`${value} isn't a valid UPC. Check the digits.`, "warn");
        this.list.save();
        return this.refresh();
      }
      if (field === "color") { this.list.setColor(p, value); return this.refresh(); }
      p[field] = field === "title" ? value : value.toUpperCase();
      this.list.save();
      this.refreshQueue();
    }

    duplicate(id) {
      const copy = this.list.insertAfter(this.list.find(id), this.list.find(id).duplicate());
      this.refresh();
      this.table.setActive(copy.id);
      this.table.focus(copy.id, "size");
      this.status.show("Copied. Edit the size, SKU and UPC for a new variant, or leave it for an extra sheet.", "ok");
    }

    remove(id) {
      const p = this.list.find(id);
      this.list.remove(p);
      this.barcodes.releaseIfUnused(p.imageKey, this.list.products);
      this.refresh();
    }

    addRow() {
      const p = this.list.add(new Product({ print: true }));
      this.table.resetFilters();
      this.refresh();
      this.table.setActive(p.id);
      this.table.focus(p.id, "title");
      this.status.show("Type the details, then the UPC. The clip icon attaches a GS1 image.");
    }

    clearList() {
      if (!confirm("Remove all rows? Saved barcode images and colors are kept.")) return;
      this.list.clear();
      this.store.remove("file");
      this.status.show("");
      this.refresh();
    }

    downloadTemplate() {
      Downloads.save(new Blob([CsvImporter.templateCSV()], { type: "text/csv" }), "LabelFlow bulk template.csv");
    }

    // ----- Output -----
    preview() {
      const queue = this.queue();
      this.viewer.show(queue.toPdf(this.pdf, "LabelFlow preview"), $("download").textContent);
    }

    async saveStickerPng(product) {
      const barcode = this.barcodes.barcodeFor(product);
      if (!barcode) return;
      Downloads.save(await this.png.render(product, barcode), product.fileName.replace(/\.pdf$/, ".png"));
      this.status.show("Saved 1 sticker.", "ok");
    }

    async download() {
      const queue = this.queue();
      if (queue.isEmpty) return;
      const btn = $("download");
      btn.disabled = true;
      try {
        if (this.queuePanel.format === "png") {
          if (queue.sheetCount === 1) {
            const { product, barcode } = queue.entries[0];
            Downloads.save(await this.png.render(product, barcode), queue.fileName(".png"));
          } else {
            const blob = await queue.toPngZip(this.png, window.JSZip, async (i, n) => { btn.textContent = `${i} of ${n}`; await nextFrame(); });
            Downloads.save(blob, queue.fileName(".zip"));
          }
          this.status.show(`Saved ${queue.sheetCount} sticker${queue.sheetCount === 1 ? "" : "s"}.`, "ok");
        } else if (queue.sheetCount === 1 || this.queuePanel.mode === "one") {
          const name = queue.fileName(".pdf");
          queue.toPdf(this.pdf, name.replace(/\.pdf$/, "")).save(name);
        } else {
          const blob = await queue.toZip(this.pdf, window.JSZip, async (i, n) => { btn.textContent = `${i} of ${n}`; await nextFrame(); });
          Downloads.save(blob, queue.fileName(".zip"));
          this.status.show(`Saved ${queue.sheetCount} PDFs.`, "ok");
        }
      } finally {
        btn.disabled = false;
        this.refreshQueue();
      }
    }
  }

  new LabelFlowApp().start();
})();
