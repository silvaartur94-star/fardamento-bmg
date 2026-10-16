// Gerador de ficheiros .xlsx (Office Open XML) verdadeiros, sem dependências pesadas.
import { strToU8, zipSync } from 'fflate';
import { cellText, type Dataset } from './format';

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function sheetName(name: string, used: Set<string>): string {
  let n = name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Folha';
  let k = 2;
  while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${k++}`;
  used.add(n.toLowerCase());
  return n;
}

function sheetXml(ds: Dataset): string {
  const cols = ds.columns;
  const widths = cols.map((c, i) => {
    const max = Math.max(c.label.length, ...ds.rows.slice(0, 500).map((r) => cellText(c, r).length));
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(c.width ?? max + 2, 8), 60)}" customWidth="1"/>`;
  });
  const rows: string[] = [];
  // Linha 1: título; linha 2: filtros/data; linha 4: cabeçalhos.
  rows.push(`<row r="1"><c r="A1" t="inlineStr" s="3"><is><t>${esc(ds.title)}</t></is></c></row>`);
  const sub = `Banda Marcial de Gueifães — emitido em ${new Date().toISOString().slice(0, 10)}${ds.filters?.length ? ` — Filtros: ${ds.filters.join('; ')}` : ''}`;
  rows.push(`<row r="2"><c r="A2" t="inlineStr" s="4"><is><t>${esc(sub)}</t></is></c></row>`);
  const headerRow = 4;
  rows.push(
    `<row r="${headerRow}">${cols.map((c, i) => `<c r="${colName(i)}${headerRow}" t="inlineStr" s="1"><is><t>${esc(c.label)}</t></is></c>`).join('')}</row>`,
  );
  ds.rows.forEach((r, ri) => {
    const rn = headerRow + 1 + ri;
    const cells = cols.map((c, i) => {
      const ref = `${colName(i)}${rn}`;
      const v = r[c.key];
      if ((c.type === 'int' || c.type === 'money') && v !== null && v !== undefined && v !== '' && !c.map) {
        const n = c.type === 'money' ? Number(v) / 100 : Number(v);
        if (Number.isFinite(n)) return `<c r="${ref}" s="${c.type === 'money' ? 5 : 2}"><v>${n}</v></c>`;
      }
      const t = cellText(c, r);
      // Texto como inlineStr: nunca é interpretado como fórmula.
      return t ? `<c r="${ref}" t="inlineStr" s="2"><is><t xml:space="preserve">${esc(t)}</t></is></c>` : '';
    });
    rows.push(`<row r="${rn}">${cells.join('')}</row>`);
  });
  const lastRow = headerRow + Math.max(ds.rows.length, 1);
  const lastCol = colName(Math.max(cols.length - 1, 0));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A${headerRow}:${lastCol}${lastRow}"/>
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF1F3A5F"/><name val="Calibri"/></font><font><i/><sz val="9"/><color rgb="FF555555"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD0D7E2"/></left><right style="thin"><color rgb="FFD0D7E2"/></right><top style="thin"><color rgb="FFD0D7E2"/></top><bottom style="thin"><color rgb="FFD0D7E2"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function toXlsx(datasets: Dataset[]): Uint8Array {
  const used = new Set<string>();
  const names = datasets.map((d) => sheetName(d.sheetName, used));
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`);
  files['_rels/.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`);
  files['docProps/core.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(datasets[0]?.title ?? 'Exportação')}</dc:title><dc:creator>Banda Marcial de Gueifães — Gestão de Fardamento</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>`);
  files['xl/workbook.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${names
    .map((n, i) => {
      const d = datasets[i];
      const last = colName(Math.max(d.columns.length - 1, 0));
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(n.replace(/'/g, "''"))}'!$A$4:$${last}$${4 + Math.max(d.rows.length, 1)}</definedName>`;
    })
    .join('')}</definedNames>
</workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  files['xl/styles.xml'] = strToU8(STYLES);
  datasets.forEach((d, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(d));
  });
  return zipSync(files, { level: 6 });
}
