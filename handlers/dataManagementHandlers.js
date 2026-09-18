const { ipcMain, dialog } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const XLSX = require("xlsx");
const saasClient = require("./saasClient");

// Bulk data export/import — now backed by the multi-tenant API's existing
// list/create endpoints (loop-paginated for export, one row at a time for
// import) instead of raw SQL against a local per-clinic MySQL database.
// Import's supported-table scope matches the legacy handler exactly —
// Appointments/Billing/BillingItems/AppointmentServices were never
// implemented there either ("Complex relationships"), preserved as a
// documented limitation, not a new one. One real behavior change versus
// the old handler: that version wrapped the whole import in one local DB
// transaction (all-or-nothing); this one can't, since each row is now an
// independent HTTP call — a row that fails partway through an import
// leaves everything imported before it in place rather than rolling back.

// Same page-loop-until-last-page pattern already used for Reports' expense
// export (reportsHandlers.js) — walks every page of a paginated list
// endpoint to reconstruct the legacy unpaginated SELECT *.
async function fetchAllPages(listFn, params = {}) {
  let all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = await listFn({ ...params, page, pageSize: 100 });
    all = all.concat(result.data);
    totalPages = result.totalPages;
    page += 1;
  } while (page <= totalPages);
  return all;
}

// A row that fails with a 4xx (duplicate key, not found, bad value) is
// counted as "skipped," not a hard failure — matches the legacy handler's
// own "check first, insert only if missing" duplicate handling in spirit,
// and is more forgiving of messy real-world spreadsheet data than aborting
// the whole import on one bad row. A 5xx/network error still aborts.
async function importRows(rows, createFn) {
  let count = 0;
  for (const row of rows) {
    try {
      await createFn(row);
      count++;
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
    }
  }
  return count;
}

function findDataByTable(importData, tableName) {
  for (const [sheetName, sheetData] of Object.entries(importData)) {
    if (
      sheetName.toLowerCase().includes(tableName.toLowerCase()) ||
      (sheetData.length > 0 &&
        Object.keys(sheetData[0]).some((key) => key.toLowerCase().includes(tableName.toLowerCase().slice(0, -1))))
    ) {
      return sheetData;
    }
  }
  return [];
}

module.exports = function setupDataManagementHandlers() {
  ipcMain.handle("export-data", async (_event, options) => {
    try {
      const exportData = {};

      if (options.includeClients) {
        const clients = await fetchAllPages(saasClient.listClients);
        exportData.clients = clients.map((c) => ({
          client_id: c.id,
          client_name: c.clientName,
          contact_number: c.contactNumber,
          address: c.address,
        }));
      }
      if (options.includePets) {
        const pets = await fetchAllPages(saasClient.listPets);
        exportData.pets = pets.map((p) => ({
          pet_id: p.id,
          client_id: p.clientId,
          pet_name: p.petName,
          sex: p.sex,
          species: p.species,
          breed: p.breed,
          color: p.color,
          date_of_birth: p.dateOfBirth,
          age: p.age,
        }));
      }
      if (options.includeAppointments) {
        const appointments = await fetchAllPages(saasClient.listAppointments);
        exportData.appointments = appointments.map((a) => ({
          appointment_id: a.id,
          pet_id: a.petId,
          pet_name: a.petName,
          client_name: a.clientName,
          appointment_date: a.appointmentDate,
          appointment_time: a.appointmentTime,
          doctor: a.doctor,
          status: a.status,
          total_amount: a.totalAmount,
          billing_status: a.billingStatus,
        }));
      }
      if (options.includeEmployees) {
        const employees = await fetchAllPages(saasClient.listEmployees);
        exportData.employees = employees.map((e) => ({
          id: e.id,
          name: e.name,
          position: e.position,
          designation: e.designation,
          salary: e.salary,
          contact: e.contact,
          joined_on: e.joinedOn,
        }));
      }

      const exportDir = path.join(os.homedir(), "Desktop", "PodVet-Backup");
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      const workbook = XLSX.utils.book_new();
      Object.keys(exportData).forEach((tableName) => {
        if (exportData[tableName].length > 0) {
          const worksheet = XLSX.utils.json_to_sheet(exportData[tableName]);
          XLSX.utils.book_append_sheet(workbook, worksheet, tableName);
        }
      });

      const filePath = path.join(exportDir, `data-export-${Date.now()}.xlsx`);
      XLSX.writeFile(workbook, filePath);

      return {
        success: true,
        message: "Data exported successfully to Excel",
        filePath,
        exportedTables: Object.keys(exportData),
      };
    } catch (err) {
      console.error("[export-data]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("open-file-dialog", async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "Data Files", extensions: ["json", "xlsx", "xls"] },
          { name: "JSON", extensions: ["json"] },
          { name: "Excel", extensions: ["xlsx", "xls"] },
        ],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        return { success: true, filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) };
      }
      return { success: false, message: "No file selected" };
    } catch (err) {
      console.error("[open-file-dialog]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("import-data", async (_event, filePath) => {
    try {
      const fileExtension = path.extname(filePath).toLowerCase();
      let importData = {};

      if (fileExtension === ".xlsx" || fileExtension === ".xls") {
        const workbook = XLSX.readFile(filePath);
        workbook.SheetNames.forEach((sheetName) => {
          importData[sheetName] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        });
      } else if (fileExtension === ".json") {
        importData = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } else {
        return { success: false, message: "Unsupported file format" };
      }

      const importResults = {};
      let importedCount = 0;

      const clients = findDataByTable(importData, "clients").filter(
        (r) => (r.client_name || r["Client Name"] || r.clientName) && (r.contact_number || r["Contact Number"] || r.contact || r.phone),
      );
      importResults.Clients = await importRows(clients, (row) =>
        saasClient.createClient({
          clientName: row.client_name || row["Client Name"] || row.clientName,
          contactNumber: row.contact_number || row["Contact Number"] || row.contact || row.phone,
          address: row.address || row["Address"] || undefined,
        }),
      );
      importedCount += importResults.Clients;

      // No `email` column in the legacy Users sheet (createClinicUser now
      // requires one) — synthesized from the username when missing, same
      // spirit as the legacy handler's own 'defaultpassword' fallback for a
      // missing password.
      const users = findDataByTable(importData, "users").filter((r) => r.name && r.username);
      importResults.Users = await importRows(users, (row) =>
        saasClient.createClinicUser({
          name: row.name,
          username: row.username,
          email: row.email || `${row.username}@imported.podvet.local`,
          password: row.password && String(row.password).length >= 8 ? String(row.password) : "ImportedUser123",
          role: String(row.role || "USER").toUpperCase() === "ADMIN" ? "ADMIN" : "USER",
        }),
      );
      importedCount += importResults.Users;

      const employees = findDataByTable(importData, "employees").filter(
        (r) => r.name && r.position && (r.contact || r.contactNumber),
      );
      importResults.Employees = await importRows(employees, (row) =>
        saasClient.createEmployee({
          name: row.name,
          position: row.position,
          designation: row.designation || undefined,
          salary: parseFloat(row.salary) || 0,
          contact: row.contact || row.contactNumber,
          joinedOn: row.joined_on || row.joinedOn || new Date().toISOString().split("T")[0],
        }),
      );
      importedCount += importResults.Employees;

      const services = findDataByTable(importData, "services").filter((r) => r.name && r.category);
      importResults.Services = await importRows(services, (row) =>
        saasClient.createService({
          name: row.name,
          category: row.category,
          baseRate: parseFloat(row.base_rate) || 0,
        }),
      );
      importedCount += importResults.Services;

      const products = findDataByTable(importData, "products").filter((r) => (r.barcode_number || r.barcodeNumber) && r.name);
      importResults.Products = await importRows(products, (row) =>
        saasClient.createProduct({
          barcodeNumber: row.barcode_number || row.barcodeNumber,
          name: row.name,
          price: parseFloat(row.price) || 0,
          quantity: parseFloat(row.quantity) || 0,
        }),
      );
      importedCount += importResults.Products;

      const coupons = findDataByTable(importData, "coupons").filter((r) => r.code);
      importResults.Coupons = await importRows(coupons, (row) =>
        saasClient.createCoupon({
          code: row.code,
          discountType: String(row.discount_type || row.discountType || "PERCENT").toUpperCase(),
          discountValue: parseFloat(row.discount_value || row.discountValue) || 0,
          startDate: row.start_date || row.startDate || undefined,
          expiryDate: row.expiry_date || row.expiryDate || undefined,
          usageLimit: parseInt(row.usage_limit || row.usageLimit) || undefined,
        }),
      );
      importedCount += importResults.Coupons;

      // Pets are created under a specific client (POST /clients/:id/pets),
      // so client_id must resolve to a client this clinic actually owns —
      // matches the legacy handler's own "verify client exists first"
      // guard, just enforced server-side (404) instead of a local SELECT.
      const pets = findDataByTable(importData, "pets").filter((r) => {
        const clientId = parseInt(r.client_id || r.clientId);
        return clientId && (r.pet_name || r.petName) && r.sex && r.species;
      });
      importResults.Pets = await importRows(pets, (row) =>
        saasClient.createClientPet(parseInt(row.client_id || row.clientId), {
          petName: row.pet_name || row.petName,
          sex: row.sex,
          species: row.species,
          breed: row.breed || undefined,
          color: row.color || undefined,
          dateOfBirth: row.date_of_birth || row.dateOfBirth || undefined,
          age: row.age || undefined,
        }),
      );
      importedCount += importResults.Pets;

      // Never implemented, even in the legacy local-DB handler ("Complex
      // relationships") — preserved as-is, not a new limitation.
      importResults.Appointments = 0;
      importResults.Billing = 0;
      importResults.BillingItems = 0;
      importResults.AppointmentServices = 0;

      return {
        success: true,
        message: `Data imported successfully. ${importedCount} records added.`,
        details: importResults,
      };
    } catch (err) {
      console.error("[import-data]", err);
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle("debug-excel", async (_event, filePath) => {
    try {
      const workbook = XLSX.readFile(filePath);
      const result = {};
      workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);
        result[sheetName] = {
          rowCount: data.length,
          columns: data.length > 0 ? Object.keys(data[0]) : [],
          firstRow: data.length > 0 ? data[0] : null,
        };
      });
      return { success: true, data: result };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
};
