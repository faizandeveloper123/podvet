const { ipcMain, app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { generateExpenseReportPDFAsync } = require("../generate_invoice");
const { toCalendarDateKey, resolveApiBranding } = require("./utils");
const saasClient = require("./saasClient");

const MAX_API_PAGE_SIZE = 100;

// toCalendarDateKey already handles a plain "YYYY-MM-DD"-prefixed string
// (via regex, before it ever tries Date parsing) just as well as the raw
// mysql2 Date object it was originally written for — the API's ISO date
// strings ("2026-08-02T00:00:00.000Z") match that fast path directly.
function serializeExpense(e) {
  return {
    id: e.id,
    name: e.name,
    category_id: e.categoryId,
    category_name: e.categoryName,
    branch_id: e.branchId ?? null,
    branch_name: e.branchName ?? null,
    amount: parseFloat(e.amount) || 0,
    date: toCalendarDateKey(e.date),
    notes: e.notes,
    created_at: e.createdAt,
  };
}

// Fetches every expense matching the filter, looping past the API's
// per-page cap — same loop-pagination pattern already used for Dashboard's
// low-stock product count. get-expenses/download-expense-pdf need the full
// unpaginated set the legacy per-clinic-MySQL queries always returned.
async function fetchAllExpenses(params) {
  let all = [];
  let page = 1;
  let totalPages = 1;
  let totalAmount = "0";
  do {
    const result = await saasClient.listExpenses({ ...params, page, pageSize: MAX_API_PAGE_SIZE });
    all = all.concat(result.data);
    totalPages = result.totalPages;
    totalAmount = result.totalAmount;
    page += 1;
  } while (page <= totalPages);
  return { data: all, totalAmount };
}

module.exports = function setupExpensesHandlers(store) {
  // Generic transactions-list delete — handles two unrelated concerns by ID
  // prefix. Product Sale rows live behind the multi-tenant API's per-item
  // return endpoint; a legacy Product Sale delete always removed the WHOLE
  // billing record regardless of which item was clicked (the item id was
  // parsed but never used) — replicated here by fully returning every item
  // on that bill in turn; the API's own returnProductTransaction already
  // deletes the Billing row once its last item is gone, so no separate
  // "delete whole bill" endpoint is needed.
  ipcMain.handle("delete-transaction", async (_event, { id, type }) => {
    try {
      if (type === "Expense") {
        const expenseId = parseInt(id.replace("expense_", ""), 10);
        if (isNaN(expenseId)) return { success: false, message: "Invalid expense ID" };
        await saasClient.deleteExpense(expenseId);
        return { success: true };
      }

      if (type === "Product Sale") {
        const match = id.match(/^bill_(\d+)_item_\d+$/);
        if (!match) return { success: false, message: "Invalid billing ID" };
        const billingId = parseInt(match[1], 10);

        const result = await saasClient.listProductTransactions({ search: String(billingId), pageSize: 100 });
        const items = result.data.filter((t) => t.billingId === billingId);
        for (const item of items) {
          await saasClient.returnProductTransaction(item.itemId, { billingId });
        }
        return { success: true };
      }

      return { success: false, message: "Unsupported transaction type for deletion" };
    } catch (error) {
      console.error("[delete-transaction]", error);
      return { success: false, message: error.message };
    }
  });

  ipcMain.handle("get-expense-categories", async () => {
    try {
      const result = await saasClient.listExpenseCategories();
      return { success: true, data: result.data };
    } catch (err) {
      console.error("[get-expense-categories]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("add-expense-category", async (_event, { name, description }) => {
    try {
      const result = await saasClient.createExpenseCategory({
        name: name.trim(),
        description: description?.trim() || undefined,
      });
      return { success: true, id: result.data.id };
    } catch (err) {
      console.error("[add-expense-category]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("update-expense-category", async (_event, { id, name, description }) => {
    try {
      await saasClient.updateExpenseCategory(id, { name: name.trim(), description: description?.trim() || null });
      return { success: true };
    } catch (err) {
      console.error("[update-expense-category]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("delete-expense-category", async (_event, id) => {
    try {
      await saasClient.deleteExpenseCategory(id);
      return { success: true };
    } catch (err) {
      console.error("[delete-expense-category]", err);
      return { success: false, error: err.message };
    }
  });

  // GET expenses – single date OR date range, plus an optional branch_id
  // filter (owner-only — a branch-scoped caller's results are already
  // forced to their own branch server-side regardless of this).
  // Payload: { date } OR { startDate, endDate }, + { branch_id? }
  ipcMain.handle("get-expenses", async (_event, filters = {}) => {
    try {
      const { branch_id, ...rest } = filters;
      const params = { ...rest, ...(branch_id ? { branchId: branch_id } : {}) };
      const { data } = await fetchAllExpenses(params);
      return { success: true, data: data.map(serializeExpense) };
    } catch (err) {
      console.error("[get-expenses]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("add-expense", async (_event, { name, category_id, amount, date, notes, branch_id }) => {
    try {
      const result = await saasClient.createExpense({
        name: name.trim(),
        categoryId: category_id,
        amount,
        date,
        notes: notes?.trim() || undefined,
        // Only present when the caller is an owner picking a branch in the
        // UI — a branch-scoped admin/user's form never includes this key,
        // and the backend forces their own branch regardless either way.
        ...(branch_id !== undefined && branch_id !== "" ? { branchId: Number(branch_id) } : {}),
      });
      return { success: true, id: result.data.id };
    } catch (err) {
      console.error("[add-expense]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("update-expense", async (_event, { id, name, category_id, amount, date, notes, branch_id }) => {
    try {
      await saasClient.updateExpense(id, {
        name: name.trim(),
        categoryId: category_id,
        amount,
        date,
        notes: notes?.trim() || null,
        // undefined = don't touch (non-owner callers never send this key);
        // "" = owner explicitly chose "Clinic-wide", clear it back to null.
        ...(branch_id !== undefined ? { branchId: branch_id === "" ? null : Number(branch_id) } : {}),
      });
      return { success: true };
    } catch (err) {
      console.error("[update-expense]", err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("delete-expense", async (_event, id) => {
    try {
      await saasClient.deleteExpense(id);
      return { success: true };
    } catch (err) {
      console.error("[delete-expense]", err);
      return { success: false, error: err.message };
    }
  });

  // GET daily/range expense TOTAL (for badge / PDF header) — pageSize:1
  // since only the list response's always-full-filter totalAmount is
  // needed, not the rows themselves.
  ipcMain.handle("get-expense-total", async (_event, { date, startDate, endDate } = {}) => {
    try {
      const result = await saasClient.listExpenses({ date, startDate, endDate, pageSize: 1 });
      return { success: true, total: parseFloat(result.totalAmount) || 0 };
    } catch (err) {
      console.error("[get-expense-total]", err);
      return { success: false, error: err.message };
    }
  });

  // Download expense report PDF (saved under Documents/PetVet-Expenses)
  ipcMain.handle("download-expense-pdf", async (_event, { date, startDate, endDate } = {}) => {
    try {
      const { data, totalAmount } = await fetchAllExpenses({ date, startDate, endDate });
      const expenses = data.map(serializeExpense);
      const total = parseFloat(totalAmount) || 0;

      const clinicResult = await saasClient.getMyClinic();
      const branding = await resolveApiBranding(store, clinicResult.clinic);

      const baseDir = path.join(app.getPath("documents"), "PetVet-Expenses");
      await fs.promises.mkdir(baseDir, { recursive: true });

      const label = date ? date : `${startDate || "start"}_to_${endDate || "end"}`;
      const filePath = path.join(
        baseDir,
        `ExpenseReport_${String(label).replace(/[^\w.-]+/g, "_")}_${Date.now()}.pdf`,
      );

      await generateExpenseReportPDFAsync({ expenses, total, date, startDate, endDate, branding }, filePath);

      await shell.openPath(filePath);
      return { success: true, message: `Report saved to:\n${filePath}`, pdfPath: filePath };
    } catch (err) {
      console.error("[download-expense-pdf]", err);
      return { success: false, error: err.message };
    }
  });

  // Paginated/searchable list — Payments.jsx's Expenses tab.
  ipcMain.handle("get-expenses-list", async (event, { page = 1, limit = 10, search = "", category = "" }) => {
    try {
      const [listResult, categoriesResult] = await Promise.all([
        saasClient.listExpenses({ page, pageSize: limit, search: search || undefined, category: category || undefined }),
        saasClient.listExpenseCategories(),
      ]);
      return {
        success: true,
        expenses: listResult.data.map(serializeExpense),
        total: listResult.total,
        totalPages: listResult.totalPages,
        categories: categoriesResult.data,
      };
    } catch (error) {
      console.error("get-expenses-list error:", error);
      return { success: false, message: error.message };
    }
  });
};
