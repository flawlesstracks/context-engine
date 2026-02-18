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
  // Require the linkedin.com/in/ URL — common words like "experience",
  // "education", "skills" appear in many document types and are not
  // sufficient on their own to identify a LinkedIn profile export.
  if (!lower.includes('linkedin.com/in/')) return false;
  let hits = 1; // already counted the URL
  for (const marker of LINKEDIN_MARKERS) {
    if (marker === 'linkedin.com/in/') continue;
    if (lower.includes(marker)) hits++;
  }
  return hits >= 3;
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
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 });
      const result = await parser.getText();
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

    case '.doc': {
      // .doc (legacy Word) — extract with mammoth (limited support) or fall back to raw text
      try {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        const text = result.value || '';
        return {
          text,
          metadata: { isLinkedIn: detectLinkedIn(text), isContactList: false },
        };
      } catch {
        const text = buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
        return { text, metadata: { isContactList: false, isLinkedIn: false } };
      }
    }

    case '.json': {
      const text = buffer.toString('utf-8');
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
