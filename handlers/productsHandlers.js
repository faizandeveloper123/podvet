const { ipcMain, dialog } = require("electron");
const path = require("path");
const XLSX = require("xlsx");
const saasClient = require("./saasClient");

// Products — backed by the multi-tenant API's /api/products. Not
// branch-scoped (same as Clients/Pets/Records — branch-level data scoping
// hasn't been carried over to the new backend for any module).

function toLocalProduct(p) {
  return {
    id: p.id,
    barcode_number: p.barcodeNumber,
    name: p.name,
    price: p.price,
    quantity: p.quantity,
    vendor_id: p.vendorId,
    vendor_name: p.vendorName,
    vendor_share_percentage: p.vendorSharePercentage,
    vendor_credit_percent: p.vendorCreditPercent,
    vendor_clinic_fixed_per_unit: p.vendorClinicFixedPerUnit,
    category: p.category,
  };
}

// The Add/Edit Product form sends "" (not null/undefined) for every unset
// optional field (vendor_id, category, the three vendor-share fields) —
// "" ?? null leaves it as "", and z.coerce.number() then turns "" into 0,
// which fails the API's .positive() check. Treat "" as absent everywhere.
function emptyToNull(value) {
  return value === "" || value === undefined ? null : value;
}

function toApiProductPayload(product) {
  return {
    // emptyToNull (not `?? undefined`, unlike category below): an explicit
    // null both creates the product with no barcode AND, on edit, clears a
    // previously-set one — omitting the key on edit would leave the old
    // barcode untouched instead.
    barcodeNumber: emptyToNull(product.barcode_number),
    name: product.name,
    price: product.price,
    quantity: emptyToNull(product.quantity),
    category: emptyToNull(product.category) ?? undefined,
    vendorId: emptyToNull(product.vendor_id),
    vendorSharePercentage: emptyToNull(product.vendor_share_percentage),
    vendorCreditPercent: emptyToNull(product.vendor_credit_percent),
    vendorClinicFixedPerUnit: emptyToNull(product.vendor_clinic_fixed_per_unit),
  };
}

// Batch CSV import (Products screen's "Import Products" button) — accepts
// only the columns a plain product listing would actually have (barcode,
// name, price, optionally quantity/category). Vendor/consignment linkage
// is deliberately not importable this way — it's a relational field
// (vendorId, not a name a CSV could reasonably carry) better set via the
// regular Edit form after import, one product at a time.
function normalizeCsvKey(key) {
  // Lowercase, strip spaces/underscores/hyphens so "Product Name",
  // "product_name", "PRODUCT NAME" and "productname" all match one alias.
  return String(key || "").trim().toLowerCase().replace(/[\s_\-./]+/g, "");
}

// Real CSVs rarely use the exact "Name"/"Price" headers the import form
// documents, so accept the common spellings. Value lookup survives
// currency symbols, thousands separators and trailing units.
function csvAlias(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

function csvNumber(value) {
  if (value === undefined || value === null) return undefined;
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? undefined : n;
}

function parseProductCsvRow(row) {
  const norm = {};
  for (const k of Object.keys(row || {})) norm[normalizeCsvKey(k)] = row[k];

  const barcodeNumber = String(csvAlias(norm, ["barcode", "barcodenumber", "barcode_number", "barcodeid", "sku", "isfid"]) ?? "").trim();
  const name = String(csvAlias(norm, ["name", "product", "productname", "item", "itemname", "title", "description", "service", "servicename"]) ?? "").trim();
  const price = csvNumber(csvAlias(norm, ["price", "rates", "rate", "sellingprice", "unitprice", "cost", "costprice", "mrp", "amount", "prices"]));
  const quantity = csvNumber(csvAlias(norm, ["quantity", "qty", "stock", "stockquantity", "qauntity", "units", "onhand", "currentstock", "available", "packsize"]));
  const category = String(csvAlias(norm, ["category", "categories", "categoryname", "type", "group", "department", "section"]) ?? "").trim();

  if (!name) return { error: "Missing name" };
  if (price === undefined || price < 0) {
    return { error: "Missing or invalid price" };
  }

  return {
    payload: {
      barcodeNumber: barcodeNumber || undefined,
      name,
      price,
      quantity: quantity !== undefined && quantity >= 0 ? quantity : null,
      category: category || undefined,
    },
  };
}

const MAX_API_PAGE_SIZE = 100;

module.exports = function setupProductsHandlers() {
  ipcMain.handle("retrieve-products", async (_event, { page, query, limit: requestedLimit }) => {
    try {
      const limit = requestedLimit || 5;
      // Callers (e.g. Dashboard's "fetch effectively everything for a
      // low-stock count" pattern) sometimes ask for a limit well past the
      // API's per-page cap — loop-paginate rather than clamping, so a
      // large-limit caller still gets every row up to what it asked for
      // instead of silently only seeing the first 100.
      if (limit > MAX_API_PAGE_SIZE) {
        let all = [];
        let total = 0;
        let totalPages = 1;
        for (let p = 1; all.length < limit; p++) {
          const result = await saasClient.listProducts({ page: p, pageSize: MAX_API_PAGE_SIZE, search: query || undefined });
          all = all.concat(result.data.map(toLocalProduct));
          total = result.total;
          totalPages = result.totalPages;
          if (p >= result.totalPages) break;
        }
        return { success: true, data: all.slice(0, limit), total, totalPages };
      }

      const result = await saasClient.listProducts({ page, pageSize: limit, search: query || undefined });
      return { success: true, data: result.data.map(toLocalProduct), total: result.total, totalPages: result.totalPages };
    } catch (err) {
      console.error("[retrieve-products]", err);
      return { success: false, error: err.message, data: [], total: 0 };
    }
  });

  ipcMain.handle("add-product", async (_event, product) => {
    try {
      const result = await saasClient.createProduct(toApiProductPayload(product));
      return { success: true, message: "Product added successfully", productId: result.data.id };
    } catch (err) {
      console.error("[add-product]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("edit-product", async (_event, product) => {
    try {
      await saasClient.updateProduct(product.id, toApiProductPayload(product));
      return { success: true, message: "Product updated successfully" };
    } catch (err) {
      console.error("[edit-product]", err);
      return { success: false, message: err.message };
    }
  });

  // Step 1 of 2: pick + parse + validate only — nothing is created yet.
  // The renderer shows this as a preview ("N products will be added, M
  // rows skipped") and only calls confirm-products-import below once the
  // user explicitly approves it.
  ipcMain.handle("scan-products-csv", async () => {
    const picked = await dialog.showOpenDialog({
      title: "Select Products CSV",
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["openFile"],
    });
    if (picked.canceled || !picked.filePaths.length) {
      return { success: false, canceled: true };
    }

    let rows;
    try {
      // XLSX.readFile auto-detects CSV from the extension — same parser
      // already used for the Settings > Data Management Excel import, no
      // need for a second CSV-parsing dependency.
      const workbook = XLSX.readFile(picked.filePaths[0]);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    } catch (err) {
      console.error("[scan-products-csv] parse error:", err);
      return { success: false, message: "Could not read that file — make sure it's a valid CSV." };
    }

    if (rows.length === 0) {
      return { success: false, message: "That file has no rows to import." };
    }

    const parsedRows = rows.map((row, i) => {
      const rowNumber = i + 2; // +1 for the header row, +1 for 1-indexing
      const parsed = parseProductCsvRow(row);
      if (parsed.error) {
        return { row: rowNumber, valid: false, reason: parsed.error };
      }
      return { row: rowNumber, valid: true, payload: parsed.payload };
    });

    return {
      success: true,
      fileName: path.basename(picked.filePaths[0]),
      total: parsedRows.length,
      validCount: parsedRows.filter((r) => r.valid).length,
      rows: parsedRows,
    };
  });

  // Step 2 of 2: actually create the rows the user reviewed and confirmed
  // in the preview — `payloads` is exactly the `{row, payload}` pairs from
  // scan-products-csv's valid rows, nothing is re-read from disk here.
  ipcMain.handle("confirm-products-import", async (_event, payloads) => {
    const outcomes = [];
    for (const item of payloads || []) {
      try {
        await saasClient.createProduct(item.payload);
        outcomes.push({ row: item.row, success: true, name: item.payload.name });
      } catch (err) {
        outcomes.push({ row: item.row, success: false, name: item.payload.name, reason: err.message || "Could not create product" });
      }
    }

    const added = outcomes.filter((o) => o.success).length;
    return {
      success: true,
      total: outcomes.length,
      added,
      failed: outcomes.length - added,
      outcomes,
    };
  });

  ipcMain.handle("delete-product", async (_event, productId) => {
    try {
      await saasClient.deleteProduct(productId);
      return { success: true, message: "Product deleted successfully" };
    } catch (err) {
      console.error("[delete-product]", err);
      return { success: false, message: err.message };
    }
  });

  // In-stock-only autocomplete suggestions (POS / appointment product add).
  ipcMain.handle("search-products", async (_event, term) => {
    try {
      const result = await saasClient.searchProducts(term);
      return { success: true, products: result.data.map(toLocalProduct) };
    } catch (err) {
      console.error("[search-products]", err);
      return { success: false, products: [] };
    }
  });

  // Name-suggestion source for record-entry autocompletes (Vaccination /
  // Deworming product name fields) — filtered by category, but deliberately
  // skips the quantity > 0 filter search-products uses above: this is
  // suggesting a name, not picking stock to deduct.
  ipcMain.handle("search-products-by-category", async (_event, term, category) => {
    try {
      const result = await saasClient.searchProductsByCategory(term, category);
      return { success: true, products: result.data.map(toLocalProduct) };
    } catch (err) {
      console.error("[search-products-by-category]", err);
      return { success: false, products: [] };
    }
  });

  // Barcode-scanner lookup.
  ipcMain.handle("find-product", async (_event, searchTerm) => {
    try {
      const result = await saasClient.findProduct(searchTerm);
      if (!result.data) return { success: false, message: "Product not found" };
      return { success: true, product: toLocalProduct(result.data) };
    } catch (err) {
      console.error("[find-product]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("get-products-transactions", async (_event, { page = 1, limit = 10, search = "" } = {}) => {
    try {
      const result = await saasClient.listProductTransactions({ page, pageSize: limit, search: search || undefined });
      const transactions = result.data.map((t) => ({
        billing_id: t.billingId,
        item_id: t.itemId,
        product_id: t.productId,
        product_name: t.productName,
        quantity: t.quantity,
        price: t.price,
        total: t.total,
        billing_date: t.billingDate,
        billing_time: t.billingTime,
        customer_name: t.customerName,
        customer_phone: t.customerPhone,
        linked_appointment_count: t.linkedAppointmentCount,
      }));
      return { success: true, transactions, total: result.total, totalPages: result.totalPages };
    } catch (err) {
      console.error("[get-products-transactions]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("delete-product-transaction", async (_event, { item_id, billing_id, return_qty }) => {
    try {
      await saasClient.returnProductTransaction(item_id, { billingId: billing_id, returnQty: return_qty ?? undefined });
      return { success: true };
    } catch (err) {
      console.error("[delete-product-transaction]", err);
      return { success: false, message: err.message };
    }
  });
};
