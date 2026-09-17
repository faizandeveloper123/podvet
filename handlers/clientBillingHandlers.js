const { ipcMain, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { formatTime, resolveApiBranding } = require('./utils');
const saasClient = require('./saasClient');
const { printGeneratedPdf } = require('../generate_invoice');

const paymentStatusToLocal = { PAID: "Paid", UNPAID: "Unpaid", PARTIALLY_PAID: "Partially Paid" };

// Client billing/ledger reports and WhatsApp integration — backed by the
// multi-tenant API's /api/clients/:id/unpaid-ledger and
// /api/clients/unpaid-summary. open-whatsapp is pure OS-level (no DB
// coupling at all) and stays completely unchanged.
module.exports = function setupClientBillingHandlers(store) {
ipcMain.handle('open-whatsapp', async (event, url) => {
  // The desktop-app deep link races against a timeout because
  // shell.openExternal doesn't reliably reject for an unregistered
  // protocol (whatsapp:// when WhatsApp Desktop isn't installed) — without
  // the race this would just hang instead of falling back to wa.me/browser.
  const match = url.match(/wa\.me\/(\d+)(?:\?text=(.*))?/);
  if (!match) { await shell.openExternal(url); return; }
  const [, number, encodedText] = match;
  const desktopUrl = `whatsapp://send?phone=${number}${encodedText ? `&text=${encodedText}` : ''}`;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('whatsapp-desktop-timeout')), 1200));
  try {
    await Promise.race([shell.openExternal(desktopUrl), timeout]);
  } catch {
    await shell.openExternal(url); // fallback to WhatsApp Web / browser
  }
});

ipcMain.handle('generate-client-unpaid-ledger', async (event, { client }) => {
  try {
    const ledgerResult = await saasClient.getClientUnpaidLedger(client.client_id);
    const ledger = ledgerResult.data;

    const clinicResult = await saasClient.getMyClinic();
    const branding = await resolveApiBranding(store, clinicResult.clinic);
    const RED = branding.color
      ? (() => {
          const h = branding.color.replace("#", "");
          return [parseInt(h.substring(0,2),16), parseInt(h.substring(2,4),16), parseInt(h.substring(4,6),16)];
        })()
      : [139, 0, 0];

    const logoFile = (() => {
      if (branding.logoPath && fs.existsSync(branding.logoPath)) return branding.logoPath;
      const candidates = app.isPackaged
        ? [
            path.join(app.getAppPath(), "clinic_logo.png"),
            path.join(process.resourcesPath, "app.asar.unpacked", "clinic_logo.png"),
            path.join(process.resourcesPath, "clinic_logo.png"),
          ]
        // clinic_logo.png is bundled at the project root, same as
        // generate_invoice.js's identical fallback — but this file lives in
        // handlers/, so __dirname alone (unlike generate_invoice.js, which
        // *is* at the root) pointed one directory too deep and always
        // missed, silently dropping the logo whenever a clinic had no
        // logoUrl configured (the ledger's only caller of this fallback).
        : [path.join(__dirname, "..", "clinic_logo.png")];
      return candidates.find((c) => fs.existsSync(c)) || null;
    })();

    // Fetch itemized services/products per appointment — the ledger
    // endpoint only returns aggregate totals, so this reconstructs the
    // same per-line breakdown the legacy SQL's extra per-appointment
    // queries produced, via the already-migrated appointments/products
    // endpoints instead of new backend work.
    let clientData = { ...client };
    const appointmentsWithProducts = [];
    for (const apt of ledger.appointments) {
      // getAppointmentProductsDisplay (not the plain getAppointmentProducts)
      // — a partial payment that included products merges them into
      // BillingItem rows and deletes the live AppointmentProduct rows (see
      // clientBilling.service.ts's computeUnpaidBreakdown, which apt.productsTotal
      // above already comes from and had the same gap), so the plain
      // endpoint would silently omit already-billed product lines here even
      // though productsTotal now correctly includes them.
      const [billing, productsResult] = await Promise.all([
        saasClient.getAppointmentForBilling(apt.appointmentId),
        saasClient.getAppointmentProductsDisplay(apt.appointmentId),
      ]);
      const services = billing.data.services.map((s) => ({
        name: s.serviceName,
        rate: s.rate,
        quantity: s.quantity,
        total: Number(s.rate ?? 0) * s.quantity,
      }));
      // getAppointmentProductsDisplay returns one row per live
      // AppointmentProduct plus one per already-billed BillingItem — a
      // product added twice via the Appointments "Products" button before
      // either add was billed (two live rows), or added again after an
      // earlier add of the same product was already billed (one billed +
      // one live row), would otherwise print as two separate lines on the
      // statement even though the total was always correct. Merge by
      // product_id (summing qty/total) before building the PDF's line items.
      const productsByProductId = new Map();
      for (const p of productsResult.data) {
        const existing = p.productId != null ? productsByProductId.get(p.productId) : null;
        if (existing) {
          existing.quantity = (parseFloat(existing.quantity) || 0) + (parseFloat(p.quantity) || 0);
          existing.total = (parseFloat(existing.total) || 0) + (parseFloat(p.total) || 0);
        } else {
          const row = { id: p.id, product_id: p.productId, name: p.name, quantity: p.quantity, price: p.price, total: p.total };
          if (p.productId != null) productsByProductId.set(p.productId, row);
          else productsByProductId.set(`__no_product_id_${p.id}`, row);
        }
      }
      const products = [...productsByProductId.values()];

      appointmentsWithProducts.push({
        date:            apt.date.slice(0, 10),
        time:            apt.time ? apt.time.match(/T(\d{2}:\d{2})/)?.[1] : "",
        amount:          apt.amount,
        appointment_id:  apt.appointmentId,
        pet_name:        apt.petName,
        billing_status:  paymentStatusToLocal[apt.billingStatus] || apt.billingStatus,
        already_paid:    apt.alreadyPaid,
        appointment_fee: apt.appointmentFee,
        first_time_fee:  billing.data.firstTimeFee ? Number(billing.data.firstTimeFee) : 0,
        services,
        products_total:  apt.productsTotal,
        products,
        remaining:       apt.remaining,
        discount_amount: apt.discountAmount,
        gross_total:     apt.grossTotal,
      });
    }
    clientData.appointments = appointmentsWithProducts;

    // Quick Bill unpaid balances — same source as the on-screen "Outstanding
    // Balances (by Client)" panel's Quick Bills section (getQuickBillUnpaidDetail,
    // see billing.service.ts's getQuickBillUnpaidDetail). A quick bill has no
    // Appointment of its own, so a client whose only outstanding balance is a
    // quick bill would otherwise get a statement showing PKR 0 — this call is
    // best-effort (an API hiccup here shouldn't block the appointments-only
    // portion of the statement from generating).
    let quickBillsData = [];
    try {
      const qbDetailResult = await saasClient.getQuickBillUnpaidDetail(client.client_id);
      quickBillsData = (qbDetailResult.data.quickBills || []).map((qb) => ({
        invoice_no: qb.invoiceNo,
        date: qb.date.slice(0, 10),
        total: Number(qb.total),
        paid: Number(qb.paid),
        remaining: Number(qb.remaining),
        items: (qb.items || []).map((i) => ({ name: i.name, quantity: i.quantity, total: Number(i.total) })),
      }));
    } catch (qbErr) {
      console.error('[generate-client-unpaid-ledger] failed to fetch quick bill balances (statement will show appointments only):', qbErr);
    }

    // Product sale (standalone walk-in Billing rows from the Products
    // screen) unpaid balances — same source as the on-screen "Outstanding
    // Balances (by Client)" panel's Product Sales section
    // (getProductBillingUnpaidDetail, see billing.service.ts's
    // getProductBillingUnpaidDetail). Mirrors the Quick Bill fetch above;
    // best-effort for the same reason.
    let productSalesData = [];
    try {
      const psDetailResult = await saasClient.getProductBillingUnpaidDetail(client.client_id);
      productSalesData = (psDetailResult.data.billings || []).map((b) => ({
        billing_id: b.billingId,
        date: b.date.slice(0, 10),
        final_amount: Number(b.finalAmount),
        paid: Number(b.paid),
        remaining: Number(b.remaining),
        items: (b.items || []).map((i) => ({ name: i.name, quantity: i.quantity, total: Number(i.total) })),
      }));
    } catch (psErr) {
      console.error('[generate-client-unpaid-ledger] failed to fetch product sale balances (statement will omit them):', psErr);
    }

    const { jsPDF } = require('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    const PW = 210;
    const M  = 18;
    const UW = PW - 2 * M;
    let y = M;

    // ── Logo ──────────────────────────────────────────────────────────────
    const LOGO_W = 32, LOGO_H = 28;
    if (logoFile) {
      const ext = path.extname(logoFile).slice(1).toUpperCase();
      const b64 = fs.readFileSync(logoFile, { encoding: "base64" });
      doc.addImage(`data:image/${ext.toLowerCase()};base64,${b64}`, ext, M, y, LOGO_W, LOGO_H);
    }

    // ── Clinic header ─────────────────────────────────────────────────────
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(...RED);
    doc.text(branding.clinicName.toUpperCase(), M + UW, y + 5, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(102, 102, 102);
    if (branding.address) doc.text(branding.address, M + UW, y + 10, { align: "right" });
    if (branding.phone)   doc.text(`Phone: ${branding.phone}`, M + UW, branding.address ? y + 15 : y + 10, { align: "right" });
    y += LOGO_H + 2;

    // ── Red rule ──────────────────────────────────────────────────────────
    doc.setDrawColor(...RED);
    doc.setLineWidth(0.8);
    doc.line(M, y, M + UW, y);
    y += 5;

    // ── Title bar ─────────────────────────────────────────────────────────
    const BAR_H = 22;
    doc.setFillColor(...RED);
    doc.roundedRect(M, y, UW, BAR_H, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.setTextColor(255, 255, 255);
    doc.text("OUTSTANDING BALANCE STATEMENT", M + UW / 2, y + 9, { align: "center" });

    const use12HourTime = store.get("use12HourTime", false);
    const generatedAt = new Date().toLocaleString("en-PK", { hour12: use12HourTime });
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(255, 204, 204);
    doc.text("Generated at:", M + 5, y + 17);
    const genLabelWidth = doc.getTextWidth("Generated at:");
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(generatedAt, M + 5 + genLabelWidth + 1.5, y + 17);

    const clientIdValue = `#${client.client_id}`;
    const clientIdValueWidth = doc.getTextWidth(clientIdValue);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(255, 204, 204);
    const clientIdLabelWidth = doc.getTextWidth("Client ID:");
    doc.text("Client ID:", M + UW - 3 - clientIdValueWidth - clientIdLabelWidth - 1.5, y + 17);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(clientIdValue, M + UW - 3, y + 17, { align: "right" });
    y += BAR_H + 8;

    // ── Client Information Box ────────────────────────────────────────────
    const pinkTint = RED.map(v => Math.round(255 * 0.95 + v * 0.05));
    doc.setFillColor(...pinkTint);
    doc.setDrawColor(...RED);
    doc.setLineWidth(0.5);
    doc.roundedRect(M, y, UW, 35, 2, 2, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...RED);
    doc.text("CLIENT INFORMATION", M + 5, y + 6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(51, 51, 51);
    doc.text(`Name: ${client.client_name}`, M + 5, y + 13);
    doc.text(`Contact: ${client.contact_number || 'N/A'}`, M + 5, y + 19);
    if (client.address) doc.text(`Address: ${client.address}`, M + 5, y + 25);
    y += 40;

    // ── Summary Cards ─────────────────────────────────────────────────────
    const cardWidth = (UW - 10) / 2;

    const totalItems = clientData.appointments.length + quickBillsData.length + productSalesData.length;
    const appointmentsTotalDue = clientData.appointments.reduce((s, a) => s + a.remaining, 0);
    const quickBillsTotalDue = quickBillsData.reduce((s, qb) => s + qb.remaining, 0);
    const productSalesTotalDue = productSalesData.reduce((s, ps) => s + ps.remaining, 0);
    const actualTotalDue = appointmentsTotalDue + quickBillsTotalDue + productSalesTotalDue;

    doc.setFillColor(...RED);
    doc.roundedRect(M, y, cardWidth, 20, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text("OUTSTANDING ITEMS", M + 5, y + 7);
    doc.setFontSize(16);
    doc.text(String(totalItems), M + 5, y + 16);

    doc.setFillColor(...RED);
    doc.roundedRect(M + cardWidth + 10, y, cardWidth, 20, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text("TOTAL OUTSTANDING", M + cardWidth + 15, y + 7);
    doc.setFontSize(14);
    doc.text(`PKR ${Math.round(actualTotalDue).toLocaleString()}`, M + cardWidth + 15, y + 16);
    y += 28;

    const ROW_H = 9;

    // ── Appointment Details Table ─────────────────────────────────────────
    if (clientData.appointments.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...RED);
    doc.text("APPOINTMENT DETAILS", M, y);
    y += 6;

    const col = {
      sn:     M,
      date:   M + 12,
      time:   M + 52,
      amount: M + UW - 3,
    };

    const drawTableHeader = () => {
      doc.setFillColor(...RED);
      doc.rect(M, y, UW, 7, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(255, 255, 255);
      doc.text("#",          col.sn + 3,   y + 5);
      doc.text("Date",       col.date + 1, y + 5);
      doc.text("Time",       col.time + 1, y + 5);
      doc.text("Amount Due", col.amount,   y + 5, { align: "right" });
      y += 7;
    };

    drawTableHeader();

    clientData.appointments.forEach((apt, idx) => {
      const isPartial   = (apt.billing_status || "Unpaid") === "Partially Paid";
      const remaining   = Math.max(0, (apt.amount || 0) - (apt.already_paid || 0));
      const hasDiscount = apt.discount_amount > 0;
      const hasProducts = apt.products && apt.products.length > 0;

      // ── Height estimation ──────────────────────────────────────────────
      const hasFirstTimeFee = (apt.first_time_fee || 0) > 0;
      const hasServices     = apt.services && apt.services.length > 0;
      const hasAppointmentFee = (apt.appointment_fee || 0) > 0;

      const apptFeeLines = hasAppointmentFee
        ? ((hasFirstTimeFee ? 1 : 0) + (hasServices ? apt.services.length : 1))
        : 0;

      let breakdownLines = Math.max(apptFeeLines, 1);
      if (hasDiscount) {
        breakdownLines += 2; // discount row + net amount due
        if (apt.already_paid > 0) breakdownLines += 2; // already paid + balance remaining
      }
      if (hasProducts) {
        breakdownLines += 1 + apt.products.length + 2; // label + items + subtotal
        if (hasDiscount) breakdownLines += 1; // gross total line
      }

      const breakdownHeight = 4 + (breakdownLines * 5) + 4;
      const requiredHeight  = ROW_H + breakdownHeight;

      if (y + requiredHeight > 270) {
        doc.addPage();
        y = M;
        drawTableHeader();
      }

      // ── Main row ───────────────────────────────────────────────────────
      if (idx % 2 === 0) {
        doc.setFillColor(...pinkTint);
        doc.rect(M, y, UW, ROW_H, "F");
      }
      doc.setDrawColor(221, 221, 221);
      doc.setLineWidth(0.1);
      doc.line(M, y + ROW_H, M + UW, y + ROW_H);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(51, 51, 51);
      doc.text(String(idx + 1),                           col.sn + 3,   y + 5.5);
      doc.text(apt.date || "-",                           col.date + 1, y + 5.5);
      doc.text(`${formatTime(apt.time, use12HourTime) || "---"} - ${apt.pet_name}`, col.time + 1, y + 5.5);

      if (isPartial) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(180, 83, 9);
        doc.text(`PKR ${Math.round(remaining).toLocaleString()} remaining`, col.amount, y + 4.5, { align: "right" });
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(120, 120, 120);
        doc.text(`of PKR ${Math.round(apt.amount || 0).toLocaleString()}`, col.amount, y + 8, { align: "right" });
      } else {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor(...RED);
        doc.text(`PKR ${Math.round(apt.amount || 0).toLocaleString()}`, col.amount, y + 5.5, { align: "right" });
      }

      y += ROW_H;

      // ── Breakdown block ────────────────────────────────────────────────
      const BREAKDOWN_BG = idx % 2 === 0 ? [245, 245, 245] : [250, 250, 250];
      const breakdownStartY = y;

      doc.setFillColor(...BREAKDOWN_BG);
      doc.rect(M, breakdownStartY, UW, breakdownHeight, "F");
      doc.setFillColor(...RED);
      doc.rect(M, breakdownStartY, 2, breakdownHeight, "F");

      y += 4;

      if (hasDiscount) {
        // ── Appointment fee / services (original, pre-discount) ─────────
        if (hasAppointmentFee) {
          if (hasFirstTimeFee) {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.5);
            doc.setTextColor(90, 90, 90);
            doc.text("New Client Fee", M + 8, y + 4);
            doc.setTextColor(100, 100, 100);
            doc.text(`PKR ${Math.round(apt.first_time_fee).toLocaleString()}`, col.amount, y + 4, { align: "right" });
            y += 5;
          }
          if (hasServices) {
            for (const svc of apt.services) {
              let svcName = svc.name;
              const maxWidth = 95;
              if (doc.getTextWidth(svcName) > maxWidth) {
                while (doc.getTextWidth(svcName + '...') > maxWidth) svcName = svcName.slice(0, -1);
                svcName += '...';
              }
              doc.setFont("helvetica", "normal");
              doc.setFontSize(7.5);
              doc.setTextColor(90, 90, 90);
              doc.text(svcName, M + 8, y + 4);
              doc.setTextColor(100, 100, 100);
              doc.text(`PKR ${Math.round(parseFloat(svc.total) || parseFloat(svc.rate)).toLocaleString()}`, col.amount, y + 4, { align: "right" });
              y += 5;
            }
          } else {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.5);
            doc.setTextColor(90, 90, 90);
            doc.text("Appointment Fee (original)", M + 8, y + 4);
            doc.setTextColor(100, 100, 100);
            doc.text(`PKR ${Math.round(apt.appointment_fee).toLocaleString()}`, col.amount, y + 4, { align: "right" });
            y += 5;
          }
        }

        // ── Products (if any) ───────────────────────────────────────────
        if (hasProducts) {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("Products", M + 8, y + 4);
          y += 5;

          for (const product of apt.products) {
            let productName = product.name;
            const maxWidth = 95;
            if (doc.getTextWidth(productName) > maxWidth) {
              while (doc.getTextWidth(productName + "...") > maxWidth) productName = productName.slice(0, -1);
              productName += "...";
            }
            const qtyStr = parseFloat(product.quantity).toFixed(4).replace(/\.?0+$/, '');
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7);
            doc.setTextColor(100, 100, 100);
            doc.text(`- ${productName}  x${qtyStr}`, M + 10, y + 4);
            doc.text(`PKR ${Math.round(product.total).toLocaleString()}`, col.amount, y + 4, { align: "right" });
            y += 5;
          }

          // Products subtotal
          doc.setDrawColor(200, 200, 200);
          doc.setLineWidth(0.2);
          doc.line(M + 8, y, M + UW - 3, y);
          y += 2;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("Products Subtotal", M + 8, y + 4);
          doc.text(`PKR ${Math.round(apt.products_total).toLocaleString()}`, col.amount, y + 4, { align: "right" });
          y += 5;

          // Gross total (appt fee + products, before discount)
          doc.setDrawColor(200, 200, 200);
          doc.setLineWidth(0.2);
          doc.line(M + 8, y, M + UW - 3, y);
          y += 2;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(51, 51, 51);
          doc.text("Gross Total", M + 8, y + 4);
          doc.text(`PKR ${Math.round(apt.gross_total).toLocaleString()}`, col.amount, y + 4, { align: "right" });
          y += 5;
        }

        // ── Discount row ────────────────────────────────────────────────
        doc.setFillColor(220, 252, 231);
        doc.rect(M + 2, y, UW - 2, 6, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(7.5);
        doc.setTextColor(22, 101, 52);
        doc.text("Discount Applied", M + 8, y + 4.5);
        doc.text(`-PKR ${Math.round(apt.discount_amount).toLocaleString()}`, col.amount, y + 4.5, { align: "right" });
        y += 7;

        // ── Net amount due ──────────────────────────────────────────────
        doc.setDrawColor(...RED);
        doc.setLineWidth(0.4);
        doc.line(M + 8, y, M + UW - 3, y);
        y += 2;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(...RED);
        doc.text("Net Amount Due", M + 8, y + 4.5);
        doc.text(`PKR ${Math.round(apt.amount).toLocaleString()}`, col.amount, y + 4.5, { align: "right" });
        y += 7;

        // ── Already paid + balance (partial only) ───────────────────────
        if (apt.already_paid > 0) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("Already Paid", M + 8, y + 4.5);
          doc.setTextColor(22, 101, 52);
          doc.text(`-PKR ${Math.round(apt.already_paid).toLocaleString()}`, col.amount, y + 4.5, { align: "right" });
          y += 6;

          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(...RED);
          doc.text("Balance Remaining", M + 8, y + 4.5);
          doc.text(`PKR ${Math.round(apt.remaining).toLocaleString()}`, col.amount, y + 4.5, { align: "right" });
          y += 6;
        }

      } else {
        // ── No discount ─────────────────────────────────────────────────
        if (hasAppointmentFee) {
          if (hasFirstTimeFee) {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.5);
            doc.setTextColor(90, 90, 90);
            doc.text("New Client Fee", M + 8, y + 5);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(51, 51, 51);
            doc.text(`PKR ${Math.round(apt.first_time_fee).toLocaleString()}`, col.amount, y + 5, { align: "right" });
            y += 5;
          }
          if (hasServices) {
            for (const svc of apt.services) {
              let svcName = svc.name;
              const maxWidth = 95;
              if (doc.getTextWidth(svcName) > maxWidth) {
                while (doc.getTextWidth(svcName + '...') > maxWidth) svcName = svcName.slice(0, -1);
                svcName += '...';
              }
              doc.setFont("helvetica", "normal");
              doc.setFontSize(7.5);
              doc.setTextColor(90, 90, 90);
              doc.text(svcName, M + 8, y + 5);
              doc.setFont("helvetica", "bold");
              doc.setTextColor(51, 51, 51);
              doc.text(`PKR ${Math.round(parseFloat(svc.total) || parseFloat(svc.rate)).toLocaleString()}`, col.amount, y + 5, { align: "right" });
              y += 5;
            }
          } else {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.5);
            doc.setTextColor(90, 90, 90);
            doc.text("Appointment Fee", M + 8, y + 5);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(51, 51, 51);
            doc.text(`PKR ${Math.round(apt.appointment_fee).toLocaleString()}`, col.amount, y + 5, { align: "right" });
            y += 5;
          }
          y += 2;
        }

        if (hasProducts) {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("Products", M + 8, y + 4);
          y += 5;

          for (const product of apt.products) {
            let productName = product.name;
            const maxWidth = 95;
            if (doc.getTextWidth(productName) > maxWidth) {
              while (doc.getTextWidth(productName + "...") > maxWidth) productName = productName.slice(0, -1);
              productName += "...";
            }
            const qtyStr = parseFloat(product.quantity).toFixed(4).replace(/\.?0+$/, '');
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7);
            doc.setTextColor(100, 100, 100);
            doc.text(`- ${productName}  x${qtyStr}`, M + 10, y + 4);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(51, 51, 51);
            doc.text(`PKR ${Math.round(product.total).toLocaleString()}`, col.amount, y + 4, { align: "right" });
            y += 5;
          }

          doc.setDrawColor(200, 200, 200);
          doc.setLineWidth(0.2);
          doc.line(M + 8, y, M + UW - 3, y);
          y += 2;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(...RED);
          doc.text("Products Total", M + 8, y + 4);
          doc.text(`PKR ${Math.round(apt.products_total).toLocaleString()}`, col.amount, y + 4, { align: "right" });
          y += 6;
        }

        // ── Already paid + balance (partial only, no discount) ──────────
        if (apt.already_paid > 0) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("Already Paid", M + 8, y + 4.5);
          doc.setTextColor(22, 101, 52);
          doc.text(`-PKR ${Math.round(apt.already_paid).toLocaleString()}`, col.amount, y + 4.5, { align: "right" });
          y += 6;

          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(...RED);
          doc.text("Balance Remaining", M + 8, y + 4.5);
          doc.text(`PKR ${Math.round(apt.remaining).toLocaleString()}`, col.amount, y + 4.5, { align: "right" });
          y += 6;
        }
      }

      doc.setDrawColor(220, 220, 220);
      doc.setLineWidth(0.3);
      doc.line(M, y, M + UW, y);
      y += 3;
    });
    } // clientData.appointments.length > 0

    // ── Quick Bill Details Table ────────────────────────────────────────────
    // Simpler than the appointment breakdown above (no discount/products-vs-
    // fee distinction — a quick bill is just line items + amount collected),
    // but visually matches it. Skipped entirely for a client with no
    // outstanding quick bills, same as the Appointment Details table above.
    if (quickBillsData.length > 0) {
      if (y + 20 > 270) { doc.addPage(); y = M; }
      y += 4;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...RED);
      doc.text("QUICK BILL DETAILS", M, y);
      y += 6;

      const qbCol = { sn: M, date: M + 12, invoice: M + 52, amount: M + UW - 3 };
      const drawQbTableHeader = () => {
        doc.setFillColor(...RED);
        doc.rect(M, y, UW, 7, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(255, 255, 255);
        doc.text("#",          qbCol.sn + 3,      y + 5);
        doc.text("Date",       qbCol.date + 1,    y + 5);
        doc.text("Invoice",    qbCol.invoice + 1, y + 5);
        doc.text("Amount Due", qbCol.amount,      y + 5, { align: "right" });
        y += 7;
      };
      drawQbTableHeader();

      quickBillsData.forEach((qb, idx) => {
        const isPartial = qb.paid > 0;
        const itemLines = Math.max(qb.items.length, 1);
        let breakdownLines = itemLines;
        if (isPartial) breakdownLines += 2; // already paid + balance remaining
        const breakdownHeight = 4 + (breakdownLines * 5) + 4;
        const requiredHeight  = ROW_H + breakdownHeight;

        if (y + requiredHeight > 270) {
          doc.addPage();
          y = M;
          drawQbTableHeader();
        }

        // ── Main row ─────────────────────────────────────────────────────
        if (idx % 2 === 0) {
          doc.setFillColor(...pinkTint);
          doc.rect(M, y, UW, ROW_H, "F");
        }
        doc.setDrawColor(221, 221, 221);
        doc.setLineWidth(0.1);
        doc.line(M, y + ROW_H, M + UW, y + ROW_H);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(51, 51, 51);
        doc.text(String(idx + 1),      qbCol.sn + 3,      y + 5.5);
        doc.text(qb.date || "-",       qbCol.date + 1,    y + 5.5);
        doc.text(qb.invoice_no || "-", qbCol.invoice + 1, y + 5.5);

        if (isPartial) {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(180, 83, 9);
          doc.text(`PKR ${Math.round(qb.remaining).toLocaleString()} remaining`, qbCol.amount, y + 4.5, { align: "right" });
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7);
          doc.setTextColor(120, 120, 120);
          doc.text(`of PKR ${Math.round(qb.total).toLocaleString()}`, qbCol.amount, y + 8, { align: "right" });
        } else {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(...RED);
          doc.text(`PKR ${Math.round(qb.remaining).toLocaleString()}`, qbCol.amount, y + 5.5, { align: "right" });
        }

        y += ROW_H;

        // ── Breakdown block ─────────────────────────────────────────────
        const BREAKDOWN_BG = idx % 2 === 0 ? [245, 245, 245] : [250, 250, 250];
        const breakdownStartY = y;
        doc.setFillColor(...BREAKDOWN_BG);
        doc.rect(M, breakdownStartY, UW, breakdownHeight, "F");
        doc.setFillColor(...RED);
        doc.rect(M, breakdownStartY, 2, breakdownHeight, "F");
        y += 4;

        if (qb.items.length > 0) {
          qb.items.forEach((item) => {
            let itemName = item.name;
            const maxWidth = 95;
            if (doc.getTextWidth(itemName) > maxWidth) {
              while (doc.getTextWidth(itemName + '...') > maxWidth) itemName = itemName.slice(0, -1);
              itemName += '...';
            }
            const qtyStr = parseFloat(item.quantity).toFixed(4).replace(/\.?0+$/, '') || "0";
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.5);
            doc.setTextColor(90, 90, 90);
            doc.text(`${itemName}  x${qtyStr}`, M + 8, y + 4);
            doc.setTextColor(100, 100, 100);
            doc.text(`PKR ${Math.round(item.total).toLocaleString()}`, qbCol.amount, y + 4, { align: "right" });
            y += 5;
          });
        } else {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("No itemized lines", M + 8, y + 4);
          y += 5;
        }

        if (isPartial) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("Already Paid", M + 8, y + 4.5);
          doc.setTextColor(22, 101, 52);
          doc.text(`-PKR ${Math.round(qb.paid).toLocaleString()}`, qbCol.amount, y + 4.5, { align: "right" });
          y += 6;

          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(...RED);
          doc.text("Balance Remaining", M + 8, y + 4.5);
          doc.text(`PKR ${Math.round(qb.remaining).toLocaleString()}`, qbCol.amount, y + 4.5, { align: "right" });
          y += 6;
        }

        doc.setDrawColor(220, 220, 220);
        doc.setLineWidth(0.3);
        doc.line(M, y, M + UW, y);
        y += 3;
      });
    }

    // ── Product Sale Details Table ──────────────────────────────────────────
    // Same shape as the Quick Bill Details table above (standalone walk-in
    // sale + itemized products, no discount/products-vs-fee distinction).
    // Skipped entirely for a client with no outstanding product sales, same
    // as the tables above.
    if (productSalesData.length > 0) {
      if (y + 20 > 270) { doc.addPage(); y = M; }
      y += 4;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(...RED);
      doc.text("PRODUCT SALE DETAILS", M, y);
      y += 6;

      const psCol = { sn: M, date: M + 12, invoice: M + 52, amount: M + UW - 3 };
      const drawPsTableHeader = () => {
        doc.setFillColor(...RED);
        doc.rect(M, y, UW, 7, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(255, 255, 255);
        doc.text("#",          psCol.sn + 3,      y + 5);
        doc.text("Date",       psCol.date + 1,    y + 5);
        doc.text("Sale #",     psCol.invoice + 1, y + 5);
        doc.text("Amount Due", psCol.amount,      y + 5, { align: "right" });
        y += 7;
      };
      drawPsTableHeader();

      productSalesData.forEach((ps, idx) => {
        const isPartial = ps.paid > 0;
        const itemLines = Math.max(ps.items.length, 1);
        let breakdownLines = itemLines;
        if (isPartial) breakdownLines += 2; // already paid + balance remaining
        const breakdownHeight = 4 + (breakdownLines * 5) + 4;
        const requiredHeight  = ROW_H + breakdownHeight;

        if (y + requiredHeight > 270) {
          doc.addPage();
          y = M;
          drawPsTableHeader();
        }

        // ── Main row ─────────────────────────────────────────────────────
        if (idx % 2 === 0) {
          doc.setFillColor(...pinkTint);
          doc.rect(M, y, UW, ROW_H, "F");
        }
        doc.setDrawColor(221, 221, 221);
        doc.setLineWidth(0.1);
        doc.line(M, y + ROW_H, M + UW, y + ROW_H);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(51, 51, 51);
        doc.text(String(idx + 1),                     psCol.sn + 3,      y + 5.5);
        doc.text(ps.date || "-",                       psCol.date + 1,    y + 5.5);
        doc.text(ps.billing_id ? `#${ps.billing_id}` : "-", psCol.invoice + 1, y + 5.5);

        if (isPartial) {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(180, 83, 9);
          doc.text(`PKR ${Math.round(ps.remaining).toLocaleString()} remaining`, psCol.amount, y + 4.5, { align: "right" });
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7);
          doc.setTextColor(120, 120, 120);
          doc.text(`of PKR ${Math.round(ps.final_amount).toLocaleString()}`, psCol.amount, y + 8, { align: "right" });
        } else {
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(...RED);
          doc.text(`PKR ${Math.round(ps.remaining).toLocaleString()}`, psCol.amount, y + 5.5, { align: "right" });
        }

        y += ROW_H;

        // ── Breakdown block ─────────────────────────────────────────────
        const BREAKDOWN_BG = idx % 2 === 0 ? [245, 245, 245] : [250, 250, 250];
        const breakdownStartY = y;
        doc.setFillColor(...BREAKDOWN_BG);
        doc.rect(M, breakdownStartY, UW, breakdownHeight, "F");
        doc.setFillColor(...RED);
        doc.rect(M, breakdownStartY, 2, breakdownHeight, "F");
        y += 4;

        if (ps.items.length > 0) {
          ps.items.forEach((item) => {
            let itemName = item.name;
            const maxWidth = 95;
            if (doc.getTextWidth(itemName) > maxWidth) {
              while (doc.getTextWidth(itemName + '...') > maxWidth) itemName = itemName.slice(0, -1);
              itemName += '...';
            }
            const qtyStr = parseFloat(item.quantity).toFixed(4).replace(/\.?0+$/, '') || "0";
            doc.setFont("helvetica", "normal");
            doc.setFontSize(7.5);
            doc.setTextColor(90, 90, 90);
            doc.text(`${itemName}  x${qtyStr}`, M + 8, y + 4);
            doc.setTextColor(100, 100, 100);
            doc.text(`PKR ${Math.round(item.total).toLocaleString()}`, psCol.amount, y + 4, { align: "right" });
            y += 5;
          });
        } else {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("No itemized lines", M + 8, y + 4);
          y += 5;
        }

        if (isPartial) {
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(90, 90, 90);
          doc.text("Already Paid", M + 8, y + 4.5);
          doc.setTextColor(22, 101, 52);
          doc.text(`-PKR ${Math.round(ps.paid).toLocaleString()}`, psCol.amount, y + 4.5, { align: "right" });
          y += 6;

          doc.setFont("helvetica", "bold");
          doc.setFontSize(7.5);
          doc.setTextColor(...RED);
          doc.text("Balance Remaining", M + 8, y + 4.5);
          doc.text(`PKR ${Math.round(ps.remaining).toLocaleString()}`, psCol.amount, y + 4.5, { align: "right" });
          y += 6;
        }

        doc.setDrawColor(220, 220, 220);
        doc.setLineWidth(0.3);
        doc.line(M, y, M + UW, y);
        y += 3;
      });
    }

    // ── Total box ─────────────────────────────────────────────────────────
    y += 5;
    const TOT_W = 78;
    const TOT_X = M + UW - TOT_W;
    const CELL_H = 10;

    doc.setFillColor(...RED);
    doc.roundedRect(TOT_X, y, TOT_W, CELL_H, 2, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text("TOTAL OUTSTANDING", TOT_X + 5, y + 7);
    doc.text(`PKR ${Math.round(actualTotalDue).toLocaleString()}`, TOT_X + TOT_W - 5, y + 7, { align: "right" });
    y += CELL_H + 10;

    // ── Bank Details ──────────────────────────────────────────────────────
    if (branding.bankName || branding.bankAccount) {
      doc.setDrawColor(204, 204, 204);
      doc.setLineWidth(0.3);
      doc.line(M, y, M + UW, y);
      y += 4;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...RED);
      doc.text("Bank Details", M, y);
      y += 4;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(102, 102, 102);
      const bankLine = [branding.bankName, branding.bankAccount ? `Account: ${branding.bankAccount}` : ""]
        .filter(Boolean)
        .join("   |   ");
      doc.text(bankLine, M, y);
      y += 8;
    }

    // ── Footer ────────────────────────────────────────────────────────────
    doc.setDrawColor(204, 204, 204);
    doc.setLineWidth(0.3);
    doc.line(M, y, M + UW, y);
    y += 5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(102, 102, 102);
    doc.text("Please settle the outstanding amount at your earliest convenience.", M + UW / 2, y, { align: "center" });
    y += 4;
    doc.setFontSize(7);
    doc.setTextColor(170, 170, 170);
    doc.text("Thank you for trusting us with your pet's care!", M + UW / 2, y, { align: "center" });
    y += 4;
    doc.text("Developed by hifi.", M + UW / 2, y, { align: "center" });

    // ── Save to temp + return raw bytes ──────────────────────────────────
    // Written to a temp file (not ~/Documents, and not shell.openPath'd)
    // so the renderer can preview it in an in-app modal — the returned
    // `data` bytes build the iframe preview, `pdfPath` is only needed by
    // print-pdf-file for the native print dialog.
    const safeName  = client.client_name.replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const filePath  = path.join(app.getPath("temp"), `Outstanding_${safeName}_${timestamp}.pdf`);

    const pdfBytes = doc.output("arraybuffer");
    fs.writeFileSync(filePath, Buffer.from(pdfBytes));

    return { success: true, data: Buffer.from(pdfBytes), pdfPath: filePath };

  } catch (error) {
    console.error('generate-client-unpaid-ledger error:', error);
    return { success: false, message: error.message };
  }
});

// Generic A4 physical-print trigger for an already-rendered PDF file on
// disk (e.g. the Ledger Preview's pdfPath from generate-client-unpaid-ledger
// above) — mirrors payments' print-pdf-buffer, which does the same for a
// renderer-side PDF that only exists as in-memory bytes.
ipcMain.handle('print-pdf-file', async (event, filePath) => {
  try {
    return await printGeneratedPdf(filePath);
  } catch (err) {
    console.error('[print-pdf-file]', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-client-unpaid-summary', async (event, { search = '', page = 1, limit = 10 } = {}) => {
  try {
    const result = await saasClient.listClientUnpaidSummary({ search: search || undefined, page, pageSize: limit });
    const clients = result.data.map((c) => ({
      client_id: c.clientId,
      client_name: c.clientName,
      contact_number: c.contactNumber,
      address: c.address,
      unpaid_count: c.unpaidCount,
      total_due: c.totalDue,
      appointments: c.appointments.map((apt) => ({
        date: apt.date.slice(0, 10),
        time: apt.time ? String(apt.time).match(/T(\d{2}:\d{2})/)?.[1] : "",
        amount: apt.amount,
        appointment_id: apt.appointmentId,
        pet_name: apt.petName,
        billing_status: paymentStatusToLocal[apt.billingStatus] || apt.billingStatus,
        already_paid: apt.alreadyPaid,
        appointment_fee: apt.appointmentFee,
        products_total: apt.productsTotal,
        discount_amount: apt.discountAmount,
        remaining: apt.remaining,
      })),
    }));
    return { success: true, clients, total: result.total, totalPages: result.totalPages };
  } catch (error) {
    console.error('get-client-unpaid-summary error:', error);
    return { success: false, message: error.message };
  }
});

const payAllPaymentModeToApi = { Cash: "CASH", "Card Payment": "CARD_PAYMENT", "Bank Transfer": "BANK_TRANSFER" };

ipcMain.handle('pay-all-client-appointments', async (event, { client_id, payment_mode }) => {
  try {
    const result = await saasClient.payAllClientAppointments(client_id, {
      paymentMode: payAllPaymentModeToApi[payment_mode] || payment_mode,
    });
    return {
      success: true,
      message: `All ${result.data.appointmentCount} appointments marked as paid. Total: PKR ${result.data.totalPaid.toLocaleString()}`,
      appointmentCount: result.data.appointmentCount,
      totalPaid: result.data.totalPaid,
      pdfPaths: [],
    };
  } catch (error) {
    console.error('pay-all-client-appointments error:', error);
    return { success: false, message: error.message };
  }
});

// ── Outstanding Product Sales (walk-in Billing credit/partial sales) ──────
// Parallel to get-client-unpaid-summary/pay-all-client-appointments above,
// but sourced from standalone walk-in Billing rows (Product Billing screen)
// rather than Appointments — kept as its own section, matching legacy's own
// separate "Clients with Outstanding Product Sales" panel.
ipcMain.handle('get-product-billing-unpaid-clients', async (event, { search = '', page = 1, limit = 10 } = {}) => {
  try {
    const result = await saasClient.listProductBillingUnpaidClients({ search: search || undefined, page, pageSize: limit });
    const clients = result.data.map((c) => ({
      client_id: c.clientId,
      client_name: c.clientName,
      contact_number: c.contactNumber,
      address: c.address,
      unpaid_count: c.unpaidCount,
      total_due: c.totalDue,
    }));
    return { success: true, clients, total: result.total, totalPages: result.totalPages };
  } catch (error) {
    console.error('get-product-billing-unpaid-clients error:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-product-billing-unpaid-detail', async (event, client_id) => {
  try {
    const result = await saasClient.getProductBillingUnpaidDetail(client_id);
    const d = result.data;
    return {
      success: true,
      client_id: d.clientId,
      client_name: d.clientName,
      contact_number: d.contactNumber,
      address: d.address,
      total_due: d.totalDue,
      billings: d.billings.map((b) => ({
        billing_id: b.billingId,
        date: b.date.slice(0, 10),
        final_amount: b.finalAmount,
        paid: b.paid,
        remaining: b.remaining,
        items: b.items.map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
      })),
    };
  } catch (error) {
    console.error('get-product-billing-unpaid-detail error:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('pay-all-client-billing', async (event, { client_id, payment_mode }) => {
  try {
    const result = await saasClient.payAllClientBilling(client_id, {
      paymentMode: payAllPaymentModeToApi[payment_mode] || payment_mode,
    });
    return {
      success: true,
      message: `All ${result.data.billingCount} product sale(s) marked as paid. Total: PKR ${result.data.totalPaid.toLocaleString()}`,
      billingCount: result.data.billingCount,
      totalPaid: result.data.totalPaid,
    };
  } catch (error) {
    console.error('pay-all-client-billing error:', error);
    return { success: false, message: error.message };
  }
});

// ── Outstanding Quick Bills (custom-invoice credit/partial sales) ─────────
// Parallel to get-product-billing-unpaid-clients above, but sourced from
// CustomInvoice rows (Quick Bill) — a quick bill has no Appointment or
// walk-in Billing row of its own, so it never appears in either other list.
// Only quick bills saved with a matched client (see QuickBill.jsx's "Bill
// To" search) can ever surface here.
ipcMain.handle('get-quick-bill-unpaid-clients', async (event, { search = '', page = 1, limit = 10 } = {}) => {
  try {
    const result = await saasClient.listQuickBillUnpaidClients({ search: search || undefined, page, pageSize: limit });
    const clients = result.data.map((c) => ({
      client_id: c.clientId,
      client_name: c.clientName,
      contact_number: c.contactNumber,
      address: c.address,
      unpaid_count: c.unpaidCount,
      total_due: c.totalDue,
    }));
    return { success: true, clients, total: result.total, totalPages: result.totalPages };
  } catch (error) {
    console.error('get-quick-bill-unpaid-clients error:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-quick-bill-unpaid-detail', async (event, client_id) => {
  try {
    const result = await saasClient.getQuickBillUnpaidDetail(client_id);
    const d = result.data;
    return {
      success: true,
      client_id: d.clientId,
      client_name: d.clientName,
      contact_number: d.contactNumber,
      address: d.address,
      total_due: d.totalDue,
      quick_bills: d.quickBills.map((qb) => ({
        custom_invoice_id: qb.customInvoiceId,
        invoice_no: qb.invoiceNo,
        date: qb.date.slice(0, 10),
        total: qb.total,
        paid: qb.paid,
        remaining: qb.remaining,
        items: qb.items.map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
      })),
    };
  } catch (error) {
    console.error('get-quick-bill-unpaid-detail error:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('pay-all-client-quick-bills', async (event, { client_id, payment_mode }) => {
  try {
    const result = await saasClient.payAllClientQuickBills(client_id, {
      paymentMode: payAllPaymentModeToApi[payment_mode] || payment_mode,
    });
    return {
      success: true,
      message: `All ${result.data.quickBillCount} quick bill(s) marked as paid. Total: PKR ${result.data.totalPaid.toLocaleString()}`,
      quickBillCount: result.data.quickBillCount,
      totalPaid: result.data.totalPaid,
    };
  } catch (error) {
    console.error('pay-all-client-quick-bills error:', error);
    return { success: false, message: error.message };
  }
});
};
