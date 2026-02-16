'use strict';

const path = require('path');

const LINKEDIN_MARKERS = ['linkedin.com/in/', 'experience', 'education', 'skills'];

const CONTACT_COLUMNS = [
  'name', 'first name', 'last name', 'full name',
  'email', 'e-mail',
  'phone', 'mobile', 'tel',
  'company', 'organization', 'org',
  'title', 'role', 'job title', 'position',
];

function detectLinkedIn(text) {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const marker of LINKEDIN_MARKERS) {
    if (lower.includes(marker)) hits++;
  }
  return hits >= 2;
}

function detectContactColumns(headers) {
  let matches = 0;
  const normalised = headers.map(h => h.toLowerCase().trim());
  for (const col of CONTACT_COLUMNS) {
    if (normalised.some(h => h.includes(col))) matches++;
  }
  return matches >= 2;
}

async function normalizeFileToText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  switch (ext) {
    case '.pdf': {
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(buffer);
      const text = result.text || '';
      return {
        text,
        metadata: { isLinkedIn: detectLinkedIn(text), isContactList: false },
      };
    }

    case '.docx': {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value || '';
      return {
        text,
        metadata: { isLinkedIn: detectLinkedIn(text), isContactList: false },
      };
    }

    case '.xlsx':
    case '.xls': {
      const XLSX = require('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const allRows = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        allRows.push(...rows);
      }

      if (allRows.length > 0) {
        const headers = Object.keys(allRows[0]);
        if (detectContactColumns(headers)) {
          return {
            text: JSON.stringify(allRows),
            metadata: { isContactList: true, rows: allRows },
          };
        }
      }

      // Flatten cells to text
      let text = '';
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        text += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
      }
      return { text, metadata: { isContactList: false, isLinkedIn: false } };
    }

    case '.csv': {
      const { parse } = require('csv-parse/sync');
      const csvText = buffer.toString('utf-8');
      const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

      if (rows.length > 0) {
        const headers = Object.keys(rows[0]);
        if (detectContactColumns(headers)) {
          return {
            text: JSON.stringify(rows),
            metadata: { isContactList: true, rows },
          };
        }
      }

      // Not a contact list — join as text
      const text = rows.map(row => Object.values(row).join(', ')).join('\n');
      return { text, metadata: { isContactList: false, isLinkedIn: false } };
    }

    case '.txt':
    case '.md': {
      const text = buffer.toString('utf-8');
      return { text, metadata: { isContactList: false, isLinkedIn: detectLinkedIn(text) } };
    }

    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

module.exports = { normalizeFileToText, detectContactColumns, detectLinkedIn };
