// recap.js
// Membuat file PDF rekap kas: tabel bergaris (nomor, nama, kolom per bulan,
// baris total) meniru tampilan tabel Excel di lembar kas asli.

const PDFDocument = require('pdfkit');

function currency(n) {
  return n ? 'Rp ' + Number(n).toLocaleString('id-ID') : '-';
}

const COLORS = {
  header: '#2f5233',
  headerMonth: '#a9822c',
  border: '#26291f',
  totalBg: '#e4ead9',
  paidText: '#2f5233',
  unpaidText: '#8a8878',
};

/**
 * Menghasilkan Promise<Buffer> berisi file PDF.
 * months: array nama bulan, members: array nama anggota (string),
 * payments: object "nama||bulan" -> nominal.
 */
function buildRecapPdf({ months, members, payments, title }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const marginLeft = doc.page.margins.left;
    const marginTop = doc.page.margins.top;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colNo = 26;
    const colNama = 130;
    const monthColWidth = (pageWidth - colNo - colNama) / months.length;
    const rowHeight = 15;
    const headerHeight = 20;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - rowHeight;

    doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.header)
      .text(title || 'Rekap Kas Wajib', marginLeft, marginTop);
    doc.fontSize(8).font('Helvetica').fillColor('#5c5a4c')
      .text('Dicetak otomatis: ' + new Date().toLocaleString('id-ID'), marginLeft, marginTop + 18);

    let y = marginTop + 36;

    function drawHeaderRow() {
      let x = marginLeft;
      doc.rect(x, y, colNo, headerHeight).fill(COLORS.header);
      doc.rect(x + colNo, y, colNama, headerHeight).fill(COLORS.header);
      doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
      doc.text('No', x, y + 6, { width: colNo, align: 'center' });
      doc.text('Nama', x + colNo + 4, y + 6, { width: colNama - 8 });

      let mx = x + colNo + colNama;
      months.forEach(m => {
        doc.rect(mx, y, monthColWidth, headerHeight).fill(COLORS.headerMonth);
        doc.fillColor('#ffffff').text(m, mx, y + 6, { width: monthColWidth, align: 'center' });
        mx += monthColWidth;
      });
      doc.fillColor('#000000').font('Helvetica');
      y += headerHeight;
    }

    function drawCellBorder(x, rowY, width) {
      doc.rect(x, rowY, width, rowHeight).lineWidth(0.4).strokeColor(COLORS.border).stroke();
    }

    drawHeaderRow();

    members.forEach((member, idx) => {
      if (y > bottomLimit) {
        doc.addPage();
        y = marginTop;
        drawHeaderRow();
      }
      const x = marginLeft;
      drawCellBorder(x, y, colNo);
      doc.fontSize(7.5).fillColor('#000000').font('Helvetica')
        .text(String(idx + 1), x, y + 4, { width: colNo, align: 'center' });

      drawCellBorder(x + colNo, y, colNama);
      doc.text(member, x + colNo + 4, y + 4, { width: colNama - 8 });

      let mx = x + colNo + colNama;
      months.forEach(month => {
        drawCellBorder(mx, y, monthColWidth);
        const amt = payments[member + '||' + month];
        doc.fillColor(amt ? COLORS.paidText : COLORS.unpaidText)
          .text(currency(amt), mx, y + 4, { width: monthColWidth - 4, align: 'right' });
        mx += monthColWidth;
      });
      doc.fillColor('#000000');
      y += rowHeight;
    });

    if (y > bottomLimit) {
      doc.addPage();
      y = marginTop;
      drawHeaderRow();
    }
    const x = marginLeft;
    doc.rect(x, y, colNo + colNama, rowHeight).fill(COLORS.totalBg);
    doc.fillColor(COLORS.header).font('Helvetica-Bold').fontSize(8)
      .text('Total per bulan', x + 4, y + 4, { width: colNo + colNama - 8 });

    let mx = x + colNo + colNama;
    months.forEach(month => {
      let total = 0;
      members.forEach(member => { total += payments[member + '||' + month] || 0; });
      doc.rect(mx, y, monthColWidth, rowHeight).fill(COLORS.totalBg);
      doc.fillColor(COLORS.header).text(currency(total), mx, y + 4, { width: monthColWidth - 4, align: 'right' });
      mx += monthColWidth;
    });

    doc.end();
  });
}

/**
 * Menghasilkan Promise<Buffer> berisi file PDF daftar pengeluaran kas:
 * tanggal, bulan, keterangan, nominal, plus total di baris bawah.
 */
function buildExpensePdf({ expenses, totalMasuk, title }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 32 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const marginLeft = doc.page.margins.left;
    const marginTop = doc.page.margins.top;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const totalKeluar = expenses.reduce((s, e) => s + Number(e.nominal || 0), 0);
    const saldo = (totalMasuk || 0) - totalKeluar;

    doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.header)
      .text(title || 'Rekap Pengeluaran Kas', marginLeft, marginTop);
    doc.fontSize(8).font('Helvetica').fillColor('#5c5a4c')
      .text('Dicetak otomatis: ' + new Date().toLocaleString('id-ID'), marginLeft, marginTop + 18);

    let y = marginTop + 40;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#26291f');
    doc.text(`Total pemasukan: ${currency(totalMasuk || 0)}`, marginLeft, y);
    doc.text(`Total pengeluaran: ${currency(totalKeluar)}`, marginLeft, y + 14);
    doc.fillColor(saldo >= 0 ? COLORS.paidText : '#a13a2e')
      .text(`Saldo kas saat ini: ${currency(saldo)}`, marginLeft, y + 28);
    doc.fillColor('#000000');
    y += 52;

    const colNo = 22;
    const colTanggal = 62;
    const colBulan = 58;
    const colNominal = 85;
    const colKeterangan = pageWidth - colNo - colTanggal - colBulan - colNominal;
    const rowHeight = 16;
    const headerHeight = 20;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - rowHeight;

    function drawHeaderRow() {
      let x = marginLeft;
      const cols = [
        ['No', colNo], ['Tanggal', colTanggal], ['Bulan', colBulan], ['Keterangan', colKeterangan], ['Nominal', colNominal],
      ];
      doc.fontSize(8).font('Helvetica-Bold');
      cols.forEach(([label, w]) => {
        doc.rect(x, y, w, headerHeight).fill(COLORS.header);
        doc.fillColor('#ffffff').text(label, x + 4, y + 6, { width: w - 8, align: label === 'Nominal' ? 'right' : 'left' });
        x += w;
      });
      doc.fillColor('#000000').font('Helvetica');
      y += headerHeight;
    }

    function drawRow(cellsWithWidth) {
      let x = marginLeft;
      cellsWithWidth.forEach(([text, w, align]) => {
        doc.rect(x, y, w, rowHeight).lineWidth(0.4).strokeColor(COLORS.border).stroke();
        doc.fontSize(8).text(String(text), x + 4, y + 4, { width: w - 8, align: align || 'left' });
        x += w;
      });
      y += rowHeight;
    }

    drawHeaderRow();
    if (!expenses.length) {
      doc.fontSize(9).fillColor('#5c5a4c').text('Belum ada pengeluaran tercatat.', marginLeft, y + 6);
    }
    expenses.forEach((e, idx) => {
      if (y > bottomLimit) {
        doc.addPage();
        y = marginTop;
        drawHeaderRow();
      }
      drawRow([
        [idx + 1, colNo, 'center'],
        [e.tanggal, colTanggal, 'left'],
        [e.bulan || '-', colBulan, 'left'],
        [e.keterangan, colKeterangan, 'left'],
        [currency(e.nominal), colNominal, 'right'],
      ]);
    });

    if (y > bottomLimit) { doc.addPage(); y = marginTop; }
    doc.rect(marginLeft, y, pageWidth, rowHeight).fill(COLORS.totalBg);
    doc.fillColor(COLORS.header).font('Helvetica-Bold').fontSize(8)
      .text('Total pengeluaran', marginLeft + 4, y + 4, { width: pageWidth - colNominal - 8 })
      .text(currency(totalKeluar), marginLeft + pageWidth - colNominal, y + 4, { width: colNominal - 4, align: 'right' });

    doc.end();
  });
}

/**
 * Menghasilkan Promise<Buffer> berisi file PDF daftar pemasukan lain-lain
 * (di luar iuran wajib WhatsApp): tanggal, bulan, keterangan, nominal.
 */
function buildIncomePdf({ income, totalIuran, totalKeluar, title }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 32 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const marginLeft = doc.page.margins.left;
    const marginTop = doc.page.margins.top;
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const totalPemasukanLain = income.reduce((s, e) => s + Number(e.nominal || 0), 0);
    const totalMasuk = (totalIuran || 0) + totalPemasukanLain;
    const saldo = totalMasuk - (totalKeluar || 0);

    doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.header)
      .text(title || 'Rekap Pemasukan Kas', marginLeft, marginTop);
    doc.fontSize(8).font('Helvetica').fillColor('#5c5a4c')
      .text('Dicetak otomatis: ' + new Date().toLocaleString('id-ID'), marginLeft, marginTop + 18);

    let y = marginTop + 40;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#26291f');
    doc.text(`Iuran wajib (WhatsApp): ${currency(totalIuran || 0)}`, marginLeft, y);
    doc.text(`Pemasukan lain-lain: ${currency(totalPemasukanLain)}`, marginLeft, y + 14);
    doc.text(`Total pemasukan: ${currency(totalMasuk)}`, marginLeft, y + 28);
    doc.fillColor(saldo >= 0 ? COLORS.paidText : '#a13a2e')
      .text(`Saldo kas saat ini: ${currency(saldo)}`, marginLeft, y + 42);
    doc.fillColor('#000000');
    y += 66;

    const colNo = 22;
    const colTanggal = 62;
    const colBulan = 58;
    const colNominal = 85;
    const colKeterangan = pageWidth - colNo - colTanggal - colBulan - colNominal;
    const rowHeight = 16;
    const headerHeight = 20;
    const bottomLimit = doc.page.height - doc.page.margins.bottom - rowHeight;

    function drawHeaderRow() {
      let x = marginLeft;
      const cols = [
        ['No', colNo], ['Tanggal', colTanggal], ['Bulan', colBulan], ['Keterangan', colKeterangan], ['Nominal', colNominal],
      ];
      doc.fontSize(8).font('Helvetica-Bold');
      cols.forEach(([label, w]) => {
        doc.rect(x, y, w, headerHeight).fill(COLORS.header);
        doc.fillColor('#ffffff').text(label, x + 4, y + 6, { width: w - 8, align: label === 'Nominal' ? 'right' : 'left' });
        x += w;
      });
      doc.fillColor('#000000').font('Helvetica');
      y += headerHeight;
    }

    function drawRow(cellsWithWidth) {
      let x = marginLeft;
      cellsWithWidth.forEach(([text, w, align]) => {
        doc.rect(x, y, w, rowHeight).lineWidth(0.4).strokeColor(COLORS.border).stroke();
        doc.fontSize(8).text(String(text), x + 4, y + 4, { width: w - 8, align: align || 'left' });
        x += w;
      });
      y += rowHeight;
    }

    drawHeaderRow();
    if (!income.length) {
      doc.fontSize(9).fillColor('#5c5a4c').text('Belum ada pemasukan lain-lain tercatat.', marginLeft, y + 6);
    }
    income.forEach((e, idx) => {
      if (y > bottomLimit) {
        doc.addPage();
        y = marginTop;
        drawHeaderRow();
      }
      drawRow([
        [idx + 1, colNo, 'center'],
        [e.tanggal, colTanggal, 'left'],
        [e.bulan || '-', colBulan, 'left'],
        [e.keterangan, colKeterangan, 'left'],
        [currency(e.nominal), colNominal, 'right'],
      ]);
    });

    if (y > bottomLimit) { doc.addPage(); y = marginTop; }
    doc.rect(marginLeft, y, pageWidth, rowHeight).fill(COLORS.totalBg);
    doc.fillColor(COLORS.header).font('Helvetica-Bold').fontSize(8)
      .text('Total pemasukan lain-lain', marginLeft + 4, y + 4, { width: pageWidth - colNominal - 8 })
      .text(currency(totalPemasukanLain), marginLeft + pageWidth - colNominal, y + 4, { width: colNominal - 4, align: 'right' });

    doc.end();
  });
}

module.exports = { buildRecapPdf, buildExpensePdf, buildIncomePdf };
