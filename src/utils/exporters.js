'use strict';

const zlib = require('node:zlib');

/**
 * Report exporters for the Premium Reports dashboard (V3 §26).
 *
 * Both formats are produced in-process. The XLSX writer below is a minimal but
 * genuine OOXML package rather than a renamed CSV or a SpreadsheetML file, so
 * Excel, Numbers and LibreOffice all open it without a format warning - and no
 * dependency has to be added for what amounts to a few hundred lines of ZIP.
 */

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Escapes a value for CSV: quotes when it contains a delimiter, quote or newline. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {{key: string, label: string}[]} columns
 * @param {object[]} rows
 */
function toCsv(columns, rows) {
  const lines = [columns.map((column) => csvCell(column.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(','));
  }
  // A BOM so Excel on Windows reads the file as UTF-8 rather than ANSI, which
  // is what otherwise mangles the rupee sign and merchant names.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time, which is what a ZIP local header stores. */
function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Builds a ZIP archive from `[name, Buffer]` entries.
 *
 * Entries are deflated when that actually helps - XML compresses very well, and
 * a stored-only archive of a large report would be several times the size.
 */
function zip(entries) {
  const { time, day } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(content);
    const deflated = zlib.deflateRawSync(content, { level: 6 });
    const useDeflate = deflated.length < content.length;
    const payload = useDeflate ? deflated : content;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuffer, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/** Spreadsheet column name for a zero-based index: 0 -> A, 26 -> AA. */
function columnName(index) {
  let name = '';
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

function cellXml(reference, value, styleIndex) {
  const style = styleIndex ? ` s="${styleIndex}"` : '';
  if (value === null || value === undefined || value === '') {
    return `<c r="${reference}"${style}/>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  // Inline strings keep the package to a single sheet part - no shared string
  // table to keep in sync, which is where most hand-rolled writers go wrong.
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

/**
 * @param {{key: string, label: string}[]} columns
 * @param {object[]} rows
 * @param {string} sheetName
 */
function toXlsx(columns, rows, sheetName = 'Report') {
  const headerCells = columns
    .map((column, index) => cellXml(`${columnName(index)}1`, column.label, 1))
    .join('');

  const bodyRows = rows
    .map((row, rowIndex) => {
      const cells = columns
        .map((column, columnIndex) =>
          cellXml(`${columnName(columnIndex)}${rowIndex + 2}`, row[column.key]),
        )
        .join('');
      return `<row r="${rowIndex + 2}">${cells}</row>`;
    })
    .join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${columns.map((_, index) => `<col min="${index + 1}" max="${index + 1}" width="18" customWidth="1"/>`).join('')}</cols>
<sheetData><row r="1">${headerCells}</row>${bodyRows}</sheetData>
</worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  // One extra font/fill so the header row reads as a header.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4338CA"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zip([
    ['[Content_Types].xml', Buffer.from(contentTypes, 'utf8')],
    ['_rels/.rels', Buffer.from(rootRels, 'utf8')],
    ['xl/workbook.xml', Buffer.from(workbook, 'utf8')],
    ['xl/_rels/workbook.xml.rels', Buffer.from(workbookRels, 'utf8')],
    ['xl/styles.xml', Buffer.from(styles, 'utf8')],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8')],
  ]);
}

const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Renders `rows` in the requested format and returns what the response needs. */
function render(format, columns, rows, { sheetName = 'Report', fileName = 'report' } = {}) {
  const normalised = format === 'excel' || format === 'xlsx' ? 'xlsx' : 'csv';
  const body = normalised === 'xlsx' ? toXlsx(columns, rows, sheetName) : toCsv(columns, rows);
  return {
    body,
    contentType: MIME[normalised],
    fileName: `${fileName}.${normalised}`,
  };
}

module.exports = { toCsv, toXlsx, render, columnName, crc32 };
