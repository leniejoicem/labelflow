// LabelFlow core: products, UPC-A barcodes, sheet layout, label rendering (PDF and SVG),
// CSV import, file naming and the print queue. No DOM access here, so it runs in Node for tests.
// Browser: window.LabelFlow.<Class>. Node: require("./labelflow.js").<Class>.
(function (root) {
  "use strict";

  // ---------- CSV ----------
  class CsvParser {
    // Returns one object per row, keyed by the (trimmed) header names.
    static parse(text) {
      text = text.replace(/^﻿/, "");
      const rows = [];
      let row = [], field = "", inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
          } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
          if (c === "\r" && text[i + 1] === "\n") i++;
          row.push(field); rows.push(row); row = []; field = "";
        } else field += c;
      }
      if (field !== "" || row.length) { row.push(field); rows.push(row); }
      const header = (rows.shift() || []).map((h) => h.trim());
      return rows
        .filter((r) => r.some((v) => v.trim() !== ""))
        .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || "").trim()])));
    }
  }

  // ---------- UPC-A ----------
  const L_CODES = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
  const R_CODES = L_CODES.map((p) => p.replace(/./g, (b) => (b === "1" ? "0" : "1")));

  class Upc {
    static checkDigit(first11) {
      let odd = 0, even = 0;
      first11.split("").map(Number).forEach((n, i) => (i % 2 === 0 ? (odd += n) : (even += n)));
      return (10 - ((odd * 3 + even) % 10)) % 10;
    }

    // A UPC / GTIN-13 / GTIN-14 cell as a 12-digit UPC-A, or null if it isn't a valid one.
    static normalize(value) {
      let v = String(value || "").replace(/\D/g, "");
      if (v.length === 14 && v.startsWith("00")) v = v.slice(2);
      if (v.length === 13 && v.startsWith("0")) v = v.slice(1);
      if (v.length !== 12) return null;
      return Upc.checkDigit(v.slice(0, 11)) === Number(v[11]) ? v : null;
    }

    // First UPC found in text such as "00012345678905.png".
    static findIn(text) {
      for (const m of String(text).match(/\d{12,14}/g) || []) { const u = Upc.normalize(m); if (u) return u; }
      return "";
    }

    // 95 modules: [{bit, long}]. "long" bars (guards, first and last digit) extend below the others.
    static modules(upc) {
      const mods = [];
      const push = (bits, long) => bits.split("").forEach((b) => mods.push({ bit: b === "1", long }));
      push("101", true);
      for (let i = 0; i < 6; i++) push(L_CODES[+upc[i]], i === 0);
      push("01010", true);
      for (let i = 6; i < 12; i++) push(R_CODES[+upc[i]], i === 11);
      push("101", true);
      return mods;
    }
  }

  // ---------- Colors from SKU codes ----------
  class SkuColor {
    // Single letters could mean more than one color, so they are flagged as guesses.
    static CODES = {
      BLK: "BLACK", WHT: "WHITE", YLW: "YELLOW", NVY: "NAVY", BRWN: "BROWN", BRN: "BROWN",
      BLU: "BLUE", GRN: "GREEN", PNK: "PINK", RED: "RED", GRY: "GREY", GRAY: "GREY",
      BEI: "BEIGE", CRM: "CREAM", PRP: "PURPLE", ORG: "ORANGE", TAN: "TAN", IVR: "IVORY",
      B: "BLACK", W: "WHITE", R: "RED",
    };
    static GUESSES = new Set(["B", "W", "R"]);

    static fromSku(sku) {
      for (const p of String(sku || "").toUpperCase().split("-").slice(1)) {
        if (SkuColor.CODES[p]) return { color: SkuColor.CODES[p], guessed: SkuColor.GUESSES.has(p) };
      }
      return { color: "", guessed: true };
    }
  }

  // ---------- Product ----------
  let idCounter = Date.now();

  class Product {
    static FIELDS = ["id", "source", "handle", "title", "sku", "color", "colorGuessed", "size", "upc", "rawUpc", "print", "imageKey"];

    constructor(fields = {}) {
      this.id = fields.id || Product.newId();
      this.source = fields.source || "manual";   // "csv" rows are replaced on the next CSV load; "manual" rows stay
      this.handle = fields.handle || "";         // groups the sizes of one product
      this.title = fields.title || "";
      this.sku = fields.sku || "";
      this.color = fields.color || "";
      this.colorGuessed = !!fields.colorGuessed;
      this.size = fields.size || "";
      this.upc = fields.upc || "";
      this.rawUpc = fields.rawUpc || this.upc;
      this.print = !!fields.print;
      this.imageKey = fields.imageKey || "";     // attached GS1 image, if any
    }

    static newId() { return "r" + (idCounter++).toString(36); }

    // Saved data from older versions used a label count instead of a print flag.
    static fromJSON(o) {
      return new Product({ ...o, print: o.print !== undefined ? o.print : o.labels > 0 });
    }

    toJSON() { return Object.fromEntries(Product.FIELDS.map((f) => [f, this[f]])); }

    // Returns false when the value isn't a valid UPC (the raw text is kept so the user can fix it).
    setUpc(value) {
      this.rawUpc = value;
      this.upc = Upc.normalize(value) || "";
      return !value || !!this.upc;
    }

    setColor(value) {
      this.color = String(value || "").trim().toUpperCase();
      this.colorGuessed = false;
    }

    get needsCheck() { return !this.color || this.colorGuessed; }

    duplicate() { return new Product({ ...this.toJSON(), id: Product.newId(), source: "manual", print: true }); }

    matches(query) {
      return [this.title, this.sku, this.color, this.size, this.upc].join(" ").toLowerCase().includes(query);
    }

    get fileName() { return FileNamer.forProduct(this); }
    get displayName() { return FileNamer.forProduct(this, ""); }
  }

  // ---------- File names ----------
  class FileNamer {
    // All-caps or all-lowercase text becomes Title Case; mixed case is kept as written.
    static tidy(s) {
      s = String(s || "").trim().replace(/\s+/g, " ");
      return s && (s === s.toUpperCase() || s === s.toLowerCase())
        ? s.toLowerCase().replace(/(^|[\s\-\/(])(\S)/g, (m, a, c) => a + c.toUpperCase())
        : s;
    }

    static safe(name) { return name.replace(/[\/\\:*?"<>|]/g, ""); }

    // "Classic Tee - Black - M.pdf"
    static forProduct(p, ext = ".pdf") {
      const parts = [FileNamer.tidy(p.title), FileNamer.tidy(p.color), String(p.size || "").trim().toUpperCase()];
      return FileNamer.safe(parts.filter(Boolean).join(" - ")) + ext;
    }

    // One product + color: "Classic Tee - Black - S, M, L.pdf"
    // Mixed products:      "Classic Tee - Black - M + 2 more.pdf"
    static forGroup(products, ext) {
      const first = products[0];
      const key = (p) => FileNamer.forProduct({ title: p.title, color: p.color }, "");
      if (products.every((p) => key(p) === key(first))) {
        const sizes = [...new Set(products.map((p) => String(p.size || "").toUpperCase()).filter(Boolean))];
        return FileNamer.forProduct({ title: first.title, color: first.color, size: sizes.join(", ") }, ext);
      }
      return `${FileNamer.forProduct(first, "")} + ${products.length - 1} more${ext}`;
    }
  }

  // ---------- Sheet layout ----------
  class SheetLayout {
    constructor({ page, cols, rows, left, top, labelW, labelH, barcodeTop }) {
      Object.assign(this, { page, cols, rows, left, top, labelW, labelH, barcodeTop });
    }

    get perSheet() { return this.cols * this.rows; }

    // Top-left corner of label slot i (0-based, left to right, top to bottom).
    slot(i) {
      return { x: this.left + (i % this.cols) * this.labelW, y: this.top + Math.floor(i / this.cols) * this.labelH };
    }
  }

  // US Letter, 4 x 9, 2.0" x 1.11" labels. Measured from the original Canva stickers (pt).
  SheetLayout.LETTER_4X9 = new SheetLayout({
    page: { w: 612, h: 792 }, cols: 4, rows: 9,
    left: 17.4, top: 36.2, labelW: 144.35, labelH: 79.85,
    barcodeTop: 42.5,   // top of the barcode bars, from the label's top edge
  });

  // ---------- Drawing surfaces ----------
  // A label is drawn once (LabelDesign) onto any Surface; PDF and SVG only differ in how they draw.
  class Surface {
    text(str, x, y, opts) { throw new Error("Surface.text not implemented"); }
    fillRect(x, y, w, h) { throw new Error("Surface.fillRect not implemented"); }
    strokeRect(x, y, w, h, lineWidth) { throw new Error("Surface.strokeRect not implemented"); }
    image(img, x, y, w, h) { throw new Error("Surface.image not implemented"); }
    background(x, y, w, h) {}   // white behind a label without a border; PDF pages are already white
  }

  class PdfSurface extends Surface {
    static FONT = "Arial";

    constructor(doc) {
      super();
      this.doc = doc;
      doc.setTextColor(0, 0, 0);
      doc.setFillColor(0, 0, 0);
      doc.setDrawColor(0, 0, 0);
    }

    // opts: {size, bold, align: "left"|"center"|"right", spacing, maxWidth}
    text(str, x, y, { size, bold = false, align, spacing, maxWidth } = {}) {
      this.doc.setFont(PdfSurface.FONT, bold ? "bold" : "normal");
      this.doc.setFontSize(size);
      const o = {};
      if (align) o.align = align;
      if (spacing) o.charSpace = spacing;
      if (maxWidth) o.maxWidth = maxWidth;
      this.doc.text(str, x, y, o);
    }

    fillRect(x, y, w, h) { this.doc.rect(x, y, w, h, "F"); }

    strokeRect(x, y, w, h, lineWidth) {
      this.doc.setLineWidth(lineWidth);
      this.doc.rect(x, y, w, h, "S");
    }

    image(img, x, y, w, h) { this.doc.addImage(img.dataUrl, "PNG", x, y, w, h, img.id, "FAST"); }
  }

  class SvgSurface extends Surface {
    static ANCHOR = { left: "start", center: "middle", right: "end" };

    constructor() { super(); this.parts = []; }

    static escape(t) {
      return String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    text(str, x, y, { size, bold = false, align = "left", spacing, color } = {}) {
      this.parts.push(`<text x="${x}" y="${y}" font-size="${size}" text-anchor="${SvgSurface.ANCHOR[align]}"` +
        (bold ? ' font-weight="700"' : "") + (spacing ? ` letter-spacing="${spacing}"` : "") +
        (color ? ` fill="${color}"` : "") + `>${SvgSurface.escape(str)}</text>`);
    }

    fillRect(x, y, w, h) { this.parts.push(`<rect x="${x}" y="${y}" width="${w + 0.01}" height="${h}"/>`); }

    strokeRect(x, y, w, h, lineWidth) {
      this.parts.push(`<rect x="${x + lineWidth / 2}" y="${y + lineWidth / 2}" width="${w - lineWidth}" height="${h - lineWidth}" fill="#fff" stroke="#000" stroke-width="${lineWidth}"/>`);
    }

    image(img, x, y, w, h) { this.parts.push(`<image href="${img.dataUrl}" x="${x}" y="${y}" width="${w}" height="${h}"/>`); }

    background(x, y, w, h) { this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>`); }

    toString(w, h) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="Arial, Helvetica, sans-serif">${this.parts.join("")}</svg>`;
    }
  }

  // ---------- Barcodes ----------
  // Each barcode draws itself into the barcode area of a label: {cx, top, maxW, maxH}.
  class Barcode {
    draw(surface, area) { throw new Error("Barcode.draw not implemented"); }
  }

  // UPC-A drawn from the 12 digits.
  class GeneratedBarcode extends Barcode {
    static BARS_W = 41.3;        // width of the 95 modules
    static BARS_H = 25.3;        // height of normal bars
    static GUARD_EXTRA = 4.5;    // guard bars reach this far below, leaving room for the digits
    static DIGIT_SIZE = 4.6;

    constructor(upc) { super(); this.upc = upc; }

    draw(surface, { cx, top }) {
      const { BARS_W, BARS_H, GUARD_EXTRA, DIGIT_SIZE } = GeneratedBarcode;
      const m = BARS_W / 95, x0 = cx - BARS_W / 2, upc = this.upc;
      const mods = Upc.modules(upc);
      for (let i = 0; i < 95;) {
        if (!mods[i].bit) { i++; continue; }
        let j = i;
        while (j < 95 && mods[j].bit && mods[j].long === mods[i].long) j++;
        surface.fillRect(x0 + i * m, top, (j - i) * m, mods[i].long ? BARS_H + GUARD_EXTRA : BARS_H);
        i = j;
      }
      const base = top + BARS_H + GUARD_EXTRA, t = { size: DIGIT_SIZE };
      surface.text(upc[0], x0 - 1.2, base, { ...t, align: "right" });
      surface.text(upc.slice(1, 6), x0 + m * 27.5, base, { ...t, align: "center", spacing: 0.1 });   // modules 10-45
      surface.text(upc.slice(6, 11), x0 + m * 67.5, base, { ...t, align: "center", spacing: 0.1 });  // modules 50-85
      surface.text(upc[11], x0 + BARS_W + 1.2, base, { ...t, align: "left" });
    }
  }

  // Artwork uploaded from GS1, fitted into the area with its aspect ratio kept. img = {dataUrl, width, height, id}
  class ImageBarcode extends Barcode {
    constructor(img) { super(); this.img = img; }

    draw(surface, { cx, top, maxW, maxH }) {
      const { img } = this;
      const k = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * k, h = img.height * k;
      surface.image(img, cx - w / 2, top - 1 + (maxH - h) / 2, w, h);
    }
  }

  // Shown in the on-screen preview only; rows without a barcode never reach the PDF.
  class MissingBarcode extends Barcode {
    draw(surface, { cx, top }) { surface.text("NO BARCODE YET", cx, top + 19.5, { size: 5, align: "center", color: "#c0392b" }); }
  }

  // ---------- Label design ----------
  class LabelDesign {
    // border: the thin cut line printed around each sticker on a sheet. Single PNG stickers leave it off.
    constructor(layout = SheetLayout.LETTER_4X9, { border = true } = {}) {
      this.layout = layout;
      this.border = border;
    }

    draw(surface, product, barcode, x, y) {
      const { labelW: w, labelH: h, barcodeTop } = this.layout, cx = x + w / 2;
      if (this.border) surface.strokeRect(x, y, w, h, 0.5);
      else surface.background(x, y, w, h);
      surface.text(String(product.sku || "").toUpperCase(), cx, y + 8.6, { size: 7, bold: true, align: "center" });
      surface.text(String(product.title || "").toUpperCase(), cx, y + 19.2, { size: 6, align: "center", maxWidth: w - 8 });
      surface.text(String(product.color || "").toUpperCase(), x + 17.0, y + 35.5, { size: 6 });
      surface.text(String(product.size || "").toUpperCase(), x + 117.6, y + 35.5, { size: 6, align: "right" });
      barcode.draw(surface, {
        cx, top: y + barcodeTop,
        maxW: Math.min(52, w - 8), maxH: Math.min(33, h - (barcodeTop - 1) - 2),
      });
    }
  }

  // ---------- Renderers ----------
  class PdfSheetRenderer {
    constructor(jsPDF, fonts, design = new LabelDesign()) {
      this.jsPDF = jsPDF;
      this.fonts = fonts;
      this.design = design;
    }

    newDocument(title) {
      const doc = new this.jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
      doc.addFileToVFS("Arial.ttf", this.fonts.regular);
      doc.addFont("Arial.ttf", PdfSurface.FONT, "normal");
      doc.addFileToVFS("Arial-Bold.ttf", this.fonts.bold);
      doc.addFont("Arial-Bold.ttf", PdfSurface.FONT, "bold");
      doc.setProperties({ title: title || "LabelFlow labels", creator: "LabelFlow" });
      return doc;
    }

    // entries: [{product, barcode, count}]. Labels fill slots in order; a new page starts when one is full.
    render(entries, title) {
      const doc = this.newDocument(title);
      const surface = new PdfSurface(doc);
      const layout = this.design.layout;
      let slot = 0;
      for (const { product, barcode, count } of entries) {
        for (let n = 0; n < count; n++) {
          if (slot === layout.perSheet) { doc.addPage(); slot = 0; }
          const { x, y } = layout.slot(slot++);
          this.design.draw(surface, product, barcode, x, y);
        }
      }
      return doc;
    }
  }

  class SvgLabelRenderer {
    constructor(design = new LabelDesign()) { this.design = design; }

    render(product, barcode) {
      const surface = new SvgSurface();
      this.design.draw(surface, product, barcode, 0, 0);
      return surface.toString(this.design.layout.labelW, this.design.layout.labelH);
    }
  }

  // ---------- CSV import ----------
  // Picks the importer from the columns: a Handle column means a Shopify export, otherwise the LabelFlow template.
  class CsvImporter {
    static TEMPLATE_HEADER = ["Title", "SKU", "Color", "Size", "UPC"];

    static for(records) {
      const hasHandle = records.some((r) => Object.keys(r).some((k) => k.trim().toLowerCase() === "handle"));
      return hasHandle ? new ShopifyImporter() : new TemplateImporter();
    }

    static templateCSV() {
      return CsvImporter.TEMPLATE_HEADER.join(",") + "\n" +
        "Classic Tee,TEE-BLK-M,Black,M,012345678905\n" +
        "Classic Tee,TEE-BLK-L,Black,L,012345678912\n";
    }

    import(records) {
      this.reset();
      const out = [];
      for (const raw of records) {
        const r = CsvImporter.lowerKeys(raw);
        const get = (...names) => { for (const n of names) if (r[n]) return r[n]; return ""; };
        const sku = get("variant sku", "sku");
        const rawUpc = get("upc code", "upc", "gtin", "variant barcode", "barcode");
        if (!sku && !rawUpc) continue;

        // Shopify options: use "OptionN Name" when present, otherwise Option1 is the size.
        let size = get("size"), color = get("color", "colour");
        for (let i = 1; i <= 3; i++) {
          const name = (r[`option${i} name`] || "").toLowerCase(), val = r[`option${i} value`] || "";
          if (!val) continue;
          if (/colou?r/.test(name)) color = color || val;
          else if (/size/.test(name) || (!name && i === 1)) size = size || val;
        }
        const c = color ? { color: color.toUpperCase(), guessed: false } : SkuColor.fromSku(sku);
        const upc = ["upc code", "upc", "gtin", "variant barcode", "barcode"].map((k) => Upc.normalize(get(k))).find(Boolean) || "";

        out.push(new Product({
          source: "csv", sku, rawUpc, upc,
          size: size.toUpperCase(), color: c.color, colorGuessed: c.guessed,
          ...this.identify(get, c.color),
        }));
      }
      return out;
    }

    static lowerKeys(raw) {
      const r = {};
      for (const k in raw) r[k.trim().toLowerCase()] = (raw[k] || "").trim();
      return r;
    }

    reset() {}
    identify(get, color) { throw new Error("CsvImporter.identify not implemented"); }
  }

  class ShopifyImporter extends CsvImporter {
    reset() { this.titles = {}; }

    // Shopify only writes the title on a product's first row, so it is carried down by handle.
    identify(get) {
      const handle = get("handle");
      const title = get("title", "product", "product name", "name");
      if (title) this.titles[handle] = title;
      const labels = parseInt(get("labels", "label qty", "qty", "quantity"), 10);
      return { handle, title: this.titles[handle] || handle, print: labels > 0 };
    }
  }

  class TemplateImporter extends CsvImporter {
    // Each title + color is one product. Template rows come in ticked.
    identify(get, color) {
      const title = get("title", "product", "product name", "name");
      return { handle: `${title}|${color}`, title, print: true };
    }
  }

  // ---------- Print queue ----------
  class PrintQueue {
    static PER_SHEET = 36;

    // barcodeFor(product) -> Barcode or null
    constructor(products, barcodeFor) {
      const ticked = products.filter((p) => p.print);
      this.entries = [];
      this.skipped = [];
      for (const product of ticked) {
        const barcode = barcodeFor(product);
        if (barcode) this.entries.push({ product, barcode, count: PrintQueue.PER_SHEET });
        else this.skipped.push(product);
      }
    }

    get sheetCount() { return this.entries.length; }
    get stickerCount() { return this.entries.length * PrintQueue.PER_SHEET; }
    get isEmpty() { return this.entries.length === 0; }
    get products() { return this.entries.map((e) => e.product); }

    fileName(ext) {
      return this.entries.length === 1 ? FileNamer.forProduct(this.entries[0].product, ext) : FileNamer.forGroup(this.products, ext);
    }

    toPdf(renderer, title) { return renderer.render(this.entries, title || this.fileName("")); }

    // One PDF sheet per product, in a ZIP.
    toZip(renderer, JSZip, onProgress) {
      return this.zipEach(JSZip, ".pdf", (entry, name) => renderer.render([entry], name).output("arraybuffer"), onProgress);
    }

    // One PNG sticker per product, in a ZIP. pngRenderer.render(product, barcode) resolves to image data.
    toPngZip(pngRenderer, JSZip, onProgress) {
      return this.zipEach(JSZip, ".png", (entry) => pngRenderer.render(entry.product, entry.barcode), onProgress);
    }

    // Same names get " (2)", " (3)" and so on.
    async zipEach(JSZip, ext, makeFile, onProgress) {
      const zip = new JSZip();
      const used = new Map();
      for (let i = 0; i < this.entries.length; i++) {
        if (onProgress) await onProgress(i + 1, this.entries.length);
        const entry = this.entries[i];
        let name = FileNamer.forProduct(entry.product, "");
        const n = (used.get(name) || 0) + 1;
        used.set(name, n);
        if (n > 1) name += ` (${n})`;
        zip.file(name + ext, await makeFile(entry, name));
      }
      return zip.generateAsync({ type: "blob" });
    }
  }

  const api = {
    CsvParser, Upc, SkuColor, Product, FileNamer, SheetLayout,
    Surface, PdfSurface, SvgSurface,
    Barcode, GeneratedBarcode, ImageBarcode, MissingBarcode,
    LabelDesign, PdfSheetRenderer, SvgLabelRenderer,
    CsvImporter, ShopifyImporter, TemplateImporter, PrintQueue,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LabelFlow = api;
})(typeof window !== "undefined" ? window : globalThis);
