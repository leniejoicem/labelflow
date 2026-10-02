# LabelFlow

Turns product data plus GS1 UPC-A barcodes into printable label sheets, in the same 4 × 9
US Letter layout as the original Canva stickers (36 labels per sheet, each 2.0" × 1.11").
Each label shows the SKU, product name, color, size and barcode.

Open `index.html` in Chrome (double-click it, or `open ~/labelflow/index.html`). Everything runs
locally; nothing is uploaded.

## Bulk workflow

1. **Load products** (or drag the file anywhere onto the page)
   - A Shopify product export with UPC codes, **or**
   - The bulk template: click **Download bulk template**, fill it in Excel / Google Sheets,
     save as CSV and load it. Columns: `Title, SKU, Color, Size, UPC`. Every template row
     comes in already ticked to print.
2. **Add GS1 barcodes (optional)**: click **Add barcode images** and select all the image files
   at once (or drag a batch onto the page). Each image is matched to its rows by the UPC in the
   file name (e.g. `00012345678905.png`), or, if the name has no UPC, by reading the barcode in
   the image. Rows without an image get a barcode generated from their UPC.
3. **Tick what to print**: each ticked row prints one full sheet of 36 stickers. For many rows at
   once, search (e.g. "tee") and tick the **Print** header to tick everything shown. Click any row to see its sticker in the preview.
4. **Download**: one variant → one PDF. Several → a ZIP with one PDF per variant, each named
   `Product name - Color - Size.pdf` (e.g. `Classic Tee - Black - M.pdf`),
   or choose **One combined PDF**. Combined files and the ZIP are named the same way:
   `Classic Tee - Black - S, M, L.pdf` for one product, or
   `Classic Tee - Black - M + 2 more.pdf` when products are mixed.

Print at **100% / Actual size** (no "fit to page").

### Single stickers as PNG

- **Sticker → Save PNG** saves the sticker shown in the preview as one PNG.
- **To print → 1 sticker each (PNG)** saves one PNG per ticked product (a ZIP when there are
  several), named like `Classic Tee - Black - M.png`.
- PNGs are the real sticker size, 2" × 1.11" at 600 dpi (1203 × 665 px), on white with no cut line.

## Good to know

- **Filter → Needs checking** lists rows with a guessed or missing color, or no valid barcode.
  Colors are read from SKU codes (`YLW` → YELLOW); single letters (`B`, `W`, `R`) are guesses and
  show orange. Changing a color on one size updates every size of that product.
- **+ Add row** adds a product by hand: type the details, then type the UPC or click 📎 to attach
  the GS1 image.
- **Preview sheets** opens a large preview of exactly what will print.
- **⧉ Duplicate** copies a row right below itself (same details and barcode, ticked to print).
  Use it to print an extra sheet of a product, or change the size, SKU and UPC to make a new
  variant quickly. Copies can be removed with ✕.
- **Filter → Duplicates** shows rows that share a UPC or SKU, so accidental copies are easy to spot.
- UPCs are check-digit validated; invalid ones are red and are skipped when printing.
- Rows, ticks, colors and barcode images are remembered in this browser. Loading a new CSV
  replaces the previous CSV rows but keeps hand-added rows and saved barcode images.
- Barcode images: PNG, JPG or SVG. Export EPS/PDF to PNG first.

## Files

- `index.html`: the page (layout and styles)
- `labelflow.js`: the core, with no browser code (runs in Node for tests)
  - `Product`, `Upc`, `SkuColor`, `FileNamer`
  - `CsvParser`, `CsvImporter` → `ShopifyImporter` / `TemplateImporter`
  - `Barcode` → `GeneratedBarcode` / `ImageBarcode` / `MissingBarcode`
  - `SheetLayout`, `LabelDesign` (the one place the sticker layout is defined)
  - `Surface` → `PdfSurface` / `SvgSurface`, drawn by `PdfSheetRenderer` and `SvgLabelRenderer`
  - `PrintQueue` (ticked products → one PDF or a ZIP)
- `app.js`: the browser side
  - `LocalStore`, `ImageStore`, `BarcodeLibrary`, `ImageReader`, `ProductList`
  - `PngLabelRenderer` (rasterises the SVG sticker at 600 dpi)
  - `ProductTable`, `StickerPreview`, `QueuePanel`, `SheetViewer`, `StatusBar`
  - `LabelFlowApp` connects them
- `vendor/`: jsPDF, JSZip, the embedded Arial font (labels) and Plus Jakarta Sans (app title, OFL license)
- `examples/`: a sample generated sheet
